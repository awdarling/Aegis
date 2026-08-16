import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { parseYesNo } from '../utils/yes-no';
import { textOpener } from '../messaging/greeting';
import { generateReply } from '../ai/claude';
import { coerceJsonObject } from '../utils/coerce-json';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { coercePolicyWrite } from '../lib/policy-write';
import { handleWageRateSync } from './payroll';
import {
  computeManagerAvailabilityChange,
  writeEmployeeAvailability,
  formatAvailabilityList,
  type AvailabilitySlot,
} from './employee-onboarding';
import type { InboundMessage, VerifiedContact } from '../security/types';
import { aegisSystemFacts, aegisScopeGuard } from '../router/system-knowledge';
import type { CapabilityRole } from '../router/capabilities';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FetchFilter {
  field: string;
  op: 'eq' | 'neq' | 'gte' | 'lte' | 'like' | 'in' | 'is';
  value: string | number | boolean | null | string[];
}

interface FetchPlanItem {
  table: string;
  select?: string;
  filters?: FetchFilter[];
  order?: { field: string; ascending: boolean };
  limit?: number;
}

interface FetchPlan {
  fetches: FetchPlanItem[];
  date_context?: 'today' | 'current_week' | 'next_week' | 'recent';
}

export interface PendingEdit {
  company_id: string;
  manager_id: string;
  table: string;
  action: 'update' | 'create' | 'delete';
  entity_type: string;
  entity_name: string;
  entity_id: string | null;
  field?: string;
  current_value?: unknown;
  new_value?: unknown;
  create_fields?: Record<string, unknown>;
  schedule_id?: string;
  availability_slots?: AvailabilitySlot[]; // for entity_type 'availability' (manager-set)
  // D1: for entity_type 'policy'. The EXACT column patch that the reader for this
  // policy_key actually consults — decided by coercePolicyWrite() at confirmation
  // time, never by the LLM. Engine policies get policy_value_json; time-off
  // policies get a bare-number policy_value + policy_type='time_off'.
  policy_patch?: Record<string, unknown>;
  // D8: for entity_type 'banned_pair'. Two employees, not one, so it can't ride
  // the generic single-entity edit path.
  conflict_pair?: {
    employee_id_1: string;
    employee_id_2: string;
    name_1: string;
    name_2: string;
    severity: 'never' | 'avoid';
  };
  expires_at: string;
}

interface ParsedEdit {
  entity_type: string;
  entity_name: string;
  action: 'update' | 'create' | 'delete';
  field?: string;
  new_value?: unknown;
  create_fields?: Record<string, unknown>;
}

// Allowed tables Claude can request — prevents injection via fetch plan
const ALLOWED_TABLES = new Set([
  'employees', 'availability', 'time_off_requests', 'schedules',
  'shift_types', 'shift_requirements', 'wage_rates', 'policies',
  'events', 'employee_conflicts', 'aegis_memory', 'activity_log',
]);

// Tables that are PERSONAL to one employee (keyed by employee_id). When an
// EMPLOYEE self-queries ("what's my availability", "where's my time off?"), the
// LLM fetch plan can't know their UUID, so without forcing this scope the plan
// pulls the WHOLE company's rows — and the answer model, told to only reveal the
// asker's own and never anyone else's, can't tell which rows are "mine" and
// returns nothing/wrong. Scoping to self both fixes the read and is a privacy
// backstop (an employee can never fetch a coworker's availability/time off here).
const EMPLOYEE_SELF_SCOPED_TABLES = new Set<string>([
  'availability', 'time_off_requests',
]);

// Entity type → Supabase table mapping
const ENTITY_TABLE: Record<string, string> = {
  employee: 'employees',
  event: 'events',
  special_note: 'events',
  policy: 'policies',
  wage_rate: 'wage_rates',
  shift_type: 'shift_types',
  shift_requirement: 'shift_requirements',
  schedule: 'schedules',
};

// The column to match an entity_name against. Most tables use 'name', but some
// are keyed differently — without this, editing a rule/wage/requirement by name
// fails because those tables have no 'name' column.
function editLookupColumn(table: string): string {
  if (table === 'policies') return 'policy_key';
  if (table === 'wage_rates' || table === 'shift_requirements') return 'role';
  return 'name';
}

// ── D3: writable-column allow-list ────────────────────────────────────────────
//
// `pending.field` and `pending.create_fields` come from an LLM and used to be
// interpolated straight into `.update({[field]: value})` / `.insert(fields)`.
// That means the model could name ANY column on an allowed table — including
// `company_id` (cross-tenant write) or `id`. Only `shift_requirements.days_active`
// was ever blocked. This is the allow-list: nothing else is writable by message.
//
// Verified against information_schema on 2026-07-13. DELIBERATE omissions:
//   employees.aegis_access      — a permission field; not editable by message.
//   employees.company_id / id   — tenant + identity. Never.
//   shift_requirements.shift_name/start_time/end_time — denormalized copies of
//                                 shift_types (D4). Editing them here deepens
//                                 the drift; edit the shift type instead.
//   shift_requirements.days_active   — dormant (D9), already blocked below.
//   shift_requirements.accepted_roles — not read by the engine (D10); inert.
//   events.event_shifts / shift_overrides — structured staffing specs. Never
//                                 built from a free-text LLM field. Use Homebase.
//   policies.policy_value_json / policy_type — set by coercePolicyWrite(), NOT
//                                 by the model. The model may only ask to change
//                                 `policy_value`; we decide which column that
//                                 actually means. See D1.
//   schedules.*                 — schedule edits are refused upstream.
const EDITABLE_COLUMNS: Record<string, Set<string>> = {
  employees: new Set([
    'name', 'primary_role', 'qualified_roles', 'max_weekly_hours',
    'contact_phone', 'contact_email', 'active', 'is_veteran', 'individual_wage', 'sex',
  ]),
  policies: new Set(['policy_value', 'description']),
  wage_rates: new Set(['role', 'hourly_rate']),
  shift_types: new Set(['name', 'start_time', 'end_time', 'days_active', 'active']),
  shift_requirements: new Set(['role', 'required_count']),
  events: new Set(['title', 'date', 'end_date', 'description', 'event_type', 'staffing_notes']),
};

/** Columns Aegis may set when CREATING a row (a subset of the updatable ones,
 *  plus the identity columns a new row needs). company_id is always forced by
 *  executeEdit and is never taken from the model. */
const CREATABLE_COLUMNS: Record<string, Set<string>> = {
  employees: new Set([...EDITABLE_COLUMNS.employees]),
  policies: new Set(['policy_key', 'policy_value', 'description']),
  wage_rates: new Set([...EDITABLE_COLUMNS.wage_rates]),
  shift_types: new Set([...EDITABLE_COLUMNS.shift_types]),
  shift_requirements: new Set(['role', 'required_count', 'shift_type_id']),
  events: new Set([...EDITABLE_COLUMNS.events]),
};

// Manager phrasings → real column names. The edit parser occasionally echoes the
// manager's words ("max hours", "weekly cap") instead of the column
// ("max_weekly_hours"), which then trips the allow-list even though the column
// itself is editable. Normalize known synonyms here; unknown fields pass through
// unchanged (the allow-list still guards them). (batch 3c)
const FIELD_SYNONYMS: Record<string, string> = {
  'max hours': 'max_weekly_hours',
  'max weekly hours': 'max_weekly_hours',
  'weekly hours': 'max_weekly_hours',
  'weekly cap': 'max_weekly_hours',
  'hour cap': 'max_weekly_hours',
  'hours cap': 'max_weekly_hours',
  'weekly hour cap': 'max_weekly_hours',
  'max hrs': 'max_weekly_hours',
  'wage': 'individual_wage',
  'pay': 'individual_wage',
  'pay rate': 'individual_wage',
  'hourly rate': 'hourly_rate',
  'hourly wage': 'hourly_rate',
  'role': 'primary_role',
  'position': 'primary_role',
  'phone': 'contact_phone',
  'phone number': 'contact_phone',
  'email': 'contact_email',
  'email address': 'contact_email',
};
export function normalizeFieldName(field: string): string {
  const key = field.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  return FIELD_SYNONYMS[key] ?? field.trim();
}

function assertEditableColumn(table: string, field: string): void {
  const allowed = EDITABLE_COLUMNS[table];
  if (!allowed) throw new Error(`I can't edit ${table} records by message.`);
  if (!allowed.has(field)) {
    throw new Error(
      `I can't change "${field.replace(/_/g, ' ')}" by message. I can change: ` +
        `${[...allowed].map(c => c.replace(/_/g, ' ')).join(', ')}.`,
    );
  }
}

/** Drop any column the model invented. Returns the kept fields + what was dropped. */
function filterCreateFields(
  table: string,
  fields: Record<string, unknown>,
): { kept: Record<string, unknown>; dropped: string[] } {
  const allowed = CREATABLE_COLUMNS[table];
  if (!allowed) throw new Error(`I can't create ${table} records by message.`);
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.has(k)) kept[k] = v;
    else dropped.push(k);
  }
  return { kept, dropped };
}

// ── Personality prompt ────────────────────────────────────────────────────────

async function getAegisPersonality(companyId: string): Promise<string> {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).single();
  const name = (data as { name: string } | null)?.name ?? 'your company';
  return (
    `You are Aegis, an AI assistant manager for ${name}. ` +
    `You know this operation and its staff. You speak like a sharp, capable assistant manager — direct, confident, professional but warm. First person.\n\n` +
    `How you respond:\n` +
    `- Lead with the answer. Never open with caveats, hedges, or what you don't have.\n` +
    `- Be concise. Operational queries get 3-5 sentences unless complexity genuinely demands more.\n` +
    `- Work with the data you have. If it's partial, state what you know confidently, then note the gap in one short sentence at the end. Never say things like "I can't confirm" or "I need more data" — answer with what you have.\n` +
    `- No markdown formatting. No **bold**, no bullet asterisks, no headers. Use plain language structure — short sentences, clear clauses, line breaks where needed.\n` +
    `- Make recommendations when they're useful. Treat the reader as a competent professional.\n` +
    `- Don't pad with preamble, restatements of the question, or sign-offs.`
  );
}

// ── Store helpers ─────────────────────────────────────────────────────────────

export async function getPendingEdit(
  companyId: string,
  managerId: string
): Promise<(PendingEdit & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `edit_pending:${managerId}`)
    .maybeSingle();

  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingEdit;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

async function storePendingEdit(pending: PendingEdit): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', pending.company_id)
    .eq('source', `edit_pending:${pending.manager_id}`);
  await supabase.from('aegis_memory').insert({
    company_id: pending.company_id,
    memory_type: 'observation',
    source: `edit_pending:${pending.manager_id}`,
    content: JSON.stringify(pending),
  });
}

async function clearPendingEdit(companyId: string, managerId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `edit_pending:${managerId}`);
}

// ── Date context helpers ──────────────────────────────────────────────────────

function getWeekBoundsForDate(date: string): { weekStart: string; weekEnd: string } {
  const d = new Date(date + 'T12:00:00Z');
  const sun = new Date(d); sun.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const sat = new Date(sun); sat.setUTCDate(sun.getUTCDate() + 6);
  return { weekStart: sun.toISOString().slice(0, 10), weekEnd: sat.toISOString().slice(0, 10) };
}

function getNextWeekBounds(today: string): { weekStart: string; weekEnd: string } {
  const d = new Date(today + 'T12:00:00Z');
  const days = d.getUTCDay() === 0 ? 7 : 7 - d.getUTCDay();
  const sun = new Date(d); sun.setUTCDate(d.getUTCDate() + days);
  const sat = new Date(sun); sat.setUTCDate(sun.getUTCDate() + 6);
  return { weekStart: sun.toISOString().slice(0, 10), weekEnd: sat.toISOString().slice(0, 10) };
}

// ── Fetch plan execution ──────────────────────────────────────────────────────

export async function executeFetchPlan(
  plan: FetchPlan,
  companyId: string,
  today: string,
  role?: CapabilityRole,
  selfEmployeeId?: string | null
): Promise<Record<string, unknown[]>> {
  const results: Record<string, unknown[]> = {};

  // Compute date ranges for context injection
  const { weekStart: cwStart, weekEnd: cwEnd } = getWeekBoundsForDate(today);
  const { weekStart: nwStart, weekEnd: nwEnd } = getNextWeekBounds(today);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const item of plan.fetches) {
    if (!ALLOWED_TABLES.has(item.table)) continue;

    let q = supabase
      .from(item.table)
      .select(item.select ?? '*')
      .eq('company_id', companyId);

    // Apply date context filters for relevant tables
    if (plan.date_context && (item.table === 'schedules' || item.table === 'time_off_requests')) {
      if (plan.date_context === 'current_week') {
        q = q.lte('week_start' in {} ? 'week_start' : 'start_date', cwEnd)
              .gte('week_end' in {} ? 'week_end' : 'end_date', cwStart);
        // Adjust field names based on table
        if (item.table === 'schedules') {
          q = supabase.from(item.table).select(item.select ?? '*').eq('company_id', companyId)
              .lte('week_start', cwEnd).gte('week_end', cwStart);
        } else {
          q = supabase.from(item.table).select(item.select ?? '*').eq('company_id', companyId)
              .lte('start_date', cwEnd).gte('end_date', cwStart);
        }
      } else if (plan.date_context === 'next_week') {
        if (item.table === 'schedules') {
          q = supabase.from(item.table).select(item.select ?? '*').eq('company_id', companyId)
              .lte('week_start', nwEnd).gte('week_end', nwStart);
        } else {
          q = supabase.from(item.table).select(item.select ?? '*').eq('company_id', companyId)
              .lte('start_date', nwEnd).gte('end_date', nwStart);
        }
      } else if (plan.date_context === 'recent') {
        q = supabase.from(item.table).select(item.select ?? '*').eq('company_id', companyId)
            .gte('start_date' in {} ? 'start_date' : 'created_at', thirtyDaysAgo);
      }
    }

    // Apply explicit filters from the plan
    for (const f of item.filters ?? []) {
      // Safety: don't allow filtering on company_id (we already set it)
      if (f.field === 'company_id') continue;
      switch (f.op) {
        case 'eq': q = q.eq(f.field, f.value as string); break;
        case 'neq': q = q.neq(f.field, f.value as string); break;
        case 'gte': q = q.gte(f.field, f.value as string); break;
        case 'lte': q = q.lte(f.field, f.value as string); break;
        case 'like': q = q.ilike(f.field, `%${f.value}%`); break;
        case 'in': q = q.in(f.field, f.value as string[]); break;
      }
    }

    // Employees only ever see the posted (published) roster — never unpublished drafts.
    if (item.table === 'schedules' && role === 'employee') {
      q = q.eq('status', 'published');
    }

    // Force self-scope on personal tables for an employee, so "my availability" /
    // "my time off" resolves to THEIR rows (the LLM plan can't supply the UUID).
    // Applied last so the date_context branch above — which rebuilds `q` for
    // time_off_requests — can't drop it.
    if (role === 'employee' && selfEmployeeId && EMPLOYEE_SELF_SCOPED_TABLES.has(item.table)) {
      q = q.eq('employee_id', selfEmployeeId);
    }

    if (item.order) q = q.order(item.order.field, { ascending: item.order.ascending });
    if (item.limit) q = q.limit(item.limit);

    const { data, error } = await q;
    if (error) {
      console.warn(`[operational-query] fetch failed for ${item.table}:`, error.message);
      results[item.table] = [];
    } else {
      results[item.table] = (data ?? []) as unknown[];
    }
  }

  return results;
}

// ── Answer-context summarization (MANAGER-COMM-1) ───────────────────────────────
// Manager headcount/coverage answers were going wrong because the raw fetched
// rows were dumped as JSON and hard-truncated at 4000 chars — which chopped the
// schedule's assignments list mid-record, so the model couldn't see who was on
// duty, hedged, and leaked the mechanics ("the schedule data is truncated", "pull
// the full slice from Homebase"). Instead we turn the schedule into clean, human
// staffing facts (per-date headcount + names by role) and never chop a record.

interface AssignmentLite {
  date: string;
  employee_id: string;
  employee_name: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function prettyDate(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return date;
  return `${WEEKDAY[d.getUTCDay()]} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}

// Fallback only: a rough AM/PM segment derived from a shift's start TIME, used to
// label a shift ONLY when it has no tenant shift_name. Every other user-facing
// shift label comes from the tenant's own shift_name (see formatStaffOnDuty), never
// a hardcoded AM/PM — a client's shift names must survive across tenants.
function shiftSegment(startTime: string): string {
  const h = Number(startTime.slice(0, 2));
  if (!Number.isFinite(h)) return '';
  return h < 12 ? 'AM' : 'PM';
}

// One on-duty person rendered as "Name (AM, 9:00 AM–1:00 PM)" — segment + time so
// a "who's working" answer reads operationally, not as a bare list of names.
// Degrades to just the name when the assignment has no usable times.
function formatStaffOnDuty(a: AssignmentLite): string {
  // Label the shift by the tenant's OWN name (shift_name) — never a hardcoded
  // AM/PM. The client defines its shift names ("AM", "Flex", "Twilight"…) and
  // Aegis must echo them so onboarding a new client stays a data-only change. A
  // time-derived AM/PM segment is only a fallback for a shift with no name.
  const label = a.shift_name.trim() || shiftSegment(a.start_time);
  const times = a.start_time && a.end_time ? `${fmtShiftTime(a.start_time)}–${fmtShiftTime(a.end_time)}` : '';
  const detail = [label, times].filter(Boolean).join(', ');
  return detail ? `${a.employee_name} (${detail})` : a.employee_name;
}

// Pull every assignment out of the fetched schedule rows (schedules.data.assignments).
export function collectAssignments(scheduleRows: unknown[]): AssignmentLite[] {
  const out: AssignmentLite[] = [];
  for (const row of scheduleRows) {
    const data = (row as { data?: { assignments?: unknown[] } }).data;
    const list = Array.isArray(data?.assignments) ? (data!.assignments as unknown[]) : [];
    for (const a of list) {
      const x = a as Partial<AssignmentLite>;
      if (!x.date || !x.employee_name) continue;
      out.push({
        date: String(x.date),
        employee_id: String(x.employee_id ?? ''),
        employee_name: String(x.employee_name),
        shift_name: String(x.shift_name ?? ''),
        role: String(x.role ?? ''),
        start_time: String(x.start_time ?? ''),
        end_time: String(x.end_time ?? ''),
      });
    }
  }
  return out;
}

// Per-date staffing summary: distinct headcount + a role → names breakdown.
// This is the deterministic factual answer to "how many people did I have on
// staff that day" and "who was working" — the model just reads it back.
export function summarizeStaffingByDate(assignments: AssignmentLite[]): string {
  if (assignments.length === 0) return '';
  const byDate = new Map<string, AssignmentLite[]>();
  for (const a of assignments) {
    const list = byDate.get(a.date) ?? [];
    list.push(a);
    byDate.set(a.date, list);
  }
  const lines: string[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const dayAssigns = byDate.get(date)!;
    // Distinct PEOPLE (one person on two shifts the same day counts once).
    const distinct = new Set(dayAssigns.map(a => a.employee_id || a.employee_name));
    const byRole = new Map<string, AssignmentLite[]>();
    for (const a of dayAssigns) {
      const list = byRole.get(a.role) ?? [];
      list.push(a);
      byRole.set(a.role, list);
    }
    const roleParts = [...byRole.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([role, list]) => {
        // Count DISTINCT people in the role, but list each shift they work so a
        // "who's working" answer carries segment + time, not just a name (a
        // double shows once in the count, twice in the detail).
        const headcount = new Set(list.map(a => a.employee_id || a.employee_name)).size;
        const detail = list
          .slice()
          .sort((a, b) => a.employee_name.localeCompare(b.employee_name) || a.start_time.localeCompare(b.start_time))
          .map(formatStaffOnDuty)
          .join(', ');
        return `${role || 'Staff'} (${headcount}): ${detail}`;
      });
    lines.push(`${prettyDate(date)}: ${distinct.size} on duty — ${roleParts.join('; ')}`);
  }
  return lines.join('\n');
}

// Per-date "available but NOT scheduled" summary (Batch-1.5 #16): the deterministic
// answer to "who's free [date]", mirroring summarizeStaffingByDate for "who's
// working". availability is a recurring pattern keyed by day_of_week (0=Sun), so
// for each date we take its weekday's available employees and subtract anyone
// already assigned that date. The model just reads back the line for the day asked.
export function summarizeAvailableByDate(
  employees: Array<Record<string, unknown>>,
  availability: Array<Record<string, unknown>>,
  assignments: AssignmentLite[],
  dates: string[],
): string {
  if (dates.length === 0) return '';
  const nameById = new Map<string, string>();
  const roleById = new Map<string, string>();
  for (const e of employees) {
    const id = String(e.id ?? '');
    if (!id) continue;
    nameById.set(id, String(e.name ?? 'Someone'));
    roleById.set(id, String(e.primary_role ?? ''));
  }
  const availByDow = new Map<number, Set<string>>();
  for (const a of availability) {
    const dow = Number(a.day_of_week);
    const eid = String(a.employee_id ?? '');
    if (Number.isNaN(dow) || !eid) continue;
    const set = availByDow.get(dow) ?? new Set<string>();
    set.add(eid);
    availByDow.set(dow, set);
  }
  const assignedByDate = new Map<string, Set<string>>();
  for (const a of assignments) {
    const set = assignedByDate.get(a.date) ?? new Set<string>();
    if (a.employee_id) set.add(a.employee_id);
    assignedByDate.set(a.date, set);
  }
  const lines: string[] = [];
  for (const date of [...new Set(dates)].sort()) {
    const dow = new Date(date + 'T12:00:00Z').getUTCDay();
    const avail = availByDow.get(dow) ?? new Set<string>();
    const assigned = assignedByDate.get(date) ?? new Set<string>();
    const freeIds = [...avail].filter(id => !assigned.has(id) && nameById.has(id));
    if (freeIds.length === 0) {
      lines.push(`${prettyDate(date)}: nobody available who isn't already scheduled`);
      continue;
    }
    const names = freeIds
      .map(id => { const r = roleById.get(id); return r ? `${nameById.get(id)} (${r})` : nameById.get(id)!; })
      .sort();
    lines.push(`${prettyDate(date)}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

// Detects a "who's free / available" staffing question (as opposed to "who's
// working"). The two share the operational_query intent; this routes the free-set
// computation on top of the same fetched schedule + availability.
export function isFreeStaffQuery(body: string): boolean {
  return /\bwho'?s\s+(free|available|open|around|not\s+(working|scheduled|on))\b|\bwho\s+(can|could)\s+work\b|\bwho\s+is\s+(free|available)\b|\banyone\s+(free|available|around)\b/i.test(body || '');
}

// Unfilled coverage across the fetched schedules, as plain text.
function summarizeGaps(scheduleRows: unknown[]): string {
  const lines: string[] = [];
  for (const row of scheduleRows) {
    const data = (row as { data?: { gaps?: unknown[] } }).data;
    const gaps = Array.isArray(data?.gaps) ? (data!.gaps as unknown[]) : [];
    for (const g of gaps) {
      const x = g as { date?: string; shift_name?: string; role?: string; required_count?: number; filled_count?: number };
      const need = (x.required_count ?? 0) - (x.filled_count ?? 0);
      if (need > 0 && x.date) {
        lines.push(`${prettyDate(String(x.date))} ${x.shift_name ?? ''} ${x.role ?? ''}: short ${need}`.replace(/\s+/g, ' ').trim());
      }
    }
  }
  return lines.join('\n');
}

// Build the answer-prompt context from the fetched tables. Schedules become a
// readable staffing summary; every other table lists FULL rows (never chopped
// mid-record), capped by row count rather than character count.
// Comp/PII columns an employee-facing answer must never be handed — even as raw
// context. The model is also instructed not to reveal them, but we don't put them
// in front of it at all (defense in depth). Pure/deterministic — no extra LLM call.
const EMPLOYEE_REDACTED_FIELDS = new Set<string>([
  'individual_wage', 'wage', 'wage_rate', 'hourly_wage',
  'contact_phone', 'contact_email', 'phone', 'email',
  'aegis_access', 'is_veteran', 'sex', 'max_weekly_hours',
]);
function redactForEmployee(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (EMPLOYEE_REDACTED_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function buildDataContext(fetchedData: Record<string, unknown[]>, role?: CapabilityRole): string {
  const blocks: string[] = [];
  for (const [table, rows] of Object.entries(fetchedData)) {
    if (!rows || rows.length === 0) continue;
    if (table === 'schedules') {
      const meta = rows
        .map(r => {
          const x = r as { week_start?: string; week_end?: string; status?: string };
          return `Week ${x.week_start ?? '?'} to ${x.week_end ?? '?'} (${x.status ?? 'draft'})`;
        })
        .join('\n');
      const staffing = summarizeStaffingByDate(collectAssignments(rows));
      const gaps = summarizeGaps(rows);
      let block = `schedules:\n${meta}`;
      if (staffing) block += `\nWho is on duty each day:\n${staffing}`;
      if (gaps) block += `\nUnfilled coverage:\n${gaps}`;
      blocks.push(block);
    } else {
      const MAX_ROWS = 80;
      const source = role === 'employee' ? rows.map(redactForEmployee) : rows;
      const shown = source.slice(0, MAX_ROWS).map(r => JSON.stringify(r)).join('\n');
      const more = rows.length > MAX_ROWS ? `\n…and ${rows.length - MAX_ROWS} more` : '';
      blocks.push(`${table} (${rows.length}):\n${shown}${more}`);
    }
  }
  return blocks.join('\n\n');
}

// ── Free-form answer system prompt ────────────────────────────────────────────
//
// EVERY free-form answer the assistant generates for an operational_query or a
// general_question flows through this one builder — so this is the single place
// that guarantees three things at once:
//   1. GROUNDING (aegisSystemFacts): the answer is anchored to how Aegis actually
//      works, so it can never invent a process that doesn't exist. This is what
//      closes the "to request time off, log into Homebase" hallucination — an
//      employee has no Homebase login; they just text Aegis.
//   2. SCOPE (aegisScopeGuard): Aegis stays a workforce assistant and declines
//      off-domain asks (trivia, coding, essays, math…) instead of behaving like a
//      free general-purpose chatbot.
//   3. NO LEAK (noLeakGuard): the answer never exposes the data plumbing.
// Exported + pure so all three can be asserted in tests without an LLM call.
export function buildOperationalAnswerSystem(
  role: CapabilityRole,
  personality: string,
  today: string,
  name: string
): string {
  // Never let the answer expose the plumbing. Headcount/coverage questions were
  // leaking internals ("the data is truncated", "the complete payload", "pull the
  // June 17 slice from Homebase") — Aegis should sound like a manager, not a
  // database. If a fact genuinely isn't here, say so plainly and offer to pull it.
  const noLeakGuard =
    `Answer plainly, in your own voice, and NEVER mention how you got the information — ` +
    `no talk of data, payloads, records, JSON, schedules being "loaded"/"truncated"/"provided", or "pulling from Homebase". ` +
    `If you genuinely don't have what's needed, say so in one short, natural sentence, NAME the date you assumed, and offer the RIGHT next step — never explain the internals or apologize for the system. When a schedule for that date does NOT exist yet, offer to BUILD one (e.g. "There's no schedule up for Saturday Aug 16 yet — want me to build it?"); only when a schedule likely exists but you don't have it in front of you should you offer to pull it up (e.g. "I don't have next week's schedule in front of me — want me to pull it up?"). Do not say "pull it up" for a date that has no schedule — that reads as retrieving something that isn't there.`;

  const roleScope =
    role === 'employee'
      ? `You are answering a question from ${name}, an employee. ` +
        `Answer questions about their own schedule, their own time off, their own availability, their own hours, and their own shifts. ` +
        `You can also tell them who is working on any given day, in what role and shift time — and if they ask about a specific shift ("who's on Monday night", or a shift by name), scope it to just that shift using the shift name and time shown for each person. The posted schedule is shared with the whole team, so the roster is not private; share it plainly for any day they ask about, whether or not they're on it themselves, and never disclaim or hedge about whose shifts they can see. ` +
        `Never reveal anyone else's wages, personal availability, total hours, contact information, or other personal details — only who is on, their role, and the shift time.`
      : `You can answer staffing questions like how many people were on a given day, who was working (and in what role), who's free/available, where coverage is short, and who's near their max weekly hours. ` +
        `The staffing summary below already gives you exact per-day headcounts and who was on by role — treat those counts as authoritative and answer with them directly. ` +
        `When someone asks about a specific SHIFT rather than the whole day ("who's on the PM shift Monday", "who's working Twilight on Saturday"), scope your answer to just that shift: each person in the summary is tagged with their shift name and start–end time, so match the shift they named — by the tenant's shift name, or by AM/PM read from the times shown — and list only the people on it.`;

  // Order matters: personality (voice) → date → GROUNDING → SCOPE → role data
  // scope → no-leak. Grounding and scope come before the role scope so the model
  // reads "here's how the system works and what's off-limits" before it decides
  // how to answer.
  return [
    personality,
    `Today is ${today}.`,
    aegisSystemFacts(role),
    aegisScopeGuard(role),
    `${roleScope} Be direct and specific. ${noLeakGuard}`,
  ].join('\n\n');
}

// ── Operational query handler ─────────────────────────────────────────────────

export async function handleOperationalQuery(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const personality = await getAegisPersonality(contact.company_id);

  // Step 1: Ask Claude what data to fetch
  const tableDescriptions = `
Available Homebase tables (all scoped to this company):
- employees: id, name, primary_role, qualified_roles, max_weekly_hours, contact_email, contact_phone, active, individual_wage
- availability: employee_id, day_of_week (0=Sun), start_time, end_time
- time_off_requests: employee_id, start_date, end_date, reason, status (pending/approved/denied/cancelled — 'cancelled' means the EMPLOYEE withdrew their own approved request, so that day is NOT off), requested_at
- schedules: week_start, week_end, status (draft/published), data (JSON: assignments[], gaps[]), staffing_report (JSON), generated_at
- shift_types: name, start_time, end_time, days_active, active
- shift_requirements: role, required_count
- wage_rates: role, hourly_rate
- policies: policy_key, policy_value, policy_type, description
- events: title, date, end_date, event_type, staffing_notes
- employee_conflicts: employee_id_1, employee_id_2, severity (avoid/never)
`.trim();

  const fetchPlanSystem =
    `You are determining what Homebase data to fetch to answer a workforce question. Today is ${today}. ` +
    `${tableDescriptions}\n\n` +
    `Return ONLY valid JSON: {"fetches":[{"table":"...","select":"...","filters":[{"field":"...","op":"eq|gte|lte|like|in","value":"..."}],"limit":N}],"date_context":"today|current_week|next_week|recent|null"}. ` +
    `Use the minimal set of tables needed. For schedule questions, always fetch the schedules table.`;

  const fetchPlanText = await generateReply(fetchPlanSystem, message.body, []);

  let plan: FetchPlan = { fetches: [] };
  const parsedPlan = coerceJsonObject<FetchPlan>(fetchPlanText);
  if (parsedPlan) {
    plan = parsedPlan;
  } else {
    // If Claude can't produce a plan, fall back to fetching common tables
    plan = {
      fetches: [
        { table: 'employees', filters: [{ field: 'active', op: 'eq', value: true }] },
        { table: 'schedules', limit: 2, order: { field: 'generated_at', ascending: false } },
      ],
      date_context: 'current_week',
    };
  }

  // "Who's free [date]" needs employees + availability + the published schedule to
  // compute available-but-not-scheduled (Batch-1.5 #16). The LLM plan reads "free"
  // as availability-only and skips schedules, so the answer model has nothing to
  // subtract the scheduled set from and hedges ("I don't have the schedule…").
  // Force the three inputs so the deterministic free-set block below can be built.
  const freeStaff = isFreeStaffQuery(message.body);
  if (freeStaff) {
    const ensure = (table: string, item: FetchPlanItem) => {
      if (!plan.fetches.some(f => f.table === table)) plan.fetches.push(item);
    };
    ensure('employees', { table: 'employees', filters: [{ field: 'active', op: 'eq', value: true }] });
    ensure('availability', { table: 'availability' });
    ensure('schedules', { table: 'schedules', limit: 4, order: { field: 'generated_at', ascending: false } });
  }

  // Step 2: Execute the fetch plan. Pass the asker's employee_id so an employee's
  // self-queries (availability, time off) are scoped to their own rows.
  const fetchedData = await executeFetchPlan(
    plan,
    contact.company_id,
    today,
    contact.role as CapabilityRole,
    contact.employee_id,
  );

  // Step 3: Ask Claude to answer with the data. The context is pre-summarized
  // into clean facts (esp. schedules → per-date headcount + names) so the model
  // never has to parse — or hedge about — a truncated raw JSON blob.
  let dataContext = buildDataContext(fetchedData, contact.role as CapabilityRole);

  // Append the deterministic "available but not scheduled" block for a who's-free
  // question, computed over the same fetched tables (Batch-1.5 #16).
  if (freeStaff) {
    const schedRows = (fetchedData.schedules ?? []) as Array<Record<string, unknown>>;
    const assignments = collectAssignments(schedRows);
    const dates = new Set<string>();
    for (const a of assignments) dates.add(a.date);
    for (const row of schedRows) {
      const ws = typeof row.week_start === 'string' ? row.week_start : null;
      const we = typeof row.week_end === 'string' ? row.week_end : null;
      if (ws && we) {
        for (let d = ws; d <= we; d = addDaysISO(d, 1)) dates.add(d);
      }
    }
    const freeBlock = summarizeAvailableByDate(
      (fetchedData.employees ?? []) as Array<Record<string, unknown>>,
      (fetchedData.availability ?? []) as Array<Record<string, unknown>>,
      assignments,
      [...dates],
    );
    if (freeBlock) {
      dataContext += `${dataContext ? '\n\n' : ''}Available but NOT scheduled each day (these people can work but aren't on the schedule):\n${freeBlock}`;
    }
  }

  const answerSystem = buildOperationalAnswerSystem(
    contact.role as CapabilityRole,
    personality,
    today,
    contact.name
  );

  const answer = await generateReply(answerSystem, `Question: ${message.body}\n\nWhat I know:\n${dataContext || 'Nothing on file for this one.'}`, []);

  await reply(contact, message, answer);

  await logActivity({
    company_id: contact.company_id,
    action: 'operational_query_answered',
    summary: `${contact.name} asked: ${message.body.slice(0, 120)}`,
    metadata: { tables_fetched: Object.keys(fetchedData), role: contact.role },
  });
}

// ── Homebase edit handler ─────────────────────────────────────────────────────

export async function handleHomebaseEdit(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  const personality = await getAegisPersonality(contact.company_id);

  // Step 1: Parse the edit intent
  const parseSystem =
    `You are parsing a Homebase data edit request from a manager. ` +
    `Return ONLY valid JSON: {"entity_type":"employee|event|policy|wage_rate|shift_type|shift_requirement|availability|schedule|experience_rule|banned_pair","entity_name":"...","action":"update|create|delete","field":"column_name_or_null","new_value":"...or null","create_fields":{} }. ` +
    `For a rule about TWO employees NOT working together ("never schedule Marcus and Riley together", "keep Jordan and Sam apart", "try not to put Alex with Casey", "Marcus and Riley can work together again"), entity_type="banned_pair" — the names, how strict it is, and whether they're setting or removing the rule stay in the message and are parsed downstream. ` +
    `For an availability change to an employee ("Maria can't work Wednesdays anymore", "set Maria to Mondays 9am-5pm", "give Jordan mornings off until Sept 1"), entity_type="availability", entity_name=the employee's name, action="update" — the day/time details stay in the message and are parsed downstream. ` +
    `For a VETERAN / EXPERIENCE staffing requirement on a shift ("Saturday nights should be all veterans", "at least two veterans on the morning shift", "veterans only on the closing shift this summer", "June 20 needs veteran lifeguards"), entity_type="experience_rule", action="create" — the shift, count, days, and season details stay in the message and are parsed downstream. ` +
    `For schedule edits (move/add/remove employee from shift), entity_type="schedule".`;

  const parseText = await generateReply(parseSystem, message.body, []);

  const parsedEdit = coerceJsonObject<ParsedEdit>(parseText);
  if (!parsedEdit) {
    await reply(contact, message,
      "I couldn't parse that edit request. Could you be more specific? For example: \"Update Jordan's max hours to 32\" or \"Mark Marcus as inactive\"."
    );
    return;
  }
  const parsed: ParsedEdit = parsedEdit;

  // Normalize a manager's field phrasing to the real column before anything
  // downstream (record lookup, allow-list check, confirm copy) uses it. (3c)
  if (parsed.field) parsed.field = normalizeFieldName(parsed.field);

  // Availability changes are multi-row + natural-language, so they get their own
  // handler (reuses the availability engine) rather than the generic field editor.
  if (parsed.entity_type === 'availability') {
    await handleAvailabilityEdit(message, contact, parsed);
    return;
  }

  // Veteran/experience staffing rules get their own parse (mode, shift, days,
  // season) + confirm, then write a shift_experience_rules row the engine reads.
  if (parsed.entity_type === 'experience_rule') {
    await handleExperienceRuleEdit(message, contact);
    return;
  }

  // D8 — banned / avoided PAIRS ("never schedule Marcus and Riley together").
  // These need their own parse because they name TWO employees, not one, so the
  // generic single-entity edit path cannot express them.
  //
  // CHANNEL PARITY (contract rule 3): a manager could set this in Homebase and
  // through Soteria, but NOT by emailing Aegis — the assistant they're paying for
  // couldn't do a thing their website could. Every rule a manager can set must be
  // settable through every channel, or the AI employee is a second-class citizen.
  if (parsed.entity_type === 'banned_pair') {
    await handleBannedPairEdit(message, contact);
    return;
  }

  // Schedule edits by message aren't supported — point the manager to Homebase
  // rather than dead-end or misfire.
  if (parsed.entity_type === 'schedule') {
    await reply(contact, message, `I can't move shifts around by message yet — make schedule changes in Homebase's schedule editor for now. I can change availability, rules, wages, roles, shifts, and employee details by message, though.`);
    return;
  }

  const table = ENTITY_TABLE[parsed.entity_type];
  if (!table) {
    await reply(contact, message, `I don't know how to edit ${parsed.entity_type} records. Try specifying: employee, event, policy, wage_rate, shift_type, shift_requirement, or availability.`);
    return;
  }

  if (parsed.action === 'create') {
    await handleCreateEdit(message, contact, parsed, table, personality);
  } else if (parsed.action === 'delete') {
    await handleDeleteEdit(message, contact, parsed, table, personality);
  } else {
    await handleUpdateEdit(message, contact, parsed, table, personality);
  }
}

// ── D8 — banned / avoided pairs by message ────────────────────────────────────
//
// "Never schedule Marcus and Riley together."
//
// Writes `employee_conflicts`, which the engine reads: severity 'never' is a HARD
// block at build time and in swap cohabitation checks; 'avoid' is a soft flag the
// manager sees before approving a swap (D13). Same table, same semantics, same
// engine as the Homebase UI and Soteria — this is a new CHANNEL, not a new
// concept, and it deliberately writes nowhere else.
async function handleBannedPairEdit(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<void> {
  const parseSystem =
    `You are parsing a manager's rule about two employees NOT being scheduled together. ` +
    `Return ONLY JSON: {"employee_a":string|null,"employee_b":string|null,"severity":"never"|"avoid","action":"create"|"delete"}. ` +
    `employee_a / employee_b = the two people's names as the manager wrote them. ` +
    `severity: "never" = a hard rule (the schedule engine will never place them on the same shift) — use this for "never", "do not", "can't", "under no circumstances", or an unqualified "don't schedule them together". ` +
    `"avoid" = a soft preference — use ONLY for clearly hedged wording ("try not to", "prefer not to", "if possible", "rather you didn't", "ideally"). When in doubt, choose "never": over-restricting is visible and easily undone, while under-restricting silently puts two people together the manager wanted apart. ` +
    `action: "delete" when they are REMOVING the rule ("they can work together again", "drop that rule", "Marcus and Riley are fine now"), otherwise "create".`;

  const parseText = await generateReply(parseSystem, message.body, []);
  const r = coerceJsonObject<{
    employee_a?: string | null;
    employee_b?: string | null;
    severity?: string | null;
    action?: string | null;
  }>(parseText);

  if (!r?.employee_a || !r?.employee_b) {
    await reply(contact, message,
      `I couldn't tell which two people you meant. Try something like "never schedule Marcus and Riley together".`);
    return;
  }

  // Resolve both names to real employees in THIS company.
  const [empA, empB] = await Promise.all([
    findEmployeeByNameForEdit(contact.company_id, r.employee_a),
    findEmployeeByNameForEdit(contact.company_id, r.employee_b),
  ]);

  const missing = [
    !empA ? r.employee_a : null,
    !empB ? r.employee_b : null,
  ].filter(Boolean) as string[];

  if (missing.length > 0) {
    await reply(contact, message,
      `I couldn't find ${missing.map(n => `"${n}"`).join(' or ')} on your team. Check the spelling and try again.`);
    return;
  }
  if (empA!.id === empB!.id) {
    await reply(contact, message, `Those are the same person — I need two different people for that rule.`);
    return;
  }

  const severity: 'never' | 'avoid' = r.severity === 'avoid' ? 'avoid' : 'never';
  const action: 'create' | 'delete' = r.action === 'delete' ? 'delete' : 'create';

  const confirmMsg = action === 'delete'
    ? `Want me to drop the rule keeping ${empA!.name} and ${empB!.name} apart? They'd be able to work the same shift again.`
    : severity === 'never'
      ? `Got it — ${empA!.name} and ${empB!.name} should never be on the same shift. Want me to lock that in as a hard rule?`
      : `Got it — I'll keep ${empA!.name} and ${empB!.name} off the same shift where I can, but I won't leave a shift short if they're the only cover. Want me to set that up?`;

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table: 'employee_conflicts',
    action,
    entity_type: 'banned_pair',
    entity_name: `${empA!.name} & ${empB!.name}`,
    entity_id: null,
    conflict_pair: {
      employee_id_1: empA!.id,
      employee_id_2: empB!.id,
      name_1: empA!.name,
      name_2: empB!.name,
      severity,
    },
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await storePendingEdit(pending);
  await reply(contact, message, confirmMsg);
}

/** Resolve an employee by name within a company. Exact match first, then a single
 *  unambiguous partial. Returns null on no match OR on ambiguity — we will not
 *  guess which of two people a manager meant when setting a rule about them. */
async function findEmployeeByNameForEdit(
  companyId: string,
  name: string
): Promise<{ id: string; name: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const { data: exact } = await supabase
    .from('employees')
    .select('id, name')
    .eq('company_id', companyId)
    .eq('active', true)
    .ilike('name', trimmed)
    .limit(2);

  const exactRows = (exact ?? []) as { id: string; name: string }[];
  if (exactRows.length === 1) return exactRows[0];
  if (exactRows.length > 1) return null; // ambiguous — don't guess

  const { data: partial } = await supabase
    .from('employees')
    .select('id, name')
    .eq('company_id', companyId)
    .eq('active', true)
    .ilike('name', `%${trimmed}%`)
    .limit(2);

  const partialRows = (partial ?? []) as { id: string; name: string }[];
  return partialRows.length === 1 ? partialRows[0] : null;
}

// Manager sets a veteran/experience staffing rule on a shift by message
// ("Saturday nights should be all veterans this summer"). Parses the rule,
// resolves the named shift to a shift type, confirms in plain English, then on
// "yes" writes a shift_experience_rules row that the schedule engine enforces.
async function handleExperienceRuleEdit(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const parseSystem =
    `You are parsing a manager's request to set a VETERAN/EXPERIENCE staffing requirement on a shift. Today is ${today}. ` +
    `Return ONLY JSON: {"mode":"all_veterans"|"min_veterans","min_count":number|null,"shift_name":string|null,"days_of_week":number[]|null,"role":string|null,"season_start":"YYYY-MM-DD"|null,"season_end":"YYYY-MM-DD"|null}. ` +
    `mode "all_veterans" = every position on that shift must be a veteran; "min_veterans" = at least min_count veterans (min_count required, >= 1). ` +
    `shift_name = the shift they named, in their words (e.g. "PM Lifeguard", "Saturday night", "closing shift"); null if not specified. ` +
    `days_of_week (0=Sun..6=Sat) when they limit to certain days ("Saturday nights" -> [6], "weekends" -> [0,6]); null = all days. ` +
    `role = a single role if scoped ("lifeguards" -> "Lifeguard"); null = all roles. ` +
    `season_start/season_end = the window if mentioned ("this summer" -> roughly 06-01..08-31 of the current year, "until Sept 1" -> end only, "on June 20"/"June 20th" -> both = that date); null = open-ended.`;
  const parseText = await generateReply(parseSystem, message.body, []);
  const r = coerceJsonObject<{
    mode?: string;
    min_count?: number | null;
    shift_name?: string | null;
    days_of_week?: number[] | null;
    role?: string | null;
    season_start?: string | null;
    season_end?: string | null;
  }>(parseText);

  if (!r || (r.mode !== 'all_veterans' && r.mode !== 'min_veterans')) {
    await reply(contact, message, `I couldn't quite read that staffing rule. Try something like "Saturday night lifeguards should be all veterans this summer" or "at least 2 veterans on the morning shift".`);
    return;
  }
  if (r.mode === 'min_veterans' && (typeof r.min_count !== 'number' || r.min_count < 1)) {
    await reply(contact, message, `How many veterans should that shift need at minimum? For example: "at least 2 veterans on the PM shift".`);
    return;
  }

  // Resolve the named shift to a shift type (null = applies to every shift).
  let shiftTypeId: string | null = null;
  let shiftLabel = 'every shift';
  if (r.shift_name) {
    const { data: sts } = await supabase
      .from('shift_types')
      .select('id, name')
      .eq('company_id', contact.company_id)
      .eq('active', true);
    const types = (sts ?? []) as { id: string; name: string }[];
    const want = r.shift_name.toLowerCase();
    const match = types.find(t => want.includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(want));
    if (match) {
      shiftTypeId = match.id;
      shiftLabel = match.name;
    } else {
      const names = types.map(t => t.name).join(', ');
      await reply(contact, message, `Which shift do you mean? I have: ${names || '(no shifts set up yet)'}. Send the rule again naming one of those.`);
      return;
    }
  }

  const days = Array.isArray(r.days_of_week)
    ? r.days_of_week.filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
    : null;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const seasonStart = typeof r.season_start === 'string' && DATE_RE.test(r.season_start) ? r.season_start : null;
  const seasonEnd = typeof r.season_end === 'string' && DATE_RE.test(r.season_end) ? r.season_end : null;

  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmt = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const need = r.mode === 'all_veterans' ? 'all veterans' : `at least ${r.min_count} veteran${r.min_count === 1 ? '' : 's'}`;
  const dayLabel = days && days.length ? ` on ${days.map(d => DAY[d]).join(', ')}` : '';
  const roleLabel = r.role ? ` (${r.role} positions)` : '';
  const seasonLabel =
    seasonStart || seasonEnd
      ? ` from ${seasonStart ? fmt(seasonStart) : 'now'}${seasonEnd ? ` through ${fmt(seasonEnd)}` : ' onward'}`
      : ' (ongoing)';
  const confirmMsg = `Here's the rule: the ${shiftLabel} shift${dayLabel}${roleLabel} needs ${need}${seasonLabel}. I'll staff it that way from now on — want me to lock it in?`;

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table: 'shift_experience_rules',
    action: 'create',
    entity_type: 'experience_rule',
    entity_name: shiftLabel,
    entity_id: null,
    create_fields: {
      shift_type_id: shiftTypeId,
      days_of_week: days && days.length ? days : null,
      role: r.role?.trim() || null,
      mode: r.mode,
      min_count: r.mode === 'min_veterans' ? r.min_count : null,
      season_start: seasonStart,
      season_end: seasonEnd,
    },
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await storePendingEdit(pending);
  await reply(contact, message, confirmMsg);
}

// Manager changes a named employee's availability by message. Reuses the same
// availability engine the employee flow uses (parse → set/remove → full-week
// default), then confirms before writing — the manager is the authority here.
async function handleAvailabilityEdit(
  message: InboundMessage,
  contact: VerifiedContact,
  parsed: ParsedEdit
): Promise<void> {
  const { data: emps } = await supabase
    .from('employees')
    .select('id, name')
    .eq('company_id', contact.company_id)
    .ilike('name', `%${parsed.entity_name}%`)
    .limit(3);
  const rows = (emps ?? []) as { id: string; name: string }[];
  if (rows.length === 0) {
    await reply(contact, message, `I couldn't find an employee named "${parsed.entity_name}" in Homebase.`);
    return;
  }
  const emp = rows[0];
  const firstName = emp.name.split(' ')[0];

  const change = await computeManagerAvailabilityChange(contact.company_id, emp.id, message.body);
  if (!change) {
    await reply(
      contact,
      message,
      `I couldn't work out the availability change for ${emp.name}. Try something like "${firstName} can't work Wednesdays" or "set ${firstName} to Mondays 9am-5pm".`
    );
    return;
  }

  const proposedDisplay = formatAvailabilityList(change.proposed);
  const confirmMsg = `Here's ${emp.name}'s availability as I'd set it:\n${proposedDisplay}\n\nWant me to save that?`;

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table: 'availability',
    action: 'update',
    entity_type: 'availability',
    entity_name: emp.name,
    entity_id: emp.id,
    availability_slots: change.proposed,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await storePendingEdit(pending);
  await reply(contact, message, confirmMsg);
}

async function handleUpdateEdit(
  message: InboundMessage,
  contact: VerifiedContact,
  parsed: ParsedEdit,
  table: string,
  personality: string
): Promise<void> {
  if (!parsed.field) {
    await reply(contact, message, "What field should I update? For example: \"Update Jordan's max hours to 32\".");
    return;
  }

  // Find the record by its lookup column (name, or policy_key / role for the
  // tables that have no name column).
  const lookupCol = editLookupColumn(table);
  const { data: records } = await supabase
    .from(table)
    .select('*')
    .eq('company_id', contact.company_id)
    .ilike(lookupCol, `%${parsed.entity_name}%`)
    .limit(3);

  const rows = (records ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    await reply(contact, message, `I couldn't find a ${parsed.entity_type} named "${parsed.entity_name}" in Homebase.`);
    return;
  }

  const record = rows[0];
  const currentValue = record[parsed.field];
  const entityId = record['id'] as string;

  // D3 — validate the column BEFORE we ask the manager to confirm. Confirming a
  // change we're going to refuse is worse than refusing it now.
  try {
    assertEditableColumn(table, parsed.field);
  } catch (err) {
    await reply(contact, message, err instanceof Error ? err.message : 'I can\'t change that field by message.');
    return;
  }

  // D1 — POLICIES. Never write the column the model named; write the column the
  // READER for this policy_key actually consults. coercePolicyWrite() resolves
  // the family (engine → policy_value_json; time-off → text policy_value +
  // policy_type='time_off') and validates the value against the same vocabulary
  // the engine parses with. If it can't be expressed safely, we say so now.
  let policyPatch: Record<string, unknown> | undefined;
  let confirmMsg: string;

  if (table === 'policies') {
    const policyKey = String(record['policy_key'] ?? '');
    const coerced = coercePolicyWrite(policyKey, parsed.new_value);
    if (!coerced.ok) {
      await reply(contact, message, coerced.reason);
      return;
    }
    policyPatch = coerced.patch;
    const currentStr = currentValue === null || currentValue === undefined ? 'not set' : String(currentValue);
    confirmMsg =
      `${policyKey.replace(/_/g, ' ')} is currently ${currentStr}. Want me to change it to ${coerced.display}?`;
  } else {
    confirmMsg = buildUpdateConfirmation(parsed, currentValue, personality);
  }

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table,
    action: 'update',
    entity_type: parsed.entity_type,
    entity_name: parsed.entity_name,
    entity_id: entityId,
    field: parsed.field,
    current_value: currentValue,
    new_value: parsed.new_value,
    ...(policyPatch ? { policy_patch: policyPatch } : {}),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await storePendingEdit(pending);
  await reply(contact, message, confirmMsg);
}

async function handleCreateEdit(
  message: InboundMessage,
  contact: VerifiedContact,
  parsed: ParsedEdit,
  table: string,
  personality: string
): Promise<void> {
  const fields = parsed.create_fields ?? {};
  const preview = Object.entries(fields)
    .map(([k, v]) => `  ${k.replace(/_/g, ' ')}: ${formatPlainValue(v)}`)
    .join('\n');

  const confirmMsg = `Here's the new ${parsed.entity_type} I'll create:\n${preview}\n\nWant me to go ahead?`;

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table,
    action: 'create',
    entity_type: parsed.entity_type,
    entity_name: parsed.entity_name || 'new record',
    entity_id: null,
    create_fields: fields,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await storePendingEdit(pending);
  await reply(contact, message, confirmMsg);
}

async function handleDeleteEdit(
  message: InboundMessage,
  contact: VerifiedContact,
  parsed: ParsedEdit,
  table: string,
  personality: string
): Promise<void> {
  const lookupCol = editLookupColumn(table);
  const { data: records } = await supabase
    .from(table)
    .select(`id, ${lookupCol}`)
    .eq('company_id', contact.company_id)
    .ilike(lookupCol, `%${parsed.entity_name}%`)
    .limit(3);

  const rows = (records ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) {
    await reply(contact, message, `I couldn't find a ${parsed.entity_type} named "${parsed.entity_name}" to delete.`);
    return;
  }

  const record = rows[0];
  const displayName = String(record[lookupCol] ?? parsed.entity_name);
  const confirmMsg = `Want me to delete ${parsed.entity_type} "${displayName}"? Heads up — I can't undo this.`;

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table,
    action: 'delete',
    entity_type: parsed.entity_type,
    entity_name: displayName,
    entity_id: String(record['id']),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await storePendingEdit(pending);
  await reply(contact, message, confirmMsg);
}

export function formatPlainValue(v: unknown): string {
  if (v === null || v === undefined) return 'not set';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map(x => String(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function buildUpdateConfirmation(parsed: ParsedEdit, currentValue: unknown, _personality: string): string {
  const currentStr = currentValue === null || currentValue === undefined
    ? 'not set'
    : typeof currentValue === 'boolean'
      ? (currentValue ? 'yes' : 'no')
      : String(currentValue);

  const newStr = parsed.new_value === null || parsed.new_value === undefined
    ? 'not set'
    : typeof parsed.new_value === 'boolean'
      ? (parsed.new_value ? 'yes' : 'no')
      : String(parsed.new_value);

  const fieldLabel = (parsed.field ?? '').replace(/_/g, ' ');
  return `${parsed.entity_name}'s ${fieldLabel} is currently ${currentStr}. Want me to change it to ${newStr}?`;
}

// ── Edit confirmation handler ─────────────────────────────────────────────────

export async function handleEditConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingEdit & { _memory_id?: string }
): Promise<void> {
  const answer = parseYesNo(message.body);

  if (answer === 'unclear') {
    const actioning =
      pending.action === 'delete' ? 'remove it' :
      pending.action === 'create' ? 'create it' :
      'make the change';
    await reply(contact, message,
      `Just let me know — a yes and I'll ${actioning}, or no to cancel.`
    );
    return;
  }

  await clearPendingEdit(contact.company_id, contact.matched_identifier);

  if (answer === 'no') {
    await reply(contact, message, `No problem — I didn't change anything.`);
    return;
  }

  // Execute the edit
  try {
    await executeEdit(pending, contact.company_id);
    await logActivity({
      company_id: contact.company_id,
      action: `homebase_edit_${pending.action}`,
      entity_type: pending.entity_type,
      entity_id: pending.entity_id ?? undefined,
      summary: pending.table === 'availability'
        ? `Manager updated ${pending.entity_name}'s availability`
        : `Manager edited ${pending.entity_type} "${pending.entity_name}": ${pending.action === 'update' ? `${pending.field} → ${JSON.stringify(pending.new_value)}` : pending.action}`,
      metadata: {
        table: pending.table, field: pending.field,
        old_value: pending.current_value, new_value: pending.new_value,
        create_fields: pending.create_fields,
        // D1: record the columns we ACTUALLY wrote, so the audit trail shows
        // policy_value_json (or the time-off text) — not the model's guess.
        ...(pending.policy_patch ? { policy_patch: pending.policy_patch } : {}),
      },
    });

    const isStructural = ['policies', 'wage_rates', 'shift_types', 'shift_requirements', 'shift_experience_rules', 'employee_conflicts'].includes(pending.table);
    const doneMsg = pending.table === 'availability'
      ? `Updated ${pending.entity_name}'s availability.`
      : pending.table === 'shift_experience_rules'
        ? `The staffing rule for the ${pending.entity_name} shift is set — I'll enforce it on every build from now on.`
      // D8 — say plainly what the rule will DO, so the manager knows whether it's a
      // hard block or a soft preference without having to look it up.
      : pending.table === 'employee_conflicts'
        ? (pending.action === 'delete'
            ? `${pending.conflict_pair?.name_1} and ${pending.conflict_pair?.name_2} can work together again.`
            : pending.conflict_pair?.severity === 'never'
              ? `${pending.conflict_pair?.name_1} and ${pending.conflict_pair?.name_2} won't be put on the same shift — I'll enforce that on every build and flag any swap that would break it.`
              : `I'll keep ${pending.conflict_pair?.name_1} and ${pending.conflict_pair?.name_2} apart where I can, and check with you before approving a swap that puts them together.`)
      : pending.action === 'create'
        ? `Created ${pending.entity_type} "${pending.entity_name}".`
        : pending.action === 'delete'
          ? `Deleted ${pending.entity_type} "${pending.entity_name}".`
          : `${pending.entity_name}'s ${(pending.field ?? '').replace(/_/g, ' ')} is now ${formatPlainValue(pending.new_value)}.`;

    const footerMsg = isStructural
      ? ' This changes how I build schedules — worth a look in Homebase to be sure.'
      : '';

    await reply(contact, message, doneMsg + footerMsg);
  } catch (err) {
    console.error('[homebase-edit] execute failed:', err);
    // executeEdit throws MANAGER-FACING messages (allow-list refusals, policy
    // coercion failures, and now real DB errors that used to be swallowed).
    // Passing them through tells the manager what to do instead of a dead end.
    const msg = err instanceof Error ? err.message : '';
    const actionable = msg && !/^[A-Z][a-z]+ (into|to) /.test(msg) && msg.length < 400;
    await reply(
      contact,
      message,
      actionable
        ? msg
        : `That change didn't go through, so nothing was saved. Make the edit directly in Homebase, or send it again and I'll retry.`,
    );
  }
}

async function executeEdit(pending: PendingEdit, companyId: string): Promise<void> {
  // D8 — banned/avoided pair. Writes `employee_conflicts`, the SAME table the
  // Homebase UI and Soteria write and the SAME one the engine reads (hard 'never'
  // block at build + swap cohabitation; soft 'avoid' flag on swap approval).
  // A new channel, not a new concept.
  if (pending.table === 'employee_conflicts') {
    const pair = pending.conflict_pair;
    if (!pair) throw new Error('Missing the pair for that rule — send it again and I\'ll redo it.');

    // The pair is unordered: (A,B) and (B,A) are the same rule. Match on both
    // orderings so we never create a duplicate or fail to delete one.
    const bothOrders =
      `and(employee_id_1.eq.${pair.employee_id_1},employee_id_2.eq.${pair.employee_id_2}),` +
      `and(employee_id_1.eq.${pair.employee_id_2},employee_id_2.eq.${pair.employee_id_1})`;

    if (pending.action === 'delete') {
      const { error: delErr } = await supabase
        .from('employee_conflicts')
        .delete()
        .eq('company_id', companyId)
        .or(bothOrders);
      if (delErr) throw new Error(`Couldn't remove that rule: ${delErr.message}`);
      return;
    }

    // Upsert-by-hand: an existing rule for this pair gets its severity updated
    // rather than duplicated (two rows for one pair would make 'avoid' and
    // 'never' both true for the same people).
    const { data: existing, error: findErr } = await supabase
      .from('employee_conflicts')
      .select('id')
      .eq('company_id', companyId)
      .or(bothOrders)
      .limit(1)
      .maybeSingle();
    if (findErr) throw new Error(`Couldn't check that rule: ${findErr.message}`);

    if (existing) {
      const { error: updErr } = await supabase
        .from('employee_conflicts')
        .update({ severity: pair.severity })
        .eq('id', (existing as { id: string }).id)
        .eq('company_id', companyId);
      if (updErr) throw new Error(`Couldn't update that rule: ${updErr.message}`);
      return;
    }

    const { error: insErr } = await supabase.from('employee_conflicts').insert({
      company_id: companyId,
      employee_id_1: pair.employee_id_1,
      employee_id_2: pair.employee_id_2,
      severity: pair.severity,
      reason: 'Set by manager via Aegis',
    });
    if (insErr) throw new Error(`Couldn't save that rule: ${insErr.message}`);
    return;
  }

  // Availability is a multi-row replace (delete + insert), handled by the engine.
  if (pending.table === 'availability') {
    if (!pending.entity_id || !pending.availability_slots) throw new Error('Missing availability data for edit');
    await writeEmployeeAvailability(companyId, pending.entity_id, pending.availability_slots);
    return;
  }

  if (pending.action === 'create') {
    // D3 — the model's create_fields are UNTRUSTED. Keep only allow-listed
    // columns; company_id is forced from the verified contact, never the model.
    const { kept, dropped } = filterCreateFields(pending.table, pending.create_fields ?? {});
    if (dropped.length > 0) {
      console.warn(`[homebase-edit] dropped non-allow-listed create fields on ${pending.table}:`, dropped);
    }
    const fields: Record<string, unknown> = { ...kept, company_id: companyId };

    // D1 — a new POLICY row must be written into the column its reader consults.
    // policy_value and policy_type are both NOT NULL, so a naive insert also
    // just fails; coercePolicyWrite supplies both correctly.
    if (pending.table === 'policies') {
      const policyKey = String(kept['policy_key'] ?? '').trim();
      const coerced = coercePolicyWrite(policyKey, kept['policy_value']);
      if (!coerced.ok) throw new Error(coerced.reason);
      Object.assign(fields, coerced.patch);
      fields['policy_key'] = policyKey.toLowerCase();
      // policy_type is load-bearing ONLY for the time-off family (its loader
      // filters on it); coercePolicyWrite already set it there. The engine
      // parser ignores policy_type entirely, so 'custom' is correct for it —
      // and matches every existing engine-family row.
      if (coerced.family === 'engine') fields['policy_type'] = 'custom';
    }

    // Sensible defaults for employee creation
    if (pending.table === 'employees') {
      if (fields['active'] === undefined) fields['active'] = true;
      if (fields['max_weekly_hours'] === undefined) fields['max_weekly_hours'] = 40;
      if (fields['qualified_roles'] === undefined) {
        fields['qualified_roles'] = fields['primary_role'] ? [fields['primary_role']] : [];
      }
    }
    // For events / experience rules created by Aegis
    if (pending.table === 'events' || pending.table === 'shift_experience_rules') {
      fields['created_by'] = 'aegis';
    }
    const { error: insertErr } = await supabase.from(pending.table).insert(fields);
    if (insertErr) throw new Error(`Insert into ${pending.table} failed: ${insertErr.message}`);
    return;
  }

  if (pending.action === 'delete') {
    if (!pending.entity_id) throw new Error('No entity_id for delete');

    // D15 — deleting an EMPLOYEE must take everything that points at them with
    // it. Otherwise their approved time-off keeps blocking coverage maths, and a
    // banned-pair rule keeps being enforced about a person who no longer exists.
    // Dependants first, employee last, so a mid-way failure never leaves the
    // person gone but their rules alive. Mirrors the Soteria delete_employee
    // cascade exactly — both channels, same behaviour.
    if (pending.table === 'employees') {
      const empId = pending.entity_id;
      for (const [table, filter] of [
        ['availability', 'employee_id'],
        ['custom_availability', 'employee_id'],
        ['time_off_requests', 'employee_id'],
      ] as const) {
        const { error } = await supabase
          .from(table)
          .delete()
          .eq('company_id', companyId)
          .eq(filter, empId);
        if (error) throw new Error(`Couldn't remove ${pending.entity_name}'s ${table.replace(/_/g, ' ')}: ${error.message}`);
      }
      // employee_conflicts references the employee in EITHER id column.
      const { error: confErr } = await supabase
        .from('employee_conflicts')
        .delete()
        .eq('company_id', companyId)
        .or(`employee_id_1.eq.${empId},employee_id_2.eq.${empId}`);
      if (confErr) throw new Error(`Couldn't remove ${pending.entity_name}'s scheduling rules: ${confErr.message}`);
    }

    const { error: delErr } = await supabase
      .from(pending.table)
      .delete()
      .eq('id', pending.entity_id)
      .eq('company_id', companyId);
    if (delErr) throw new Error(`Delete from ${pending.table} failed: ${delErr.message}`);
    return;
  }

  // Update
  if (!pending.entity_id || !pending.field) throw new Error('Missing entity_id or field for update');

  // shift_requirements.days_active is dormant — the engine reads days_active
  // from shift_types only. Block direct edits to keep the column from
  // diverging silently. days_active edits to shift_types still pass through.
  if (pending.table === 'shift_requirements' && pending.field === 'days_active') {
    throw new Error('Days are set on the shift type, not on the role requirement. Try editing the shift instead.');
  }

  // D3 — re-assert the allow-list at the write. handleUpdateEdit checks it too;
  // this is the backstop, because THIS is the line that touches the database.
  assertEditableColumn(pending.table, pending.field);

  // D1 — POLICIES take the pre-coerced patch, never `{[field]: value}`. Writing
  // policy_value on an engine-family rule leaves policy_value_json stale and the
  // engine keeps enforcing the OLD rule while the manager is told it changed.
  if (pending.table === 'policies') {
    if (!pending.policy_patch) {
      throw new Error('Missing the resolved policy patch — re-send the change and I\'ll redo it.');
    }
    const { error: polErr } = await supabase
      .from('policies')
      .update(pending.policy_patch)
      .eq('id', pending.entity_id)
      .eq('company_id', companyId);
    if (polErr) throw new Error(`Policy update failed: ${polErr.message}`);
    return;
  }

  let newValue = pending.new_value;

  // Type coercions for specific fields
  if (pending.field === 'active') newValue = newValue === true || newValue === 'true' || newValue === 'yes';
  if (pending.field === 'max_weekly_hours' || pending.field === 'hourly_rate' || pending.field === 'individual_wage') {
    newValue = typeof newValue === 'string' ? parseFloat(newValue) : newValue;
  }
  if (pending.field === 'qualified_roles' && typeof newValue === 'string') {
    newValue = (newValue as string).split(',').map(s => s.trim());
  }
  if (pending.field === 'days_active' && typeof newValue === 'string') {
    newValue = (newValue as string).split(',').map(s => parseInt(s.trim()));
  }

  const patch: Record<string, unknown> = { [pending.field]: newValue };

  // D16 — a primary_role that isn't in qualified_roles makes the employee
  // UNSCHEDULABLE FOR THEIR OWN JOB. The engine matches on qualified_roles
  // (Rule 0b); primary_role only breaks ranking ties. So "make Jordan a
  // Headguard" would set the title and leave the engine refusing to schedule
  // Jordan as a Headguard — and the gap reason would say "not qualified" about
  // the exact role on their record.
  //
  // Same heal as the Soteria path (soteria/execute update_employee): a manager
  // promoting someone plainly means they can work the role. Both channels must
  // behave identically — that is the whole point of the contract.
  if (pending.table === 'employees' && pending.field === 'primary_role' && typeof newValue === 'string') {
    const { data: current } = await supabase
      .from('employees')
      .select('qualified_roles')
      .eq('id', pending.entity_id)
      .eq('company_id', companyId)
      .maybeSingle();
    const qualified = (current as { qualified_roles: string[] } | null)?.qualified_roles ?? [];
    if (!qualified.includes(newValue)) {
      patch['qualified_roles'] = [newValue, ...qualified];
    }
  }

  const { error: updErr } = await supabase
    .from(pending.table)
    .update(patch)
    .eq('id', pending.entity_id)
    .eq('company_id', companyId);
  // Previously unchecked: a rejected write (type error, constraint) still fell
  // through to the "Done — updated" reply. No orphan outputs.
  if (updErr) throw new Error(`Update to ${pending.table}.${pending.field} failed: ${updErr.message}`);

  // Sync wage rate to payroll provider when individual_wage is updated on an employee
  if (pending.table === 'employees' && pending.field === 'individual_wage' && typeof newValue === 'number') {
    void handleWageRateSync({
      companyId,
      employeeId: pending.entity_id,
      employeeName: pending.entity_name,
      newRate: newValue,
      changedBy: pending.manager_id,
    });
  }

  // For schedule assignment edits: recompute wages
  if (pending.table === 'schedules' && pending.schedule_id) {
    const { data: schedRow } = await supabase.from('schedules').select('data, staffing_report')
      .eq('id', pending.schedule_id).is('deleted_at', null).single();
    if (schedRow) {
      const row = schedRow as { data: { assignments?: unknown[] }; staffing_report: Record<string, unknown> | null };
      const assignments = (row.data.assignments ?? []) as Array<{
        employee_id: string; employee_name: string; role: string; start_time: string; end_time: string; hours?: number;
      }>;
      const wages = await computeWageEstimate(companyId, assignments);
      await supabase.from('schedules').update({
        staffing_report: { ...(row.staffing_report ?? {}), estimated_wages: wages },
      }).eq('id', pending.schedule_id);
    }
  }
}

// ── #12 — Employee "what are my shifts?" ──────────────────────────────────────
// An employee asks about their OWN upcoming shifts (distinct from operational_query,
// which is the manager's workforce question). Warm, plain reply; EMPLOYEE-facing,
// so never a "View in Homebase" CTA.

export interface MyShift {
  date: string;
  role: string;
  shift_name: string;
  start_time: string;
  end_time: string;
  hours: number;
}
type ShiftScope = { kind: 'upcoming' } | { kind: 'date'; date: string } | { kind: 'week'; label: string; start: string; end: string };

function fmtShiftDate(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
function fmtShiftTime(t: string): string {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  const am = h < 12;
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`;
}

// Pure: turn an employee's shift list into a warm reply. Tested directly.
export function formatMyShiftsReply(employeeName: string, shifts: MyShift[], scope: ShiftScope): string {
  const hi = textOpener(employeeName);
  if (shifts.length === 0) {
    if (scope.kind === 'date')
      return `${hi}you're not scheduled on ${fmtShiftDate(scope.date)} — looks like you've got that day off. If you were expecting a shift, reply here or check with your manager and we'll sort it out.`;
    if (scope.kind === 'week')
      return `${hi}you're not on the schedule ${scope.label} — looks like you've got ${scope.label} off. If that seems off, reply here or check with your manager and we'll take a look.`;
    return `${hi}you don't have any upcoming shifts on the schedule right now. If that seems off, reply here or check with your manager and we'll take a look.`;
  }
  const totalHours = Math.round(shifts.reduce((s, a) => s + a.hours, 0) * 10) / 10;
  const lead = scope.kind === 'date'
    ? `Here's what you're on for ${fmtShiftDate(scope.date)}:`
    : scope.kind === 'week'
      ? `You're on for ${shifts.length} shift${shifts.length === 1 ? '' : 's'} ${scope.label} — ${totalHours}h in total:`
      : `You're on for ${shifts.length} shift${shifts.length === 1 ? '' : 's'} coming up — ${totalHours}h in total:`;
  const lines = shifts
    .map(s => `• ${fmtShiftDate(s.date)} — ${s.role} (${s.shift_name}), ${fmtShiftTime(s.start_time)}–${fmtShiftTime(s.end_time)}, ${s.hours}h`)
    .join('\n');
  const tail = scope.kind === 'date' ? '' : `\n\nThat's ${totalHours}h in all.`;
  return `${hi}${lead}\n\n${lines}${tail}\n\nIf anything looks off, just reply here or reach out to your manager.`;
}

// Sunday-anchored week window for "this week" / "next week", from the tenant's
// local today (schedule weeks run Sun–Sat). Returns null when no relative week is
// named, so a plain "my shifts" keeps the 'upcoming' behavior.
function addDaysISO(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function detectWeekScope(body: string, todayLocal: string): { label: string; start: string; end: string } | null {
  const t = (body || '').toLowerCase();
  const dow = new Date(todayLocal + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  const thisStart = addDaysISO(todayLocal, -dow);
  if (/\bthis (?:coming )?week\b/.test(t)) {
    return { label: 'this week', start: thisStart, end: addDaysISO(thisStart, 6) };
  }
  if (/\bnext week\b/.test(t)) {
    const nextStart = addDaysISO(thisStart, 7);
    return { label: 'next week', start: nextStart, end: addDaysISO(nextStart, 6) };
  }
  return null;
}

// Resolve the shift-query window. An EXPLICIT week phrase wins over a stray
// extracted date (Batch-1.5 #3): a vague follow-up like "what about next week?"
// classifies with medium confidence and the model sometimes emits a spurious
// single date (next week's Monday). If the body literally says "next week" /
// "this week", honor the full Sun–Sat window rather than narrowing to that one
// day. Only a specific date with NO week phrase resolves to a single day.
export function resolveShiftScope(body: string, rawDate: string | null, todayLocal: string): ShiftScope {
  const week = detectWeekScope(body, todayLocal);
  if (week) return { kind: 'week', label: week.label, start: week.start, end: week.end };
  if (rawDate) return { kind: 'date', date: rawDate };
  return { kind: 'upcoming' };
}

export async function handleMyShiftsQuery(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>,
): Promise<void> {
  if (!contact.employee_id) {
    await reply(contact, message, "I couldn't find your employee record, so I can't pull your shifts. Please contact your manager directly.");
    return;
  }

  // Tenant-local today (never server UTC) so relative week windows land on the
  // correct calendar days.
  const { data: companyRow } = await supabase
    .from('companies').select('timezone').eq('id', contact.company_id).single();
  const tz = (companyRow as { timezone: string | null } | null)?.timezone ?? 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  const rawDate = typeof extracted.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)
    ? extracted.date
    : null;
  const scope = resolveShiftScope(message.body, rawDate, today);

  // Published, non-deleted schedules that could hold the relevant shifts.
  const lowerBound = scope.kind === 'week' ? scope.start : (rawDate ?? today);
  let schedQuery = supabase
    .from('schedules')
    .select('data, week_start, week_end')
    .eq('company_id', contact.company_id)
    .eq('status', 'published')
    .is('deleted_at', null)
    .gte('week_end', lowerBound)
    .order('week_start', { ascending: true })
    .limit(8);
  if (scope.kind === 'week') schedQuery = schedQuery.lte('week_start', scope.end);
  const { data: schedRows } = await schedQuery;

  const schedules = (schedRows ?? []) as Array<{ data: { assignments?: Array<Record<string, unknown>> } | null }>;

  const seen = new Set<string>();
  const mine: MyShift[] = [];
  for (const s of schedules) {
    for (const raw of (s.data?.assignments ?? [])) {
      const a = raw as { employee_id?: string; date?: string; role?: string; shift_name?: string; start_time?: string; end_time?: string; hours?: number };
      if (a.employee_id !== contact.employee_id || !a.date) continue;
      if (scope.kind === 'date') { if (a.date !== rawDate) continue; }
      else if (scope.kind === 'week') { if (a.date < scope.start || a.date > scope.end) continue; }
      else if (a.date < today) continue;
      const key = `${a.date}|${a.shift_name ?? ''}|${a.start_time ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mine.push({
        date: a.date,
        role: a.role ?? '',
        shift_name: a.shift_name ?? '',
        start_time: a.start_time ?? '',
        end_time: a.end_time ?? '',
        hours: typeof a.hours === 'number' ? a.hours : 0,
      });
    }
  }
  mine.sort((x, y) => x.date.localeCompare(y.date) || x.start_time.localeCompare(y.start_time));

  await reply(contact, message, formatMyShiftsReply(contact.name, mine, scope));

  await logActivity({
    company_id: contact.company_id,
    action: 'employee_shift_query',
    summary: `${contact.name} asked about their shifts (${scope.kind === 'date' ? scope.date : scope.kind === 'week' ? scope.label : 'upcoming'}) — ${mine.length} found`,
    metadata: { employee_id: contact.employee_id, scope: scope.kind, date: rawDate, count: mine.length },
  });
}
