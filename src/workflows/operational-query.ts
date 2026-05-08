import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { generateReply } from '../ai/claude';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { handleWageRateSync } from './payroll';
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

// ── Personality prompt ────────────────────────────────────────────────────────

async function getAegisPersonality(companyId: string): Promise<string> {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).single();
  const name = (data as { name: string } | null)?.name ?? 'your company';
  return (
    `You are Aegis, an AI assistant manager for ${name}. ` +
    `You know this operation and its staff. You communicate like a capable, professional assistant manager — ` +
    `direct, confident, and operationally sharp. Not chatty. Not robotic. First person. ` +
    `You answer questions with the data you have in front of you. ` +
    `You make recommendations when they're useful. ` +
    `You say what you don't know rather than guessing. ` +
    `You never pad responses with unnecessary preamble. ` +
    `You treat the manager as a competent professional.`
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
- shift_requirements: shift_name, role, required_count, days_active
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
  try {
    plan = JSON.parse(fetchPlanText) as FetchPlan;
  } catch {
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

  const answerSystem = `${personality}\n\nToday is ${today}. Answer using the Homebase data below. Be direct and specific. If the data doesn't contain what's needed, say so clearly.`;

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
    `Return ONLY valid JSON: {"entity_type":"employee|event|policy|wage_rate|shift_type|shift_requirement|schedule","entity_name":"...","action":"update|create|delete","field":"column_name_or_null","new_value":"...or null","create_fields":{} }. ` +
    `For schedule edits (move/add/remove employee from shift), entity_type="schedule" and use create_fields to describe the change: {"change":"move|add|remove","employee_name":"...","shift_name":"...","date":"YYYY-MM-DD"}.`;

  const parseText = await generateReply(parseSystem, message.body, []);

  let parsed: ParsedEdit;
  try {
    parsed = JSON.parse(parseText) as ParsedEdit;
  } catch {
    await reply(contact, message,
      "I couldn't parse that edit request. Could you be more specific? For example: \"Update Jordan's max hours to 32\" or \"Mark Marcus as inactive\"."
    );
    return;
  }

  const table = ENTITY_TABLE[parsed.entity_type];
  if (!table) {
    await reply(contact, message, `I don't know how to edit ${parsed.entity_type} records. Try specifying: employee, event, policy, wage_rate, shift_type, or shift_requirement.`);
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

  // Find the record by name
  const { data: records } = await supabase
    .from(table)
    .select('*')
    .eq('company_id', contact.company_id)
    .ilike('name', `%${parsed.entity_name}%`)
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
  const { data: records } = await supabase
    .from(table)
    .select('id, name')
    .eq('company_id', contact.company_id)
    .ilike('name', `%${parsed.entity_name}%`)
    .limit(3);

  const rows = (records ?? []) as { id: string; name: string }[];
  if (rows.length === 0) {
    await reply(contact, message, `I couldn't find a ${parsed.entity_type} named "${parsed.entity_name}" to delete.`);
    return;
  }

  const record = rows[0];
  const confirmMsg = `Delete ${parsed.entity_type} "${record.name}"? This cannot be undone. (yes/no)`;

  const pending: PendingEdit = {
    company_id: contact.company_id,
    manager_id: contact.matched_identifier,
    table,
    action: 'delete',
    entity_type: parsed.entity_type,
    entity_name: record.name,
    entity_id: record.id,
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
      summary: `Manager edited ${pending.entity_type} "${pending.entity_name}": ${pending.action === 'update' ? `${pending.field} → ${JSON.stringify(pending.new_value)}` : pending.action}`,
      metadata: {
        table: pending.table, field: pending.field,
        old_value: pending.current_value, new_value: pending.new_value,
        create_fields: pending.create_fields,
      },
    });

    const isStructural = ['policies', 'wage_rates', 'shift_types', 'shift_requirements'].includes(pending.table);
    const doneMsg = pending.action === 'create'
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
    // For events created by Aegis
    if (pending.table === 'events') {
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
      .eq('id', pending.schedule_id).single();
    if (schedRow) {
      const row = schedRow as { data: { shifts?: unknown[] }; staffing_report: Record<string, unknown> | null };
      const shifts = (row.data.shifts ?? []) as Array<{
        employee_id: string; employee_name: string; role: string; start_time: string; end_time: string; hours?: number;
      }>;
      const wages = await computeWageEstimate(companyId, shifts);
      await supabase.from('schedules').update({
        staffing_report: { ...(row.staffing_report ?? {}), estimated_wages: wages },
      }).eq('id', pending.schedule_id);
    }
  }
}
