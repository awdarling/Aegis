import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { sendSms } from '../messaging/sms';
import { reply } from '../messaging/reply';
import { env } from '../config/env';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee } from '../db/types';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AvailabilitySlot {
  day_of_week: number; // 0=Sun, 6=Sat
  start_time: string;  // HH:MM 24h
  end_time: string;    // HH:MM 24h
}

export interface OnboardingSession {
  company_id: string;
  employee_id: string;
  employee_name: string;
  employee_phone: string;
  aegis_sms_channel: string;
  manager_contact: string;
  manager_channel: 'sms' | 'email';
  manager_sender: string;
  manager_recipient: string;
  step: 'name_confirm' | 'email' | 'role' | 'availability' | 'availability_confirm' | 'time_off' | 'complete';
  collected: {
    name_confirmed: boolean;
    email: string | null;
    role: string | null;
    availability_raw: string | null;
    availability_parsed: AvailabilitySlot[];
    availability_confirmed: boolean;
    time_off_submitted: boolean;
  };
  flagged_low_availability: boolean;
  invalid_email_attempts: number;
  invalid_availability_attempts: number;
  warned_24h: boolean;
  started_at: string;
  expires_at: string;
}

interface ShiftBounds {
  earliest_start: string;
  latest_end: string;
  min_shift_hours: number;
}

interface PendingAvailUpdate {
  employee_id: string;
  employee_name: string;
  company_id: string;
  current_availability: AvailabilitySlot[];
  proposed_availability: AvailabilitySlot[];
  availability_raw: string;
  employee_sender: string;
  employee_recipient: string;
  expires_at: string;
}

interface PendingManagerAvailApproval {
  employee_id: string;
  employee_name: string;
  company_id: string;
  current_availability: AvailabilitySlot[];
  proposed_availability: AvailabilitySlot[];
  availability_raw: string;
  employee_sender: string;
  employee_recipient: string;
  expires_at: string;
}

export interface OnboardingFanoutPending {
  company_id: string;
  manager_contact: string;
  manager_channel: 'sms' | 'email';
  manager_sender: string;
  manager_recipient: string;
  aegis_sms_channel: string;
  target_employee_ids: string[];
  expires_at: string;
}

// Test employee setup: add Bubba Ganush to Watermark's company via Supabase SQL,
// not via this file. Required fields:
//   name='Bubba Ganush', contact_phone='+16163280114',
//   company_id=<Watermark's id>, primary_role=null, contact_email=null,
//   active=true. Leaving primary_role and contact_email null ensures the
//   onboarding flow collects them.

// ── Session keys ──────────────────────────────────────────────────────────────

function sessionSource(employeeId: string): string {
  return `onboarding:${employeeId}`;
}

function availConfirmSource(employeeId: string): string {
  return `avail_pending_confirm:${employeeId}`;
}

function availApprovalSource(companyId: string, employeeId: string): string {
  return `avail_pending_mgr:${companyId}:${employeeId}`;
}

function fanoutSource(companyId: string, managerIdentifier: string): string {
  return `onboarding_fanout:${companyId}:${managerIdentifier}`;
}

// ── Session management ────────────────────────────────────────────────────────

export async function getOnboardingSession(
  companyId: string,
  employeeId: string
): Promise<(OnboardingSession & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', sessionSource(employeeId))
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const session = JSON.parse(row.content) as OnboardingSession;

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      await logActivity({
        company_id: companyId,
        action: 'onboarding_timeout',
        entity_type: 'employee',
        entity_id: employeeId,
        summary: `Onboarding session expired for ${session.employee_name}`,
        metadata: {
          step_reached: session.step,
          started_at: session.started_at,
        },
      });
      await notifyManagerSmsDirect(
        session.manager_sender,
        session.manager_recipient,
        session.company_id,
        `${session.employee_name}'s onboarding window (48h) expired without completion. Their session has been cleared.`
      );
      return null;
    }

    return { ...session, _memory_id: row.id };
  } catch {
    return null;
  }
}

// Phone-keyed lookup. Used by the router to find an active onboarding session
// for an inbound SMS whose sender is the employee being onboarded — regardless
// of how identity verification resolved the sender (e.g., a Quria admin whose
// personal phone is also the phone of a test employee being onboarded).
export async function getOnboardingSessionByPhone(
  phone: string
): Promise<(OnboardingSession & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .like('source', 'onboarding:%');

  const rows = (data ?? []) as { id: string; content: string }[];

  for (const row of rows) {
    let session: OnboardingSession;
    try {
      session = JSON.parse(row.content) as OnboardingSession;
    } catch {
      continue;
    }

    if (session.employee_phone !== phone) continue;

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_timeout',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `Onboarding session expired for ${session.employee_name}`,
        metadata: {
          step_reached: session.step,
          started_at: session.started_at,
        },
      });
      await notifyManagerSmsDirect(
        session.manager_sender,
        session.manager_recipient,
        session.company_id,
        `${session.employee_name}'s onboarding window (48h) expired without completion. Their session has been cleared.`
      );
      return null;
    }

    return { ...session, _memory_id: row.id };
  }

  return null;
}

async function saveOnboardingSession(
  session: OnboardingSession & { _memory_id?: string }
): Promise<void> {
  const { _memory_id, ...data } = session;
  const content = JSON.stringify(data);

  if (_memory_id) {
    await supabase.from('aegis_memory').update({ content }).eq('id', _memory_id);
  } else {
    await supabase
      .from('aegis_memory')
      .delete()
      .eq('company_id', session.company_id)
      .eq('source', sessionSource(session.employee_id));
    await supabase.from('aegis_memory').insert({
      company_id: session.company_id,
      memory_type: 'observation',
      source: sessionSource(session.employee_id),
      content,
    });
  }
}

async function clearOnboardingSession(companyId: string, employeeId: string): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', companyId)
    .eq('source', sessionSource(employeeId));
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadShiftBounds(companyId: string): Promise<ShiftBounds> {
  const { data } = await supabase
    .from('shift_types')
    .select('start_time, end_time')
    .eq('company_id', companyId)
    .eq('active', true);

  const shifts = (data ?? []) as { start_time: string; end_time: string }[];

  if (shifts.length === 0) {
    return { earliest_start: '06:00', latest_end: '23:00', min_shift_hours: 4 };
  }

  const starts = shifts.map(s => s.start_time).sort();
  const ends = shifts.map(s => s.end_time).sort();

  const durations = shifts.map(s => {
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    return (eh * 60 + em - (sh * 60 + sm)) / 60;
  });

  return {
    earliest_start: starts[0],
    latest_end: ends[ends.length - 1],
    min_shift_hours: Math.max(Math.min(...durations), 1),
  };
}

// Roles are stored as strings across shift_requirements and wage_rates.
// No dedicated roles table exists, so we derive the canonical list from
// shift_requirements (operationally meaningful) with a fallback to wage_rates.
async function loadRoles(companyId: string): Promise<string[]> {
  const { data: srData } = await supabase
    .from('shift_requirements')
    .select('role')
    .eq('company_id', companyId);

  const srRoles = [
    ...new Set(((srData ?? []) as { role: string }[]).map(r => r.role).filter(Boolean)),
  ].sort();

  if (srRoles.length > 0) return srRoles;

  const { data: wrData } = await supabase
    .from('wage_rates')
    .select('role')
    .eq('company_id', companyId);

  return [
    ...new Set(((wrData ?? []) as { role: string }[]).map(r => r.role).filter(Boolean)),
  ].sort();
}

async function loadCompanyName(companyId: string): Promise<string> {
  const { data } = await supabase
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .single();
  return (data as { name: string } | null)?.name ?? 'your company';
}

async function getIncompleteEmployees(companyId: string): Promise<Employee[]> {
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true);

  const employees = (empData ?? []) as Employee[];

  const { data: availData } = await supabase
    .from('availability')
    .select('employee_id')
    .eq('company_id', companyId);

  const withAvail = new Set(
    ((availData ?? []) as { employee_id: string }[]).map(r => r.employee_id)
  );

  return employees.filter(
    e =>
      !e.contact_phone ||
      !e.contact_email ||
      !e.primary_role ||
      !withAvail.has(e.id)
  );
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatTime12h(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 || 12;
  return m === 0 ? `${hour}${period}` : `${hour}:${m.toString().padStart(2, '0')}${period}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatAvailabilityList(slots: AvailabilitySlot[]): string {
  const byDay = new Map<number, AvailabilitySlot[]>();
  for (const slot of slots) {
    const existing = byDay.get(slot.day_of_week) ?? [];
    existing.push(slot);
    byDay.set(slot.day_of_week, existing);
  }

  const lines: string[] = [];
  for (let d = 0; d <= 6; d++) {
    const daySlots = byDay.get(d);
    if (!daySlots) continue;
    const times = daySlots
      .map(s => `${formatTime12h(s.start_time)} – ${formatTime12h(s.end_time)}`)
      .join(', ');
    lines.push(`${DAY_NAMES[d]}: ${times}`);
  }
  return lines.join('\n');
}

function totalWeeklyHours(slots: AvailabilitySlot[]): number {
  return slots.reduce((sum, s) => {
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    return sum + (eh * 60 + em - (sh * 60 + sm)) / 60;
  }, 0);
}

function clampTime(time: string, min: string, max: string): string {
  if (time < min) return min;
  if (time > max) return max;
  return time;
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

async function textEmployee(session: OnboardingSession, body: string): Promise<void> {
  await sendSms({
    to: session.employee_phone,
    from: session.aegis_sms_channel,
    body,
    company_id: session.company_id,
  });
}

async function notifyManagerSmsDirect(
  managerPhone: string,
  aegisNumber: string,
  companyId: string,
  body: string
): Promise<void> {
  await sendSms({ to: managerPhone, from: aegisNumber, body, company_id: companyId });
}

function buildManagerContact(session: OnboardingSession): VerifiedContact {
  return {
    role: 'manager',
    company_id: session.company_id,
    employee_id: null,
    user_id: null,
    name: 'Manager',
    matched_identifier: session.manager_contact,
    channel: session.manager_channel,
  };
}

function buildManagerMsg(session: OnboardingSession): InboundMessage {
  return {
    sender: session.manager_sender,
    recipient: session.manager_recipient,
    body: '',
    channel: session.manager_channel,
  };
}

// ── AI helpers ────────────────────────────────────────────────────────────────

async function claudeMatchName(message: string, employeeName: string): Promise<boolean> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 64,
    system:
      `You are verifying if a message confirms a person's name. ` +
      `The expected name is: "${employeeName}". ` +
      `Reply with ONLY valid JSON: {"matches": true} or {"matches": false}. ` +
      `A match means the message plausibly confirms or states this name, ` +
      `including nicknames, partial names, or affirmatives like "yes that's me".`,
    messages: [{ role: 'user', content: message }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  try {
    return (JSON.parse(text) as { matches: boolean }).matches;
  } catch {
    const lower = message.toLowerCase();
    return employeeName
      .toLowerCase()
      .split(' ')
      .some(part => lower.includes(part));
  }
}

async function claudeParseAvailability(
  message: string,
  bounds: ShiftBounds
): Promise<AvailabilitySlot[]> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system:
      `You are parsing employee availability from natural language into structured data. ` +
      `Extract all days and time ranges the employee is available. ` +
      `Clamp all times to ${bounds.earliest_start}–${bounds.latest_end} (24h). ` +
      `"All day" or "anytime" means ${bounds.earliest_start} to ${bounds.latest_end}. ` +
      `day_of_week: 0=Sunday through 6=Saturday. Times in HH:MM (24h). ` +
      `Respond ONLY with valid JSON (no markdown): ` +
      `{ "slots": [{ "day_of_week": 0, "start_time": "HH:MM", "end_time": "HH:MM" }] } ` +
      `If nothing clear can be parsed, return { "slots": [] }.`,
    messages: [{ role: 'user', content: message }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  try {
    return (JSON.parse(text) as { slots: AvailabilitySlot[] }).slots ?? [];
  } catch {
    return [];
  }
}

// Binary yes/no classifier — used in onboarding confirmation steps where natural
// language ("right but Friday's wrong", "looks good") needs to be interpreted
// reliably. Falls back to 'no' on parse failure (the safe default everywhere
// it's used: re-prompt rather than silently accept).
async function claudeClassifyYesNo(message: string, question: string): Promise<'yes' | 'no'> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16,
    system:
      `${question} Reply with ONLY one word: "yes" or "no". ` +
      `"yes" only if the message clearly affirms. "no" for anything else, ` +
      `including denials, requests to change, ambiguity, or partial mentions.`,
    messages: [{ role: 'user', content: message }],
  });
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return text.trim().toLowerCase().startsWith('y') ? 'yes' : 'no';
}

async function claudeExtractDates(
  message: string
): Promise<{ start_date: string; end_date: string }[]> {
  const today = new Date().toISOString().split('T')[0];
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system:
      `Extract time-off dates from a message. Today is ${today}. ` +
      `If only one date, set start_date = end_date. ` +
      `Respond ONLY with valid JSON (no markdown): ` +
      `{ "dates": [{ "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" }] } ` +
      `If none, return { "dates": [] }.`,
    messages: [{ role: 'user', content: message }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  try {
    return (JSON.parse(text) as { dates: { start_date: string; end_date: string }[] }).dates ?? [];
  } catch {
    return [];
  }
}

// ── Step senders ──────────────────────────────────────────────────────────────

async function sendNameConfirmStep(session: OnboardingSession, companyName: string): Promise<void> {
  await textEmployee(
    session,
    `Hi, I'm Aegis, the scheduling assistant for ${companyName}. ` +
      `I'm reaching out to get your info on file. Can you confirm your name?`
  );
}

async function sendEmailStep(session: OnboardingSession): Promise<void> {
  const firstName = session.employee_name.split(' ')[0];
  await textEmployee(
    session,
    `Thanks ${firstName}. What's your email address? We'll use it to send you your schedule each week.`
  );
}

async function sendRoleStep(session: OnboardingSession, roles: string[]): Promise<void> {
  const list = roles.map((r, i) => `${i + 1}. ${r}`).join('\n');
  await textEmployee(session, `What's your role?\n${list}\nReply with a number.`);
}

async function sendAvailabilityStep(session: OnboardingSession, bounds: ShiftBounds): Promise<void> {
  await textEmployee(
    session,
    `Now let's get your availability on file. Tell me which days you can work and what hours. ` +
      `We schedule between ${formatTime12h(bounds.earliest_start)} and ${formatTime12h(bounds.latest_end)}. ` +
      `You can speak naturally — for example: "I'm free Monday through Friday after 3pm and all day weekends."`
  );
}

async function sendAvailabilityConfirmStep(session: OnboardingSession): Promise<void> {
  const list = formatAvailabilityList(session.collected.availability_parsed);
  await textEmployee(
    session,
    `Got it. Let me confirm your availability:\n${list}\nDoes that look right? Reply YES to confirm or NO to make changes.`
  );
}

async function sendTimeOffStep(session: OnboardingSession): Promise<void> {
  await textEmployee(
    session,
    `Almost done. Do you have any upcoming dates you know you won't be available? ` +
      `For example, a vacation or appointments? Reply NO if nothing comes to mind.`
  );
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleNameConfirmStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  employee: Employee,
  companyName: string
): Promise<void> {
  const matches = await claudeMatchName(body, session.employee_name);

  if (!matches) {
    await textEmployee(
      session,
      `I didn't quite catch that. Could you confirm your name? I have ${session.employee_name} on file.`
    );
    return;
  }

  session.collected.name_confirmed = true;
  const needsEmail = !employee.contact_email;
  const needsRole = !employee.primary_role && !session.collected.role;

  if (needsEmail) {
    session.step = 'email';
    await saveOnboardingSession(session);
    await sendEmailStep(session);
  } else if (needsRole) {
    session.step = 'role';
    const roles = await loadRoles(session.company_id);
    await saveOnboardingSession(session);
    await sendRoleStep(session, roles);
  } else {
    session.step = 'availability';
    const bounds = await loadShiftBounds(session.company_id);
    await saveOnboardingSession(session);
    await sendAvailabilityStep(session, bounds);
  }
}

async function handleEmailStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  employee: Employee,
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const trimmed = body.trim().toLowerCase();

  if (!emailRegex.test(trimmed)) {
    session.invalid_email_attempts++;

    if (session.invalid_email_attempts >= 3) {
      await clearOnboardingSession(session.company_id, session.employee_id);
      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_email_failed',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `${session.employee_name} provided invalid email 3 times — onboarding paused`,
      });
      await textEmployee(
        session,
        `I'm having trouble with that email address. I'll let your manager know — they can update it directly.`
      );
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name} was unable to provide a valid email during onboarding. Please update their email in Homebase and restart onboarding.`
      );
      return;
    }

    await saveOnboardingSession(session);
    await textEmployee(
      session,
      `That doesn't look like a valid email. Could you try again? Example: name@example.com`
    );
    return;
  }

  session.collected.email = trimmed;
  session.invalid_email_attempts = 0;

  const needsRole = !employee.primary_role && !session.collected.role;

  if (needsRole) {
    session.step = 'role';
    const roles = await loadRoles(session.company_id);
    await saveOnboardingSession(session);
    await sendRoleStep(session, roles);
  } else {
    session.step = 'availability';
    const bounds = await loadShiftBounds(session.company_id);
    await saveOnboardingSession(session);
    await sendAvailabilityStep(session, bounds);
  }
}

async function handleRoleStep(
  body: string,
  session: OnboardingSession & { _memory_id: string }
): Promise<void> {
  const roles = await loadRoles(session.company_id);
  const num = parseInt(body.trim(), 10);

  if (isNaN(num) || num < 1 || num > roles.length) {
    await textEmployee(session, `Please reply with a number between 1 and ${roles.length}.`);
    return;
  }

  session.collected.role = roles[num - 1];
  session.step = 'availability';
  const bounds = await loadShiftBounds(session.company_id);
  await saveOnboardingSession(session);
  await sendAvailabilityStep(session, bounds);
}

async function handleAvailabilityStep(
  body: string,
  session: OnboardingSession & { _memory_id: string }
): Promise<void> {
  const bounds = await loadShiftBounds(session.company_id);
  const slots = await claudeParseAvailability(body, bounds);

  if (slots.length === 0) {
    session.invalid_availability_attempts++;

    if (session.invalid_availability_attempts >= 2) {
      await saveOnboardingSession(session);
      await textEmployee(
        session,
        `I'm having trouble understanding that. Try a simpler format — for example: ` +
          `"Monday 9am to 5pm, Tuesday 10am to 3pm, weekends off."`
      );
      return;
    }

    await saveOnboardingSession(session);
    await textEmployee(
      session,
      `I didn't quite catch that. Could you describe which days and hours you're available?`
    );
    return;
  }

  const clamped = slots
    .map(s => ({
      ...s,
      start_time: clampTime(s.start_time, bounds.earliest_start, bounds.latest_end),
      end_time: clampTime(s.end_time, bounds.earliest_start, bounds.latest_end),
    }))
    .filter(s => s.start_time < s.end_time);

  if (clamped.length === 0) {
    await saveOnboardingSession(session);
    await textEmployee(
      session,
      `Your availability falls outside our schedule window (${formatTime12h(bounds.earliest_start)}–${formatTime12h(bounds.latest_end)}). ` +
        `Could you tell me when within those hours you're available?`
    );
    return;
  }

  session.collected.availability_raw = body;
  session.collected.availability_parsed = clamped;
  session.invalid_availability_attempts = 0;
  session.step = 'availability_confirm';
  await saveOnboardingSession(session);
  await sendAvailabilityConfirmStep(session);
}

async function handleAvailabilityConfirmStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  const verdict = await claudeClassifyYesNo(
    body,
    `The employee was asked to confirm their availability. Did they confirm (yes) or request changes (no)?`
  );

  if (verdict === 'no') {
    session.step = 'availability';
    session.collected.availability_raw = null;
    session.collected.availability_parsed = [];
    session.invalid_availability_attempts = 0;
    const bounds = await loadShiftBounds(session.company_id);
    await saveOnboardingSession(session);
    await sendAvailabilityStep(session, bounds);
    return;
  }

  session.collected.availability_confirmed = true;
  const bounds = await loadShiftBounds(session.company_id);
  const weeklyHours = totalWeeklyHours(session.collected.availability_parsed);

  if (weeklyHours < bounds.min_shift_hours) {
    session.flagged_low_availability = true;
    await reply(
      managerContact,
      managerMsg,
      `${session.employee_name} submitted limited availability — only ${weeklyHours.toFixed(1)}h/week. ` +
        `Saved as submitted but flagging for your review.`
    );
    await logActivity({
      company_id: session.company_id,
      action: 'onboarding_low_availability_flagged',
      entity_type: 'employee',
      entity_id: session.employee_id,
      summary: `${session.employee_name} has low availability: ${weeklyHours.toFixed(1)}h/week`,
      metadata: { weekly_hours: weeklyHours, min_shift_hours: bounds.min_shift_hours },
    });
  }

  session.step = 'time_off';
  await saveOnboardingSession(session);
  await sendTimeOffStep(session);
}

async function handleTimeOffStep(
  body: string,
  session: OnboardingSession & { _memory_id: string },
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  const dates = await claudeExtractDates(body);

  if (dates.length === 0) {
    // Don't silently complete on an empty parse — confirm the employee really
    // means "no time off" before closing out the workflow. Claude classifies
    // whether the message is a clear no vs. ambiguous mention.
    const clearlyNoTimeOff = await claudeClassifyYesNo(
      body,
      `The employee was asked if they have any upcoming time off. Did they clearly say they have no upcoming time off?`
    );

    if (clearlyNoTimeOff === 'yes') {
      session.step = 'complete';
      await saveOnboardingSession(session);
      await completeOnboarding(session, managerContact, managerMsg);
      return;
    }

    // Ambiguous — stay in the time_off step and ask for clarification.
    await textEmployee(
      session,
      `Just to confirm — you don't have any upcoming dates you need off? ` +
        `Reply YES if that's correct, or tell me the specific dates.`
    );
    return;
  }

  for (const { start_date, end_date } of dates) {
    const { data: torData } = await supabase
      .from('time_off_requests')
      .insert({
        employee_id: session.employee_id,
        company_id: session.company_id,
        start_date,
        end_date,
        reason: 'submitted during onboarding',
        status: 'pending',
        requested_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (torData) {
      const tor = torData as { id: string };
      await logActivity({
        company_id: session.company_id,
        action: 'time_off_request_created',
        entity_type: 'time_off_request',
        entity_id: tor.id,
        summary: `${session.employee_name} submitted time-off during onboarding: ${start_date} to ${end_date}`,
        metadata: { source: 'onboarding' },
      });
      const dateStr = start_date === end_date ? start_date : `${start_date} to ${end_date}`;
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name} requested time off for ${dateStr} during onboarding. Status: pending your approval.`
      );
    }
  }

  session.collected.time_off_submitted = true;
  session.step = 'complete';
  await saveOnboardingSession(session);
  await completeOnboarding(session, managerContact, managerMsg);
}

// ── Completion ────────────────────────────────────────────────────────────────

async function completeOnboarding(
  session: OnboardingSession & { _memory_id: string },
  managerContact: VerifiedContact,
  managerMsg: InboundMessage
): Promise<void> {
  const firstName = session.employee_name.split(' ')[0];

  await textEmployee(
    session,
    `You're all set ${firstName}. I've saved your availability and contact info. ` +
      `You'll receive your schedule from Aegis each week. Welcome to the team.`
  );

  // Write to employees table
  const updates: Record<string, unknown> = {};
  if (session.collected.email) updates['contact_email'] = session.collected.email;
  if (session.collected.role) updates['primary_role'] = session.collected.role;

  if (Object.keys(updates).length > 0) {
    await supabase.from('employees').update(updates).eq('id', session.employee_id);
  }

  // Add primary_role to qualified_roles if not already present
  if (session.collected.role) {
    const { data: empData } = await supabase
      .from('employees')
      .select('qualified_roles')
      .eq('id', session.employee_id)
      .single();
    const emp = empData as { qualified_roles: string[] } | null;
    if (emp && !emp.qualified_roles.includes(session.collected.role)) {
      await supabase
        .from('employees')
        .update({ qualified_roles: [...emp.qualified_roles, session.collected.role] })
        .eq('id', session.employee_id);
    }
  }

  // Replace availability
  if (session.collected.availability_parsed.length > 0) {
    await supabase.from('availability').delete().eq('employee_id', session.employee_id);
    await supabase.from('availability').insert(
      session.collected.availability_parsed.map(s => ({
        company_id: session.company_id,
        employee_id: session.employee_id,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
      }))
    );
  }

  const weeklyHours = totalWeeklyHours(session.collected.availability_parsed);

  await logActivity({
    company_id: session.company_id,
    action: 'onboarding_complete',
    entity_type: 'employee',
    entity_id: session.employee_id,
    summary: `${session.employee_name} completed onboarding`,
    metadata: {
      availability_raw: session.collected.availability_raw,
      availability_parsed: session.collected.availability_parsed,
      email_collected: !!session.collected.email,
      role_collected: !!session.collected.role,
      time_off_submitted: session.collected.time_off_submitted,
      flagged_low_availability: session.flagged_low_availability,
      total_weekly_hours: weeklyHours,
    },
  });

  const flagNote = session.flagged_low_availability
    ? ` Note: limited availability flagged (${weeklyHours.toFixed(1)}h/week).`
    : '';

  await reply(
    managerContact,
    managerMsg,
    `${session.employee_name} completed onboarding. ${weeklyHours.toFixed(1)}h/week availability saved.${flagNote}`
  );

  await clearOnboardingSession(session.company_id, session.employee_id);
}

// ── Public: employee response handler ────────────────────────────────────────

export async function handleOnboardingResponse(
  message: InboundMessage,
  contact: VerifiedContact,
  session: OnboardingSession & { _memory_id: string }
): Promise<void> {
  const managerContact = buildManagerContact(session);
  const managerMsg = buildManagerMsg(session);

  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('id', session.employee_id)
    .single();
  const employee = empData as Employee | null;

  if (!employee) {
    await textEmployee(session, `I couldn't locate your employee record. Please contact your manager.`);
    await clearOnboardingSession(session.company_id, session.employee_id);
    return;
  }

  switch (session.step) {
    case 'name_confirm': {
      const companyName = await loadCompanyName(session.company_id);
      await handleNameConfirmStep(message.body, session, employee, companyName);
      break;
    }
    case 'email':
      await handleEmailStep(message.body, session, employee, managerContact, managerMsg);
      break;
    case 'role':
      await handleRoleStep(message.body, session);
      break;
    case 'availability':
      await handleAvailabilityStep(message.body, session);
      break;
    case 'availability_confirm':
      await handleAvailabilityConfirmStep(message.body, session, managerContact, managerMsg);
      break;
    case 'time_off':
      await handleTimeOffStep(message.body, session, managerContact, managerMsg);
      break;
    case 'complete':
      await textEmployee(
        session,
        `You've already completed onboarding. If you need to make changes, please contact your manager.`
      );
      break;
    default:
      break;
  }
}

// ── Public: manager initiates onboarding ─────────────────────────────────────

export async function handleInitiateOnboarding(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const { data: channelData } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', contact.company_id)
    .eq('channel_type', 'sms')
    .maybeSingle();

  const aegisSmsChannel = (channelData as { channel_value: string } | null)?.channel_value;

  if (!aegisSmsChannel) {
    await reply(
      contact,
      message,
      `Onboarding requires an Aegis SMS channel configured for your company. Please contact support.`
    );
    return;
  }

  const companyName = await loadCompanyName(contact.company_id);
  const roles = await loadRoles(contact.company_id);
  const targetName = extracted['employee_name'] as string | undefined;

  let candidates: Employee[];

  if (targetName) {
    const incomplete = await getIncompleteEmployees(contact.company_id);
    const lower = targetName.toLowerCase();
    candidates = incomplete.filter(e => e.name.toLowerCase().includes(lower));

    if (candidates.length === 0) {
      const { data: allData } = await supabase
        .from('employees')
        .select('*')
        .eq('company_id', contact.company_id)
        .eq('active', true);
      const all = (allData ?? []) as Employee[];
      const found = all.find(e => e.name.toLowerCase().includes(lower));

      if (found) {
        await reply(contact, message, `${found.name} already has all required information on file.`);
      } else {
        await reply(contact, message, `I couldn't find an employee matching "${targetName}". Please check the name and try again.`);
      }
      return;
    }

    // Named target — proceed immediately, even if substring matches multiple.
    await executeOnboardingForCandidates(
      candidates,
      companyName,
      roles,
      aegisSmsChannel,
      contact,
      message
    );
    return;
  }

  // No name specified — onboard all incomplete employees.
  candidates = await getIncompleteEmployees(contact.company_id);
  if (candidates.length === 0) {
    await reply(contact, message, `All active employees already have their information on file. No onboarding needed.`);
    return;
  }

  // Fan-out confirmation gate: if 2+ reachable employees would be SMSed at once,
  // ask the manager to confirm first so they don't accidentally spam staff.
  const reachable = candidates.filter(e => e.contact_phone);
  if (reachable.length > 1) {
    const pending: OnboardingFanoutPending = {
      company_id: contact.company_id,
      manager_contact: contact.matched_identifier,
      manager_channel: message.channel,
      manager_sender: message.sender,
      manager_recipient: message.recipient,
      aegis_sms_channel: aegisSmsChannel,
      target_employee_ids: candidates.map(e => e.id),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    await saveFanoutPending(pending);

    const previewNames = reachable.slice(0, 10).map(e => e.name);
    const overflow = reachable.length > 10 ? `\n...and ${reachable.length - 10} more` : '';
    const noPhone = candidates.filter(e => !e.contact_phone);
    const skipNote = noPhone.length > 0
      ? `\n\n${noPhone.length} will be skipped (no phone on file): ${noPhone.map(e => e.name).join(', ')}.`
      : '';

    await reply(
      contact,
      message,
      `I'm about to start onboarding for ${reachable.length} employees:\n` +
        previewNames.join('\n') +
        overflow +
        skipNote +
        `\n\nReply YES to begin or NO to cancel.`
    );
    return;
  }

  // Single reachable (or all unreachable) — execute immediately, existing
  // executeOnboardingForCandidates handles the skip-no-phone reporting.
  await executeOnboardingForCandidates(
    candidates,
    companyName,
    roles,
    aegisSmsChannel,
    contact,
    message
  );
}

async function executeOnboardingForCandidates(
  candidates: Employee[],
  companyName: string,
  roles: string[],
  aegisSmsChannel: string,
  contact: VerifiedContact,
  message: InboundMessage
): Promise<void> {
  const started: string[] = [];
  const skippedNoPhone: string[] = [];

  for (const employee of candidates) {
    if (!employee.contact_phone) {
      skippedNoPhone.push(employee.name);
      await logActivity({
        company_id: contact.company_id,
        action: 'onboarding_skipped_no_phone',
        entity_type: 'employee',
        entity_id: employee.id,
        summary: `Onboarding skipped for ${employee.name} — no phone on file`,
        metadata: { employee_id: employee.id },
      });
      continue;
    }

    const existing = await getOnboardingSession(contact.company_id, employee.id);
    if (existing) {
      started.push(`${employee.name} (already in progress)`);
      continue;
    }

    const now = new Date();
    const session: OnboardingSession = {
      company_id: contact.company_id,
      employee_id: employee.id,
      employee_name: employee.name,
      employee_phone: employee.contact_phone,
      aegis_sms_channel: aegisSmsChannel,
      manager_contact: contact.matched_identifier,
      manager_channel: message.channel,
      manager_sender: message.sender,
      manager_recipient: message.recipient,
      step: 'name_confirm',
      collected: {
        name_confirmed: false,
        email: null,
        // Auto-assign when exactly one role exists and employee has none
        role: roles.length === 1 && !employee.primary_role ? roles[0] : null,
        availability_raw: null,
        availability_parsed: [],
        availability_confirmed: false,
        time_off_submitted: false,
      },
      flagged_low_availability: false,
      invalid_email_attempts: 0,
      invalid_availability_attempts: 0,
      warned_24h: false,
      started_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
    };

    await saveOnboardingSession(session);
    await sendNameConfirmStep(session, companyName);
    started.push(employee.name);

    await logActivity({
      company_id: contact.company_id,
      action: 'onboarding_started',
      entity_type: 'employee',
      entity_id: employee.id,
      summary: `Onboarding started for ${employee.name} by manager`,
      metadata: { triggered_by: message.channel },
    });
  }

  const lines: string[] = [];
  if (started.length > 0) {
    lines.push(
      `Onboarding started for ${started.length} employee${started.length !== 1 ? 's' : ''}: ${started.join(', ')}.`
    );
  }
  if (skippedNoPhone.length > 0) {
    lines.push(
      `Skipped ${skippedNoPhone.length} (no phone on file): ${skippedNoPhone.join(', ')}. Update their phone in Homebase and try again.`
    );
  }

  await reply(contact, message, lines.join(' '));
}

// ── Fan-out confirmation ─────────────────────────────────────────────────────

async function saveFanoutPending(pending: OnboardingFanoutPending): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', pending.company_id)
    .eq('source', fanoutSource(pending.company_id, pending.manager_contact));
  await supabase.from('aegis_memory').insert({
    company_id: pending.company_id,
    memory_type: 'observation',
    source: fanoutSource(pending.company_id, pending.manager_contact),
    content: JSON.stringify(pending),
  });
}

export async function getOnboardingFanoutPending(
  companyId: string,
  managerIdentifier: string
): Promise<(OnboardingFanoutPending & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', fanoutSource(companyId, managerIdentifier))
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as OnboardingFanoutPending;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function handleOnboardingFanoutConfirm(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: OnboardingFanoutPending & { _memory_id: string }
): Promise<void> {
  const lower = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|yep|y\b|confirm|go(\s|$)|start|begin|do\s?it|proceed|sure|ok|okay)/i.test(lower);
  const isNo = /^(no|nope|n\b|cancel|stop|nah|don'?t|never\s?mind)/i.test(lower);

  if (!isYes && !isNo) {
    await reply(contact, message, `Reply YES to start onboarding or NO to cancel.`);
    return;
  }

  await supabase.from('aegis_memory').delete().eq('id', pending._memory_id);

  if (isNo) {
    await reply(contact, message, `Onboarding cancelled.`);
    return;
  }

  // YES — load the employees that were queued and execute. Re-fetch in case
  // anyone became inactive or got deleted in the 10-minute confirmation window.
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .in('id', pending.target_employee_ids)
    .eq('active', true);
  const employees = (empData ?? []) as Employee[];

  if (employees.length === 0) {
    await reply(contact, message, `No active employees found to onboard. They may have been removed or deactivated.`);
    return;
  }

  const companyName = await loadCompanyName(pending.company_id);
  const roles = await loadRoles(pending.company_id);

  await executeOnboardingForCandidates(
    employees,
    companyName,
    roles,
    pending.aegis_sms_channel,
    contact,
    message
  );
}

// ── Update availability flow ──────────────────────────────────────────────────

export async function getPendingAvailConfirm(
  companyId: string,
  employeeId: string
): Promise<(PendingAvailUpdate & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', availConfirmSource(employeeId))
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingAvailUpdate;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function getPendingManagerAvailApproval(
  companyId: string
): Promise<(PendingManagerAvailApproval & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .like('source', `avail_pending_mgr:${companyId}:%`)
    .maybeSingle();

  if (!data) return null;

  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingManagerAvailApproval;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function handleUpdateAvailability(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  const employeeId = contact.employee_id!;
  const bounds = await loadShiftBounds(contact.company_id);

  const { data: currentData } = await supabase
    .from('availability')
    .select('day_of_week, start_time, end_time')
    .eq('employee_id', employeeId);

  const currentAvail = (currentData ?? []) as AvailabilitySlot[];
  const parsed = await claudeParseAvailability(message.body, bounds);

  if (parsed.length === 0) {
    await reply(
      contact,
      message,
      `I wasn't able to understand your availability. Could you be more specific? ` +
        `For example: "Monday 9am to 5pm and Friday 10am to 3pm."`
    );
    return;
  }

  const proposed = parsed
    .map(s => ({
      ...s,
      start_time: clampTime(s.start_time, bounds.earliest_start, bounds.latest_end),
      end_time: clampTime(s.end_time, bounds.earliest_start, bounds.latest_end),
    }))
    .filter(s => s.start_time < s.end_time);

  const pending: PendingAvailUpdate = {
    employee_id: employeeId,
    employee_name: contact.name,
    company_id: contact.company_id,
    current_availability: currentAvail,
    proposed_availability: proposed,
    availability_raw: message.body,
    employee_sender: message.sender,
    employee_recipient: message.recipient,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };

  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', contact.company_id)
    .eq('source', availConfirmSource(employeeId));

  await supabase.from('aegis_memory').insert({
    company_id: contact.company_id,
    memory_type: 'observation',
    source: availConfirmSource(employeeId),
    content: JSON.stringify(pending),
  });

  const proposedDisplay = formatAvailabilityList(proposed);
  await reply(
    contact,
    message,
    `You want to change your availability to:\n${proposedDisplay}\nI'll send this to your manager for approval. Is that correct? Reply YES or NO.`
  );
}

export async function handleAvailabilityConfirmResponse(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingAvailUpdate & { _memory_id: string }
): Promise<void> {
  const lower = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|yep|y\b|correct|confirmed|ok|okay|sure)/i.test(lower);
  const isNo = /^(no|nope|n\b|cancel|wrong|nah)/i.test(lower);

  if (!isYes && !isNo) {
    await reply(contact, message, `Please reply YES to send to your manager or NO to cancel.`);
    return;
  }

  await supabase.from('aegis_memory').delete().eq('id', pending._memory_id);

  if (isNo) {
    await reply(contact, message, `No problem — availability update cancelled.`);
    return;
  }

  // Find manager
  const { data: mgrData } = await supabase
    .from('users')
    .select('email, name')
    .eq('company_id', contact.company_id)
    .in('role', ['manager', 'owner'])
    .limit(1)
    .maybeSingle();

  const manager = mgrData as { email: string; name: string } | null;
  if (!manager) {
    await reply(contact, message, `I couldn't locate a manager. Please speak with them directly.`);
    return;
  }

  const { data: mgrEmpData } = await supabase
    .from('employees')
    .select('contact_phone')
    .eq('company_id', contact.company_id)
    .eq('contact_email', manager.email)
    .maybeSingle();

  const managerPhone = (mgrEmpData as { contact_phone: string | null } | null)?.contact_phone;

  const { data: chData } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', contact.company_id)
    .eq('channel_type', 'sms')
    .maybeSingle();

  const aegisSmsChannel = (chData as { channel_value: string } | null)?.channel_value;

  if (!managerPhone || !aegisSmsChannel) {
    await reply(contact, message, `I couldn't reach your manager via SMS. Please speak with them directly.`);
    return;
  }

  const approval: PendingManagerAvailApproval = {
    ...pending,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', contact.company_id)
    .eq('source', availApprovalSource(contact.company_id, pending.employee_id));

  await supabase.from('aegis_memory').insert({
    company_id: contact.company_id,
    memory_type: 'observation',
    source: availApprovalSource(contact.company_id, pending.employee_id),
    content: JSON.stringify(approval),
  });

  const currentDisplay =
    pending.current_availability.length > 0
      ? formatAvailabilityList(pending.current_availability)
      : 'Not on file';
  const proposedDisplay = formatAvailabilityList(pending.proposed_availability);

  await sendSms({
    to: managerPhone,
    from: aegisSmsChannel,
    body:
      `${pending.employee_name} wants to update their availability.\n\n` +
      `CURRENT:\n${currentDisplay}\n\nPROPOSED:\n${proposedDisplay}\n\n` +
      `Reply YES to approve or NO to deny.`,
    company_id: contact.company_id,
  });

  await reply(
    contact,
    message,
    `Your availability request has been sent to your manager for approval. You'll hear back soon.`
  );
}

export async function handleManagerAvailabilityApproval(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingManagerAvailApproval & { _memory_id: string }
): Promise<void> {
  const lower = message.body.trim().toLowerCase();
  const isYes = /^(yes|yeah|y\b|approve|approved|ok|okay|sure)/i.test(lower);
  const isNo = /^(no|nope|n\b|deny|denied|decline)/i.test(lower);

  if (!isYes && !isNo) {
    await reply(
      contact,
      message,
      `Please reply YES to approve or NO to deny ${pending.employee_name}'s availability update.`
    );
    return;
  }

  await supabase.from('aegis_memory').delete().eq('id', pending._memory_id);

  if (isYes) {
    await supabase.from('availability').delete().eq('employee_id', pending.employee_id);
    await supabase.from('availability').insert(
      pending.proposed_availability.map(s => ({
        company_id: pending.company_id,
        employee_id: pending.employee_id,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
      }))
    );

    await logActivity({
      company_id: contact.company_id,
      action: 'availability_updated',
      entity_type: 'employee',
      entity_id: pending.employee_id,
      summary: `${pending.employee_name}'s availability updated via manager approval`,
      metadata: {
        approved_by: contact.name,
        previous: pending.current_availability,
        updated: pending.proposed_availability,
        raw_request: pending.availability_raw,
      },
    });

    await reply(contact, message, `${pending.employee_name}'s availability has been updated.`);
    await sendSms({
      to: pending.employee_sender,
      from: pending.employee_recipient,
      body: `Your availability update has been approved. Your new schedule reflects the change.`,
      company_id: pending.company_id,
    });
  } else {
    await logActivity({
      company_id: contact.company_id,
      action: 'availability_update_denied',
      entity_type: 'employee',
      entity_id: pending.employee_id,
      summary: `${pending.employee_name}'s availability update denied by manager`,
      metadata: { denied_by: contact.name },
    });

    await reply(contact, message, `${pending.employee_name}'s availability update has been denied.`);
    await sendSms({
      to: pending.employee_sender,
      from: pending.employee_recipient,
      body: `Your availability update was not approved. Please speak with your manager directly if you'd like to discuss.`,
      company_id: pending.company_id,
    });
  }
}

// ── Proactive expiry (called by scheduler) ────────────────────────────────────
// Scans every onboarding session and deletes any past its 48h expires_at,
// notifying the manager on their original channel. Without this, the lazy
// check inside getOnboardingSession only fires if the employee sends another
// message — fully-silent sessions would otherwise linger indefinitely.

export async function expireOldOnboardingSessions(): Promise<void> {
  const { data: rows, error } = await supabase
    .from('aegis_memory')
    .select('id, company_id, content')
    .like('source', 'onboarding:%');

  if (error) {
    console.error('[onboarding-expire] DB query failed:', error.message);
    return;
  }

  const records = (rows ?? []) as { id: string; company_id: string; content: string }[];
  const now = new Date();
  let expired = 0;

  for (const record of records) {
    try {
      const session = JSON.parse(record.content) as OnboardingSession;
      if (new Date(session.expires_at) > now) continue;

      // Delete first so a transient notify failure doesn't leave the row stuck.
      await supabase.from('aegis_memory').delete().eq('id', record.id);

      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_timeout',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `Onboarding session expired for ${session.employee_name}`,
        metadata: {
          step_reached: session.step,
          started_at: session.started_at,
          reaped_by: 'proactive_expiry',
        },
      });

      const managerContact = buildManagerContact(session);
      const managerMsg = buildManagerMsg(session);
      await reply(
        managerContact,
        managerMsg,
        `${session.employee_name}'s onboarding window expired without completion. ` +
          `Their session has been cleared. You can restart onboarding anytime.`
      );

      expired++;
    } catch (err) {
      console.error('[onboarding-expire] error processing record:', err);
    }
  }

  if (expired > 0) {
    console.log(`[onboarding-expire] expired ${expired} stale onboarding session(s)`);
  }
}

// ── Stale session checker (called by scheduler) ───────────────────────────────

export async function checkStaleOnboardingSessions(): Promise<void> {
  const { data: rows, error } = await supabase
    .from('aegis_memory')
    .select('id, company_id, content')
    .like('source', 'onboarding:%');

  if (error) {
    console.error('[onboarding-timeout] DB query failed:', error.message);
    return;
  }

  const records = (rows ?? []) as { id: string; company_id: string; content: string }[];
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const record of records) {
    try {
      const session = JSON.parse(record.content) as OnboardingSession;

      if (session.step === 'complete') continue;
      if (session.warned_24h) continue;
      if (new Date(session.started_at) > twentyFourHoursAgo) continue;

      // Mark warned before sending so a service restart doesn't double-notify
      const updated: OnboardingSession = { ...session, warned_24h: true };
      await supabase
        .from('aegis_memory')
        .update({ content: JSON.stringify(updated) })
        .eq('id', record.id);

      await notifyManagerSmsDirect(
        session.manager_sender,
        session.manager_recipient,
        session.company_id,
        `${session.employee_name} hasn't completed onboarding yet. You may want to follow up directly.`
      );

      await logActivity({
        company_id: session.company_id,
        action: 'onboarding_24h_warning_sent',
        entity_type: 'employee',
        entity_id: session.employee_id,
        summary: `24h onboarding warning sent for ${session.employee_name}`,
        metadata: { step_reached: session.step },
      });
    } catch {
      // Corrupted record — skip
    }
  }
}
