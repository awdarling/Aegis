import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { generateReply } from '../ai/claude';
import { coerceJsonObject } from '../utils/coerce-json';
import { computeWageEstimate } from '../lib/schedule-simulator';
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
  raw_request?: string; // original request text, so a conversational correction can fold into it
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

  // Step 3: Ask Claude to answer with the data
  const dataContext = Object.entries(fetchedData)
    .filter(([, rows]) => rows.length > 0)
    .map(([table, rows]) => `${table} (${rows.length} records):\n${JSON.stringify(rows, null, 0).slice(0, 4000)}`)
    .join('\n\n');

  const answerSystem =
    contact.role === 'employee'
      ? `${personality}\n\nToday is ${today}. ` +
        `You are answering a question from ${contact.name}, an employee. ` +
        `Only answer questions about their own schedule, their own time off, their own availability, and their own shifts. ` +
        `You CAN answer things like: when their next shift is, what they're scheduled this week, how many hours they have, and who they're working alongside on a given day. ` +
        `For "who am I working with" you may share coworkers' names and roles on a shift this employee is ALSO on — but never reveal anyone's wages, availability, hours totals, or personal details. ` +
        `Answer using the Homebase data below. Be direct and specific. If the data doesn't contain what's needed, say so clearly.`
      : `${personality}\n\nToday is ${today}. ` +
        `You can answer staffing questions like who's free/available on a given day, where coverage is short (gaps), and who's near their max weekly hours / approaching overtime. ` +
        `Answer using the Homebase data below. Be direct and specific. If the data doesn't contain what's needed, say so clearly.`;

  const answer = await generateReply(answerSystem, `Question: ${message.body}\n\nData:\n${dataContext || 'No relevant data found.'}`, []);

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
  const built = await buildExperienceRulePending(message, contact, message.body);
  if (!built) return;
  await storePendingEdit(built.pending);
  await reply(contact, message, built.confirmMsg);
}

// Parses a request into a pending experience-rule edit + a warm confirmation,
// or returns null after sending the manager a friendly clarification. Shared by
// the first request and the conversational correction path, so "from this time
// to this time" style tweaks re-read against the original request.
async function buildExperienceRulePending(
  message: InboundMessage,
  contact: VerifiedContact,
  requestText: string
): Promise<{ pending: PendingEdit; confirmMsg: string } | null> {
  const firstName = (contact.name || '').trim().split(/\s+/)[0] || 'there';
  const today = new Date().toISOString().slice(0, 10);
  const parseSystem =
    `You are parsing a manager's request to set a VETERAN/EXPERIENCE staffing requirement on a shift. Today is ${today}. ` +
    `If the text includes an earlier request plus a later clarification, MERGE them — the clarification overrides. ` +
    `Return ONLY JSON: {"mode":"all_veterans"|"min_veterans","min_count":number|null,"shift_name":string|null,"days_of_week":number[]|null,"role":string|null,"season_start":"YYYY-MM-DD"|null,"season_end":"YYYY-MM-DD"|null}. ` +
    `mode "all_veterans" = every position on that shift must be a veteran; "min_veterans" = at least min_count veterans (min_count required, >= 1). ` +
    `shift_name = the shift they named, in their words (e.g. "PM Lifeguard", "Saturday night", "closing shift"); null if not specified. ` +
    `days_of_week (0=Sun..6=Sat) when they limit to certain days ("Saturday nights" -> [6], "weekends" -> [0,6]); null = all days. ` +
    `role = a single role if scoped ("lifeguards" -> "Lifeguard"); null = all roles. ` +
    `season_start/season_end = the window if mentioned ("this summer" -> roughly 06-01..08-31 of the current year, "until Sept 1" -> end only, "on June 20"/"June 20th" -> both = that date); null = open-ended.`;
  const parseText = await generateReply(parseSystem, requestText, []);
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
    await reply(contact, message, `Hmm, I didn't quite catch that one, ${firstName}. Tell me the shift and what you need — something like "Saturday night lifeguards should be all veterans this summer" or "at least 2 veterans on the morning shift" — and I'll set it up.`);
    return null;
  }
  if (r.mode === 'min_veterans' && (typeof r.min_count !== 'number' || r.min_count < 1)) {
    await reply(contact, message, `How many veterans should that shift need at a minimum, ${firstName}? For example, "at least 2 veterans on the PM shift."`);
    return null;
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
      await reply(contact, message, `Which shift did you have in mind, ${firstName}? I've got: ${names || '(no shifts set up yet)'}. Just name one and I'll take care of it.`);
      return null;
    }
  }

  const days = Array.isArray(r.days_of_week)
    ? r.days_of_week.filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
    : null;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const seasonStart = typeof r.season_start === 'string' && DATE_RE.test(r.season_start) ? r.season_start : null;
  const seasonEnd = typeof r.season_end === 'string' && DATE_RE.test(r.season_end) ? r.season_end : null;

  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fmt = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const need = r.mode === 'all_veterans' ? 'all veterans' : `at least ${r.min_count} veteran${r.min_count === 1 ? '' : 's'}`;
  const dayLabel = days && days.length ? ` on ${days.map(d => DAY[d]).join(' and ')}` : '';
  const roleLabel = r.role ? ` ${r.role.toLowerCase()} positions` : '';
  const seasonLabel =
    seasonStart && seasonEnd && seasonStart === seasonEnd
      ? ` just for ${fmt(seasonStart)}`
      : seasonStart || seasonEnd
        ? ` from ${seasonStart ? fmt(seasonStart) : 'now'}${seasonEnd ? ` through ${fmt(seasonEnd)}` : ' on'}`
        : '';
  const confirmMsg =
    `Hey ${firstName} — happy to get that sorted. Just so I've got it right: you want the ${shiftLabel}${dayLabel} staffed with ${need}${roleLabel}${seasonLabel}. ` +
    `Sound right? Say the word and I'll write it in across your systems — or just tell me what to tweak.`;

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table: 'shift_experience_rules',
    action: 'create',
    entity_type: 'experience_rule',
    entity_name: shiftLabel,
    entity_id: null,
    raw_request: requestText,
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
  return { pending, confirmMsg };
}

// Conversational confirm for an experience rule. "Yes" writes it; a plain "no"
// warmly sets it aside and invites a change; anything else is treated as a
// correction — folded into the original request and re-confirmed, so it's a
// real back-and-forth, not a dead-ended yes/no gate.
async function handleExperienceRuleConfirm(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingEdit
): Promise<void> {
  const firstName = (contact.name || '').trim().split(/\s+/)[0] || 'there';
  const trimmed = message.body.trim();
  const pureYes = /^(yes|yep|yeah|yup|confirm|confirmed|correct|do it|go ahead|sounds? good|perfect|looks good|that'?s? right|great|👍)\b[\s.!]*$/i.test(trimmed);
  const pureCancel = /^(no|nope|cancel|stop|never ?mind|nevermind|forget it|nah|scrap that|drop it)\b[\s.!]*$/i.test(trimmed);

  if (pureYes) {
    await clearPendingEdit(contact.company_id, contact.matched_identifier);
    try {
      await executeEdit(pending, contact.company_id);
      await logActivity({
        company_id: contact.company_id,
        action: 'homebase_edit_create',
        entity_type: 'experience_rule',
        summary: `Manager set a veteran staffing rule for the ${pending.entity_name} shift`,
        metadata: { table: pending.table, create_fields: pending.create_fields },
      });
      await reply(contact, message, `All set, ${firstName} — I've written that ${pending.entity_name} rule in across your systems, and I'll hold every schedule to it from here on.`);
    } catch (err) {
      console.error('[experience-rule] execute failed:', err);
      await reply(contact, message, `Ah, something tripped up saving that one, ${firstName}. Mind setting it in Homebase, or give me another minute and try again?`);
    }
    return;
  }

  if (pureCancel) {
    await clearPendingEdit(contact.company_id, contact.matched_identifier);
    await reply(contact, message, `No worries, ${firstName} — set that one aside. Want to adjust it instead? Just tell me what's different and I'll redo it.`);
    return;
  }

  // Treat anything else as a correction: fold it into the original request and re-confirm.
  const original = pending.raw_request ?? `a veteran staffing rule for the ${pending.entity_name} shift`;
  const combined = `Original request: ${original}\n\nThe manager then clarified: "${message.body}"`;
  const built = await buildExperienceRulePending(message, contact, combined);
  if (!built) return; // a friendly clarification reply was already sent
  await storePendingEdit(built.pending);
  await reply(contact, message, `Got it — ${built.confirmMsg}`);
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

  // Build confirmation message
  const confirmMsg = buildUpdateConfirmation(parsed, currentValue, personality);

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
  // Experience rules get a conversational confirm (yes / set-aside / correction)
  // and a warm voice, instead of the rigid yes-no gate below.
  if (pending.table === 'shift_experience_rules') {
    await handleExperienceRuleConfirm(message, contact, pending);
    return;
  }

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
    await reply(contact, message, `Something went wrong executing that change. Please make the edit directly in Homebase and try again.`);
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
    const fields: Record<string, unknown> = { ...(pending.create_fields ?? {}), company_id: companyId };
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
    await supabase.from(pending.table).insert(fields);
    return;
  }

  if (pending.action === 'delete') {
    if (!pending.entity_id) throw new Error('No entity_id for delete');
    await supabase.from(pending.table).delete().eq('id', pending.entity_id).eq('company_id', companyId);
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

  await supabase.from(pending.table).update({ [pending.field]: newValue }).eq('id', pending.entity_id).eq('company_id', companyId);

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
