import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { greeting } from '../messaging/greeting';
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

async function executeFetchPlan(
  plan: FetchPlan,
  companyId: string,
  today: string
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
    const byRole = new Map<string, Set<string>>();
    for (const a of dayAssigns) {
      const set = byRole.get(a.role) ?? new Set<string>();
      set.add(a.employee_name);
      byRole.set(a.role, set);
    }
    const roleParts = [...byRole.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([role, names]) => `${role || 'Staff'} (${names.size}): ${[...names].sort().join(', ')}`);
    lines.push(`${prettyDate(date)}: ${distinct.size} on duty — ${roleParts.join('; ')}`);
  }
  return lines.join('\n');
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
export function buildDataContext(fetchedData: Record<string, unknown[]>): string {
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
      const shown = rows.slice(0, MAX_ROWS).map(r => JSON.stringify(r)).join('\n');
      const more = rows.length > MAX_ROWS ? `\n…and ${rows.length - MAX_ROWS} more` : '';
      blocks.push(`${table} (${rows.length}):\n${shown}${more}`);
    }
  }
  return blocks.join('\n\n');
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
- time_off_requests: employee_id, start_date, end_date, reason, status (pending/approved/denied), requested_at
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

  // Step 2: Execute the fetch plan
  const fetchedData = await executeFetchPlan(plan, contact.company_id, today);

  // Step 3: Ask Claude to answer with the data. The context is pre-summarized
  // into clean facts (esp. schedules → per-date headcount + names) so the model
  // never has to parse — or hedge about — a truncated raw JSON blob.
  const dataContext = buildDataContext(fetchedData);

  // Never let the answer expose the plumbing. Headcount/coverage questions were
  // leaking internals ("the data is truncated", "the complete payload", "pull the
  // June 17 slice from Homebase") — Aegis should sound like a manager, not a
  // database. If a fact genuinely isn't here, say so plainly and offer to pull it.
  const noLeakGuard =
    ` Answer plainly, in your own voice, and NEVER mention how you got the information — ` +
    `no talk of data, payloads, records, JSON, schedules being "loaded"/"truncated"/"provided", or "pulling from Homebase". ` +
    `If you genuinely don't have what's needed, say so in one short, natural sentence and offer to pull it up (e.g. "I don't have that week's schedule in front of me — want me to pull it up?") — never explain the internals or apologize for the system.`;

  const answerSystem =
    contact.role === 'employee'
      ? `${personality}\n\nToday is ${today}. ` +
        `You are answering a question from ${contact.name}, an employee. ` +
        `Only answer questions about their own schedule, their own time off, their own availability, and their own shifts. ` +
        `You CAN answer things like: when their next shift is, what they're scheduled this week, how many hours they have, and who they're working alongside on a given day. ` +
        `For "who am I working with" you may share coworkers' names and roles on a shift this employee is ALSO on — but never reveal anyone's wages, availability, hours totals, or personal details. ` +
        `Be direct and specific.${noLeakGuard}`
      : `${personality}\n\nToday is ${today}. ` +
        `You can answer staffing questions like how many people were on a given day, who was working (and in what role), who's free/available, where coverage is short, and who's near their max weekly hours. ` +
        `The staffing summary below already gives you exact per-day headcounts and who was on by role — treat those counts as authoritative and answer with them directly. ` +
        `Be direct and specific.${noLeakGuard}`;

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
    `Return ONLY valid JSON: {"entity_type":"employee|event|policy|wage_rate|shift_type|shift_requirement|availability|schedule|experience_rule","entity_name":"...","action":"update|create|delete","field":"column_name_or_null","new_value":"...or null","create_fields":{} }. ` +
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
  const confirmMsg = `Set a staffing rule: the ${shiftLabel} shift${dayLabel}${roleLabel} needs ${need}${seasonLabel}. The schedule will staff it that way from now on. Confirm? (yes/no)`;

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
  const confirmMsg = `Update ${emp.name}'s availability to:\n${proposedDisplay}\n\nConfirm? (yes/no)`;

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
      `${policyKey.replace(/_/g, ' ')} is currently ${currentStr}. Change it to ${coerced.display}? (yes/no)`;
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
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const confirmMsg = `Create new ${parsed.entity_type}:\n${preview}\n\nConfirm? (yes/no)`;

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
  const confirmMsg = `Delete ${parsed.entity_type} "${displayName}"? This cannot be undone. (yes/no)`;

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

function buildUpdateConfirmation(parsed: ParsedEdit, currentValue: unknown, _personality: string): string {
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
  return `${parsed.entity_name}'s ${fieldLabel} is currently ${currentStr}. Change to ${newStr}? (yes/no)`;
}

// ── Edit confirmation handler ─────────────────────────────────────────────────

export async function handleEditConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingEdit & { _memory_id?: string }
): Promise<void> {
  const body = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|yep|confirm|correct|ok|okay|do it|go ahead|sure)/.test(body);
  const isNo = /^(no|nope|cancel|stop|don'?t|wait|never mind|nevermind)/.test(body);

  if (!isYes && !isNo) {
    await reply(contact, message,
      `I'm waiting for your confirmation. Reply "yes" to proceed with the ${pending.action} or "no" to cancel.`
    );
    return;
  }

  await clearPendingEdit(contact.company_id, contact.matched_identifier);

  if (isNo) {
    await reply(contact, message, 'Cancelled — no changes made.');
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

    const isStructural = ['policies', 'wage_rates', 'shift_types', 'shift_requirements', 'shift_experience_rules'].includes(pending.table);
    const doneMsg = pending.table === 'availability'
      ? `Done — ${pending.entity_name}'s availability updated.`
      : pending.table === 'shift_experience_rules'
        ? `Done — the staffing rule for the ${pending.entity_name} shift is set. I'll enforce it on every build going forward.`
      : pending.action === 'create'
        ? `Done — ${pending.entity_type} "${pending.entity_name}" created.`
        : pending.action === 'delete'
          ? `Done — ${pending.entity_type} "${pending.entity_name}" deleted.`
          : `Done — ${pending.entity_name}'s ${(pending.field ?? '').replace(/_/g, ' ')} updated to ${JSON.stringify(pending.new_value)}.`;

    const footerMsg = isStructural
      ? ' This affects how Aegis builds schedules — worth verifying in Homebase.'
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

  const { error: updErr } = await supabase
    .from(pending.table)
    .update({ [pending.field]: newValue })
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
type ShiftScope = { kind: 'upcoming' } | { kind: 'date'; date: string };

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
  const hi = greeting(employeeName);
  if (shifts.length === 0) {
    return scope.kind === 'date'
      ? `${hi}\n\nYou're not scheduled on ${fmtShiftDate(scope.date)} — looks like you've got that day off. If you were expecting a shift, reply here or check with your manager and we'll sort it out.`
      : `${hi}\n\nYou don't have any upcoming shifts on the schedule right now. If that seems off, reply here or check with your manager and we'll take a look.`;
  }
  const totalHours = Math.round(shifts.reduce((s, a) => s + a.hours, 0) * 10) / 10;
  const lead = scope.kind === 'date'
    ? `Here's what you're on for ${fmtShiftDate(scope.date)}:`
    : `You're on for ${shifts.length} shift${shifts.length === 1 ? '' : 's'} coming up — ${totalHours}h in total:`;
  const lines = shifts
    .map(s => `• ${fmtShiftDate(s.date)} — ${s.role} (${s.shift_name}), ${fmtShiftTime(s.start_time)}–${fmtShiftTime(s.end_time)}, ${s.hours}h`)
    .join('\n');
  const tail = scope.kind === 'date' ? '' : `\n\nThat's ${totalHours}h in all.`;
  return `${hi}\n\n${lead}\n\n${lines}${tail}\n\nIf anything looks off, just reply here or reach out to your manager.`;
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

  const today = new Date().toISOString().slice(0, 10);
  const rawDate = typeof extracted.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)
    ? extracted.date
    : null;
  const scope: ShiftScope = rawDate ? { kind: 'date', date: rawDate } : { kind: 'upcoming' };

  // Published, non-deleted schedules that could hold the relevant shifts.
  const { data: schedRows } = await supabase
    .from('schedules')
    .select('data, week_start, week_end')
    .eq('company_id', contact.company_id)
    .eq('status', 'published')
    .is('deleted_at', null)
    .gte('week_end', rawDate ?? today)
    .order('week_start', { ascending: true })
    .limit(8);

  const schedules = (schedRows ?? []) as Array<{ data: { assignments?: Array<Record<string, unknown>> } | null }>;

  const seen = new Set<string>();
  const mine: MyShift[] = [];
  for (const s of schedules) {
    for (const raw of (s.data?.assignments ?? [])) {
      const a = raw as { employee_id?: string; date?: string; role?: string; shift_name?: string; start_time?: string; end_time?: string; hours?: number };
      if (a.employee_id !== contact.employee_id || !a.date) continue;
      if (rawDate ? a.date !== rawDate : a.date < today) continue;
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
    summary: `${contact.name} asked about their shifts (${scope.kind === 'date' ? scope.date : 'upcoming'}) — ${mine.length} found`,
    metadata: { employee_id: contact.employee_id, scope: scope.kind, date: rawDate, count: mine.length },
  });
}
