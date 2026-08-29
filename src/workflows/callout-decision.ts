// ── W-2 branch 5: the call-out decision, answerable from the TEXT ────────────
//
// Decision (Alexander, 2026-08-28): the manager must be able to act on a
// call-out directly from the nudge text — "find coverage", "approve — I've
// got it", "deny" — not only from the email buttons. A call-out is the most
// time-pressed decision a manager makes; "open your email" is a real tax when
// the shift starts in three hours. A text reply is also SAFER than the GET
// links (a mail client pre-fetching a link can never send a text — the exact
// shape that bit Jack on Aug 17 / J-3).
//
// RULE 0b — one decision, one function: `applyTimeOffDecision` is the single
// implementation of what a time-off/call-out decision DOES (status write,
// token retirement, schedule marking, coverage start, employee notice, audit).
// The email buttons (webhooks/decision.ts) and the text replies here both call
// it, so the two surfaces can never disagree; a second decision through either
// door reports "already handled", never acts twice.
//
// Reply parsing is DETERMINISTIC — no model calls (MINIMIZE LLM CALLS). A bare
// "yes"/"no" is ambiguous across three choices, so it earns one clarifying
// question (tracked via `awaiting` on the pending row), never a guess.

import { randomUUID } from 'crypto'
import { supabase } from '../db/client'
import { logActivity } from '../logger/activity-log'
import { reply } from '../messaging/reply'
import { sendEmail } from '../messaging/email'
import { sendSms } from '../messaging/sms'
import { env } from '../config/env'
import { normalizeReSubject } from '../messaging/reply'
import { firstName } from '../messaging/greeting'
import { resolveManagers } from '../messaging/manager-directory'
import {
  startCoverageForCallOut,
  markAssignmentsCalledOut,
  findCoverageSessionForTimeOffRequest,
  type CallOutCoverageOutcome,
} from './emergency-coverage'
import { formatDateRange } from './time-off-manager-email'
import type { InboundMessage, VerifiedContact } from '../security/types'
import type { Employee } from '../db/types'
import type { CallOutShift } from './time-off'

// ── The shared decision context ───────────────────────────────────────────────
// Everything a decision needs to act and to tell the employee — the same shape
// the email decision tokens carry (minus action/expiry), so both doors mint it
// from what they already have.
export interface TimeOffDecisionContext {
  request_id: string
  company_id: string
  employee_id: string
  employee_name: string
  employee_channel: 'sms' | 'email'
  employee_contact: string
  aegis_sms_channel: string | null
  thread_id?: string | null
  raw_subject?: string | null
  manager_user_id?: string | null
  manager_name?: string | null
  call_out?: CallOutShift[] | null
}

export type TimeOffDecisionAction = 'approve' | 'deny' | 'approve_and_cover'

export type TimeOffDecisionResult =
  | { outcome: 'applied'; action: TimeOffDecisionAction; coverage: CallOutCoverageOutcome | null; startDate: string; endDate: string }
  | { outcome: 'already_decided'; status: string; coverageOpen: { shiftName: string; filled: boolean } | null }
  | { outcome: 'not_found' }

// ── Employee decision notice (channel router) ────────────────────────────────
// Moved here from webhooks/decision.ts (which re-exports it for its tests) so
// the text path can use it without an import cycle. Behaviour unchanged:
// SMS when enabled + phone + channel, ALWAYS falling back to email — a
// decision notice must never be silently dropped (DRIFT H2 / batch 2a).
export async function notifyEmployeeDecision(opts: {
  company_id: string
  smsChannel: string | null
  phone: string | null
  email: string | null
  body: string
  subject: string
  thread_id?: string | null
  employee_id?: string | null
}): Promise<boolean> {
  if (!env.EMAIL_ONLY && opts.phone && opts.smsChannel) {
    const ok = await sendSms({
      to: opts.phone,
      from: opts.smsChannel,
      body: opts.body,
      company_id: opts.company_id,
      employee_id: opts.employee_id ?? undefined,
    })
    if (ok) return true
    console.warn(`[decision-notify] SMS send failed for company ${opts.company_id}; falling back to email`)
  }
  if (opts.email) {
    await sendEmail({ to: opts.email, subject: opts.subject, text: opts.body, company_id: opts.company_id, thread_id: opts.thread_id ?? undefined })
    return true
  }
  console.error(`[decision-notify] no channel available to deliver decision notice for company ${opts.company_id}`)
  return false
}

// The employee-facing wording per decision. Call-outs name the shift and close
// the "still on the schedule" loop the confirmation opened; approved = you're
// off, definitively (spec §3.5 pending-not-granted, resolved).
async function notifyEmployeeOfDecision(
  ctx: TimeOffDecisionContext,
  employee: Employee | null,
  action: TimeOffDecisionAction,
  dates: { start_date: string; end_date: string },
): Promise<void> {
  const forDates = ` for ${formatDateRange(dates.start_date, dates.end_date)}`
  let callOutLine: string | null = null
  if (ctx.call_out?.length) {
    const { tenantTodayAndZone } = await import('../lib/tenant-date')
    const { describeCallOutShifts } = await import('./time-off')
    const { today } = await tenantTodayAndZone(ctx.company_id)
    callOutLine = describeCallOutShifts(ctx.call_out, today)
  }
  const body = callOutLine
    ? action === 'deny'
      ? `Your manager wasn't able to approve your call-out for ${callOutLine} — you're still expected for that shift. If that's a real problem, reach out to them directly.`
      : action === 'approve_and_cover'
      ? `Your manager approved your call-out for ${callOutLine} — you're off, and I'm already reaching out to teammates to cover the shift.`
      : `Your manager approved your call-out for ${callOutLine} — you're off. They're handling coverage from here.`
    : action === 'deny'
      ? `Your time-off request${forDates} has been denied. Please contact your manager if you have questions or would like to discuss alternatives.`
      : `Great news! Your time-off request${forDates} has been approved. Enjoy your time off!`

  const subject = ctx.raw_subject
    ? normalizeReSubject(ctx.raw_subject)
    : `Your time-off request has been ${action === 'deny' ? 'denied' : 'approved'}`
  const phone = ctx.employee_channel === 'sms' ? ctx.employee_contact : null
  const email = employee?.contact_email ?? (ctx.employee_channel === 'email' ? ctx.employee_contact : null)
  await notifyEmployeeDecision({
    company_id: ctx.company_id,
    smsChannel: ctx.aegis_sms_channel,
    phone,
    email,
    body,
    subject,
    thread_id: ctx.thread_id,
    employee_id: ctx.employee_id,
  })
}

// ── THE decision (both doors call this) ──────────────────────────────────────
export async function applyTimeOffDecision(
  ctx: TimeOffDecisionContext,
  action: TimeOffDecisionAction,
  via: 'email_link' | 'text_reply',
): Promise<TimeOffDecisionResult> {
  const { data: torData } = await supabase
    .from('time_off_requests')
    .select('*')
    .eq('id', ctx.request_id)
    .eq('company_id', ctx.company_id)
    .single()
  const tor = torData as { id: string; status: string; start_date: string; end_date: string; reason: string | null } | null
  if (!tor) return { outcome: 'not_found' }

  const isCallOut = Array.isArray(ctx.call_out) && ctx.call_out.length > 0

  if (tor.status !== 'pending') {
    // Idempotent truth: a second decision reports what stands — including the
    // open coverage session for a repeat "find coverage".
    let coverageOpen: { shiftName: string; filled: boolean } | null = null
    if (tor.status === 'approved') {
      const session = await findCoverageSessionForTimeOffRequest(ctx.company_id, ctx.request_id)
      if (session) coverageOpen = { shiftName: session.shift_info.shift_name, filled: session.coverage_filled }
    }
    return { outcome: 'already_decided', status: tor.status, coverageOpen }
  }

  const approves = action !== 'deny'
  // Optimistic guard — a concurrent decision through the other door loses the
  // race cleanly and reads back as already_decided on its own re-check.
  const { error: updErr } = await supabase
    .from('time_off_requests')
    .update({
      status: approves ? 'approved' : 'denied',
      decided_at: new Date().toISOString(),
      decided_by: ctx.manager_user_id ?? null,
    })
    .eq('id', ctx.request_id)
    .eq('status', 'pending')
  if (updErr) {
    console.error(`[callout-decision] status write failed for ${ctx.request_id}: ${updErr.message}`)
    return { outcome: 'not_found' }
  }

  // Retire EVERY live decision token for this request (all managers' copies) —
  // a stale email button after a text decision must land on the truthful
  // "already decided" page, not a second action.
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', ctx.company_id)
    .like('source', 'decision_token:%')
    .like('content', `%${ctx.request_id}%`)
  // And every manager's pending text-reply row for it.
  await clearCallOutDecisionPendingForRequest(ctx.company_id, ctx.request_id)

  const decisionPast = approves ? 'approved' : 'denied'
  await logActivity({
    company_id: ctx.company_id,
    actor: 'manager',
    actor_name: ctx.manager_name ?? null,
    action: `time_off_${decisionPast}`,
    entity_type: 'time_off_request',
    entity_id: ctx.request_id,
    summary: `${isCallOut ? 'Call-out' : 'Time-off request'} for ${ctx.employee_name} ${decisionPast}${ctx.manager_name ? ` by ${ctx.manager_name}` : ''} via ${via === 'text_reply' ? 'text reply' : 'email link'}`,
    metadata: {
      employee_id: ctx.employee_id,
      start_date: tor.start_date,
      end_date: tor.end_date,
      reason: tor.reason,
      decided_by: ctx.manager_user_id ?? null,
      ...(isCallOut ? { call_out: true, via: action } : {}),
    },
  })
  await supabase.from('aegis_memory').insert({
    company_id: ctx.company_id,
    memory_type: 'pattern',
    source: 'time_off_decision_history',
    content: JSON.stringify({
      employee_id: ctx.employee_id,
      employee_name: ctx.employee_name,
      action,
      start_date: tor.start_date,
      end_date: tor.end_date,
      reason: tor.reason,
      decided_at: new Date().toISOString(),
    }),
  })

  // An APPROVED call-out marks the shift on the schedule: stays on, greyed,
  // unpaid (Alexander, 2026-08-27).
  if (isCallOut && approves) {
    try {
      await markAssignmentsCalledOut({
        company_id: ctx.company_id,
        employee_id: ctx.employee_id,
        dates: ctx.call_out!.map(s => s.date),
      })
    } catch (err) {
      console.error('[callout-decision] failed to mark call-out on schedule:', err)
    }
  }

  // Approve & find coverage — blast the qualified pool, prefilled, idempotent.
  let coverage: CallOutCoverageOutcome | null = null
  if (action === 'approve_and_cover' && isCallOut) {
    try {
      const directory = await resolveManagers(ctx.company_id)
      const clicker = directory.managers.find(m => m.userId === ctx.manager_user_id) ?? null
      const soonest = [...ctx.call_out!].sort((a, b) =>
        `${a.date}T${a.start_time}`.localeCompare(`${b.date}T${b.start_time}`))[0]
      coverage = await startCoverageForCallOut({
        companyId: ctx.company_id,
        timeOffRequestId: ctx.request_id,
        absentEmployeeId: ctx.employee_id,
        absentEmployeeName: ctx.employee_name,
        shiftDate: soonest.date,
        shiftNameHint: soonest.shift_name,
        manager: {
          userId: ctx.manager_user_id ?? null,
          name: ctx.manager_name ?? clicker?.name ?? null,
          email: clicker?.email ?? null,
          phone: clicker?.phone ?? null,
        },
      })
    } catch (err) {
      console.error('[callout-decision] failed to start call-out coverage:', err)
    }
  }

  // Tell the employee.
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('id', ctx.employee_id)
    .eq('company_id', ctx.company_id)
    .single()
  try {
    await notifyEmployeeOfDecision(ctx, empData as Employee | null, action, tor)
  } catch (err) {
    console.error('[callout-decision] employee notification failed:', err)
  }

  return { outcome: 'applied', action, coverage, startDate: tor.start_date, endDate: tor.end_date }
}

// ── The manager's pending text-reply state ───────────────────────────────────
// One row PER MANAGER PER CALL-OUT (`callout_decision:{userId}:{requestId}`),
// minted when the nudge goes out. A reply resolves against these; the row also
// carries the one-question clarifier state (`awaiting`).

export interface PendingCallOutDecision extends TimeOffDecisionContext {
  /** After an ambiguous reply, what the NEXT yes/no-ish answer means. */
  awaiting?: 'cover_choice' | 'deny_confirm'
  expires_at: string
  _memory_id?: string
}

function calloutDecisionSource(managerUserId: string, requestId: string): string {
  return `callout_decision:${managerUserId}:${requestId}`
}

export async function storeCallOutDecisionPending(
  managerUserId: string,
  ctx: TimeOffDecisionContext,
): Promise<void> {
  const row: PendingCallOutDecision = {
    ...ctx,
    manager_user_id: managerUserId,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }
  const source = calloutDecisionSource(managerUserId, ctx.request_id)
  await supabase.from('aegis_memory').delete().eq('company_id', ctx.company_id).eq('source', source)
  await supabase.from('aegis_memory').insert({
    company_id: ctx.company_id,
    memory_type: 'observation',
    source,
    content: JSON.stringify(row),
  })
}

export async function getPendingCallOutDecisions(
  companyId: string,
  managerUserId: string,
): Promise<PendingCallOutDecision[]> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .like('source', `callout_decision:${managerUserId}:%`)
  const out: PendingCallOutDecision[] = []
  const now = new Date()
  for (const rowRaw of (data ?? []) as Array<{ id: string; content: string }>) {
    try {
      const row = JSON.parse(rowRaw.content) as PendingCallOutDecision
      if (new Date(row.expires_at) < now) {
        await supabase.from('aegis_memory').delete().eq('id', rowRaw.id)
        continue
      }
      out.push({ ...row, _memory_id: rowRaw.id })
    } catch { /* skip malformed */ }
  }
  return out
}

export async function clearCallOutDecisionPendingForRequest(companyId: string, requestId: string): Promise<void> {
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', companyId)
    .like('source', 'callout_decision:%')
    .like('content', `%${requestId}%`)
}

async function updatePendingRow(row: PendingCallOutDecision, patch: Partial<PendingCallOutDecision>): Promise<void> {
  if (!row._memory_id) return
  const { _memory_id, ...data } = { ...row, ...patch }
  await supabase.from('aegis_memory').update({ content: JSON.stringify(data) }).eq('id', _memory_id)
}

// ── Deterministic reply parsing ──────────────────────────────────────────────
export type CallOutReplyParse =
  | { kind: 'action'; action: TimeOffDecisionAction }
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'none' }

export function parseCallOutDecisionReply(body: string): CallOutReplyParse {
  const t = (body || '').trim().toLowerCase().replace(/[.!]+$/, '')
  if (!t) return { kind: 'none' }

  const coverWords = /\b(find|get|arrange|need|send out|blast|text)\b.*\bcover(age)?\b|\bcover (it|her|him|them|the shift)\b|\bask the team\b|\bfind (someone|somebody|a sub|a replacement)\b|\bapprove (and|&) cover\b/
  const gotItWords = /\bi('| ha)?ve got (it|this|coverage)\b|\bi got (it|this)\b|\bi'?ll (handle|sort|cover|take care of|figure)( (it|this|that|coverage))?\b|\bhandle (it|coverage) myself\b|\bapprove only\b|\bjust approve\b|\bno coverage( needed)?\b/
  const approveWords = /\bapprove[ds]?\b|\bgranted\b|\bthat'?s fine\b|\bok(ay)? with me\b|\blet (her|him|them) off\b|\bgive (her|him|them) the (day|night) off\b/
  const denyWords = /\bden(y|ied)\b|\bdecline[ds]?\b|\brefuse[ds]?\b|\bnot approved\b|\bcan'?t approve\b|\b(she|he|they) (has|have|needs?) to (come in|work|show up)\b|\bno dice\b/

  if (denyWords.test(t)) return { kind: 'action', action: 'deny' }
  if (coverWords.test(t)) return { kind: 'action', action: 'approve_and_cover' }
  if (gotItWords.test(t)) return { kind: 'action', action: 'approve' }
  if (approveWords.test(t)) {
    // "approve" alone doesn't say who handles coverage — that's the one
    // clarifying question, not a guess.
    return { kind: 'yes' }
  }
  if (/^(yes|yeah|yep|yup|ok|okay|sure|do it|go ahead)$/.test(t)) return { kind: 'yes' }
  if (/^(no|nope|nah)$/.test(t)) return { kind: 'no' }
  return { kind: 'none' }
}

// Which open call-out does a reply name? First-name match against the pending
// rows — "mia's" / "for Mia" / "the mia one".
export function matchCallOutByName(rows: PendingCallOutDecision[], body: string): PendingCallOutDecision | null {
  const t = (body || '').toLowerCase()
  const hits = rows.filter(r => {
    const first = firstName(r.employee_name).toLowerCase()
    return first !== 'there' && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s)?\\b`).test(t)
  })
  return hits.length === 1 ? hits[0] : null
}

// ── The router hook ──────────────────────────────────────────────────────────
// Returns true when the message was a call-out decision (or its clarifier) and
// was fully handled; false = not ours, keep routing. Conservative by design:
// with no `awaiting` set, only an EXPLICIT phrase acts — a bare "yes" asks the
// one clarifying question; anything else falls through untouched.
export async function handleCallOutDecisionReply(
  message: InboundMessage,
  contact: VerifiedContact,
): Promise<boolean> {
  if (!contact.user_id) return false
  const rows = await getPendingCallOutDecisions(contact.company_id, contact.user_id)
  if (rows.length === 0) return false

  // Drop rows whose request has been decided through the other door meanwhile.
  const live: PendingCallOutDecision[] = []
  for (const row of rows) {
    const { data } = await supabase
      .from('time_off_requests')
      .select('status')
      .eq('id', row.request_id)
      .maybeSingle()
    const status = (data as { status?: string } | null)?.status
    if (status === 'pending') { live.push(row); continue }
    if (row._memory_id) await supabase.from('aegis_memory').delete().eq('id', row._memory_id)
  }
  if (live.length === 0) return false

  const parsed = parseCallOutDecisionReply(message.body)
  const awaitingRow = live.find(r => r.awaiting)

  // Nothing recognisable and no clarifier open → not ours.
  if (parsed.kind === 'none' && !awaitingRow) return false
  if (parsed.kind === 'none' && awaitingRow) {
    // Mid-clarifier, an unrelated message: release the clarifier and let the
    // message route normally — never trap the manager (the W-2 gate rule).
    await updatePendingRow(awaitingRow, { awaiting: undefined })
    return false
  }

  // Resolve WHICH call-out. A clarifier in flight owns the answer; else a
  // named employee wins; else a single open row is unambiguous; else ask.
  let target = awaitingRow ?? matchCallOutByName(live, message.body)
  if (!target && live.length === 1) target = live[0]
  if (!target) {
    const list = live
      .map(r => `${firstName(r.employee_name)}'s ${r.call_out?.[0]?.shift_name ?? 'shift'}`)
      .join(' and ')
    await reply(contact, message,
      `You've got ${live.length} call-outs waiting — ${list}. Whose are you answering? Say the name and the call ("find coverage for Mia", "deny Katie's").`)
    return true
  }

  const shiftWord = target.call_out?.[0]?.shift_name ? `${target.call_out[0].shift_name} shift` : 'shift'
  const empFirst = firstName(target.employee_name)

  // Clarifier answers.
  if (target.awaiting === 'deny_confirm') {
    if (parsed.kind === 'yes') {
      return await act(target, 'deny')
    }
    await updatePendingRow(target, { awaiting: undefined })
    await reply(contact, message,
      `Okay — nothing decided. ${empFirst}'s call-out is still waiting; answer here ("find coverage", "approve — I've got it", "deny") or use the email buttons.`)
    return true
  }
  if (target.awaiting === 'cover_choice') {
    if (parsed.kind === 'action') return await act(target, parsed.action)
    if (parsed.kind === 'yes') return await act(target, 'approve_and_cover') // "yes" to "want me to find coverage?"
    if (parsed.kind === 'no') return await act(target, 'approve')            // "no" = approve, they handle it
  }

  // Fresh replies.
  if (parsed.kind === 'action') return await act(target, parsed.action)
  if (parsed.kind === 'yes') {
    await updatePendingRow(target, { awaiting: 'cover_choice' })
    await reply(contact, message,
      `Approving ${empFirst}'s call-out — want me to find coverage for the ${shiftWord} too, or have you got it?`)
    return true
  }
  if (parsed.kind === 'no') {
    await updatePendingRow(target, { awaiting: 'deny_confirm' })
    await reply(contact, message,
      `Just to be sure — deny ${empFirst}'s call-out? ${empFirst} would still be expected for the ${shiftWord}.`)
    return true
  }
  return false

  async function act(row: PendingCallOutDecision, action: TimeOffDecisionAction): Promise<true> {
    const result = await applyTimeOffDecision(row, action, 'text_reply')
    await reply(contact, message, describeDecisionResultForManager(row, action, result))
    return true
  }
}

// One voice for the manager's receipt, mirroring the email landing pages.
export function describeDecisionResultForManager(
  ctx: TimeOffDecisionContext,
  action: TimeOffDecisionAction,
  result: TimeOffDecisionResult,
): string {
  const empFirst = firstName(ctx.employee_name)
  const shiftWord = ctx.call_out?.[0]?.shift_name ? `${ctx.call_out[0].shift_name} shift` : 'shift'
  if (result.outcome === 'not_found') {
    return `I couldn't find that request anymore — check the Time Off tab in Homebase for where it stands.`
  }
  if (result.outcome === 'already_decided') {
    if (result.coverageOpen) {
      return result.coverageOpen.filled
        ? `Already handled — the ${result.coverageOpen.shiftName} shift is covered; a teammate accepted.`
        : `Already on it — the absence is approved and I'm out asking teammates to cover the ${result.coverageOpen.shiftName} shift. I'll tell you the moment someone accepts.`
    }
    return `Already handled — that one was ${result.status} earlier. Nothing changed just now.`
  }
  // Plain (non-call-out) time off — the email-link door now lands here too
  // (N-3: the Homebase confirm page dispatches through the same core), so the
  // receipt must speak time-off, not call-out, when there is no shift at stake.
  const isCallOut = !!ctx.call_out?.length
  if (!isCallOut && result.outcome === 'applied') {
    const dates = formatDateRange(result.startDate, result.endDate)
    return action === 'deny'
      ? `Done — I've told ${empFirst} their time off for ${dates} is denied.`
      : `Done — ${empFirst}'s time off for ${dates} is approved and they've been told.`
  }
  if (action === 'deny') {
    return `Done — I've told ${empFirst} the call-out is denied and they're still expected for the ${shiftWord}.`
  }
  if (action === 'approve_and_cover') {
    const c = result.coverage
    if (c?.outcome === 'started') {
      return `On it — ${empFirst} is approved and off, and I'm texting ${c.contacted.length} qualified teammate${c.contacted.length === 1 ? '' : 's'} about the ${c.shiftName} shift right now. I'll tell you the moment someone says yes.`
    }
    if (c?.outcome === 'already_open') {
      return `${empFirst} is approved, and coverage for the ${c.shiftName} shift was already underway — I'll keep you posted.`
    }
    if (c?.outcome === 'choose') {
      return `${empFirst} is approved and off. Everyone qualified for the ${c.shiftName} shift is already working that day, so I haven't texted anyone — I've sent you the list to pick from.`
    }
    if (c?.outcome === 'no_candidates') {
      return `${empFirst} is approved and off, but I couldn't find anyone qualified and available to cover the ${c.shiftName} shift — this one needs your hands directly, sorry.`
    }
    return `${empFirst} is approved and off, but I couldn't line the shift up for automatic coverage — please handle coverage directly.`
  }
  return `Done — ${empFirst} is off and I've let them know you're handling coverage. The ${shiftWord} stays on the schedule, greyed out, until you fill it.`
}
