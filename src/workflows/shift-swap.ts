import { randomUUID } from 'crypto';
import { supabase } from '../db/client';
// RULE 0b — ONE question, ONE function. "Can this person work this slot?" is
// answered in exactly one place for the whole product. See src/lib/qualification.ts.
import { isQualified, acceptedRolesOf, roleLabel, resolveAcceptedRoles } from '../lib/qualification';
import { coerceJsonObject } from '../utils/coerce-json';
import { logActivity } from '../logger/activity-log';
import { formatClockRange } from '../lib/shift-hours';
// W-2 (C-5/J-4) — deterministic confirm-gate edit readings (shared, Rule 0b).
import { parseNamedDirective, parseWillingDaysReply, parseShiftAnswer } from '../lib/confirm-edits';
import { reply } from '../messaging/reply';
import { sendSms } from '../messaging/sms';
import { sendEmail } from '../messaging/email';
import { greeting, firstName, textOpener, managerAlertSms } from '../messaging/greeting';
import { generateReply, weekdayAnchors } from '../ai/claude';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { env } from '../config/env';
import {
  BRAND,
  brandedEmailShell,
  brandedButtonRow,
  brandActionCard,
  brandCardDetailLine,
} from '../messaging/brand';
import { generateActionToken } from '../lib/aegis-actions/tokens';
import { resolveAvailabilityForWeek } from '../lib/custom-availability';
// L4 — RULE 0b: one question ("what kind of swap is this?"), one function.
import { withSwapKind } from '../lib/swap-kind';
import { resolveManagers, primaryRecipient } from '../messaging/manager-directory';
// W-2 (C-2) — withdrawals notify managers through the one shared resolver.
import { sendManagerResolutionNotice } from '../messaging/manager-resolution-notice';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, Policy, Availability, CustomAvailability } from '../db/types';
import type { ScheduleAssignment } from './schedule-build';

// ── Schedule types (shared shape with emergency-coverage and schedule-build) ──

interface ScheduleData {
  assignments: ScheduleAssignment[];
}

// ── Public state types ────────────────────────────────────────────────────────

// How long a requester's unconfirmed swap ("reply yes to send it") stays valid.
// Bumped 1h → 24h to match the pending-time-off TTL (BUG-6): email round-trips
// routinely lag more than an hour, and a "yes" that arrives after expiry falls
// through to handleRespondSwap's "nothing pending" dead-end.
const PENDING_SWAP_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingSwap {
  mode: 'directed' | 'facilitated';
  company_id: string;
  requester_id: string;
  requester_name: string;
  channel: 'sms' | 'email';
  sender: string;
  recipient: string;
  raw_subject?: string;
  thread_id?: string;
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  // Mode 1 only:
  target_employee_id?: string;
  target_employee_name?: string;
  // Two-way trade (item 18): the target's shift the requester takes in return.
  // When present, the swap is a true trade (both employees switch shifts); when
  // absent, the legacy one-way behavior applies (facilitated / older records).
  target_shift_date?: string;
  target_shift_name?: string;
  target_role?: string;
  target_shift_start?: string;
  target_shift_end?: string;
  // Facilitated only: weekdays (0=Sun..6=Sat) the requester can work in return.
  // Drives the swap option on the broadcast; empty → the broadcast is pickup-only.
  willing_days?: number[];
  // ── W-2 (J-4): an OPEN QUESTION keeps its state ─────────────────────────────
  // "Which shift did you want to swap?" used to keep nothing: the answer
  // ("Sunday") re-entered the router cold and was re-classified as a schedule
  // query. When set, this pending row is that open question, `raw` holds
  // everything already extracted, and the next reply is read as the ANSWER
  // (parseShiftAnswer) — never re-classified. The shift_* fields hold
  // placeholders while awaiting is set.
  awaiting?: 'which_shift' | 'which_target_shift';
  raw?: StoredSwapExtraction;
  expires_at: string;
}

// The extractor's output, persisted across an open question so the model is
// never re-asked (MINIMIZE LLM CALLS — the answer merges into this).
export interface StoredSwapExtraction {
  direction: SwapDirection;
  shift_date: string | null;
  shift_name: string | null;
  target_employee_name: string | null;
  target_shift_date: string | null;
  target_shift_name: string | null;
  willing_days: number[];
}

export interface SwapOutreach {
  mode: 'directed' | 'facilitated';
  company_id: string;
  requester_id: string;
  requester_name: string;
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  requester_recipient: string;
  requester_raw_subject?: string;
  requester_thread_id?: string;
  receiver_id: string;
  receiver_phone: string;          // '' when reaching the receiver by email only
  receiver_email?: string;         // email-first outreach target
  aegis_sms_channel: string;       // '' when there's no SMS channel (email-only)
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  // Two-way trade (item 18): the target's shift the requester takes in return.
  target_shift_date?: string;
  target_shift_name?: string;
  target_role?: string;
  target_shift_start?: string;
  target_shift_end?: string;
  // Mode 2: remaining candidates not yet contacted (empty for Mode 1)
  candidate_queue: string[];
  outreach_sent_at: string;
  expires_at: string;
}

interface ValidationResult {
  valid: boolean;
  reason: string | null;
  policy_note?: string;
}

// ── Store helpers ─────────────────────────────────────────────────────────────

export async function getPendingSwap(
  companyId: string,
  employeeId: string
): Promise<(PendingSwap & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `swap_pending:${employeeId}`)
    .maybeSingle();

  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const pending = JSON.parse(row.content) as PendingSwap;
    if (new Date(pending.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...pending, _memory_id: row.id };
  } catch {
    return null;
  }
}

export async function getActiveSwapOutreach(
  companyId: string,
  employeeId: string
): Promise<(SwapOutreach & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', `swap_outreach:${employeeId}`)
    .maybeSingle();

  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const outreach = JSON.parse(row.content) as SwapOutreach;
    // W-2 — every other gate expires on read; this one never did, so a stale
    // outreach could trap its receiver's messages long after the 2h window.
    if (new Date(outreach.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...outreach, _memory_id: row.id };
  } catch {
    return null;
  }
}

async function storePendingSwap(pending: PendingSwap): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', pending.company_id)
    .eq('source', `swap_pending:${pending.requester_id}`);
  await supabase.from('aegis_memory').insert({
    company_id: pending.company_id,
    memory_type: 'observation',
    source: `swap_pending:${pending.requester_id}`,
    content: JSON.stringify(pending),
  });
}

async function clearPendingSwap(companyId: string, requesterId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `swap_pending:${requesterId}`);
}

async function storeSwapOutreach(outreach: SwapOutreach): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', outreach.company_id)
    .eq('source', `swap_outreach:${outreach.receiver_id}`);
  await supabase.from('aegis_memory').insert({
    company_id: outreach.company_id,
    memory_type: 'observation',
    source: `swap_outreach:${outreach.receiver_id}`,
    content: JSON.stringify(outreach),
  });
}

async function clearSwapOutreach(companyId: string, receiverId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', `swap_outreach:${receiverId}`);
}

// ── #10 broadcast state (one in-flight broadcast per requester) ────────────────
function swapBroadcastSource(requesterId: string): string {
  return `swap_broadcast:${requesterId}`;
}

export async function storeSwapBroadcast(broadcast: SwapBroadcast): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', broadcast.company_id)
    .eq('source', swapBroadcastSource(broadcast.requester_id));
  await supabase.from('aegis_memory').insert({
    company_id: broadcast.company_id,
    memory_type: 'observation',
    source: swapBroadcastSource(broadcast.requester_id),
    content: JSON.stringify(broadcast),
  });
}

export async function getSwapBroadcast(
  companyId: string,
  requesterId: string,
): Promise<(SwapBroadcast & { _memory_id: string }) | null> {
  const { data } = await supabase.from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', swapBroadcastSource(requesterId))
    .maybeSingle();
  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const broadcast = JSON.parse(row.content) as SwapBroadcast;
    if (new Date(broadcast.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...broadcast, _memory_id: row.id };
  } catch {
    return null;
  }
}

export type SwapCommitGuard = { allowed: true } | { allowed: false; reason: 'expired' | 'locked' | 'withdrawn' };

// First-commit-wins: only an OPEN broadcast accepts a commit. A locked one is
// already being handled by whoever committed first; a missing one has expired;
// a WITHDRAWN one was called off by the requester (W-2/C-2) — the acceptance
// must be refused kindly, never recorded.
// (Residual race between read + lock is acceptable here — the manager approval is
// the final gate; a DB-level atomic guard is a logged hardening follow-up.)
export function swapBroadcastCommitGuard(
  broadcast: { status: 'open' | 'locked' | 'withdrawn' } | null,
): SwapCommitGuard {
  if (!broadcast) return { allowed: false, reason: 'expired' };
  if (broadcast.status === 'withdrawn') return { allowed: false, reason: 'withdrawn' };
  if (broadcast.status === 'locked') return { allowed: false, reason: 'locked' };
  return { allowed: true };
}

// A candidate clicked "I'll pick it up." Lock the broadcast, create a one-way
// pickup swap_request (pending manager), tell the requester someone grabbed it,
// and email the manager the approve/deny (reusing the existing swap magic-link
// path — on approve, webhooks/decision.ts does the one-way reassignment + notifies
// both). Returns the message the Homebase landing page shows the candidate.
export async function commitSwapPickup(params: {
  company_id: string;
  requester_id: string;
  receiver_id: string;
}): Promise<{ ok: boolean; message: string }> {
  const broadcast = await getSwapBroadcast(params.company_id, params.requester_id);
  const guard = swapBroadcastCommitGuard(broadcast);
  if (!guard.allowed) {
    return {
      ok: false,
      message: guard.reason === 'withdrawn'
        ? `${firstName(broadcast!.requester_name)} doesn't need that shift covered anymore — it's been called off. Thanks for offering!`
        : guard.reason === 'locked'
        ? "Someone just grabbed this shift — it's being handled now. Thanks for jumping on it!"
        : "This shift request has expired or already been resolved. Nothing more to do here.",
    };
  }
  const b = broadcast!;
  // Lock it so no one else can also commit.
  await storeSwapBroadcast({ ...b, status: 'locked', locked_by: params.receiver_id });

  const [{ data: recvData }, { data: reqData }] = await Promise.all([
    supabase.from('employees').select('*').eq('id', params.receiver_id).single(),
    supabase.from('employees').select('*').eq('id', params.requester_id).single(),
  ]);
  const receiver = recvData as Employee | null;
  const requester = reqData as Employee | null;
  if (!receiver || !requester) {
    return { ok: false, message: 'Something went wrong finding the right records — please contact your manager.' };
  }

  // One-way pickup → pending manager.
  const { data: swapRow } = await supabase.from('swap_requests').insert({
    company_id: params.company_id,
    requesting_employee_id: params.requester_id,
    receiving_employee_id: params.receiver_id,
    shift_date: b.shift_date,
    shift_name: b.shift_name,
    role: b.role,
    status: 'pending_manager',
    initiated_by: 'aegis',
    // L4 — kind is now PERSISTED so the Homebase UI approval path can prove
    // this row is one-way instead of assuming it (see lib/swap-kind.ts).
    // L4b — kind persisted as a real COLUMN (migration 023). The notes marker
    // is written too, as the fallback for a 023 rollback.
    kind: 'pickup',
    notes: withSwapKind(`${receiver.name} offered to pick up the shift via the broadcast — one-way pickup (no trade).`, 'pickup'),
  }).select('id').single();
  const swapId = (swapRow as { id: string } | null)?.id ?? 'unknown';

  // Tell the requester someone is picking it up (their channel).
  const requesterMsg: InboundMessage = {
    sender: b.requester_sender, recipient: b.requester_recipient, body: '',
    channel: b.requester_channel, raw_subject: b.requester_raw_subject, thread_id: b.requester_thread_id,
  };
  const requesterContact: VerifiedContact = {
    role: 'employee', company_id: params.company_id, employee_id: params.requester_id,
    user_id: null, name: requester.name, matched_identifier: b.requester_sender, channel: b.requester_channel,
  };
  await reply(requesterContact, requesterMsg,
    `Good news — ${receiver.name} offered to pick up your ${b.shift_name} shift on ${formatDisplayDate(b.shift_date)}. ` +
    `It's pending your manager's approval now; I'll let you know the moment it's decided.`
  );

  // Manager approve/deny email (existing swap magic-link path; one-way = no target_*).
  const aegisSmsNumber = await getAegisSmsChannel(params.company_id);
  await sendManagerSwapApprovalRequest({
    company_id: params.company_id,
    swap_request_id: swapId,
    requester,
    requester_channel: b.requester_channel,
    requester_sender: b.requester_sender,
    receiver,
    shift_date: b.shift_date,
    shift_name: b.shift_name,
    role: b.role,
    shift_start: b.shift_start,
    shift_end: b.shift_end,
    aegis_sms_channel: aegisSmsNumber,
  });

  await logActivity({
    company_id: params.company_id,
    action: 'swap_pickup_committed',
    entity_type: 'swap_request',
    entity_id: swapId,
    summary: `${receiver.name} offered to pick up ${requester.name}'s ${b.shift_name} on ${b.shift_date} (pending manager)`,
    metadata: { requester_id: params.requester_id, receiver_id: params.receiver_id, shift_date: b.shift_date, mode: 'pickup' },
  });

  return {
    ok: true,
    message: `Thanks, ${firstName(receiver.name)}! Your manager has been asked to approve you picking up the ${b.shift_name} shift on ${formatDisplayDate(b.shift_date)}. You'll get a note once it's confirmed.`,
  };
}

// ── #10 swap proposal (two-way trade, pending the requester's agreement) ──────
// Recorded when a candidate selects which of their own shifts to trade on the
// swap-picker page. Stage 4 reads this to ask the requester to agree, then routes
// to manager approval + executeScheduleTrade (or reopens on a requester decline).
export interface SwapProposal {
  company_id: string;
  requester_id: string;
  requester_name: string;
  receiver_id: string;
  receiver_name: string;
  // The requester's shift (being given up).
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  // The receiver's shift the requester would take in return.
  target_shift_date: string;
  target_shift_name: string;
  target_role: string;
  target_shift_start: string;
  target_shift_end: string;
  // Requester contact for the agree/decline notice.
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  requester_recipient: string;
  requester_raw_subject?: string;
  requester_thread_id?: string;
  expires_at: string;
}

function swapProposalSource(requesterId: string): string {
  return `swap_proposal:${requesterId}`;
}

export async function storeSwapProposal(proposal: SwapProposal): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', proposal.company_id)
    .eq('source', swapProposalSource(proposal.requester_id));
  await supabase.from('aegis_memory').insert({
    company_id: proposal.company_id,
    memory_type: 'observation',
    source: swapProposalSource(proposal.requester_id),
    content: JSON.stringify(proposal),
  });
}

export async function getSwapProposal(
  companyId: string,
  requesterId: string,
): Promise<(SwapProposal & { _memory_id: string }) | null> {
  const { data } = await supabase.from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .eq('source', swapProposalSource(requesterId))
    .maybeSingle();
  if (!data) return null;
  try {
    const row = data as { id: string; content: string };
    const proposal = JSON.parse(row.content) as SwapProposal;
    if (new Date(proposal.expires_at) < new Date()) {
      await supabase.from('aegis_memory').delete().eq('id', row.id);
      return null;
    }
    return { ...proposal, _memory_id: row.id };
  } catch {
    return null;
  }
}

// A candidate picked which of their own shifts to trade on the swap page. Lock the
// broadcast (first-commit-wins), record the proposal, and return the message the
// page shows. Stage 4 then asks the requester to agree → manager → execute.
export async function proposeSwapTrade(params: {
  company_id: string;
  requester_id: string;
  receiver_id: string;
  selected_shift: { date: string; shift_name: string; role: string; start_time: string; end_time: string };
}): Promise<{ ok: boolean; message: string }> {
  const broadcast = await getSwapBroadcast(params.company_id, params.requester_id);
  const guard = swapBroadcastCommitGuard(broadcast);
  if (!guard.allowed) {
    return {
      ok: false,
      message: guard.reason === 'withdrawn'
        ? `${firstName(broadcast!.requester_name)} doesn't need that shift covered anymore — it's been called off. Thanks for offering!`
        : guard.reason === 'locked'
        ? "Someone just acted on this shift — it's being handled now. Thanks for offering!"
        : "This shift request has expired or already been resolved. Nothing more to do here.",
    };
  }
  const b = broadcast!;
  await storeSwapBroadcast({ ...b, status: 'locked', locked_by: params.receiver_id });

  const { data: recvData } = await supabase.from('employees').select('id, name')
    .eq('id', params.receiver_id).single();
  const receiver = recvData as { id: string; name: string } | null;
  if (!receiver) {
    return { ok: false, message: 'Something went wrong finding your record — please contact your manager.' };
  }

  const sel = params.selected_shift;
  await storeSwapProposal({
    company_id: params.company_id,
    requester_id: params.requester_id,
    requester_name: b.requester_name,
    receiver_id: params.receiver_id,
    receiver_name: receiver.name,
    shift_date: b.shift_date,
    shift_name: b.shift_name,
    role: b.role,
    shift_start: b.shift_start,
    shift_end: b.shift_end,
    schedule_id: b.schedule_id,
    target_shift_date: sel.date,
    target_shift_name: sel.shift_name,
    target_role: sel.role,
    target_shift_start: sel.start_time,
    target_shift_end: sel.end_time,
    requester_channel: b.requester_channel,
    requester_sender: b.requester_sender,
    requester_recipient: b.requester_recipient,
    requester_raw_subject: b.requester_raw_subject,
    requester_thread_id: b.requester_thread_id,
    expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
  });

  await logActivity({
    company_id: params.company_id,
    action: 'swap_proposed',
    summary: `${receiver.name} offered to trade their ${sel.shift_name} (${formatDisplayDate(sel.date)}) for ${b.requester_name}'s ${b.shift_name} (${formatDisplayDate(b.shift_date)}) — pending ${b.requester_name}'s agreement`,
    metadata: { requester_id: params.requester_id, receiver_id: params.receiver_id, shift_date: b.shift_date, target_shift_date: sel.date, mode: 'swap' },
  });

  // Ask the requester to Agree/Decline the trade. The actionable Agree/Decline
  // magic-link buttons live in the EMAIL; for a phone-holding requester we also
  // send an SMS-first heads-up pointing to it (Batch-1.5 #10 — the trade branch
  // used to notify the requester by email only, unlike the pickup branch).
  const { data: reqData } = await supabase.from('employees').select('id, name, contact_email, contact_phone')
    .eq('id', params.requester_id).single();
  const requesterRec = reqData as { id: string; name: string; contact_email: string | null; contact_phone: string | null } | null;
  const requesterEmail = requesterRec?.contact_email
    ?? (b.requester_channel === 'email' ? b.requester_sender : null);

  // SMS-first heads-up (the buttons are in the email that follows). Mirrors the
  // pickup path's reply() on the requester's submission channel; gated off under
  // EMAIL_ONLY so it doesn't double up with the email fallback.
  if (!env.EMAIL_ONLY && b.requester_channel === 'sms') {
    const requesterMsgOut: InboundMessage = {
      sender: b.requester_sender, recipient: b.requester_recipient, body: '',
      channel: b.requester_channel, raw_subject: b.requester_raw_subject, thread_id: b.requester_thread_id,
    };
    const requesterContactOut: VerifiedContact = {
      role: 'employee', company_id: params.company_id, employee_id: params.requester_id,
      user_id: null, name: b.requester_name, matched_identifier: b.requester_sender, channel: b.requester_channel,
    };
    const emailPointer = requesterEmail
      ? ` I've emailed you the details — open it to Agree or Decline and I'll finish it up.`
      : ` Your manager can help you confirm it.`;
    await reply(requesterContactOut, requesterMsgOut,
      `${firstName(receiver.name)} offered to trade their ${sel.shift_name} shift on ${formatDisplayDate(sel.date)} for your ${b.shift_name} shift on ${formatDisplayDate(b.shift_date)}.${emailPointer}`
    );
  }

  if (requesterEmail) {
    const { subject, text, html } = await buildSwapProposalEmail({
      company_id: params.company_id,
      requester: { id: params.requester_id, name: b.requester_name, email: requesterEmail },
      receiver_id: params.receiver_id,
      receiver_name: receiver.name,
      shift_name: b.shift_name,
      shift_date: b.shift_date,
      shift_start: b.shift_start,
      shift_end: b.shift_end,
      shift_role: b.role,
      target_shift_name: sel.shift_name,
      target_shift_date: sel.date,
      target_shift_start: sel.start_time,
      target_shift_end: sel.end_time,
      target_role: sel.role,
    });
    await sendEmail({ to: requesterEmail, subject, text, html, company_id: params.company_id });
  }

  return {
    ok: true,
    message: `Thanks, ${firstName(receiver.name)}! I've recorded your offer to trade your ${sel.shift_name} shift on ${formatDisplayDate(sel.date)} for ${b.requester_name}'s ${b.shift_name}. I've asked ${firstName(b.requester_name)} to confirm the trade — you'll hear back once it's settled.`,
  };
}

async function clearSwapProposal(companyId: string, requesterId: string): Promise<void> {
  await supabase.from('aegis_memory').delete()
    .eq('company_id', companyId)
    .eq('source', swapProposalSource(requesterId));
}

// The requester clicked Agree or Decline on a proposed trade.
//  • AGREE  → create the two-way swap_request (pending manager) + email the manager
//             (existing approve/deny path → executeScheduleTrade on approval) +
//             tell the candidate it's pending manager.
//  • DECLINE → REOPEN the broadcast (status back to open) so remaining candidates'
//             email buttons work again, and tell the candidate the trade is off.
export async function resolveSwapProposal(params: {
  company_id: string;
  requester_id: string;
  decision: 'agree' | 'decline';
}): Promise<{ ok: boolean; message: string }> {
  const proposal = await getSwapProposal(params.company_id, params.requester_id);
  if (!proposal) {
    return { ok: false, message: 'This trade offer has expired or was already handled. Nothing more to do here.' };
  }
  const p = proposal;

  const [{ data: reqData }, { data: recvData }] = await Promise.all([
    supabase.from('employees').select('*').eq('id', p.requester_id).single(),
    supabase.from('employees').select('*').eq('id', p.receiver_id).single(),
  ]);
  const requester = reqData as Employee | null;
  const receiver = recvData as Employee | null;
  if (!requester || !receiver) {
    return { ok: false, message: 'Something went wrong finding the right records — please contact your manager.' };
  }

  const aegisSmsNumber = await getAegisSmsChannel(params.company_id);

  if (params.decision === 'decline') {
    const broadcast = await getSwapBroadcast(params.company_id, params.requester_id);
    if (broadcast) {
      await storeSwapBroadcast({ ...broadcast, status: 'open', locked_by: null });
    }
    await clearSwapProposal(params.company_id, params.requester_id);

    await sendOutreachMessage({
      receiverId: receiver.id,
      receiverEmail: receiver.contact_email ?? null,
      receiverPhone: receiver.contact_phone ?? null,
      aegisSmsNumber,
      subject: `Update on the ${p.shift_name} trade`,
      text: `${textOpener(receiver.name)}thanks for offering to trade — ${firstName(p.requester_name)} decided to keep their original shift, so this trade won't go ahead. No action needed on your end.`,
      company_id: params.company_id,
    });

    await logActivity({
      company_id: params.company_id,
      action: 'swap_proposal_declined',
      summary: `${p.requester_name} declined ${receiver.name}'s trade offer — broadcast reopened`,
      metadata: { requester_id: p.requester_id, receiver_id: p.receiver_id, mode: 'swap' },
    });

    return { ok: true, message: `No problem — I've let ${firstName(receiver.name)} know, and your shift is open again for someone else to grab.` };
  }

  // AGREE → two-way swap_request (pending manager) + manager approve/deny email.
  const { data: swapRow } = await supabase.from('swap_requests').insert({
    company_id: params.company_id,
    requesting_employee_id: p.requester_id,
    receiving_employee_id: p.receiver_id,
    shift_date: p.shift_date,
    shift_name: p.shift_name,
    role: p.role,
    status: 'pending_manager',
    initiated_by: 'aegis',
    // L4 — marked as a TRADE so the Homebase UI approval path refuses it
    // rather than running it as a one-way giveaway and dropping the return leg.
    // L4b — THE RETURN SHIFT IS NOW STORED. It used to live only in the
    // decision-token payload on the manager's approval email, which is why the
    // Homebase UI could not approve a trade without dropping a leg.
    kind: 'trade',
    target_shift_date: p.target_shift_date ?? null,
    target_shift_name: p.target_shift_name ?? null,
    target_shift_role: p.target_role ?? null,
    notes: withSwapKind(`Two-way trade agreed by both via the broadcast: ${p.requester_name} gives ${p.shift_name} (${p.shift_date}) and takes ${p.target_shift_name} (${p.target_shift_date}).`, 'trade'),
  }).select('id').single();
  const swapId = (swapRow as { id: string } | null)?.id ?? 'unknown';

  await sendManagerSwapApprovalRequest({
    company_id: params.company_id,
    swap_request_id: swapId,
    requester,
    requester_channel: p.requester_channel,
    requester_sender: p.requester_sender,
    receiver,
    shift_date: p.shift_date,
    shift_name: p.shift_name,
    role: p.role,
    shift_start: p.shift_start,
    shift_end: p.shift_end,
    aegis_sms_channel: aegisSmsNumber,
    target_shift_date: p.target_shift_date,
    target_shift_name: p.target_shift_name,
    target_role: p.target_role,
    target_shift_start: p.target_shift_start,
    target_shift_end: p.target_shift_end,
  });

  await sendOutreachMessage({
    receiverId: receiver.id,
    receiverEmail: receiver.contact_email ?? null,
    receiverPhone: receiver.contact_phone ?? null,
    aegisSmsNumber,
    subject: `Your trade with ${firstName(p.requester_name)} — pending manager`,
    text: `${textOpener(receiver.name)}${firstName(p.requester_name)} agreed to the trade! It's with your manager for the final OK now — I'll let you know the moment it's confirmed.`,
    company_id: params.company_id,
  });

  await clearSwapProposal(params.company_id, params.requester_id);

  await logActivity({
    company_id: params.company_id,
    action: 'swap_proposal_agreed',
    entity_type: 'swap_request',
    entity_id: swapId,
    summary: `${p.requester_name} agreed to trade with ${receiver.name} — pending manager approval`,
    metadata: { requester_id: p.requester_id, receiver_id: p.receiver_id, shift_date: p.shift_date, target_shift_date: p.target_shift_date, mode: 'swap' },
  });

  return { ok: true, message: `Great — I've sent the trade to your manager for the final OK. You and ${firstName(receiver.name)} will both hear back once it's approved.` };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function computeShiftHours(start: string, end: string): number {
  const toMins = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
  let mins = toMins(end) - toMins(start);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}

// C-7 helpers for the "not scheduled" reply.
function ordinalDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z').getUTCDate();
  const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
  return `${d}${suffix}`;
}

// "this Saturday (Aug 22)" when the date is within the coming week, else the long date.
export function describeDayForNotScheduled(dateStr: string, today: string): string {
  const weekday = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const short = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const diff = Math.round((new Date(dateStr + 'T12:00:00Z').getTime() - new Date(today + 'T12:00:00Z').getTime()) / 86_400_000);
  if (diff >= 0 && diff < 7) return `this ${weekday} (${short})`;
  return `on ${formatDisplayDate(dateStr)}`;
}

// The employee's own assignment on the same weekday one week later, if a
// schedule exists for it. Used only to offer "did you mean the 29th?".
async function suggestSameWeekdayNextWeek(companyId: string, employeeId: string, dateStr: string): Promise<ScheduleAssignment | null> {
  const next = new Date(dateStr + 'T12:00:00Z');
  next.setUTCDate(next.getUTCDate() + 7);
  const nextDate = next.toISOString().slice(0, 10);
  const sched = await findSchedule(companyId, nextDate);
  if (!sched) return null;
  return sched.data.assignments.find(a => a.employee_id === employeeId && a.date === nextDate) ?? null;
}

function formatDisplayDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
}

// Read a requester's willing WEEKDAYS (0=Sun..6=Sat integers) back to them by name,
// e.g. [3] -> "Wednesday", [1,3] -> "Monday or Wednesday". '' when none were given.
export function formatWeekdayNames(days: number[]): string {
  const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const labels = [...new Set(days)]
    .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b)
    .map(d => NAMES[d]);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

// Escape user-supplied / dynamic text before inlining into branded HTML.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Natural yes/no — the swap prompts are conversational ("Want me to run it by
// Riley?"), so accept real replies, not just a literal "yes": "yeah do it",
// "go for it", "send it", "sounds good" all confirm; "not quite", "hold on",
// "never mind" all decline.
export function parseYesNo(body: string): 'yes' | 'no' | 'unclear' {
  const lower = body.trim().toLowerCase();
  if (/^(yes|yeah|yea|yep|yup|sure|ok|okay|correct|confirm(ed)?|that'?s right|right|send(?: it| that| it over)?|go (?:ahead|for it)|do it|please do|please|sounds good|looks good|that works|perfect|great|👍)/.test(lower)) return 'yes';
  if (/^(no|nope|nah|can'?t|cannot|wrong|incorrect|cancel|don'?t|not (?:quite|right|yet)|never ?mind|hold on|wait|stop|forget it)/.test(lower)) return 'no';
  return 'unclear';
}

// Can we reach this candidate for facilitated (undirected) swap outreach?
// Reachable = has an email, OR has a phone AND the tenant has an active SMS
// channel. The broadcast fan-out is SMS-first for phone-holders (H19) with email
// as the fallback; either contact method on its own is enough to include them.
export function isReachableForOutreach(
  emp: { contact_email?: string | null; contact_phone?: string | null },
  hasSmsChannel: boolean,
): boolean {
  return !!(emp.contact_email || (emp.contact_phone && hasSmsChannel));
}

// ── #10 two-button broadcast (Alexander's redesign, 2026-06-28) ───────────────
// The undirected swap becomes a simultaneous broadcast with two options per
// candidate: PICK UP the requester's shift (one-way), or SWAP (two-way trade).
// These Stage-1 helpers are the analytical core the later stages consume.

// One in-flight broadcast for a requester's unwanted shift. Stored keyed by the
// requester; `status` flips open→locked the instant the FIRST candidate commits
// (a pickup confirm, or a swap proposal the requester then sees), so the shift
// can't be double-promised. On a requester-declined swap it reopens (status back
// to 'open', locked_by cleared) so remaining candidates can still act.
export interface SwapBroadcast {
  requester_id: string;
  requester_name: string;
  company_id: string;
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  requester_recipient: string;
  requester_raw_subject?: string;
  requester_thread_id?: string;
  // The shift the requester wants off their plate.
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  // Dates (YYYY-MM-DD) the requester is willing to WORK in return — drives which
  // of a candidate's own shifts are tradeable.
  willing_dates: string[];
  // W-2 (C-2): 'withdrawn' — the requester called it off. The record is KEPT
  // (not deleted) so a late "i can take it" or a late link tap gets a kind,
  // truthful refusal instead of committing an unwanted pickup (Margaret's
  // acceptance landed two minutes after Maisey cancelled — the offer was
  // still live because cancel used to leave it open).
  status: 'open' | 'locked' | 'withdrawn';
  locked_by?: string | null;   // receiver_id that committed first
  contacted_ids: string[];     // audit: who the broadcast reached
  expires_at: string;
}

// Which of a candidate's OWN shifts could the requester take in a swap? A shift
// qualifies only if it falls on a day the requester is willing to work AND the
// requester is qualified for that shift's role. These are exactly the cards shown
// on the swap landing page; an empty result means this candidate can only PICK UP
// (button A), not SWAP (button B).
export function tradeableShiftsForCandidate(
  candidateAssignments: ScheduleAssignment[],
  requesterWillingDates: ReadonlySet<string>,
  requesterQualifiedRoles: readonly string[],
): ScheduleAssignment[] {
  const roles = new Set(requesterQualifiedRoles);
  return candidateAssignments.filter(
    a => requesterWillingDates.has(a.date) && roles.has(a.role),
  );
}

export interface SwapCandidatePartition {
  // Everyone qualified/available to take the requester's shift — all get button A.
  pickup: Employee[];
  // The subset who ALSO have a tradeable shift on a willing day — they get button B
  // too, and these are the shifts shown as cards on the swap page.
  swap: { employee: Employee; tradeableShifts: ScheduleAssignment[] }[];
}

// Split the already-vetted pickup-eligible candidates (upstream filters handle
// qualification / availability / hours / conflicts) into pickup-only vs also-
// swappable, attaching each swappable candidate's tradeable shifts.
export function partitionSwapCandidates(
  pickupEligible: Employee[],
  assignmentsByEmployee: ReadonlyMap<string, ScheduleAssignment[]>,
  requesterWillingDates: ReadonlySet<string>,
  requesterQualifiedRoles: readonly string[],
): SwapCandidatePartition {
  const swap: SwapCandidatePartition['swap'] = [];
  for (const emp of pickupEligible) {
    const tradeableShifts = tradeableShiftsForCandidate(
      assignmentsByEmployee.get(emp.id) ?? [],
      requesterWillingDates,
      requesterQualifiedRoles,
    );
    if (tradeableShifts.length > 0) swap.push({ employee: emp, tradeableShifts });
  }
  return { pickup: pickupEligible, swap };
}

// Build ONE candidate's two-button broadcast email. The PICKUP button is always
// present; the SWAP button is rendered ONLY when `swapEligible` (the candidate has
// a tradeable shift on a requester-willing day). Mints the matching magic-link
// action tokens (`swap_pickup`, and `swap_trade_select` when eligible) that carry
// the self-contained broadcast snapshot, so the Homebase landing page works from
// the token alone. EMPLOYEE-FACING — no "View in Homebase" CTA, warm voice.
// A candidate's own shift offered as a trade option on the swap-picker page.
export interface TradeableShiftOption {
  date: string;
  shift_name: string;
  role: string;
  start_time: string;
  end_time: string;
}

export async function buildSwapBroadcastEmail(params: {
  company_id: string;
  candidate: { id: string; name: string; email?: string | null };  // email optional — SMS-only candidates carry the same links (H19)
  requester_name: string;
  shift_name: string;
  shift_role: string;
  shift_date: string;
  shift_start: string;
  shift_end: string;
  willing_dates: string[];        // YYYY-MM-DD the requester can work in return
  swapEligible: boolean;          // render the SWAP button?
  tradeableShifts?: TradeableShiftOption[];  // the candidate's shifts shown on the swap page
  token_payload: Record<string, unknown>;   // shared broadcast snapshot
  ttl_minutes?: number;
}): Promise<{ subject: string; text: string; html: string; sms: string; pickupUrl: string; swapUrl: string | null }> {
  const ttl = params.ttl_minutes ?? 72 * 60;
  const dateLong = formatDisplayDate(params.shift_date);
  // Enrich both token payloads so the Homebase landing pages are self-contained
  // (no extra fetch): the requester's shift in human + raw form, plus identity.
  const sharedSnapshot = {
    ...params.token_payload,
    receiver_id: params.candidate.id,
    requester_name: params.requester_name,
    shift_name: params.shift_name,
    role: params.shift_role,
    date: dateLong,               // human display (describeAction / page copy)
    shift_date: params.shift_date, // raw YYYY-MM-DD (execution)
    shift_start: params.shift_start,
    shift_end: params.shift_end,
  };
  const pickupTok = await generateActionToken({
    action_type: 'swap_pickup',
    payload: { ...sharedSnapshot, mode: 'pickup' },
    company_id: params.company_id,
    issued_to_email: params.candidate.email ?? '',
    issued_to_employee_id: params.candidate.id,
    ttl_minutes: ttl,
  });
  let swapUrl: string | null = null;
  if (params.swapEligible) {
    const swapTok = await generateActionToken({
      action_type: 'swap_trade_select',
      payload: { ...sharedSnapshot, mode: 'swap', tradeable_shifts: params.tradeableShifts ?? [] },
      company_id: params.company_id,
      issued_to_email: params.candidate.email ?? '',
      issued_to_employee_id: params.candidate.id,
      ttl_minutes: ttl,
    });
    swapUrl = swapTok.url;
  }
  const shiftDesc = `${params.shift_name} (${params.shift_start}–${params.shift_end}, ${params.shift_role}) on ${dateLong}`;
  const willingList = params.willing_dates.length > 0
    ? params.willing_dates.slice().sort().map(formatShortDate).join(', ')
    : null;

  const subject = `Can you help cover a ${params.shift_name} shift on ${formatShortDate(params.shift_date)}?`;

  // Plain-text version (also the SMS-fallback body).
  const swapLineText = swapUrl
    ? ` Or, if you'd rather trade, you can swap one of your own shifts for it.`
    : '';
  const text =
    `${textOpener(params.candidate.name)}this is Aegis. ` +
    `${params.requester_name} can't work their ${shiftDesc} and is hoping a teammate can help out.` +
    (willingList ? ` In return, ${firstName(params.requester_name)} can work: ${willingList}.` : '') +
    ` You can pick the shift up and add it to your schedule.${swapLineText} ` +
    `Just tap the button in this email to let me know.`;

  // SMS body (H19): unlike the directed swap outreach (a yes/no reply), a broadcast
  // is first-commit-wins across many candidates, so the SMS must carry the SAME
  // per-candidate magic-links the email buttons use — one to pick the shift up, one
  // (when eligible) to offer a trade. Same tokens, minted once above.
  const smsSwapLine = swapUrl ? `\nOr offer a swap instead: ${swapUrl}` : '';
  const sms =
    `${textOpener(params.candidate.name)}this is Aegis. ` +
    `${params.requester_name} can't work their ${shiftDesc} and is hoping a teammate can cover it.` +
    (willingList ? ` In return, ${firstName(params.requester_name)} can work: ${willingList}.` : '') +
    `\nPick it up: ${pickupTok.url}` +
    smsSwapLine +
    `\nFirst to tap it gets it — your manager gives the final OK.`;

  const buttons = [
    { url: pickupTok.url, label: 'Pick up this shift', variant: 'primary' as const },
    ...(swapUrl ? [{ url: swapUrl, label: 'Offer a swap', variant: 'secondary' as const }] : []),
  ];

  // Person-first framing: the ask reads like a manager wrote it and lives in the
  // BODY. The action card holds ONLY the shift on offer + the buttons — the thing
  // the coworker can actually act on. (We never quote the requester's own message
  // into a coworker's email; we describe the shift, which is operational fact.)
  const askLine =
    `${escapeHtml(params.requester_name)} can't make the <strong>${escapeHtml(params.shift_name)}</strong> shift ` +
    `(${escapeHtml(params.shift_start)}–${escapeHtml(params.shift_end)}, ${escapeHtml(params.shift_role)}) on <strong>${escapeHtml(dateLong)}</strong> ` +
    `and is looking for coverage. You're qualified and open that day — could you help out?`;
  const tradeLine = swapUrl
    ? ` If you'd rather trade than pick it up outright${willingList ? `, ${escapeHtml(firstName(params.requester_name))} can cover one of your shifts on ${escapeHtml(willingList)} in return` : ''}.`
    : '';

  const cardInner =
    brandCardDetailLine(
      `${escapeHtml(dateLong)} · ${escapeHtml(params.shift_name)}`,
      `${escapeHtml(params.shift_start)}–${escapeHtml(params.shift_end)} · ${escapeHtml(params.shift_role)}`,
    ) +
    brandedButtonRow(buttons);

  // When both options exist, spell out what each button actually does — pickup and
  // trade are easy to confuse, and the choice changes what the coworker owes back.
  const buttonExplainer = swapUrl
    ? `<p style="margin:0 0 12px;font-size:14px;color:${BRAND.silver};line-height:1.6;"><strong>Pick up this shift</strong> adds it to your schedule — nothing owed back. <strong>Offer a swap</strong> lets you hand ${escapeHtml(firstName(params.requester_name))} one of your own shifts${willingList ? ` on ${escapeHtml(willingList)}` : ''} in return.</p>`
    : '';

  const bodyHtml =
    `<p style="margin:0 0 16px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${escapeHtml(greeting(params.candidate.name))}</p>` +
    `<p style="margin:0 0 4px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${askLine}${tradeLine}</p>` +
    brandActionCard('Shift available', cardInner) +
    buttonExplainer +
    `<p style="margin:0 0 0;font-size:14px;color:${BRAND.silver};line-height:1.6;">First person to lock it in gets it, and your manager gives the final okay before anything changes. Thanks for being flexible.</p>`;

  const html = brandedEmailShell({ bodyHtml, preheader: subject });
  return { subject, text, html, sms, pickupUrl: pickupTok.url, swapUrl };
}

// Deliver ONE candidate's broadcast message — SMS-FIRST for a phone-holder (the
// SMS carries the SAME magic-links as the email buttons), email as the fallback on
// no-phone or SMS send failure, and email-first when SMS isn't available at all
// (EMAIL_ONLY set, or the tenant has no Aegis SMS number → smsCapable=false).
// Extracted so the routing is unit-testable, exactly like the directed path's
// sendOutreachMessage. Returns the channel ACTUALLY used ('none' = unreachable, so
// the caller never over-counts). (H19 — DRIFT_REGISTER §H.)
export async function deliverSwapBroadcast(params: {
  smsCapable: boolean;
  aegisSmsNumber: string | null;
  candidateId: string | null; // the candidate EMPLOYEE — gates the SMS (N3)
  candidatePhone: string | null;
  candidateEmail: string | null;
  sms: string;
  subject: string;
  text: string;
  html: string;
  company_id: string;
}): Promise<'sms' | 'email' | 'none'> {
  if (params.smsCapable && params.candidatePhone && params.aegisSmsNumber) {
    const ok = await sendSms({ to: params.candidatePhone, from: params.aegisSmsNumber, body: params.sms, company_id: params.company_id, employee_id: params.candidateId ?? undefined });
    if (ok) return 'sms';
    console.warn(`[swap-broadcast] SMS send failed for company ${params.company_id}; falling back to email`);
  }
  if (params.candidateEmail) {
    const ok = await sendEmail({ to: params.candidateEmail, subject: params.subject, text: params.text, html: params.html, company_id: params.company_id });
    if (ok) return 'email';
  }
  return 'none';
}

// Build the REQUESTER's "do you agree to this trade?" email after a candidate
// proposes a swap on the picker page. Mints swap_agree / swap_decline magic-link
// tokens (issued to the requester). EMPLOYEE-FACING — no Homebase CTA.
export async function buildSwapProposalEmail(params: {
  company_id: string;
  requester: { id: string; name: string; email: string };
  receiver_id: string;
  receiver_name: string;
  // The requester's shift they'd give up.
  shift_name: string;
  shift_date: string;
  shift_start: string;
  shift_end: string;
  shift_role: string;
  // The receiver's shift the requester would take in return.
  target_shift_name: string;
  target_shift_date: string;
  target_shift_start: string;
  target_shift_end: string;
  target_role: string;
  ttl_minutes?: number;
}): Promise<{ subject: string; text: string; html: string }> {
  const ttl = params.ttl_minutes ?? 72 * 60;
  const payload = {
    requester_id: params.requester.id,
    receiver_id: params.receiver_id,
    receiver_name: params.receiver_name,
    shift_name: params.shift_name,
    date: formatDisplayDate(params.shift_date),
    target_shift_name: params.target_shift_name,
    target_date: formatDisplayDate(params.target_shift_date),
  };
  const [agreeTok, declineTok] = await Promise.all([
    generateActionToken({
      action_type: 'swap_agree', payload, company_id: params.company_id,
      issued_to_email: params.requester.email, issued_to_employee_id: params.requester.id, ttl_minutes: ttl,
    }),
    generateActionToken({
      action_type: 'swap_decline', payload, company_id: params.company_id,
      issued_to_email: params.requester.email, issued_to_employee_id: params.requester.id, ttl_minutes: ttl,
    }),
  ]);

  const giveUp = `${params.shift_name} (${params.shift_start}–${params.shift_end}, ${params.shift_role}) on ${formatDisplayDate(params.shift_date)}`;
  const getBack = `${params.target_shift_name} (${params.target_shift_start}–${params.target_shift_end}, ${params.target_role}) on ${formatDisplayDate(params.target_shift_date)}`;

  const subject = `${firstName(params.receiver_name)} can take your ${params.shift_name} shift — trade?`;
  const text =
    `${textOpener(params.requester.name)}good news — ${params.receiver_name} can take your ${giveUp}. ` +
    `In return, you'd take their ${getBack}. Does that trade work for you? ` +
    `Tap Agree to send it to your manager for the final OK, or Decline to pass.`;

  const detail =
    `<p style="margin:0 0 12px;font-size:15px;color:${BRAND.textPrimary};line-height:1.6;">` +
    `${escapeHtml(params.receiver_name)} can take your <strong>${escapeHtml(params.shift_name)}</strong> ` +
    `(${escapeHtml(params.shift_start)}–${escapeHtml(params.shift_end)}, ${escapeHtml(params.shift_role)}) on <strong>${escapeHtml(formatDisplayDate(params.shift_date))}</strong>.</p>` +
    `<p style="margin:0 0 16px;font-size:15px;color:${BRAND.textPrimary};line-height:1.6;">` +
    `In return, you'd take their <strong>${escapeHtml(params.target_shift_name)}</strong> ` +
    `(${escapeHtml(params.target_shift_start)}–${escapeHtml(params.target_shift_end)}, ${escapeHtml(params.target_role)}) on <strong>${escapeHtml(formatDisplayDate(params.target_shift_date))}</strong>.</p>` +
    `<p style="margin:0 0 16px;font-size:14px;color:${BRAND.silver};line-height:1.6;">If you agree, it goes to your manager for the final OK.</p>` +
    brandedButtonRow([
      { url: agreeTok.url, label: 'Agree to the trade', variant: 'primary' },
      { url: declineTok.url, label: 'Decline', variant: 'secondary' },
    ]);

  const bodyHtml =
    `<p style="margin:0 0 18px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">` +
    `${escapeHtml(greeting(params.requester.name))} someone can take that shift off your hands — here's the trade.</p>` +
    brandActionCard('Trade offer', detail);

  return { subject, text, html: brandedEmailShell({ bodyHtml, preheader: subject }) };
}

async function getAegisSmsChannel(companyId: string): Promise<string | null> {
  const { data } = await supabase.from('company_channels').select('channel_value')
    .eq('company_id', companyId).eq('channel_type', 'sms').maybeSingle();
  return (data as { channel_value: string } | null)?.channel_value ?? null;
}

async function findEmployeeByName(companyId: string, name: string): Promise<Employee | null> {
  const { data: exact } = await supabase.from('employees').select('*')
    .eq('company_id', companyId).eq('active', true).ilike('name', name.trim()).limit(1).maybeSingle();
  if (exact) return exact as Employee;
  const firstName = name.trim().split(/\s+/)[0];
  const { data: partial } = await supabase.from('employees').select('*')
    .eq('company_id', companyId).eq('active', true).ilike('name', `${firstName}%`).limit(1).maybeSingle();
  return (partial as Employee | null) ?? null;
}

async function getReceiverWeeklyHours(companyId: string, receiverId: string, shiftDate: string): Promise<number> {
  const { data } = await supabase.from('schedules').select('data').is('deleted_at', null)
    .eq('company_id', companyId).eq('status', 'published')
    .lte('week_start', shiftDate).gte('week_end', shiftDate)
    .order('generated_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return 0;
  const sched = (data as { data: ScheduleData }).data;
  return sched.assignments
    .filter(a => a.employee_id === receiverId)
    .reduce((sum, a) => sum + (a.hours ?? computeShiftHours(a.start_time, a.end_time)), 0);
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

async function findSchedule(
  companyId: string,
  date: string
): Promise<{ id: string; data: ScheduleData } | null> {
  const base = supabase.from('schedules').select('id, data').is('deleted_at', null)
    .eq('company_id', companyId).lte('week_start', date).gte('week_end', date)
    .order('generated_at', { ascending: false }).limit(1);

  const { data: pub } = await base.eq('status', 'published').maybeSingle();
  if (pub) {
    const row = pub as { id: string; data: ScheduleData };
    return { id: row.id, data: row.data };
  }
  const { data: draft } = await base.eq('status', 'draft').maybeSingle();
  if (draft) {
    const row = draft as { id: string; data: ScheduleData };
    return { id: row.id, data: row.data };
  }
  return null;
}

export function findRequesterShift(schedData: ScheduleData, requesterId: string, shiftDate: string): ScheduleAssignment | null {
  return schedData.assignments.find(a => a.employee_id === requesterId && a.date === shiftDate) ?? null;
}

// L4 [SWAP-SHIFT-RESOLVE] — resolve WHICH OF THE REQUESTER'S OWN shifts they mean
// on a named date.
//
// THE BUG THIS REPLACES. handleInitiateSwap did:
//
//     shift = findRequesterShift(schedule.data, contact.employee_id!, shiftDate);
//     if (!shift && shiftNameHint) {
//       shift = schedule.data.assignments.find(a =>
//         a.date === shiftDate && a.shift_name.toLowerCase().includes(shiftNameHint.toLowerCase())
//       ) ?? null;                      // <-- NO employee_id filter
//     }
//
// When the requester had NO assignment on the named date — a mis-parsed date, or
// a pickup message where the model put the COWORKER's date in shift_date — the
// fallback returned **whoever else's** assignment matched the name. Short hints
// like "AM"/"PM" (exactly what the router prompt asks for) substring-match real
// shift names, so the match was usually the trade counterparty's own shift.
//
// That value then propagated unfiltered — pending → outreach → manager approval
// email → decision token → side A of executeScheduleTrade — where its triple
// (date, shift_name, employee_id) could never match, because the requester was
// never on it. Before this batch that produced a SILENT HALF-APPLIED TRADE.
// After the executor fix it produces a `partial_trade` refusal, which is safe
// but still means a legitimate swap DOESN'T WORK. This closes it at the source
// so the swap actually succeeds.
//
// The second, quieter half: `findRequesterShift` matches on employee+date ONLY
// and ignores the name, so on a DOUBLE-SHIFT DAY it silently returned the first
// one — a coin flip on which of the employee's two shifts got given away, with
// no question asked. That is why the resolver is name-aware and can answer
// 'ambiguous'.
//
// Mirrors chooseTradeShift's shape and shares its soft-narrowing
// (narrowByShiftDescriptor) so BOTH legs of a trade are resolved by identical
// rules — RULE 0b.
export type RequesterShiftChoice =
  | { kind: 'one'; shift: ScheduleAssignment }
  | { kind: 'ambiguous'; shifts: ScheduleAssignment[] }
  | { kind: 'none' };

export function resolveRequesterShiftOnDate(
  schedData: ScheduleData,
  requesterId: string,
  shiftDate: string,
  nameHint?: string | null,
): RequesterShiftChoice {
  // ALWAYS scoped to the requester. There is no fallback that widens beyond
  // them — someone else's shift is never an answer to "which of MY shifts".
  const mine = schedData.assignments.filter(
    a => a.employee_id === requesterId && a.date === shiftDate,
  );
  if (mine.length === 0) return { kind: 'none' };
  if (mine.length === 1) return { kind: 'one', shift: mine[0] };

  const narrowed = narrowByShiftDescriptor(mine, nameHint);
  if (narrowed.length === 1) return { kind: 'one', shift: narrowed[0] };
  // Two shifts that day and the descriptor didn't settle it: ASK. Guessing here
  // gives away a shift the employee never named.
  return { kind: 'ambiguous', shifts: narrowed };
}

// When a swap message names no date, don't assume "today" — resolve the requester's
// UPCOMING shifts (date >= today, current schedule) so the caller can use the single
// obvious one or ask which. Pure, so it is unit-tested without a database.
export type UpcomingShiftChoice =
  | { kind: 'one'; shift: ScheduleAssignment }
  | { kind: 'ambiguous'; shifts: ScheduleAssignment[] }
  | { kind: 'none' };

export function pickUpcomingShift(
  assignments: ScheduleAssignment[],
  requesterId: string,
  today: string,
  nameHint?: string | null
): UpcomingShiftChoice {
  const mine = assignments
    .filter(a => a.employee_id === requesterId && a.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start_time ?? '').localeCompare(b.start_time ?? ''));
  const hinted = nameHint ? mine.filter(a => a.shift_name.toLowerCase().includes(nameHint.toLowerCase())) : [];
  const pool = hinted.length > 0 ? hinted : mine;
  if (pool.length === 0) return { kind: 'none' };
  if (pool.length === 1) return { kind: 'one', shift: pool[0] };
  return { kind: 'ambiguous', shifts: pool };
}

// Pure transform: reassign the requester's matching shift (date + shift_name) to
// the receiver. Returns a new assignments array; everything else is untouched.
// Extracted from executeScheduleSwap so the swap effect can be unit-tested
// without a database. Behavior-identical to the previous inline map.
export function applySwapToAssignments(
  assignments: ScheduleAssignment[],
  shiftDate: string,
  shiftName: string,
  requesterId: string,
  receiverId: string,
  receiverName: string
): ScheduleAssignment[] {
  return assignments.map(a => {
    if (a.date === shiftDate && a.shift_name === shiftName && a.employee_id === requesterId) {
      return { ...a, employee_id: receiverId, employee_name: receiverName };
    }
    return a;
  });
}

// One side of a true two-way swap: a specific person on a specific shift.
export interface TradeSide {
  date: string;
  shift_name: string;
  employee_id: string;
  employee_name: string;
}

// Pure transform for a TRUE swap (item 18 redesign): TRADE two existing
// assignments between two employees. The person on side A's shift moves onto
// side B's shift and vice versa — both people stay on the schedule, they just
// switch places. Returns a new array; every other assignment is untouched, and
// the input is never mutated. This is the core both swap modes (directed +
// job-posting) build on, testable without a database.
export function applyTradeToAssignments(
  assignments: ScheduleAssignment[],
  a: TradeSide,
  b: TradeSide
): ScheduleAssignment[] {
  return applyTradeToAssignmentsDetailed(assignments, a, b).assignments;
}

// L4 — the same transform, but REPORTING what each leg actually did.
//
// THE BUG this closes (live at Watermark, a manager reproduced it 2026-08-16):
// a two-way trade half-applied. The requester correctly landed on the
// coworker's shift; the coworker was never taken off it and never received the
// requester's shift in return.
//
// The mechanism was not in the transform — it was that the transform threw the
// per-leg result away. The two legs are INDEPENDENT `if` branches: when side
// A's triple (date, shift_name, employee_id) matches nothing but side B's does,
// leg B still fires and the array still "changed". executeScheduleTrade then
// asked `updatedAssignments.some(row changed)` — ANY one row. That is a correct
// guard for the ONE-leg executeScheduleSwap and a silently wrong one here. It
// passed; the write went through; the request was marked approved; the magic
// tokens were consumed so the manager could not retry; and BOTH employees were
// emailed "your shift trade has been approved". One of them was wrong about
// which shift they were working.
//
// So the invariant a trade must satisfy is not "something moved" but "EXACTLY
// ONE row moved on EACH side". Counting is the fix; executeScheduleTrade
// enforces it.
//
// Exactly one, not at-least-one: two rows sharing a
// (date, shift_name, employee_id) triple means the same person is on the same
// shift twice — corrupt data — and moving both would put the counterparty on
// that shift twice. Better to refuse and tell the manager than to write a
// schedule nobody can work.
export interface TradeApplyOutcome {
  assignments: ScheduleAssignment[];
  /** Rows leg A moved — the requester's shift going to the coworker. */
  aMatched: number;
  /** Rows leg B moved — the coworker's shift coming back to the requester. */
  bMatched: number;
}

export function applyTradeToAssignmentsDetailed(
  assignments: ScheduleAssignment[],
  a: TradeSide,
  b: TradeSide
): TradeApplyOutcome {
  let aMatched = 0;
  let bMatched = 0;
  const next = assignments.map(asg => {
    if (asg.date === a.date && asg.shift_name === a.shift_name && asg.employee_id === a.employee_id) {
      aMatched++;
      return { ...asg, employee_id: b.employee_id, employee_name: b.employee_name };
    }
    if (asg.date === b.date && asg.shift_name === b.shift_name && asg.employee_id === b.employee_id) {
      bMatched++;
      return { ...asg, employee_id: a.employee_id, employee_name: a.employee_name };
    }
    return asg;
  });
  return { assignments: next, aMatched, bMatched };
}

// Executes an approved swap: updates the schedule data and recalculates wages.
// Exported so the decision webhook can call it after manager approval.
// ── D2: the schedule write is AUTHORITATIVE ───────────────────────────────────
//
// These two functions used to return void and `console.warn` + `return` on every
// failure path. Their callers then marked the swap `approved` and emailed BOTH
// employees "your swap has been approved!" — whether or not the schedule had
// actually changed. An employee who believed they were covered simply didn't
// show up.
//
// They now RETURN a result. A caller may not announce an approval it did not
// get. `status='approved'` is written only together with the `schedule_id` the
// swap actually landed on — schedule first, status second.
export type SwapApplyResult =
  | { ok: true; schedule_id: string }
  | {
      ok: false;
      code:
        | 'schedule_not_found'
        | 'no_matching_assignment'
        // L4 — a TRADE where one leg matched the schedule and the other did
        // not. Distinct from 'no_matching_assignment' (neither leg matched)
        // because it is the dangerous case: it used to be reported as SUCCESS.
        | 'partial_trade'
        // L4 — the Homebase UI approval path was handed a request it cannot
        // prove is one-way. It has no target-shift columns to work from, so it
        // refuses rather than running a trade as a giveaway.
        | 'trade_not_supported_here'
        | 'write_failed';
      reason: string;
    };

export async function executeScheduleSwap(
  companyId: string,
  scheduleId: string,
  shiftDate: string,
  shiftName: string,
  requesterId: string,
  receiverId: string,
  receiverName: string
): Promise<SwapApplyResult> {
  const { data: schedRow } = await supabase.from('schedules').select('id, data, staffing_report')
    .eq('id', scheduleId).is('deleted_at', null).single();
  if (!schedRow) {
    console.warn(`[executeScheduleSwap] schedule ${scheduleId} not found/deleted — pickup for requester ${requesterId} on ${shiftDate} ${shiftName} was NOT applied`);
    return {
      ok: false,
      code: 'schedule_not_found',
      reason: `The published schedule covering ${shiftDate} could not be found, so the swap was not applied.`,
    };
  }

  const row = schedRow as { id: string; data: ScheduleData; staffing_report: Record<string, unknown> | null };
  const updatedAssignments = applySwapToAssignments(
    row.data.assignments, shiftDate, shiftName, requesterId, receiverId, receiverName
  );
  // Previously this only warned and then wrote anyway — a no-op write that
  // reported success. If nothing changed, the swap did NOT happen.
  if (!updatedAssignments.some((a, i) => a.employee_id !== row.data.assignments[i]?.employee_id)) {
    console.warn(`[executeScheduleSwap] no matching assignment for requester ${requesterId} on ${shiftDate} ${shiftName} in schedule ${scheduleId} — nothing updated`);
    return {
      ok: false,
      code: 'no_matching_assignment',
      reason: `No ${shiftName} assignment for that employee on ${shiftDate} exists in the published schedule, so there was nothing to swap.`,
    };
  }

  const updatedData: ScheduleData = { ...row.data, assignments: updatedAssignments };
  const wages = await computeWageEstimate(companyId, updatedAssignments);

  const { error: writeErr } = await supabase.from('schedules').update({
    data: updatedData as unknown as Record<string, unknown>,
    staffing_report: { ...(row.staffing_report ?? {}), estimated_wages: wages },
  }).eq('id', scheduleId);
  if (writeErr) {
    console.error(`[executeScheduleSwap] schedule write failed for ${scheduleId}:`, writeErr);
    return { ok: false, code: 'write_failed', reason: 'The schedule could not be saved, so the swap was not applied.' };
  }

  return { ok: true, schedule_id: scheduleId };
}

// Which of the target's shifts the requester is trading FOR. Resolves your
// "I name it; Aegis asks only if it's unclear" rule (item 18): if the named
// person has exactly one shift that week (or the hint narrows it to one), use
// it; if several still match, it's ambiguous and the caller should ask which.
export type TradeShiftChoice =
  | { kind: 'one'; shift: ScheduleAssignment }
  | { kind: 'none' }
  | { kind: 'ambiguous'; shifts: ScheduleAssignment[] };

// Rough AM/PM sense of a natural-language shift descriptor. TENANT-AGNOSTIC:
// derives from a leading clock hour in the phrase ("9-3", "11 to 3", "3–9") or
// the generic words morning/afternoon/etc. — never from any one client's shift
// names. Returns 'day' (starts before 13:00) | 'pm' (13:00 or later) | null.
// Deliberately tolerant: employees describe shifts loosely ("her 9-3 PM shift"
// for an 11:00 start; the leading hour "9" wins over the trailing "PM"). Used
// ONLY to disambiguate when a coworker has multiple shifts on the named day; it
// can never eliminate the last candidate.
export function descriptorAmPm(desc: string): 'day' | 'pm' | null {
  const s = desc.toLowerCase();
  const hasAm = /\bam\b/.test(s);
  const hasPm = /\bpm\b/.test(s);
  const range = s.match(/(\d{1,2})\s*(?::\d{2})?\s*(?:-|to|–|—)\s*(\d{1,2})/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = parseInt(range[2], 10);
    if (start > end) return 'day';              // e.g. "9-3", "11-3": crosses noon → a morning-start daytime shift
    if (hasPm && !hasAm) return 'pm';           // "3-9 PM"
    if (hasAm && !hasPm) return 'day';          // "9-11 AM"
    if (start >= 12) return 'pm';
    if (start >= 1 && start <= 6) return 'pm';  // "3-9" with no marker → afternoon/evening
    return 'day';                                // "8-12", "9-11" → morning
  }
  if (/\b(morning|early|opening|open)\b/.test(s)) return 'day';
  if (/\b(afternoon|evening|night|closing|close)\b/.test(s)) return 'pm';
  if (hasAm) return 'day';
  if (hasPm) return 'pm';
  return null;
}

// Does this assignment START in the afternoon? Read from the schedule's OWN
// start_time (tenant data), so it works for any client's shift structure.
const shiftStartsPm = (a: ScheduleAssignment): boolean => (a.start_time ?? '00:00').slice(0, 5) >= '13:00';

// SOFT-narrow a set of same-day candidates using the employee's loose descriptor
// ("her 9-3 PM shift", "the AM one"). First by a genuine shift_name token that
// appears in the descriptor, then by AM/PM sense against the shift's REAL
// start_time (tenant data, so it works for any client's shift structure).
//
// "Soft" is load-bearing: narrowing may REDUCE the set but must never empty it.
// A descriptor that matches nothing leaves the caller with the full set to ask
// about, rather than a false "you have no such shift".
//
// L4 — extracted from chooseTradeShift so the requester's OWN shift is resolved
// by exactly the same rules as the coworker's (RULE 0b). It used to be applied
// only to the coworker's side, which is part of why the requester's leg was the
// unreliable one.
export function narrowByShiftDescriptor(
  candidates: ScheduleAssignment[],
  descriptor: string | null | undefined,
): ScheduleAssignment[] {
  if (!descriptor || candidates.length <= 1) return candidates;
  const h = descriptor.toLowerCase();
  let narrowed = candidates.filter(a =>
    a.shift_name.toLowerCase().split(/\s+/).some(tok => tok.length > 2 && h.includes(tok)));
  if (narrowed.length !== 1) {
    const sense = descriptorAmPm(descriptor);
    if (sense) {
      const bySense = candidates.filter(a => (sense === 'pm') === shiftStartsPm(a));
      if (bySense.length > 0) narrowed = bySense;
    }
  }
  return narrowed.length > 0 ? narrowed : candidates;
}

// Resolve which of the target's shifts the requester trades FOR. Employees name
// a coworker's shift by DAY + a loose time ("her 9-3 PM shift on Friday"), which
// never matches a tenant's internal shift NAME ("AM Weekday", "Afternoon"...).
// So we resolve by the target's shift DATE first, use the time/name only to
// disambiguate when they work MULTIPLE shifts that day, and NEVER return a false
// 'none' when the target actually has shifts that week — we ask "which?" instead.
export function chooseTradeShift(
  schedData: ScheduleData,
  targetId: string,
  hint: { shift_name?: string | null; date?: string | null } | null
): TradeShiftChoice {
  const targetShifts = schedData.assignments.filter(a => a.employee_id === targetId);
  if (targetShifts.length === 0) return { kind: 'none' }; // genuinely nothing that week

  // DATE-FIRST: prefer the coworker's shift(s) on the named day. If the hint date
  // matches none of their shifts (a missed/garbled date), DON'T zero out — keep
  // the full set and fall through to "which one?", never a false 'none'.
  let candidates = targetShifts;
  if (hint?.date) {
    const onDate = targetShifts.filter(a => a.date === hint.date);
    if (onDate.length > 0) candidates = onDate;
  }
  if (candidates.length === 1) return { kind: 'one', shift: candidates[0] };

  // Multiple shifts remain (e.g. a coworker working an AM and a PM the same day).
  // SOFT-narrow by a genuine shift_name token that appears in the descriptor, then
  // by AM/PM sense vs the shift's real start_time. Soft narrowing may reduce the
  // set but MUST NOT eliminate the last candidate.
  if (hint?.shift_name && candidates.length > 1) {
    const narrowed = narrowByShiftDescriptor(candidates, hint.shift_name);
    if (narrowed.length === 1) return { kind: 'one', shift: narrowed[0] };
    if (narrowed.length > 1) candidates = narrowed;
  }

  if (candidates.length === 1) return { kind: 'one', shift: candidates[0] };
  return { kind: 'ambiguous', shifts: candidates }; // ask "which of these?" — never a false 'none'
}

// Executes an approved TRUE swap: TRADES two assignments between two employees
// (both stay on the schedule, they switch places) and recalculates wages. The
// redesigned two-way replacement for executeScheduleSwap — called once both
// employees agree and the manager approves. Built on the unit-tested
// applyTradeToAssignments core.
export async function executeScheduleTrade(
  companyId: string,
  scheduleId: string,
  sideA: TradeSide,
  sideB: TradeSide
): Promise<SwapApplyResult> {
  const { data: schedRow } = await supabase.from('schedules').select('id, data, staffing_report')
    .eq('id', scheduleId).is('deleted_at', null).single();
  if (!schedRow) {
    console.warn(`[executeScheduleTrade] schedule ${scheduleId} not found/deleted — trade between ${sideA.employee_id} and ${sideB.employee_id} was NOT applied`);
    return {
      ok: false,
      code: 'schedule_not_found',
      reason: `The published schedule covering ${sideA.date} could not be found, so the trade was not applied.`,
    };
  }

  const row = schedRow as { id: string; data: ScheduleData; staffing_report: Record<string, unknown> | null };

  // L4 — BOTH legs must land, or nothing is written.
  //
  // The old guard was `updatedAssignments.some(row changed)` — ANY one row —
  // copied from the one-leg executeScheduleSwap. On a two-leg operation that
  // reports a HALF-APPLIED trade as success. See applyTradeToAssignmentsDetailed.
  const outcome = applyTradeToAssignmentsDetailed(row.data.assignments, sideA, sideB);
  const legDesc = `${sideA.employee_id} ${sideA.date} ${sideA.shift_name} ↔ ${sideB.employee_id} ${sideB.date} ${sideB.shift_name}`;

  if (outcome.aMatched === 0 && outcome.bMatched === 0) {
    console.warn(`[executeScheduleTrade] no matching assignments for trade (${legDesc}) in schedule ${scheduleId} — nothing updated`);
    return {
      ok: false,
      code: 'no_matching_assignment',
      reason: `One or both of those shifts aren't in the published schedule, so there was nothing to trade.`,
    };
  }

  if (outcome.aMatched !== 1 || outcome.bMatched !== 1) {
    // THE reported bug. Loud, because until now this wrote a half-trade,
    // marked it approved, and told both employees it worked.
    console.error(
      `[executeScheduleTrade] REFUSING partial trade in schedule ${scheduleId} (${legDesc}): ` +
      `leg A matched ${outcome.aMatched} assignment(s), leg B matched ${outcome.bMatched}. ` +
      `A trade requires exactly one on each side. Nothing was written.`
    );
    const missing = outcome.aMatched !== 1 ? sideA : sideB;
    return {
      ok: false,
      code: 'partial_trade',
      reason:
        `Only one side of that trade matches the published schedule — the ${missing.shift_name} shift on ` +
        `${missing.date} isn't there as expected, so applying it would have left the schedule half-changed. ` +
        `Nothing was changed. The schedule most likely moved after the trade was requested; ask them to set it up again.`,
    };
  }

  const updatedAssignments = outcome.assignments;
  const updatedData: ScheduleData = { ...row.data, assignments: updatedAssignments };
  const wages = await computeWageEstimate(companyId, updatedAssignments);

  const { error: writeErr } = await supabase.from('schedules').update({
    data: updatedData as unknown as Record<string, unknown>,
    staffing_report: { ...(row.staffing_report ?? {}), estimated_wages: wages },
  }).eq('id', scheduleId);
  if (writeErr) {
    console.error(`[executeScheduleTrade] schedule write failed for ${scheduleId}:`, writeErr);
    return { ok: false, code: 'write_failed', reason: 'The schedule could not be saved, so the trade was not applied.' };
  }

  return { ok: true, schedule_id: scheduleId };
}

// ── Banned-pair (hard 'never' conflict) guard for pickups & trades ────────────
// The scheduler engine already blocks banned pairs at build time; pickups and
// trades bypass the engine, so we re-check here. Unlike validateSwap's
// requester↔receiver check, this catches the real case: someone joining a shift
// where a HARD-banned coworker is already assigned.

// `severity` is optional so existing callers/tests that build rows without it
// still typecheck; a row with no severity is treated as a HARD ('never') pair,
// which is the safe default — we'd rather over-warn than silently pair people.
export interface HardConflictRow {
  employee_id_1: string;
  employee_id_2: string;
  severity?: 'never' | 'avoid' | string | null;
}

/** Load the company's hard ('never') banned pairs. Never throws — returns []. */
// D13 — this used to filter `.eq('severity','never')`, so pairs marked 'avoid'
// were INVISIBLE to every swap path. A manager could say "try not to schedule
// these two together", and a swap would cheerfully put them on the same shift
// with no mention of it. (The build engine does honour 'avoid' — but only as a
// soft rank tiebreaker, so swaps were the one place it vanished entirely.)
//
// Now we load BOTH severities and let the caller decide how loudly to speak.
// Per flag-don't-force, neither one blocks the swap: 'never' gets a firm warning
// in the manager's approval email, 'avoid' gets a softer one. The manager holds
// final authority either way.
export async function loadHardConflicts(companyId: string): Promise<HardConflictRow[]> {
  try {
    const { data } = await supabase
      .from('employee_conflicts')
      .select('employee_id_1, employee_id_2, severity')
      .eq('company_id', companyId);
    return (data ?? []) as HardConflictRow[];
  } catch {
    return [];
  }
}

/**
 * If placing `empId` onto the (date, shiftName) instance would sit them beside a
 * hard-banned coworker already assigned there, return that coworker's name; else
 * null. `excludeEmpId` is the person vacating that shift (the requester on a
 * pickup), so they don't count as a co-inhabitant.
 */
function cohabPartnerNameBySeverity(
  empId: string,
  date: string,
  shiftName: string,
  assignments: ScheduleAssignment[],
  conflicts: HardConflictRow[],
  want: 'never' | 'avoid',
  excludeEmpId?: string,
): string | null {
  const flagged = new Set<string>();
  for (const c of conflicts) {
    // A row with no severity is treated as 'never' — the safe default.
    const sev = c.severity === 'avoid' ? 'avoid' : 'never';
    if (sev !== want) continue;
    if (c.employee_id_1 === empId) flagged.add(c.employee_id_2);
    else if (c.employee_id_2 === empId) flagged.add(c.employee_id_1);
  }
  if (flagged.size === 0) return null;
  for (const a of assignments) {
    if (a.date !== date || a.shift_name !== shiftName) continue;
    if (a.employee_id === empId || a.employee_id === excludeEmpId) continue;
    if (flagged.has(a.employee_id)) return a.employee_name;
  }
  return null;
}

export function bannedCohabPartnerName(
  empId: string,
  date: string,
  shiftName: string,
  assignments: ScheduleAssignment[],
  conflicts: HardConflictRow[],
  excludeEmpId?: string,
): string | null {
  return cohabPartnerNameBySeverity(empId, date, shiftName, assignments, conflicts, 'never', excludeEmpId);
}

/**
 * D13 — the soft twin. Returns the name of an 'avoid'-paired coworker already on
 * that shift instance. Same flag-don't-force contract: this NEVER blocks a swap,
 * it just means the manager gets told before they approve, instead of finding out
 * when the two of them turn up on the same shift.
 */
export function avoidCohabPartnerName(
  empId: string,
  date: string,
  shiftName: string,
  assignments: ScheduleAssignment[],
  conflicts: HardConflictRow[],
  excludeEmpId?: string,
): string | null {
  return cohabPartnerNameBySeverity(empId, date, shiftName, assignments, conflicts, 'avoid', excludeEmpId);
}

// ── Swap validation ───────────────────────────────────────────────────────────

// W-1 branch 4 (J-5): validateSwap phrases its reason about "the receiver" in
// the third person. When the receiver IS the person we're talking to, that read
// "Mya Vanderzwaag has approved time off on that date" — to Mya. Rewrite the
// subject to "you" for that one case; every other reader keeps the name.
export function reasonAddressedToYou(reason: string, selfName: string): string {
  const name = (selfName || '').trim();
  if (!name) return reason;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return reason
    .replace(new RegExp(`^${esc} has approved time off on that date\\.`), 'you have approved time off that day.')
    .replace(new RegExp(`^${esc} has `), 'you have ')
    .replace(new RegExp(`^${esc} is `), "you're ")
    .replace(new RegExp(`^${esc} would `), 'you would ')
    .replace(new RegExp(`^${esc}'s `), 'your ')
    .replace(/\btheir maximum weekly hours\b/, 'your maximum weekly hours');
}

async function validateSwap(params: {
  company_id: string;
  requester_id: string;
  receiver: Employee;
  shift_date: string;
  role: string;
  /** RULE 0b — the shift being swapped, so we can resolve what it accepts. */
  shift_name?: string;
  /** Every role that may fill it. If omitted, resolved from Homebase. */
  accepted_roles?: string[];
  shift_hours: number;
  policies: Policy[];
}): Promise<ValidationResult> {
  const { company_id, requester_id, receiver, shift_date, role, shift_hours, policies } = params;

  // 1. Qualification check
  //
  // RULE 0b — the SAME function the build engine uses. This previously compared
  // against the single `role` string, so a manager could configure a shift to
  // accept "Lifeguard OR Headguard", the engine would happily SCHEDULE a
  // Headguard onto it — and then this check would tell that same Headguard they
  // were "not qualified" when they tried to pick the shift up. Two channels,
  // two answers, same shift.
  //
  // `accepted_roles` may be supplied by the caller (from the assignment) or
  // resolved from the manager's configuration in Homebase. Falls back to [role].
  const acceptedRoles = params.accepted_roles?.length
    ? params.accepted_roles
    : await resolveAcceptedRoles(company_id, params.shift_name ?? '', role);

  if (!isQualified(receiver.qualified_roles, acceptedRoles)) {
    return { valid: false, reason: `${receiver.name} is not qualified for the ${roleLabel(acceptedRoles)} role.` };
  }

  // 2. Never-conflict check
  const { data: conflictData } = await supabase
    .from('employee_conflicts')
    .select('severity')
    .eq('company_id', company_id)
    .eq('severity', 'never')
    .or(`and(employee_id_1.eq.${requester_id},employee_id_2.eq.${receiver.id}),and(employee_id_1.eq.${receiver.id},employee_id_2.eq.${requester_id})`);

  if (conflictData && (conflictData as { severity: string }[]).length > 0) {
    return { valid: false, reason: `${receiver.name} has a scheduling conflict that prevents this swap.` };
  }

  // 3. Approved TO check
  const { data: toData } = await supabase
    .from('time_off_requests')
    .select('id')
    .eq('company_id', company_id)
    .eq('employee_id', receiver.id)
    .eq('status', 'approved')
    .lte('start_date', shift_date)
    .gte('end_date', shift_date)
    .limit(1);

  if (toData && (toData as { id: string }[]).length > 0) {
    return { valid: false, reason: `${receiver.name} has approved time off on that date.` };
  }

  // 4. Overtime check
  const weeklyHours = await getReceiverWeeklyHours(company_id, receiver.id, shift_date);
  if (weeklyHours + shift_hours > receiver.max_weekly_hours) {
    return {
      valid: false,
      reason: `${receiver.name} would exceed their maximum weekly hours (currently at ${weeklyHours.toFixed(1)}h, max ${receiver.max_weekly_hours}h, shift adds ${shift_hours}h).`,
    };
  }

  // 5. Policy check via Claude (notice requirements, blackout periods, etc.)
  if (policies.length > 0) {
    const policyText = policies.map(p => `${p.policy_key}: ${p.policy_value}${p.description ? ' — ' + p.description : ''}`).join('\n');
    const today = new Date().toISOString().slice(0, 10);
    const system =
      'You are reviewing a shift swap against company swap policies. ' +
      'Respond ONLY with valid JSON: {"valid":true|false,"reason":string|null}. ' +
      'If valid=false, reason must be a specific, human-readable explanation.';
    const context = `Swap date: ${shift_date}. Today: ${today}.\nPolicies:\n${policyText}`;
    const text = await generateReply(system, context, []);
    const result = coerceJsonObject<{ valid: boolean; reason: string | null }>(text);
    if (result) {
      if (!result.valid) {
        return { valid: false, reason: result.reason ?? 'This swap does not meet company swap policies.', policy_note: result.reason ?? undefined };
      }
    } else {
      // If Claude fails, don't block — log and continue
      console.warn('[shift-swap] policy validation Claude parse failed');
    }
  }

  return { valid: true, reason: null };
}

// ── Candidate pool (Mode 2) ───────────────────────────────────────────────────

export async function buildSwapCandidates(params: {
  company_id: string;
  requester_id: string;
  shift_date: string;
  role: string;
  /** RULE 0b — the shift's name, so we can resolve what it accepts if not given. */
  shift_name?: string;
  /** Every role the manager said may fill this shift. Resolved from Homebase if omitted. */
  accepted_roles?: string[];
  shift_start: string;
  shift_end: string;
  shift_hours: number;
}): Promise<Employee[]> {
  const { company_id, requester_id, shift_date, role, shift_start, shift_end, shift_hours } = params;

  // RULE 0b — who can take this shift must match who the ENGINE would schedule
  // onto it. Filtering on the single `role` here meant the broadcast/pickup list
  // silently omitted everyone qualified via the manager's other accepted roles.
  const acceptedRoles = params.accepted_roles?.length
    ? params.accepted_roles
    : await resolveAcceptedRoles(company_id, params.shift_name ?? '', role);
  const dayOfWeek = new Date(shift_date + 'T12:00:00Z').getUTCDay();

  const [empRes, availRes, customAvailRes, toRes, schedRes] = await Promise.all([
    supabase.from('employees').select('*').eq('company_id', company_id).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', company_id),
    supabase.from('custom_availability').select('*')
      .eq('company_id', company_id).eq('active', true)
      .order('created_at', { ascending: false }),
    supabase.from('time_off_requests').select('employee_id')
      .eq('company_id', company_id).eq('status', 'approved')
      .lte('start_date', shift_date).gte('end_date', shift_date),
    supabase.from('schedules').select('data, week_start, week_end').is('deleted_at', null)
      .eq('company_id', company_id).eq('status', 'published')
      .lte('week_start', shift_date).gte('week_end', shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as Availability[];
  const onTO = new Set((toRes.data ?? []).map((r: { employee_id: string }) => r.employee_id));

  const schedRow = schedRes.data as { data: ScheduleData; week_start: string; week_end: string } | null;
  const schedData = schedRow ? schedRow.data : null;
  const weeklyHoursMap = new Map<string, number>();
  if (schedData) {
    for (const a of schedData.assignments) {
      const h = a.hours ?? computeShiftHours(a.start_time, a.end_time);
      weeklyHoursMap.set(a.employee_id, (weeklyHoursMap.get(a.employee_id) ?? 0) + h);
    }
  }

  const availByEmp = new Map<string, Availability[]>();
  for (const a of availability) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
  }

  // CUSTOM-AVAIL-ALIGN — a candidate on a date-limited or rotating availability
  // block must be judged by the availability the ENGINE would use for this week,
  // not their base recurring rows. Mirror the schedule-build load+apply pattern:
  // first custom row per employee, then resolve their effective week availability.
  // Only when a published schedule row (with week bounds) exists — the rotating
  // cycle is anchored to the week-start, so we need it.
  if (schedRow) {
    const customByEmp = new Map<string, CustomAvailability>();
    for (const row of (customAvailRes.data ?? []) as CustomAvailability[]) {
      if (!customByEmp.has(row.employee_id)) customByEmp.set(row.employee_id, row);
    }
    for (const emp of employees) {
      const custom = customByEmp.get(emp.id) ?? null;
      if (!custom) continue;
      const normal = availByEmp.get(emp.id) ?? [];
      const resolved = resolveAvailabilityForWeek(emp, schedRow.week_start, schedRow.week_end, normal, custom);
      if (resolved !== normal) availByEmp.set(emp.id, resolved);
    }
  }

  // Load never-conflicts for the requester to exclude them as candidates
  const { data: conflictData } = await supabase
    .from('employee_conflicts')
    .select('employee_id_1, employee_id_2')
    .eq('company_id', company_id)
    .eq('severity', 'never')
    .or(`employee_id_1.eq.${requester_id},employee_id_2.eq.${requester_id}`);

  const neverConflictIds = new Set<string>();
  for (const c of (conflictData ?? []) as { employee_id_1: string; employee_id_2: string }[]) {
    neverConflictIds.add(c.employee_id_1 === requester_id ? c.employee_id_2 : c.employee_id_1);
  }

  const ns = shift_start.slice(0, 5);
  const ne = shift_end.slice(0, 5);

  // Anyone already assigned to a shift that OVERLAPS the target block that day can't
  // cover it — they're either already on this very shift or on a conflicting one, so
  // asking them to pick it up is nonsense. (Reported miss: a coworker already working
  // the same shift was still broadcast a request to cover it.) Availability alone
  // doesn't catch this — it says when they CAN work, not what they're already on.
  const busyOverlappingTarget = new Set<string>();
  if (schedData) {
    for (const a of schedData.assignments) {
      if (a.date !== shift_date) continue;
      if (a.start_time.slice(0, 5) < ne && a.end_time.slice(0, 5) > ns) {
        busyOverlappingTarget.add(a.employee_id);
      }
    }
  }

  const candidates = employees.filter(emp => {
    if (emp.id === requester_id) return false;
    if (busyOverlappingTarget.has(emp.id)) return false;
    if (onTO.has(emp.id)) return false;
    if (neverConflictIds.has(emp.id)) return false;
    if (!isQualified(emp.qualified_roles, acceptedRoles)) return false;
    const weeklyHours = weeklyHoursMap.get(emp.id) ?? 0;
    if (weeklyHours + shift_hours > emp.max_weekly_hours) return false;
    const empAvail = availByEmp.get(emp.id) ?? [];
    return empAvail.some(a =>
      a.day_of_week === dayOfWeek &&
      a.start_time.slice(0, 5) <= ns &&
      a.end_time.slice(0, 5) >= ne
    );
  });

  // Sort: fewest weekly hours first, then alphabetically
  candidates.sort((a, b) => {
    const ha = weeklyHoursMap.get(a.id) ?? 0;
    const hb = weeklyHoursMap.get(b.id) ?? 0;
    return ha !== hb ? ha - hb : a.name.localeCompare(b.name);
  });

  return candidates;
}

// ── AI extraction ─────────────────────────────────────────────────────────────

// The DIRECTION of a swap, from the SENDER's point of view:
//   'giveaway' — someone takes the sender's shift; the sender gets nothing back
//                ("Emily is taking my Saturday shift", "Colin is covering my Thursday").
//   'pickup'   — the sender takes someone else's shift ("I'll take Joe's Friday shift").
//   'trade'    — a two-way exchange ("swap my Sat AM for Joe's Fri PM").
// Direction governs which shift is which and whether a return shift is required.
export type SwapDirection = 'giveaway' | 'pickup' | 'trade';

export interface SwapExtractionRaw {
  direction?: string | null;
  shift_date?: string | null;
  shift_name?: string | null;
  target_employee_name?: string | null;
  target_shift_date?: string | null;
  target_shift_name?: string | null;
  willing_days?: unknown;
}

export interface SwapExtraction {
  direction: SwapDirection;
  shift_date: string | null;
  shift_name: string | null;
  target_employee_name: string | null;
  target_shift_date: string | null;
  target_shift_name: string | null;
  willing_days: number[];
}

// Pure normalization of the extractor's JSON. Kept separate + exported so the
// direction decision (which routes giveaway vs trade in handleInitiateSwap) is
// unit-testable without the LLM. A missing/unknown direction falls back safely:
// a named return shift ⇒ trade, otherwise ⇒ giveaway (so "X is taking my shift",
// with no return shift, never lands in the two-way trade path by default).
export function normalizeSwapExtraction(parsed: SwapExtractionRaw | null): SwapExtraction {
  const willing_days = Array.isArray(parsed?.willing_days)
    ? (parsed!.willing_days as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6)
    : [];
  const direction: SwapDirection =
    parsed?.direction === 'giveaway' || parsed?.direction === 'pickup' || parsed?.direction === 'trade'
      ? parsed.direction
      : (parsed?.target_shift_name ?? parsed?.target_shift_date) ? 'trade' : 'giveaway';
  return {
    direction,
    shift_date: parsed?.shift_date ?? null,
    shift_name: parsed?.shift_name ?? null,
    target_employee_name: parsed?.target_employee_name ?? null,
    target_shift_date: parsed?.target_shift_date ?? null,
    target_shift_name: parsed?.target_shift_name ?? null,
    willing_days,
  };
}

// Manager sign-off gate for a confirmed swap. A DIRECTED swap — a deliberate
// arrangement between two named people, whether a one-way giveaway or a two-way
// trade — ALWAYS requires the manager. A facilitated one-at-a-time pickup only
// requires the manager when a company swap policy explicitly says so. Exported so
// the gate is unit-testable without the DB/LLM. (The undirected broadcast path is
// separately always manager-gated in its own pickup/trade flow.)
export function swapRequiresManagerApproval(params: {
  mode: 'directed' | 'facilitated';
  targetShiftName?: string | null;
  policyRequiresApproval: boolean;
}): boolean {
  if (params.mode === 'directed') return true;
  if (params.targetShiftName) return true; // a two-way trade always needs sign-off
  return params.policyRequiresApproval;
}

// Pure builder for the coworker-ping message. A one-way giveaway (no target shift)
// must NOT be called a "trade" or say the coworker gives up a shift — they only
// pick up the sender's shift. Exported for unit testing the two wordings.
export function buildSwapAskText(params: {
  receiverName: string;
  requesterName: string;
  shiftName: string;
  shiftStart: string;
  shiftEnd: string;
  role: string;
  shiftDateDisplay: string;
  targetShiftName?: string | null;
  targetShiftDateDisplay?: string | null;
  targetShiftStart?: string | null;
  targetShiftEnd?: string | null;
}): { subject: string; text: string; isGiveaway: boolean } {
  // C-7: one time formatter (no "11:00:00–15:30:00"), BOTH legs of a trade carry
  // their times, and the ask is a natural question — never "reply yes or no".
  const theirShift = `${params.requesterName}'s ${params.shiftName} shift (${formatClockRange(params.shiftStart, params.shiftEnd)}, ${params.role}) on ${params.shiftDateDisplay}`;
  const yourShift = params.targetShiftName
    ? `your ${params.targetShiftName} shift${params.targetShiftStart && params.targetShiftEnd ? ` (${formatClockRange(params.targetShiftStart, params.targetShiftEnd)})` : ''} on ${params.targetShiftDateDisplay ?? params.shiftDateDisplay}`
    : '';
  const isGiveaway = !params.targetShiftName;
  const text = isGiveaway
    ? `${textOpener(params.receiverName)}this is Aegis. ${params.requesterName} says you agreed to take ${theirShift}. ` +
      `Can you confirm you'll cover it?`
    : `${textOpener(params.receiverName)}this is Aegis. ${params.requesterName} would like to trade shifts with you — ` +
      `you'd give up ${yourShift} and pick up ${theirShift}. Are you up for that?`;
  const subject = isGiveaway
    ? `Shift coverage request from ${params.requesterName}`
    : `Shift trade request from ${params.requesterName}`;
  return { subject, text, isGiveaway };
}

// MULTI-TENANT: "today" must be the date in the TENANT's local timezone (their
// companies.timezone row — the same source Homebase writes and the classifier
// reads), never the server's UTC date. A UTC "today" near midnight resolves a
// bare weekday to the wrong day for any non-UTC tenant. No timezone is ever
// hard-coded to a specific client; unknown tenants fall back to America/New_York
// (matching loadCompanyContext).
async function companyLocalToday(companyId: string): Promise<string> {
  const { data } = await supabase.from('companies').select('timezone').eq('id', companyId).single();
  const tz = (data as { timezone: string | null } | null)?.timezone ?? 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// Deterministic weekday→date lookup lines for the extractor prompt. Reuses the
// same weekdayAnchors the classifier uses, so the model never does weekday math
// (the recurring year/day-drift bug). Covers the sender's AND the coworker's
// bare weekdays ("my Saturday ... their Friday").
function weekdayAnchorText(today: string): string {
  const { todayName, thisWeek, nextWeek } = weekdayAnchors(today);
  const fmt = (rows: { name: string; iso: string; isToday: boolean }[]) =>
    rows.map(r => `${r.name}=${r.iso}${r.isToday ? ' (today)' : ''}`).join(', ');
  return `Today is ${todayName}. Resolve EVERY bare weekday (the sender's and the coworker's) to a date using these tables EXACTLY; never compute weekday arithmetic yourself. THIS week: ${fmt(thisWeek)}. NEXT week (only for "next <weekday>"): ${fmt(nextWeek)}.`;
}

async function extractSwapDetails(body: string, today: string): Promise<{
  direction: SwapDirection;
  shift_date: string | null;
  shift_name: string | null;
  target_employee_name: string | null;
  target_shift_date: string | null;
  target_shift_name: string | null;
  willing_days: number[];
}> {
  const system =
    `You are a data extractor for a workforce scheduling system. Today is ${today}. ` +
    `${weekdayAnchorText(today)} ` +
    'A shift swap moves a shift between two people. Determine the DIRECTION from the SENDER\'s point of view: ' +
    '"giveaway" = someone takes the SENDER\'s shift and the sender gets nothing back ("Emily is taking my Saturday shift", "Colin is covering my Thursday AM", "can someone take my Friday?"); ' +
    '"pickup" = the SENDER takes a coworker\'s shift ("I\'ll take Joe\'s Friday PM", "put me on Sam\'s Sunday shift"); ' +
    '"trade" = a two-way exchange where BOTH give up a shift ("swap my Sat AM for Joe\'s Fri PM", "me and Joe are trading — my Sat for his Fri"). ' +
    'When the sender only says a coworker is taking their shift with no shift named for the sender in return, it is a "giveaway", NOT a trade — do not invent a return shift. ' +
    'Extract: shift_date/shift_name = the SENDER\'s own shift involved (the one they give up in a giveaway or trade; for a pure "pickup" of a coworker\'s shift this may be null); ' +
    'target_employee_name = the OTHER person named (null if they didn\'t name anyone); ' +
    'target_shift_date/target_shift_name = the COWORKER\'s shift (the one the sender takes in a pickup/trade; null if not stated or if it is a giveaway); ' +
    'willing_days = the weekdays the SENDER says they CAN work in return, as integers 0=Sunday..6=Saturday (e.g. "I can work Mon/Tue/Wed" → [1,2,3]); empty array if they did not say. ' +
    'Examples: ' +
    '"Emily is taking my 3-9pm shift on Saturday" → direction "giveaway", shift_name "Saturday 3-9pm", target_employee_name "Emily", target_shift_name null. ' +
    '"Colin is taking my Thursday AM" → direction "giveaway", shift_name "Thursday AM", target_employee_name "Colin", target_shift_name null. ' +
    '"swap my Saturday AM for Joe\'s Friday PM" → direction "trade", shift_name "Saturday AM", target_employee_name "Joe", target_shift_name "Friday PM". ' +
    '"can anyone cover my Saturday shift?" → direction "giveaway", shift_name "Saturday", target_employee_name null. ' +
    'Respond with ONLY valid JSON: {"direction":"giveaway"|"pickup"|"trade","shift_date":"YYYY-MM-DD"|null,"shift_name":string|null,"target_employee_name":string|null,"target_shift_date":"YYYY-MM-DD"|null,"target_shift_name":string|null,"willing_days":number[]}';
  const text = await generateReply(system, body, []);
  const parsed = coerceJsonObject<SwapExtractionRaw>(text);
  return normalizeSwapExtraction(parsed);
}

// Resolve the requester's willing WEEKDAYS (0=Sun..6=Sat) to concrete dates that
// actually fall in the schedule week of the shift being given up. Pure + deterministic:
// a swap is within the published week, so a candidate's tradeable shift must land on
// one of these resolved dates. `weekDates` is the list of YYYY-MM-DD in that week.
export function resolveWillingDates(
  willingWeekdays: readonly number[],
  weekDates: readonly string[],
): Set<string> {
  const wanted = new Set(willingWeekdays);
  const out = new Set<string>();
  for (const d of weekDates) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wanted.has(dow)) out.add(d);
  }
  return out;
}

// The 7 YYYY-MM-DD dates of the week starting at weekStart (inclusive).
export function weekDatesFrom(weekStart: string): string[] {
  const start = new Date(weekStart + 'T12:00:00Z');
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// ── Manager notification ──────────────────────────────────────────────────────

export async function sendManagerSwapApprovalRequest(params: {
  company_id: string;
  swap_request_id: string;
  requester: Employee;
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  receiver: Employee;
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  aegis_sms_channel: string | null;
  // Two-way trade: the target's shift the requester takes in return.
  target_shift_date?: string;
  target_shift_name?: string;
  target_role?: string;
  target_shift_start?: string;
  target_shift_end?: string;
}): Promise<void> {
  const { company_id, swap_request_id, requester, receiver, shift_date, shift_name, role, shift_start, shift_end } = params;
  const isTrade = !!params.target_shift_name;

  // Flag-don't-force: if this swap/pickup would seat someone next to a HARD-
  // banned coworker on the shift, surface it as a heads-up in the manager's
  // email — but never block. The manager makes the call. Best-effort; a lookup
  // failure just omits the flag (the swap still goes for approval).
  let bannedPairFlag: string | null = null;
  try {
    const { data: schedForFlag } = await supabase.from('schedules').select('data').is('deleted_at', null)
      .eq('company_id', company_id).eq('status', 'published')
      .lte('week_start', shift_date).gte('week_end', shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();
    const assignments = schedForFlag ? (schedForFlag as { data: { assignments: ScheduleAssignment[] } }).data.assignments : null;
    if (assignments) {
      const conflicts = await loadHardConflicts(company_id);
      // Receiver joins the requester's shift (requester leaves → excluded).
      let who = receiver.name;
      let bannedWith = bannedCohabPartnerName(receiver.id, shift_date, shift_name, assignments, conflicts, requester.id);
      // On a trade, the requester also joins the receiver's shift.
      if (!bannedWith && isTrade && params.target_shift_date && params.target_shift_name) {
        bannedWith = bannedCohabPartnerName(requester.id, params.target_shift_date, params.target_shift_name, assignments, conflicts, receiver.id);
        who = requester.name;
      }
      if (bannedWith) {
        bannedPairFlag = `${who} and ${bannedWith} are a restricted pair — they normally aren't scheduled together. Approving this would place them on the same shift.`;
      } else {
        // D13 — no HARD conflict, so check the soft ones. 'avoid' pairs used to be
        // filtered out of every swap path entirely, so a manager who asked us to
        // keep two people apart would never hear about it on a swap.
        let avoidWho = receiver.name;
        let avoidWith = avoidCohabPartnerName(receiver.id, shift_date, shift_name, assignments, conflicts, requester.id);
        if (!avoidWith && isTrade && params.target_shift_date && params.target_shift_name) {
          avoidWith = avoidCohabPartnerName(requester.id, params.target_shift_date, params.target_shift_name, assignments, conflicts, receiver.id);
          avoidWho = requester.name;
        }
        if (avoidWith) {
          bannedPairFlag = `${avoidWho} and ${avoidWith} are a pair you'd rather not schedule together. This isn't a hard rule, so it's fine if you're happy with it — just flagging it before you approve.`;
        }
      }
    }
  } catch { /* flag is best-effort — never let it block the approval email */ }

  // Find manager — ONE resolver (src/messaging/manager-directory.ts). Replaces a
  // first-manager-wins query plus a case-sensitive contact_email match that
  // returned null on a miss AND on a duplicate, silently skipping the text.
  const swapDirectory = await resolveManagers(company_id);
  const manager = primaryRecipient(swapDirectory, 'approvals', company_id);
  if (!manager) {
    console.error(
      `[shift-swap] swap ${swap_request_id} needs approval but company ${company_id} has no ` +
      'reachable manager or owner. Nobody has been asked.'
    );
    return;
  }
  const managerPhone = manager.phone;

  const approveToken = randomUUID();
  const denyToken = randomUUID();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const sharedPayload = {
    decision_type: 'swap' as const,
    request_id: swap_request_id,
    company_id,
    requester_id: requester.id,
    requester_name: requester.name,
    requester_channel: params.requester_channel,
    requester_contact: params.requester_sender,
    aegis_sms_channel: params.aegis_sms_channel,
    receiver_id: receiver.id,
    receiver_name: receiver.name,
    // The approving manager — persisted to swap_requests.decided_by (Batch-1.5 #9).
    manager_user_id: manager.userId,
    manager_name: manager.name,
    shift_date,
    shift_name,
    role,
    // Two-way trade: when present, the webhook executes a true trade (both
    // employees switch shifts) instead of a one-way reassignment.
    target_shift_date: params.target_shift_date ?? null,
    target_shift_name: params.target_shift_name ?? null,
    target_role: params.target_role ?? null,
    target_shift_start: params.target_shift_start ?? null,
    target_shift_end: params.target_shift_end ?? null,
    expires_at: expires,
  };

  await Promise.all([
    supabase.from('aegis_memory').insert({
      company_id,
      memory_type: 'observation',
      source: `decision_token:${approveToken}`,
      content: JSON.stringify({ ...sharedPayload, action: 'approve' }),
    }),
    supabase.from('aegis_memory').insert({
      company_id,
      memory_type: 'observation',
      source: `decision_token:${denyToken}`,
      content: JSON.stringify({ ...sharedPayload, action: 'deny' }),
    }),
  ]);

  const base = env.BASE_URL;
  const approveUrl = `${base}/webhooks/decision?action=approve&requestId=${swap_request_id}&token=${approveToken}`;
  const denyUrl = `${base}/webhooks/decision?action=deny&requestId=${swap_request_id}&token=${denyToken}`;

  const dateStr = formatDisplayDate(shift_date);
  const targetDateStr = params.target_shift_date ? formatDisplayDate(params.target_shift_date) : dateStr;
  const subject = `Swap Request — ${requester.name} ↔ ${receiver.name} (${formatShortDate(shift_date)})`;

  const detailText = isTrade
    ? `This is a shift trade:\n` +
      `  ${requester.name}: gives up ${shift_name} (${role}) on ${dateStr}, ${shift_start}–${shift_end}; takes ${receiver.name}'s ${params.target_shift_name} on ${targetDateStr}\n` +
      `  ${receiver.name}: gives up ${params.target_shift_name} on ${targetDateStr}; takes ${shift_name} on ${dateStr}\n\n`
    : `Shift:      ${shift_name} (${role}) on ${dateStr}\n` +
      `Time:       ${shift_start}–${shift_end}\n` +
      `Giving up:  ${requester.name}\n` +
      `Taking on:  ${receiver.name}\n\n`;

  const text =
    `${greeting(manager.name)}\n\n` +
    `${firstName(requester.name)} and ${firstName(receiver.name)} have already agreed to ${isTrade ? 'trade shifts' : 'swap a shift'} — the only thing left is your sign-off. ` +
    `The details are below, and either link records your decision right away.\n\n` +
    detailText +
    (bannedPairFlag ? `⚠️  Heads up: ${bannedPairFlag} It's your call — approve or deny below.\n\n` : '') +
    `Approve this ${isTrade ? 'trade' : 'swap'}:\n${approveUrl}\n\n` +
    `Deny this ${isTrade ? 'trade' : 'swap'}:\n${denyUrl}\n\n` +
    "These links expire in 7 days, and I'll take it from there. — Aegis";

  // ── Branded (Quria dark theme) HTML ──────────────────────────────────────
  // Conclusion-first: greeting + the whole ask above the action card; the
  // actionable detail + Approve/Deny buttons live inside one brandActionCard.
  const introHtml = `
<p style="margin:0 0 12px;font-size:16px;color:${BRAND.textPrimary};">${escapeHtml(greeting(manager.name))}</p>
<p style="margin:0;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${escapeHtml(firstName(requester.name))} and ${escapeHtml(firstName(receiver.name))} have already agreed to ${isTrade ? 'trade shifts' : 'swap a shift'} — the only thing left is your sign-off. Everything's in the card below, and either button records your decision right away, so there's nothing else you'll need to do.</p>`;

  const detailsHtml = isTrade
    ? `
<div style="margin:0 0 20px;padding:16px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-radius:8px;">
  <div style="font-size:14px;color:${BRAND.textPrimary};line-height:1.5;"><strong>${escapeHtml(requester.name)}</strong> gives up <strong>${escapeHtml(shift_name)}</strong> (${escapeHtml(role)}) on ${escapeHtml(dateStr)}, ${escapeHtml(shift_start)}–${escapeHtml(shift_end)} &nbsp;→&nbsp; takes <strong>${escapeHtml(params.target_shift_name ?? '')}</strong> on ${escapeHtml(targetDateStr)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:10px;line-height:1.5;"><strong>${escapeHtml(receiver.name)}</strong> gives up <strong>${escapeHtml(params.target_shift_name ?? '')}</strong> on ${escapeHtml(targetDateStr)} &nbsp;→&nbsp; takes <strong>${escapeHtml(shift_name)}</strong> on ${escapeHtml(dateStr)}</div>
</div>`
    : `
<div style="margin:0 0 20px;padding:16px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-radius:8px;">
  <div style="font-size:14px;color:${BRAND.textPrimary};"><strong>Shift:</strong> ${escapeHtml(shift_name)} (${escapeHtml(role)}) — ${escapeHtml(shift_start)}–${escapeHtml(shift_end)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Date:</strong> ${escapeHtml(dateStr)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Giving up:</strong> ${escapeHtml(requester.name)}</div>
  <div style="font-size:14px;color:${BRAND.textPrimary};margin-top:8px;"><strong>Taking on:</strong> ${escapeHtml(receiver.name)}</div>
</div>`;

  const ctaHtml = `
<div style="border-top:1px solid ${BRAND.borderDefault};margin:6px 0 0;padding-top:18px;">
${brandedButtonRow([
  { url: approveUrl, label: 'Approve', variant: 'primary' },
  { url: denyUrl, label: 'Deny', variant: 'secondary' },
])}
  <div style="font-size:13px;color:${BRAND.textMuted};margin:2px 0 6px;">These links expire in 7 days.</div>
</div>`;

  const flagHtml = bannedPairFlag ? `
<div style="margin:0 0 18px;padding:12px 14px;background:${BRAND.warnBg};border:1px solid ${BRAND.warnBorder};border-left:3px solid ${BRAND.warnRule};border-radius:8px;">
  <div style="font-size:14px;color:${BRAND.warnText};line-height:1.5;"><strong>⚠️ Heads up:</strong> ${escapeHtml(bannedPairFlag)} It's your call — approve or deny below.</div>
</div>` : '';

  const bodyHtml = `${introHtml}
${brandActionCard(`Action needed · Shift ${isTrade ? 'trade' : 'swap'}`, `${detailsHtml}${flagHtml}${ctaHtml}`)}`;

  const html = brandedEmailShell({
    bodyHtml,
    preheader: `Shift swap — ${requester.name} ↔ ${receiver.name} (${formatShortDate(shift_date)})`,
  });

  await sendEmail({ to: manager.email, subject, text, html, company_id });

  if (!env.EMAIL_ONLY && managerPhone && params.aegis_sms_channel) {
    await sendSms({
      // Recipient is the MANAGER (not under the employee opt-in regime).
      allowPreConsent: true,
      to: managerPhone,
      from: params.aegis_sms_channel,
      body: managerAlertSms({
        managerName: manager.name,
        summary: `${requester.name} and ${receiver.name} arranged a ${isTrade ? 'shift trade' : 'shift swap'} — ${shift_name} on ${formatShortDate(shift_date)} — and just need your sign-off.`,
        inbox: 'approve',
      }),
      company_id,
    });
  }
}

// ── Execute confirmed swap (no manager approval needed) ───────────────────────

async function executeSwapNow(params: {
  company_id: string;
  requester: Employee;
  requester_channel: 'sms' | 'email';
  requester_sender: string;
  requester_recipient: string;
  requester_raw_subject?: string;
  requester_thread_id?: string;
  receiver: Employee;
  shift_date: string;
  shift_name: string;
  role: string;
  shift_start: string;
  shift_end: string;
  schedule_id: string | null;
  aegis_sms_channel: string | null;
}): Promise<void> {
  const { company_id, requester, receiver, shift_date, shift_name, role, shift_start, shift_end, schedule_id } = params;

  const dateStr = formatDisplayDate(shift_date);
  const shiftDesc = `${shift_name} (${shift_start}–${shift_end}, ${role}) on ${dateStr}`;

  // ── D2 — apply the schedule change BEFORE claiming the swap is approved ────
  // This path used to insert status='approved' first, then apply the swap only
  // `if (schedule_id)`, then tell BOTH employees "your swap has been confirmed!"
  // unconditionally. With no published schedule — or an assignment that didn't
  // match — the row said approved, both people were told it was done, and the
  // schedule never changed.
  const applied: SwapApplyResult = schedule_id
    ? await executeScheduleSwap(company_id, schedule_id, shift_date, shift_name, requester.id, receiver.id, receiver.name)
    : { ok: false, code: 'schedule_not_found', reason: `There's no published schedule covering ${dateStr} yet, so I couldn't put this on it.` };

  const requesterMsgIn: InboundMessage = {
    sender: params.requester_sender, recipient: params.requester_recipient, body: '',
    channel: params.requester_channel, raw_subject: params.requester_raw_subject, thread_id: params.requester_thread_id,
  };
  const requesterContactIn: VerifiedContact = {
    role: 'employee', company_id, employee_id: requester.id, user_id: null,
    name: requester.name, matched_identifier: params.requester_sender, channel: params.requester_channel,
  };

  if (!applied.ok) {
    // Do NOT auto-approve something that isn't on the schedule. Record it as
    // awaiting the manager, and tell both people the truth: the cover is agreed,
    // but it isn't live yet.
    console.error(`[autoApproveSwap] apply failed (${applied.code}) — recording as pending_manager instead of approved: ${applied.reason}`);
    const { data: pendingRow } = await supabase.from('swap_requests').insert({
      company_id,
      requesting_employee_id: requester.id,
      receiving_employee_id: receiver.id,
      shift_date,
      shift_name,
      role,
      status: 'pending_manager',
      initiated_by: 'aegis',
      // L4 — facilitated auto-approval is one-way by construction: a request
      // carrying a return shift is forced down the manager-approval path by
      // swapRequiresManagerApproval, so it never reaches here.
      kind: 'pickup',
      notes: withSwapKind(`Auto-approval could not be applied to the schedule (${applied.code}): ${applied.reason} Needs a manager to publish the week and approve.`, 'pickup'),
    }).select('id').single();

    await reply(
      requesterContactIn, requesterMsgIn,
      `${textOpener(requester.name)}${receiver.name} has agreed to cover your ${shiftDesc} — but I couldn't put it on the schedule yet because that week isn't published. Your manager will confirm it. Plan on working the shift until you hear it's locked in.`,
    );
    await sendOutreachMessage({
      receiverId: receiver.id,
      receiverEmail: receiver.contact_email ?? null,
      receiverPhone: receiver.contact_phone ?? null,
      aegisSmsNumber: params.aegis_sms_channel,
      subject: `Covering ${requester.name}'s ${shift_name} shift — not final yet`,
      text: `${textOpener(receiver.name)}thanks for agreeing to cover ${requester.name}'s ${shiftDesc}. It isn't on the schedule yet because that week hasn't been published — your manager will confirm it. I'll let you know when it's locked in.`,
      company_id,
    });

    await logActivity({
      company_id,
      action: 'swap_apply_failed',
      entity_type: 'swap_request',
      entity_id: (pendingRow as { id: string } | null)?.id ?? 'unknown',
      summary: `Auto-approval NOT applied (${applied.code}): ${requester.name} ↔ ${receiver.name}, ${shift_name} on ${shift_date}. Left pending_manager.`,
      metadata: { requester_id: requester.id, receiver_id: receiver.id, shift_date, shift_name, role, code: applied.code, reason: applied.reason },
    });
    return;
  }

  // The schedule changed. Now the approval is real — record it with its receipt.
  const { data: swapRow } = await supabase.from('swap_requests').insert({
    company_id,
    requesting_employee_id: requester.id,
    receiving_employee_id: receiver.id,
    shift_date,
    shift_name,
    role,
    status: 'approved',
    schedule_id: applied.schedule_id,
    initiated_by: 'aegis',
    decided_at: new Date().toISOString(),
    decided_by: null, // UUID column — system auto-approval has no manager user; null (decided_at + notes record it). Writing a string here threw invalid-uuid and failed the insert.
    kind: 'pickup',
    notes: withSwapKind('Auto-approved — no manager approval required per company policy.', 'pickup'),
  }).select('id').single();

  const swapId = (swapRow as { id: string } | null)?.id ?? 'unknown';

  // Notify requester
  await reply(requesterContactIn, requesterMsgIn, `${textOpener(requester.name)}your swap has been confirmed! ${receiver.name} will cover your ${shiftDesc}.`);

  // Notify receiver — EMAIL-FIRST (SMS only once A2P clears).
  await sendOutreachMessage({
    receiverId: receiver.id,
    receiverEmail: receiver.contact_email ?? null,
    receiverPhone: receiver.contact_phone ?? null,
    aegisSmsNumber: params.aegis_sms_channel,
    subject: `You're covering a ${shift_name} shift on ${formatShortDate(shift_date)}`,
    text: `${textOpener(receiver.name)}your swap with ${requester.name} is confirmed. You're covering the ${shiftDesc}.`,
    company_id,
  });

  await logActivity({
    company_id,
    action: 'swap_approved',
    entity_type: 'swap_request',
    entity_id: swapId,
    summary: `Swap approved: ${requester.name} ↔ ${receiver.name} for ${shift_name} on ${shift_date}`,
    // schedule_updated is now a FACT, not an assumption: we only get here if the
    // schedule write returned ok.
    metadata: { requester_id: requester.id, receiver_id: receiver.id, shift_date, shift_name, role, schedule_updated: true, schedule_id: applied.schedule_id },
  });
}

// ── Main handlers ─────────────────────────────────────────────────────────────

export async function handleInitiateSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>,
  // W-2 (J-4): when the router resumes an open question ("which shift?"), the
  // original extraction rides back in with the answer merged — the model is
  // never asked to re-read a one-word reply.
  rawOverride?: StoredSwapExtraction
): Promise<void> {
  // Tenant-local date (companies.timezone), NOT server UTC — so bare weekdays
  // ("Saturday", "Friday") resolve to the right day for any client's timezone.
  const today = await companyLocalToday(contact.company_id);
  const raw = rawOverride ?? await extractSwapDetails(message.body, today);

  // One writer for the open-question state (Rule 0b): the ask keeps everything
  // extracted so far, and handleSwapConfirmation reads the next reply as the
  // answer instead of letting the router re-classify it (J-4's "Sunday" became
  // a schedule query exactly because these asks kept nothing).
  const storeAsk = async (awaiting: 'which_shift' | 'which_target_shift', shiftDate?: string) => {
    const pendingAsk: PendingSwap = {
      mode: raw.target_employee_name ? 'directed' : 'facilitated',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      channel: message.channel,
      sender: message.sender,
      recipient: message.recipient,
      raw_subject: message.raw_subject,
      thread_id: message.thread_id,
      shift_date: shiftDate ?? raw.shift_date ?? '',
      shift_name: raw.shift_name ?? '',
      role: '',
      shift_start: '',
      shift_end: '',
      schedule_id: null,
      awaiting,
      raw,
      expires_at: new Date(Date.now() + PENDING_SWAP_TTL_MS).toISOString(),
    };
    await storePendingSwap(pendingAsk);
  };

  const shiftNameHint = raw.shift_name ?? null;
  const targetName = raw.target_employee_name ?? null;

  // Resolve WHICH shift to swap. If the message named a date, use it. If it did NOT,
  // don't silently assume "today" (that surfaced a confusing "no shift on <today>")
  // — resolve the requester's upcoming shift and use the single obvious one, or ask
  // which when there is more than one.
  let shiftDate: string;
  let shift: ScheduleAssignment | null = null;
  let schedule: { id: string; data: ScheduleData } | null = null;
  if (raw.shift_date) {
    shiftDate = raw.shift_date;
    schedule = await findSchedule(contact.company_id, shiftDate);
    // L4 [SWAP-SHIFT-RESOLVE] — resolve strictly within the REQUESTER's own
    // assignments. The old employee-agnostic fallback could hand back a
    // coworker's shift as side A; see resolveRequesterShiftOnDate.
    if (schedule) {
      const own = resolveRequesterShiftOnDate(
        schedule.data, contact.employee_id!, shiftDate, shiftNameHint,
      );
      if (own.kind === 'ambiguous') {
        // They work more than one shift that day and didn't say which. Ask —
        // picking one silently gives away a shift they never named — and KEEP
        // the question open so the answer lands here, not in the classifier.
        await storeAsk('which_shift', shiftDate);
        const list = own.shifts
          .map(a => `${a.shift_name} (${formatClockRange(a.start_time, a.end_time)})`)
          .join(', or ');
        await reply(contact, message,
          `You're on more than one shift on ${formatDisplayDate(shiftDate)} — which one did you mean: ${list}? ` +
          `Tell me which and I'll set it up.`);
        await logActivity({
          company_id: contact.company_id,
          action: 'swap_shift_ambiguous',
          summary: `${contact.name} asked to swap on ${shiftDate} but works ${own.shifts.length} shifts that day — asked which.`,
          metadata: { requester_id: contact.employee_id, shift_date: shiftDate, shift_name_hint: shiftNameHint },
        });
        return;
      }
      if (own.kind === 'one') shift = own.shift;
    }
    if (!shift) {
      // C-7: "I couldn't find a shift … matching 'Saturday'" read like a log line.
      // Say plainly that they're not scheduled that day, and if they ARE on the
      // same weekday the following week, offer that date.
      const suggestion = await suggestSameWeekdayNextWeek(contact.company_id, contact.employee_id!, shiftDate);
      await reply(contact, message,
        `${textOpener(contact.name)}you're not scheduled ${describeDayForNotScheduled(shiftDate, today)}` +
        (suggestion
          ? ` — did you mean the ${ordinalDay(suggestion.date)}? You're on ${suggestion.shift_name} (${formatClockRange(suggestion.start_time, suggestion.end_time)}) that day.`
          : `. If you think a shift is missing, your manager can check the schedule.`)
      );
      return;
    }
  } else {
    schedule = await findSchedule(contact.company_id, today);
    const choice = pickUpcomingShift(schedule?.data.assignments ?? [], contact.employee_id!, today, shiftNameHint);
    if (choice.kind === 'none') {
      await reply(contact, message,
        `I don't see any upcoming shifts on your schedule to swap${shiftNameHint ? ` matching "${shiftNameHint}"` : ''}. If that seems off, check with your manager.`
      );
      return;
    }
    if (choice.kind === 'ambiguous') {
      // W-2 (J-4) — keep the question open: "Sunday" is the answer, not a query.
      await storeAsk('which_shift');
      const list = choice.shifts.map(a => `your ${a.shift_name} shift on ${formatDisplayDate(a.date)}`).join(', or ');
      await reply(contact, message, `Which shift did you want to swap — ${list}? Just tell me which one.`);
      return;
    }
    shift = choice.shift;
    shiftDate = choice.shift.date;
  }

  const shiftHours = shift.hours ?? computeShiftHours(shift.start_time, shift.end_time);
  const mode: 'directed' | 'facilitated' = targetName ? 'directed' : 'facilitated';

  // Load swap policies for validation
  const { data: policyData } = await supabase.from('policies').select('*')
    .eq('company_id', contact.company_id).eq('policy_type', 'swaps');
  const policies = (policyData ?? []) as Policy[];

  if (mode === 'directed') {
    const targetEmployee = await findEmployeeByName(contact.company_id, targetName!);
    if (!targetEmployee) {
      await reply(contact, message,
        `I couldn't find an employee named "${targetName}" in the system. Please check the name and try again, or ask Aegis to find someone for you.`
      );
      return;
    }

    // Guard against a self-referential swap (name resolves back to the requester,
    // e.g. "Alex is taking my shift" sent by Alex) — a swap needs two distinct people.
    if (targetEmployee.id === contact.employee_id) {
      await reply(contact, message,
        `That's your own shift — a swap needs a coworker to take it. Who would you like to swap with, or want me to ask the team if anyone can cover it?`
      );
      return;
    }

    // Direction "giveaway" — the named coworker is TAKING the sender's shift and the
    // sender gets nothing back (e.g. "Emily is taking my Saturday shift", "Colin is
    // taking my Thursday AM"). This is a one-way pickup by a specific person, NOT a
    // two-way trade — so there is no coworker shift to choose. Validate only that the
    // coworker can work the sender's shift, then confirm the give-up in one-way wording.
    // (The downstream confirm/outreach/execute path already supports a null target
    // shift — see the PendingSwap.target_shift_* comment and executeScheduleSwap.)
    if (raw.direction === 'giveaway') {
      const targetTakesYours = await validateSwap({
        company_id: contact.company_id, requester_id: contact.employee_id!,
        receiver: targetEmployee, shift_date: shiftDate, role: shift.role,
        // RULE 0b — validate against every role the manager said can fill the shift.
        shift_name: shift.shift_name, accepted_roles: acceptedRolesOf(shift),
        shift_hours: shiftHours, policies,
      });
      if (!targetTakesYours.valid) {
        await reply(contact, message,
          `This swap can't proceed: ${targetTakesYours.reason} Want to try a different coworker, or ask "can anyone take my ${shift.shift_name} shift?" instead?`);
        await logActivity({ company_id: contact.company_id, action: 'swap_validation_failed',
          summary: `${contact.name}'s giveaway to ${targetEmployee.name} failed (${targetEmployee.name} taking requester's shift): ${targetTakesYours.reason}`,
          metadata: { requester_id: contact.employee_id, receiver_id: targetEmployee.id, shift_date: shiftDate, mode: 'directed', direction: 'giveaway', reason: targetTakesYours.reason } });
        return;
      }

      const pending: PendingSwap = {
        mode: 'directed',
        company_id: contact.company_id,
        requester_id: contact.employee_id!,
        requester_name: contact.name,
        channel: message.channel,
        sender: message.sender,
        recipient: message.recipient,
        raw_subject: message.raw_subject,
        thread_id: message.thread_id,
        shift_date: shiftDate,
        shift_name: shift.shift_name,
        role: shift.role,
        shift_start: shift.start_time,
        shift_end: shift.end_time,
        schedule_id: schedule?.id ?? null,
        target_employee_id: targetEmployee.id,
        target_employee_name: targetEmployee.name,
        // No target_shift_* — one-way giveaway (the coworker gives up nothing).
        expires_at: new Date(Date.now() + PENDING_SWAP_TTL_MS).toISOString(),
      };
      await storePendingSwap(pending);

      await reply(contact, message,
        `Got it — ${firstName(targetEmployee.name)} would take your ${shift.shift_name} shift on ${formatDisplayDate(shiftDate)} (${formatClockRange(shift.start_time, shift.end_time)}) and you'd be off, no shift back. Want me to check with ${firstName(targetEmployee.name)} and line it up with your manager?`
      );
      return;
    }

    // L4 — DIRECTION 'pickup' HAD NO BRANCH, so it fell through to the TRADE
    // path below.
    //
    // The classifier (extractSwapDetails) defines three directions:
    //   giveaway — a coworker takes the SENDER's shift, sender gets nothing back
    //   pickup   — the SENDER takes a COWORKER's shift ("I'll take Joe's Friday")
    //   trade    — two-way; both give up a shift
    // and normalizeSwapExtraction faithfully passes 'pickup' through (there is
    // even a test pinning that it does). But handleInitiateSwap branched only on
    // 'giveaway', so a pickup silently became a two-way trade: the sender's own
    // shift — resolved earlier, and on a pickup message frequently resolved from
    // an upcoming-shift guess rather than anything the sender named — was given
    // away as the return leg. The employee never asked to give up a shift, and
    // the leg most likely to be wrong is exactly the leg that produced the
    // half-applied trades this batch is fixing.
    //
    // A pickup is also the DIRECTIONAL INVERSE of a giveaway (sender takes,
    // rather than sender gives), so it cannot be routed to the giveaway branch
    // either — that would move the wrong shift.
    //
    // Until a genuine one-way pickup flow exists, ASK. Guessing is what caused
    // the bug; an extra question costs one message.
    if (raw.direction === 'pickup') {
      await reply(contact, message,
        `Just so I get this right — do you want to TRADE with ${firstName(targetEmployee.name)} ` +
        `(you take one of their shifts and they take your ${shift.shift_name} shift on ${formatDisplayDate(shiftDate)}), ` +
        `or are you offering to COVER one of their shifts without giving up any of your own? ` +
        `Tell me which and I'll set it up.`
      );
      await logActivity({
        company_id: contact.company_id,
        action: 'swap_direction_ambiguous',
        summary: `${contact.name} sent a one-way PICKUP for ${targetEmployee.name} — asked to disambiguate rather than assuming a trade.`,
        metadata: {
          requester_id: contact.employee_id, receiver_id: targetEmployee.id,
          shift_date: shiftDate, shift_name: shift.shift_name,
          mode: 'directed', direction: 'pickup',
        },
      });
      return;
    }

    // A swap is a TRADE — find which of the target's shifts the requester takes
    // in return. They name it; we only ask if more than one still matches.
    const choice = schedule
      ? chooseTradeShift(schedule.data, targetEmployee.id, { shift_name: raw.target_shift_name, date: raw.target_shift_date })
      : ({ kind: 'none' } as TradeShiftChoice);

    if (choice.kind === 'none') {
      await reply(contact, message,
        `${targetEmployee.name} doesn't have a shift on the schedule that week to trade for — a swap trades two shifts, so they'd need one of their own to give you. Want to try a different coworker, or ask "can anyone take my ${shift.shift_name} shift?" instead?`
      );
      return;
    }
    if (choice.kind === 'ambiguous') {
      // W-2 (J-4) — keep the question open for the one-word answer.
      await storeAsk('which_target_shift', shiftDate);
      const list = choice.shifts
        .map(s => `${s.shift_name} on ${formatDisplayDate(s.date)} (${formatClockRange(s.start_time, s.end_time)})`)
        .join('; ');
      await reply(contact, message,
        `${targetEmployee.name} has more than one shift that week — which of theirs do you want to take? ${list}. Just tell me which one and I'll set up the trade.`
      );
      return;
    }
    const targetShift = choice.shift;
    const targetShiftHours = targetShift.hours ?? computeShiftHours(targetShift.start_time, targetShift.end_time);

    // Load the requester's full record for the reverse-direction validation.
    const { data: reqEmpData } = await supabase.from('employees').select('*')
      .eq('id', contact.employee_id!).single();
    const requesterEmployee = reqEmpData as Employee | null;
    if (!requesterEmployee) {
      await reply(contact, message, 'Something went wrong looking up your record — please try again in a moment.');
      return;
    }

    // Validate BOTH directions of the trade: the target must be able to work the
    // requester's shift, AND the requester must be able to work the target's.
    const targetTakesYours = await validateSwap({
      company_id: contact.company_id, requester_id: contact.employee_id!,
      receiver: targetEmployee, shift_date: shiftDate, role: shift.role,
      // RULE 0b — validate against every role the manager said can fill the shift.
      shift_name: shift.shift_name, accepted_roles: acceptedRolesOf(shift),
      shift_hours: shiftHours, policies,
    });
    if (!targetTakesYours.valid) {
      await reply(contact, message,
        `This swap can't proceed: ${targetTakesYours.reason} Please choose a different coworker or contact your manager.`);
      await logActivity({ company_id: contact.company_id, action: 'swap_validation_failed',
        summary: `${contact.name}'s trade with ${targetEmployee.name} failed (target taking requester's shift): ${targetTakesYours.reason}`,
        metadata: { requester_id: contact.employee_id, receiver_id: targetEmployee.id, shift_date: shiftDate, reason: targetTakesYours.reason } });
      return;
    }
    const youTakeTheirs = await validateSwap({
      company_id: contact.company_id, requester_id: targetEmployee.id,
      receiver: requesterEmployee, shift_date: targetShift.date, role: targetShift.role,
      shift_name: targetShift.shift_name, accepted_roles: acceptedRolesOf(targetShift),
      shift_hours: targetShiftHours, policies,
    });
    if (!youTakeTheirs.valid) {
      // L3 — REACTIVE CANCEL. When the ONLY thing standing between this employee
      // and the shift they want is their own approved time off, offering to
      // cancel it right here is the difference between a dead end and a solved
      // problem. Any other refusal reason (not qualified, at max hours, banned
      // pair) is not theirs to fix, so it keeps the original copy.
      //
      // Note the argument order: validateSwap is called with the REQUESTER in
      // the `receiver` slot for this leg, so `youTakeTheirs.reason` really is
      // about the person we're talking to. It still offers rather than acts —
      // the same explicit yes/no gate as the proactive path (RULE 0b: one
      // question, one function — askToCancelTimeOff owns the wording).
      const blockedByOwnTimeOff = /approved time off/i.test(youTakeTheirs.reason ?? '');
      if (blockedByOwnTimeOff && contact.employee_id) {
        const { findApprovedTimeOffOn, askToCancelTimeOff } = await import('./time-off');
        const ownTimeOff = await findApprovedTimeOffOn(
          contact.company_id, contact.employee_id, targetShift.date,
        );
        if (ownTimeOff) {
          await logActivity({ company_id: contact.company_id, action: 'swap_blocked_offered_to_cancel_time_off',
            summary: `${contact.name}'s trade with ${targetEmployee.name} is blocked by their own approved time off on ${targetShift.date} — offered to cancel it.`,
            metadata: { requester_id: contact.employee_id, receiver_id: targetEmployee.id, target_shift_date: targetShift.date, time_off_request_id: ownTimeOff.id } });
          await askToCancelTimeOff({
            message, contact, request: ownTimeOff,
            lead: `You can't take ${targetEmployee.name}'s ${targetShift.shift_name} shift on that date because you have approved time off then —` +
              ` but you can cancel it if you want the shift.`,
          });
          return;
        }
      }

      await reply(contact, message,
        `This swap can't proceed — you wouldn't be able to take ${targetEmployee.name}'s ${targetShift.shift_name} shift: ${reasonAddressedToYou(youTakeTheirs.reason ?? '', contact.name)} Want to try a different shift or coworker?`);
      await logActivity({ company_id: contact.company_id, action: 'swap_validation_failed',
        summary: `${contact.name}'s trade with ${targetEmployee.name} failed (requester taking target's shift): ${youTakeTheirs.reason}`,
        metadata: { requester_id: contact.employee_id, receiver_id: targetEmployee.id, target_shift_date: targetShift.date, reason: youTakeTheirs.reason } });
      return;
    }

    // Both directions valid — ask the requester to confirm the trade.
    const pending: PendingSwap = {
      mode: 'directed',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      channel: message.channel,
      sender: message.sender,
      recipient: message.recipient,
      raw_subject: message.raw_subject,
      thread_id: message.thread_id,
      shift_date: shiftDate,
      shift_name: shift.shift_name,
      role: shift.role,
      shift_start: shift.start_time,
      shift_end: shift.end_time,
      schedule_id: schedule?.id ?? null,
      target_employee_id: targetEmployee.id,
      target_employee_name: targetEmployee.name,
      target_shift_date: targetShift.date,
      target_shift_name: targetShift.shift_name,
      target_role: targetShift.role,
      target_shift_start: targetShift.start_time,
      target_shift_end: targetShift.end_time,
      expires_at: new Date(Date.now() + PENDING_SWAP_TTL_MS).toISOString(),
    };
    await storePendingSwap(pending);

    await reply(contact, message,
      `Just so I've got it: you'd give up your ${shift.shift_name} shift on ${formatDisplayDate(shiftDate)} and pick up ${targetEmployee.name}'s ${targetShift.shift_name} shift on ${formatDisplayDate(targetShift.date)}. Want me to run it by ${firstName(targetEmployee.name)}?`
    );
  } else {
    // Mode 2: facilitated — quick feasibility check
    const candidates = await buildSwapCandidates({
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      shift_date: shiftDate,
      role: shift.role,
      // RULE 0b — the assignment carries what the manager said can fill it.
      shift_name: shift.shift_name,
      accepted_roles: acceptedRolesOf(shift),
      shift_start: shift.start_time,
      shift_end: shift.end_time,
      shift_hours: shiftHours,
    });

    const pending: PendingSwap = {
      mode: 'facilitated',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      channel: message.channel,
      sender: message.sender,
      recipient: message.recipient,
      raw_subject: message.raw_subject,
      thread_id: message.thread_id,
      shift_date: shiftDate,
      shift_name: shift.shift_name,
      role: shift.role,
      shift_start: shift.start_time,
      shift_end: shift.end_time,
      schedule_id: schedule?.id ?? null,
      willing_days: raw.willing_days,
      expires_at: new Date(Date.now() + PENDING_SWAP_TTL_MS).toISOString(),
    };
    await storePendingSwap(pending);

    const candidateNote = candidates.length > 0
      ? `I found ${candidates.length} teammate${candidates.length !== 1 ? 's' : ''} who could help. `
      : "I didn't find anyone available right now, but ";
    // If they told me which days they can work, the broadcast also offers a trade;
    // otherwise it goes out as pickup-only.
    const willingDayNames = formatWeekdayNames(raw.willing_days);
    const tradeNote = raw.willing_days.length > 0
      ? `Anyone who'd rather trade can offer you a shift on ${willingDayNames} in return. `
      : `Since you didn't mention days you could work instead, I'll send it as a straight pickup (no trade). If you'd like to allow trades, tell me which days you can work. `;

    await reply(contact, message,
      buildFacilitatedSwapConfirm({
        shiftLabel: `${shift.shift_name} shift (${shift.role}, ${formatClockRange(shift.start_time, shift.end_time)})`,
        dateLabel: formatDisplayDate(shiftDate),
        candidateNote,
        tradeNote,
      })
    );
  }
}

// Facilitated (no coworker named) swap confirmation. Surfaces the option to name
// a specific coworker for a DIRECTED swap before defaulting to a full-pool ask
// (Batch-1.5 #8 — the flow used to drop silently into a broadcast). Pure so the
// directed hint can be asserted in a test.
export function buildFacilitatedSwapConfirm(p: {
  shiftLabel: string;
  dateLabel: string;
  candidateNote: string;
  tradeNote: string;
}): string {
  return (
    `You want someone to take your ${p.shiftLabel} on ${p.dateLabel}. ${p.candidateNote}${p.tradeNote}` +
    `If you'd rather ask one person, just tell me their name and I'll set it up with them directly — otherwise, want me to ask the team?`
  );
}

// Reach a coworker for a directed swap offer — SMS-FIRST for phone-holders
// (SMS spec §3.4: swaps are text-native employee↔employee), email as the fallback
// on no-phone or SMS send failure. Replies route back via the same swap_outreach
// record keyed by the employee, on either channel. (Batch-1 systemic sweep — this
// was email-first, an email-era holdover.)
async function sendOutreachMessage(params: {
  receiverId: string | null; // the coworker EMPLOYEE being asked — gates the SMS (N3)
  receiverEmail: string | null;
  receiverPhone: string | null;
  aegisSmsNumber: string | null;
  subject: string;
  text: string;
  company_id: string;
}): Promise<'email' | 'sms' | 'none'> {
  const { receiverId, receiverEmail, receiverPhone, aegisSmsNumber, subject, text, company_id } = params;
  if (!env.EMAIL_ONLY && receiverPhone && aegisSmsNumber) {
    const ok = await sendSms({ to: receiverPhone, from: aegisSmsNumber, body: text, company_id, employee_id: receiverId ?? undefined });
    if (ok) return 'sms';
    console.warn(`[swap-outreach] SMS send failed for company ${company_id}; falling back to email`);
  }
  if (receiverEmail) {
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = brandedEmailShell({
      bodyHtml: `<p style="margin:0;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${safe}</p>`,
      preheader: subject,
    });
    // Only report 'email' if the send actually went through — a swallowed
    // SendGrid failure must not make us tell the requester we reached the coworker.
    const ok = await sendEmail({ to: receiverEmail, subject, text, html, company_id });
    return ok ? 'email' : 'none';
  }
  return 'none';
}

// ── W-2 (J-4/C-5): confirm-gate edit support ─────────────────────────────────

function stripSwapMemoryId(p: PendingSwap & { _memory_id?: string }): PendingSwap {
  const { _memory_id: _drop, ...rest } = p;
  return rest;
}

// The reply to an OPEN QUESTION ("which shift?" / "which of theirs?") is its
// answer. Merge it into the stored extraction and resume handleInitiateSwap —
// no model re-read of a one-word reply, and never a re-classification
// (Katie's "Sunday" became a schedule query; this is that fix).
async function handleSwapOpenQuestionAnswer(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingSwap & { awaiting: 'which_shift' | 'which_target_shift'; raw: StoredSwapExtraction }
): Promise<void> {
  const yn = parseYesNo(message.body);
  if (yn === 'no') {
    await clearPendingSwap(contact.company_id, contact.employee_id!);
    await reply(contact, message, "No problem — I've dropped it. Let me know if you need anything else.");
    return;
  }

  const today = await companyLocalToday(contact.company_id);
  const answer = yn === 'yes' ? null : parseShiftAnswer(message.body, today);
  if (!answer) {
    // Not an answer we can read. A clearly-different request may take over
    // (explicit different intent — the gate never clears on mere "unclear").
    const { employeeInterruptIntent } = await import('../router/interrupt');
    const interrupt = await employeeInterruptIntent(message, contact);
    if (interrupt) {
      await clearPendingSwap(contact.company_id, contact.employee_id!);
      const { routeIntent } = await import('../router/intent-router');
      await routeIntent(message, contact);
      return;
    }
    await reply(contact, message,
      pending.awaiting === 'which_shift'
        ? `Just tell me which shift you meant — a day ("Sunday") or the shift name works.`
        : `Just tell me which of their shifts you want — a day ("Sunday") or the shift name works.`);
    return;
  }

  const raw: StoredSwapExtraction = { ...pending.raw };
  if (pending.awaiting === 'which_shift') {
    if (answer.shift_date) raw.shift_date = answer.shift_date;
    if (answer.shift_name_hint) raw.shift_name = answer.shift_name_hint;
  } else {
    if (answer.shift_date) raw.target_shift_date = answer.shift_date;
    if (answer.shift_name_hint) raw.target_shift_name = answer.shift_name_hint;
  }
  await clearPendingSwap(contact.company_id, contact.employee_id!);
  await handleInitiateSwap(message, contact, {}, raw);
}

// A named person at the swap gate ("ask mia", "send it to Jenna"):
//  • the person it's ALREADY set up with → 'yes' (caller re-enters as a yes)
//  • someone else, found and not the requester → re-run the swap DIRECTED at
//    them ('redirected'; validation + a fresh confirm come from the one
//    initiate path — Rule 0b)
//  • not found / self → say so, keep the gate open ('kept'), offer the broadcast
async function handleSwapGateNamedPerson(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingSwap,
  name: string
): Promise<'yes' | 'redirected' | 'kept'> {
  const emp = await findEmployeeByName(contact.company_id, name);
  if (!emp) {
    await reply(contact, message,
      `I don't see anyone named "${name}" on the team — double-check the name? ` +
      `Or say the word and I'll ask everyone who's qualified instead.`);
    return 'kept';
  }
  if (pending.target_employee_id && emp.id === pending.target_employee_id) return 'yes';
  if (emp.id === contact.employee_id) {
    await reply(contact, message,
      `That's you — I need a coworker to take the shift. Who should I ask, or want me to ask the team?`);
    return 'kept';
  }
  await clearPendingSwap(contact.company_id, contact.employee_id!);
  const raw: StoredSwapExtraction = {
    // A directed trade keeps trading; anything else becomes a directed giveaway.
    direction: pending.target_shift_name ? 'trade' : 'giveaway',
    shift_date: pending.shift_date || null,
    shift_name: pending.shift_name || null,
    target_employee_name: emp.name,
    target_shift_date: null,
    target_shift_name: null,
    willing_days: pending.willing_days ?? [],
  };
  await handleInitiateSwap(message, contact, {}, raw);
  return 'redirected';
}

// Called from router pre-check when swap_pending:{employeeId} exists.
export async function handleSwapConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingSwap & { _memory_id?: string }
): Promise<void> {
  // ── W-2 (J-4): an open question reads the reply as its ANSWER ──────────────
  if (pending.awaiting && pending.raw) {
    await handleSwapOpenQuestionAnswer(message, contact, pending as PendingSwap & { awaiting: NonNullable<PendingSwap['awaiting']>; raw: StoredSwapExtraction });
    return;
  }

  const answer = parseYesNo(message.body);

  if (answer === 'unclear') {
    // ── W-2 (C-5): a non-yes/no reply is an EDIT before it is anything else ──
    //
    // 1. A NAMED PERSON ("ask mia", "send it to Jenna") directs the swap to
    //    that person — never a broadcast (Maisey's "ask mia" went to three
    //    people, none of them Mia). Naming the person it's ALREADY set up with
    //    is a yes.
    const namedRaw = parseNamedDirective(message.body);
    if (namedRaw) {
      const handled = await handleSwapGateNamedPerson(message, contact, pending, namedRaw);
      if (handled === 'redirected' || handled === 'kept') return;
      // handled === 'yes': naming the person it's already set up with IS the
      // confirmation — re-enter as a yes.
      await handleSwapConfirmation({ ...message, body: 'yes' }, contact, pending);
      return;
    }
    // 2. A WILLING-DAYS reply at the facilitated gate answers the confirm's own
    //    invitation ("tell me which days you can work") — it is NOT an
    //    availability change, and it must not clear the gate (J-4's root
    //    cause: the interrupt below re-routed it to update_availability).
    if (pending.mode === 'facilitated' && !namedRaw) {
      const willing = parseWillingDaysReply(message.body);
      if (willing) {
        const updated: PendingSwap = { ...stripSwapMemoryId(pending), willing_days: willing };
        await storePendingSwap(updated);
        await reply(contact, message,
          buildFacilitatedSwapConfirm({
            shiftLabel: `${pending.shift_name} shift (${pending.role}, ${formatClockRange(pending.shift_start, pending.shift_end)})`,
            dateLabel: formatDisplayDate(pending.shift_date),
            candidateNote: 'Noted. ',
            tradeNote: `Anyone who'd rather trade can offer you a shift on ${formatWeekdayNames(willing)} in return. `,
          })
        );
        return;
      }
    }
    // H7 — before re-asking, yield to a clearly-different actionable request so a
    // pending (unsent) swap confirmation does not hold a schedule query / time-off
    // / new swap hostage. The pending swap was never sent to anyone, so abandoning
    // it to handle the new request is safe (mirrors the time-off-confirm MOVED_ON
    // re-route). A genuine fumbled yes/no still falls through to the re-ask below —
    // the gate clears ONLY on yes / no / an explicit different intent, never on
    // "unclear" (W-2/J-4).
    const { employeeInterruptIntent } = await import('../router/interrupt');
    const interrupt = await employeeInterruptIntent(message, contact);
    if (interrupt) {
      await clearPendingSwap(contact.company_id, contact.employee_id!);
      const { routeIntent } = await import('../router/intent-router');
      await routeIntent(message, contact);
      return;
    }
    await reply(contact, message,
      "Just let me know — should I set that swap up? Or tell me what to change — a different day, or a specific person to ask — and I'll fix it up."
    );
    return;
  }

  await clearPendingSwap(contact.company_id, contact.employee_id!);

  if (answer === 'no') {
    await reply(contact, message, 'Swap request cancelled. Let me know if you need anything else.');
    return;
  }

  // Employee confirmed — proceed
  const aegisSmsNumber = await getAegisSmsChannel(contact.company_id);

  if (pending.mode === 'directed') {
    if (!pending.target_employee_id || !pending.target_employee_name) {
      await reply(contact, message, 'Something went wrong — could not find the target employee. Please try again.');
      return;
    }

    const { data: receiverData } = await supabase.from('employees').select('*')
      .eq('id', pending.target_employee_id).single();
    const receiver = receiverData as Employee | null;
    if (!receiver) {
      await reply(contact, message, 'Something went wrong — could not find the target employee. Please try again.');
      return;
    }

    // Email-first: reach the target by email if they have one, otherwise by text.
    const receiverEmail = receiver.contact_email ?? null;
    const receiverPhone = receiver.contact_phone ?? null;
    if (!receiverEmail && !(receiverPhone && aegisSmsNumber)) {
      await reply(contact, message,
        `${pending.target_employee_name} doesn't have an email or phone on file, so I can't reach them to set up the trade. You'll need to contact them directly.`
      );
      return;
    }

    const outreach: SwapOutreach = {
      mode: 'directed',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      requester_channel: message.channel,
      requester_sender: message.sender,
      requester_recipient: message.recipient,
      requester_raw_subject: message.raw_subject,
      requester_thread_id: message.thread_id,
      receiver_id: receiver.id,
      receiver_phone: receiverPhone ?? '',
      receiver_email: receiverEmail ?? undefined,
      aegis_sms_channel: aegisSmsNumber ?? '',
      shift_date: pending.shift_date,
      shift_name: pending.shift_name,
      role: pending.role,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      schedule_id: pending.schedule_id,
      target_shift_date: pending.target_shift_date,
      target_shift_name: pending.target_shift_name,
      target_role: pending.target_role,
      target_shift_start: pending.target_shift_start,
      target_shift_end: pending.target_shift_end,
      candidate_queue: [],
      outreach_sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
    await storeSwapOutreach(outreach);

    // From the target's side. A one-way giveaway (no target_shift_name) means they
    // simply pick up the requester's shift and give up nothing — do NOT call it a
    // "trade" or say they give up a shift. A two-way trade names both shifts.
    const ask = buildSwapAskText({
      receiverName: receiver.name,
      requesterName: contact.name,
      shiftName: pending.shift_name,
      shiftStart: pending.shift_start,
      shiftEnd: pending.shift_end,
      role: pending.role,
      shiftDateDisplay: formatDisplayDate(pending.shift_date),
      targetShiftName: pending.target_shift_name,
      targetShiftDateDisplay: pending.target_shift_date ? formatDisplayDate(pending.target_shift_date) : null,
      targetShiftStart: pending.target_shift_start ?? null,
      targetShiftEnd: pending.target_shift_end ?? null,
    });
    const isGiveaway = ask.isGiveaway;

    const delivered = await sendOutreachMessage({
      receiverId: receiver.id,
      receiverEmail, receiverPhone, aegisSmsNumber,
      subject: ask.subject,
      text: ask.text, company_id: contact.company_id,
    });

    if (delivered === 'none') {
      // The message to the coworker didn't go through — don't claim it did.
      // Clear the outreach so a retry starts clean rather than colliding with a
      // dangling session.
      await clearSwapOutreach(contact.company_id, receiver.id);
      await reply(contact, message,
        `I tried to reach ${firstName(receiver.name)} but couldn't get the message through just now. Give it a minute and send it again, or let your manager know so it doesn't slip.`
      );
      return;
    }

    await reply(contact, message,
      `I've reached out to ${receiver.name} about ${isGiveaway ? 'covering your shift' : 'the trade'}. I'll let you know as soon as I hear back.`
    );

    await logActivity({
      company_id: contact.company_id,
      action: 'swap_outreach_sent',
      summary: `Trade outreach sent to ${receiver.name} for ${contact.name} — give ${pending.shift_name} / take ${pending.target_shift_name ?? '?'} on ${pending.shift_date}`,
      metadata: { requester_id: contact.employee_id, receiver_id: receiver.id, shift_date: pending.shift_date, mode: 'directed', trade: !!pending.target_shift_name },
    });
  } else {
    // Mode 2: facilitated → the SIMULTANEOUS two-button broadcast (#10 Stage 4b).
    // Email every reachable teammate at once: everyone gets a PICKUP button; those
    // with a tradeable shift on a day the requester can work also get a SWAP
    // button. The first to commit locks the shift (enforced at click time).
    const shiftHours = computeShiftHours(pending.shift_start, pending.shift_end);
    const candidates = await buildSwapCandidates({
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      shift_date: pending.shift_date,
      role: pending.role,
      // RULE 0b — pending records may predate accepted_roles; buildSwapCandidates
      // resolves it from Homebase when we can only give it the shift name.
      shift_name: pending.shift_name,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      shift_hours: shiftHours,
    });

    const hasSms = !!aegisSmsNumber;
    const reachable = candidates.filter(c => isReachableForOutreach(c, hasSms));
    if (reachable.length === 0) {
      await reply(contact, message,
        `I couldn't find any teammates I can reach to cover your ${pending.shift_name} shift on ${formatDisplayDate(pending.shift_date)}. Please contact your manager directly.`
      );
      await logActivity({
        company_id: contact.company_id,
        action: 'swap_no_candidates',
        summary: `No reachable swap candidates for ${contact.name}'s ${pending.shift_name} on ${pending.shift_date}`,
        metadata: { requester_id: contact.employee_id, shift_date: pending.shift_date, role: pending.role },
      });
      return;
    }

    // Resolve the requester's willing weekdays → concrete dates in the shift's
    // week, and map each candidate's own shifts so we know who can also trade.
    const { data: schedRow } = await supabase.from('schedules').select('data, week_start')
      .is('deleted_at', null).eq('company_id', contact.company_id).eq('status', 'published')
      .lte('week_start', pending.shift_date).gte('week_end', pending.shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();
    const schedData = schedRow ? (schedRow as { data: ScheduleData }).data : null;
    const weekStart = schedRow ? (schedRow as { week_start: string }).week_start : null;
    const assignmentsByEmployee = new Map<string, ScheduleAssignment[]>();
    if (schedData) {
      for (const a of schedData.assignments) {
        if (!assignmentsByEmployee.has(a.employee_id)) assignmentsByEmployee.set(a.employee_id, []);
        assignmentsByEmployee.get(a.employee_id)!.push(a);
      }
    }
    const willingDates = weekStart
      ? resolveWillingDates(pending.willing_days ?? [], weekDatesFrom(weekStart))
      : new Set<string>();

    // The requester's qualified roles gate which of a candidate's shifts the
    // requester could actually take in a trade.
    const { data: reqEmp } = await supabase.from('employees').select('qualified_roles')
      .eq('id', contact.employee_id!).single();
    const requesterRoles = (reqEmp as { qualified_roles: string[] } | null)?.qualified_roles ?? [];

    const partition = partitionSwapCandidates(reachable, assignmentsByEmployee, willingDates, requesterRoles);
    const tradeableById = new Map(partition.swap.map(s => [s.employee.id, s.tradeableShifts]));

    // Fan out the two-button broadcast to every reachable candidate — SMS-FIRST
    // for phone-holders (H19; SMS spec §3.4 swaps are text-native), email as the
    // fallback on no-phone or SMS send failure, and email-first when EMAIL_ONLY is
    // set or the tenant has no SMS number. SMS-only candidates (previously skipped)
    // now get the pool blast — the qualified-pool text IS the feature.
    const smsCapable = !env.EMAIL_ONLY && !!aegisSmsNumber;
    const contactedIds: string[] = [];
    let smsReached = 0;
    for (const cand of partition.pickup) {
      const tradeable = tradeableById.get(cand.id);
      const { subject, text, html, sms } = await buildSwapBroadcastEmail({
        company_id: contact.company_id,
        candidate: { id: cand.id, name: cand.name, email: cand.contact_email },
        requester_name: contact.name,
        shift_name: pending.shift_name,
        shift_role: pending.role,
        shift_date: pending.shift_date,
        shift_start: pending.shift_start,
        shift_end: pending.shift_end,
        willing_dates: [...willingDates],
        swapEligible: !!tradeable,
        tradeableShifts: tradeable?.map(s => ({
          date: s.date, shift_name: s.shift_name, role: s.role, start_time: s.start_time, end_time: s.end_time,
        })),
        token_payload: { requester_id: contact.employee_id! },
      });
      // Honest count: only tally a teammate we ACTUALLY reached. A swallowed send
      // failure must not make us tell the requester we reached them (mirrors the
      // directed path's sendOutreachMessage). SMS-first, then email fallback.
      const delivered = await deliverSwapBroadcast({
        smsCapable,
        aegisSmsNumber,
        candidateId: cand.id,
        candidatePhone: cand.contact_phone ?? null,
        candidateEmail: cand.contact_email ?? null,
        sms, subject, text, html,
        company_id: contact.company_id,
      });
      if (delivered !== 'none') {
        contactedIds.push(cand.id);
        if (delivered === 'sms') smsReached++;
      }
    }

    if (contactedIds.length === 0) {
      await reply(contact, message,
        `I found teammates but couldn't reach any of them right now. Please contact your manager for help covering this shift.`
      );
      return;
    }

    // Record the open broadcast (first commit locks it at click time).
    await storeSwapBroadcast({
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      company_id: contact.company_id,
      requester_channel: message.channel,
      requester_sender: message.sender,
      requester_recipient: message.recipient,
      requester_raw_subject: message.raw_subject,
      requester_thread_id: message.thread_id,
      shift_date: pending.shift_date,
      shift_name: pending.shift_name,
      role: pending.role,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      schedule_id: pending.schedule_id,
      willing_dates: [...willingDates],
      status: 'open',
      locked_by: null,
      contacted_ids: contactedIds,
      expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    });

    const swapCount = partition.swap.filter(s => contactedIds.includes(s.employee.id)).length;
    const willingDatesLabel = [...willingDates].sort().map(formatShortDate).join(', ');
    await reply(contact, message,
      `Done — I've reached out to ${contactedIds.length} teammate${contactedIds.length !== 1 ? 's' : ''} about your ${pending.shift_name} shift on ${formatDisplayDate(pending.shift_date)}` +
      (swapCount > 0 ? ` (${swapCount} of them can also trade you a shift on ${willingDatesLabel})` : '') +
      `. The first to accept gets it, and I'll loop in your manager for the final OK. I'll let you know as soon as someone takes it.`
    );

    await logActivity({
      company_id: contact.company_id,
      action: 'swap_broadcast_sent',
      summary: `Broadcast swap request for ${contact.name}'s ${pending.shift_name} on ${pending.shift_date} — messaged ${contactedIds.length} teammate(s)${smsReached > 0 ? ` (${smsReached} by text)` : ''}`,
      metadata: { requester_id: contact.employee_id, shift_date: pending.shift_date, contacted: contactedIds.length, sms_reached: smsReached, swap_eligible: swapCount },
    });
  }
}

// Called from router pre-check when swap_outreach:{employeeId} exists.
export async function handleSwapOutreachResponse(
  message: InboundMessage,
  contact: VerifiedContact,
  outreach: SwapOutreach & { _memory_id?: string }
): Promise<void> {
  const answer = parseYesNo(message.body);

  if (answer === 'unclear') {
    await reply(contact, message,
      `Just let me know — can you take the ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}? A yes or no works.`
    );
    return;
  }

  const requesterMsg: InboundMessage = {
    sender: outreach.requester_sender, recipient: outreach.requester_recipient, body: '',
    channel: outreach.requester_channel, raw_subject: outreach.requester_raw_subject, thread_id: outreach.requester_thread_id,
  };
  const requesterContact: VerifiedContact = {
    role: 'employee', company_id: outreach.company_id, employee_id: outreach.requester_id,
    user_id: null, name: outreach.requester_name, matched_identifier: outreach.requester_sender, channel: outreach.requester_channel,
  };

  if (answer === 'no') {
    await clearSwapOutreach(outreach.company_id, outreach.receiver_id);
    await reply(contact, message, 'No problem — thanks for letting us know!');

    await logActivity({
      company_id: outreach.company_id,
      action: 'swap_declined',
      summary: `${contact.name} declined swap for ${outreach.requester_name}'s ${outreach.shift_name} on ${outreach.shift_date}`,
      metadata: { receiver_id: contact.employee_id, requester_id: outreach.requester_id, shift_date: outreach.shift_date },
    });

    if (outreach.mode === 'directed' || outreach.candidate_queue.length === 0) {
      await reply(requesterContact, requesterMsg,
        `${contact.name} wasn't able to take your ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}. ` +
        (outreach.mode === 'facilitated' && outreach.candidate_queue.length === 0
          ? 'All available employees have been contacted. Please speak with your manager.'
          : 'Please contact your manager for help finding coverage.')
      );
      return;
    }

    // Mode 2: advance to the next REACHABLE candidate (email-first; SMS post-A2P).
    // Walk the queue past anyone we can't message so a contactless record never
    // dead-ends the broadcast.
    const smsChannel = outreach.aegis_sms_channel || null;
    let nextEmp: Employee | null = null;
    let restQueue = outreach.candidate_queue;
    while (restQueue.length > 0) {
      const candidateId = restQueue[0];
      restQueue = restQueue.slice(1);
      const { data: empData } = await supabase.from('employees').select('*').eq('id', candidateId).single();
      const emp = empData as Employee | null;
      if (emp && isReachableForOutreach(emp, !!smsChannel)) { nextEmp = emp; break; }
    }

    if (!nextEmp) {
      await reply(requesterContact, requesterMsg,
        `${contact.name} wasn't available, and I've now reached everyone I could. Please speak with your manager about covering the ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}.`
      );
      return;
    }

    const nextOutreach: SwapOutreach = {
      ...outreach,
      receiver_id: nextEmp.id,
      receiver_phone: nextEmp.contact_phone ?? '',
      receiver_email: nextEmp.contact_email ?? undefined,
      candidate_queue: restQueue,
      outreach_sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
    await storeSwapOutreach(nextOutreach);

    await sendOutreachMessage({
      receiverId: nextEmp.id,
      receiverEmail: nextEmp.contact_email ?? null,
      receiverPhone: nextEmp.contact_phone ?? null,
      aegisSmsNumber: smsChannel,
      subject: `Can you take a ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}?`,
      text:
        `${textOpener(nextEmp.name)}this is Aegis. ` +
        `${outreach.requester_name} is looking for someone to take their ${outreach.shift_name} shift ` +
        `(${formatClockRange(outreach.shift_start, outreach.shift_end)}, ${outreach.role}) on ${formatDisplayDate(outreach.shift_date)}. ` +
        'Would you like to take it?',
      company_id: outreach.company_id,
    });

    await reply(requesterContact, requesterMsg,
      `${contact.name} wasn't available. I'm now reaching out to ${nextEmp.name}.`
    );
    return;
  }

  // Employee said YES
  await clearSwapOutreach(outreach.company_id, outreach.receiver_id);

  const { data: receiverData } = await supabase.from('employees').select('*')
    .eq('id', outreach.receiver_id).single();
  const receiver = receiverData as Employee | null;

  const { data: requesterData } = await supabase.from('employees').select('*')
    .eq('id', outreach.requester_id).single();
  const requester = requesterData as Employee | null;

  if (!receiver || !requester) {
    await reply(contact, message, 'Something went wrong — please contact your manager directly.');
    return;
  }

  // Load swap policies to determine if manager approval is required
  const { data: policyData } = await supabase.from('policies').select('*')
    .eq('company_id', outreach.company_id).eq('policy_type', 'swaps');
  const policies = (policyData ?? []) as Policy[];

  // Ask Claude whether a company swap policy explicitly requires manager approval.
  let policyRequiresApproval = false;
  if (policies.length > 0) {
    const policyText = policies.map(p => `${p.policy_key}: ${p.policy_value}${p.description ? ' — ' + p.description : ''}`).join('\n');
    const system = 'Based on these swap policies, does manager approval EXPLICITLY appear to be required before a swap is executed? Respond ONLY with valid JSON: {"requires_approval":true|false}';
    const text = await generateReply(system, policyText, []);
    const parsed = coerceJsonObject<{ requires_approval: boolean }>(text);
    policyRequiresApproval = parsed?.requires_approval ?? false;
  }

  const requiresApproval = swapRequiresManagerApproval({
    mode: outreach.mode,
    targetShiftName: outreach.target_shift_name,
    policyRequiresApproval,
  });

  await logActivity({
    company_id: outreach.company_id,
    action: 'swap_accepted',
    summary: `${contact.name} accepted swap for ${outreach.requester_name}'s ${outreach.shift_name} on ${outreach.shift_date}`,
    metadata: { receiver_id: contact.employee_id, requester_id: outreach.requester_id, shift_date: outreach.shift_date, requires_approval: requiresApproval },
  });

  if (!requiresApproval) {
    // Do NOT pre-announce "Swap complete!" here — that claimed success before the
    // schedule write, the same announce-before-apply class D2 fixed elsewhere.
    // executeSwapNow applies the change FIRST, then sends the authoritative message
    // to BOTH the requester and the receiver: a real confirmation only if the write
    // landed, or an honest "pending your manager" note if the week isn't published.
    await executeSwapNow({
      company_id: outreach.company_id,
      requester,
      requester_channel: outreach.requester_channel,
      requester_sender: outreach.requester_sender,
      requester_recipient: outreach.requester_recipient,
      requester_raw_subject: outreach.requester_raw_subject,
      requester_thread_id: outreach.requester_thread_id,
      receiver,
      shift_date: outreach.shift_date,
      shift_name: outreach.shift_name,
      role: outreach.role,
      shift_start: outreach.shift_start,
      shift_end: outreach.shift_end,
      schedule_id: outreach.schedule_id,
      aegis_sms_channel: outreach.aegis_sms_channel,
    });
  } else {
    // Create pending_manager swap_request
    const { data: swapRow } = await supabase.from('swap_requests').insert({
      company_id: outreach.company_id,
      requesting_employee_id: outreach.requester_id,
      receiving_employee_id: receiver.id,
      shift_date: outreach.shift_date,
      shift_name: outreach.shift_name,
      role: outreach.role,
      status: 'pending_manager',
      initiated_by: 'aegis',
      // L4 — THE ROOT DATA DEFECT. This note was byte-identical for a one-way
      // giveaway and a two-way trade, and `outreach.target_shift_name` — the
      // only field that tells them apart — was in scope right here and thrown
      // away. The Homebase UI approval path then had no way to know which it
      // was, so it ran every row as a giveaway and silently dropped trades'
      // return legs. Persist the kind.
      // L4b — the root data defect, closed. `outreach.target_shift_*` was in
      // scope here all along and thrown away, leaving the row unable to say
      // whether it was a giveaway or a trade, let alone what came back.
      kind: outreach.target_shift_name ? 'trade' : 'giveaway',
      target_shift_date: outreach.target_shift_date ?? null,
      target_shift_name: outreach.target_shift_name ?? null,
      target_shift_role: outreach.target_role ?? null,
      notes: withSwapKind(
        `Both employees agreed via Aegis. ${outreach.mode === 'facilitated' ? 'Facilitated swap.' : 'Directed swap.'}`,
        outreach.target_shift_name ? 'trade' : 'giveaway',
      ),
    }).select('id').single();

    const swapId = (swapRow as { id: string } | null)?.id ?? 'unknown';

    const tradeBack = outreach.target_shift_name
      ? ` and you'd take their ${outreach.target_shift_name} shift${outreach.target_shift_date ? ` on ${formatShortDate(outreach.target_shift_date)}` : ''}`
      : '';
    await reply(contact, message,
      `Thanks! The trade is pending your manager's approval — I'll let you know once it's decided.`
    );
    await reply(requesterContact, requesterMsg,
      `${receiver.name} agreed to trade: they'll take your ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}${tradeBack}. It's now pending manager approval — I'll notify you once it's decided.`
    );

    await sendManagerSwapApprovalRequest({
      company_id: outreach.company_id,
      swap_request_id: swapId,
      requester,
      requester_channel: outreach.requester_channel,
      requester_sender: outreach.requester_sender,
      receiver,
      shift_date: outreach.shift_date,
      shift_name: outreach.shift_name,
      role: outreach.role,
      shift_start: outreach.shift_start,
      shift_end: outreach.shift_end,
      aegis_sms_channel: outreach.aegis_sms_channel,
      target_shift_date: outreach.target_shift_date,
      target_shift_name: outreach.target_shift_name,
      target_role: outreach.target_role,
      target_shift_start: outreach.target_shift_start,
      target_shift_end: outreach.target_shift_end,
    });

    await logActivity({
      company_id: outreach.company_id,
      action: 'swap_pending_manager',
      entity_type: 'swap_request',
      entity_id: swapId,
      summary: `Swap between ${outreach.requester_name} and ${receiver.name} pending manager approval`,
      metadata: { requester_id: outreach.requester_id, receiver_id: receiver.id, shift_date: outreach.shift_date, shift_name: outreach.shift_name },
    });
  }
}

// Fallback: called from intent router when respond_swap_accept/decline is classified
// but no active outreach record exists for this employee.
// ── W-2 branch 3 (C-2): ONE withdraw path for a requester's swap ─────────────
//
// Maisey's Aug 17 thread: "ok i don't need to swap it anymore" left the
// broadcast live (Margaret's link tap still committed two minutes later), and
// "i don't need it covered anymore" cancelled a TIME-OFF draft instead. This is
// the single function that actually calls a swap off: close the live outreach
// and broadcast, tell every contacted teammate, cancel the pending
// swap_requests row(s), retire the manager's live approve/deny tokens, and
// (unless the caller composes a combined notice) tell the managers once.

export interface WithdrawnSwapItem {
  kind: 'unsent_confirm' | 'outreach' | 'broadcast' | 'swap_request';
  label: string;                 // "your ask to swap the AM Weekday shift on Wed, Aug 19"
  teammates_told: string[];      // who got the "no longer needed" note
  manager_knew: boolean;         // a pending_manager row / approval email existed
}

// The requester's live swap activity, described without touching it — used to
// build the "are you sure?" ask for undo-all (W-1's resolveCancelTargets shape).
export async function listWithdrawableSwaps(
  companyId: string,
  requesterId: string,
  opts?: { createdOnOrAfter?: string },
): Promise<Array<{ kind: WithdrawnSwapItem['kind']; label: string }>> {
  const out: Array<{ kind: WithdrawnSwapItem['kind']; label: string }> = [];
  const pending = await getPendingSwap(companyId, requesterId);
  if (pending && !pending.awaiting) {
    out.push({ kind: 'unsent_confirm', label: `the swap of your ${pending.shift_name} shift on ${formatShortDate(pending.shift_date)} (not sent yet)` });
  }
  for (const o of await findSwapOutreachByRequester(companyId, requesterId)) {
    out.push({ kind: 'outreach', label: `your ask for the ${o.shift_name} shift on ${formatShortDate(o.shift_date)} (waiting on a teammate)` });
  }
  const broadcast = await getSwapBroadcast(companyId, requesterId);
  if (broadcast && broadcast.status === 'open') {
    out.push({ kind: 'broadcast', label: `your ask for the ${broadcast.shift_name} shift on ${formatShortDate(broadcast.shift_date)} (${broadcast.contacted_ids.length} teammates asked)` });
  }
  for (const r of await loadPendingSwapRows(companyId, requesterId, opts?.createdOnOrAfter)) {
    out.push({ kind: 'swap_request', label: `the ${r.shift_name} shift swap on ${formatShortDate(r.shift_date)} (waiting on your manager)` });
  }
  return out;
}

async function findSwapOutreachByRequester(
  companyId: string,
  requesterId: string,
): Promise<Array<SwapOutreach & { _memory_id: string }>> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('company_id', companyId)
    .like('source', 'swap_outreach:%');
  const out: Array<SwapOutreach & { _memory_id: string }> = [];
  const now = new Date();
  for (const row of (data ?? []) as Array<{ id: string; content: string }>) {
    try {
      const o = JSON.parse(row.content) as SwapOutreach;
      if (o.requester_id !== requesterId) continue;
      if (new Date(o.expires_at) < now) continue;
      out.push({ ...o, _memory_id: row.id });
    } catch { /* skip malformed */ }
  }
  return out;
}

// The newest live broadcast that CONTACTED this employee — how a texted
// "i can take it" finds the offer it answers (there is no per-recipient gate
// on a broadcast; the links were the only path before W-2).
export async function findBroadcastContactingEmployee(
  companyId: string,
  employeeId: string,
): Promise<(SwapBroadcast & { _memory_id: string }) | null> {
  const { data } = await supabase
    .from('aegis_memory')
    .select('id, content, created_at')
    .eq('company_id', companyId)
    .like('source', 'swap_broadcast:%')
    .order('created_at', { ascending: false });
  const now = new Date();
  for (const row of (data ?? []) as Array<{ id: string; content: string }>) {
    try {
      const b = JSON.parse(row.content) as SwapBroadcast;
      if (!b.contacted_ids?.includes(employeeId)) continue;
      if (new Date(b.expires_at) < now) continue;
      return { ...b, _memory_id: row.id };
    } catch { /* skip malformed */ }
  }
  return null;
}

async function loadPendingSwapRows(
  companyId: string,
  requesterId: string,
  createdOnOrAfter?: string,
): Promise<Array<{ id: string; shift_date: string; shift_name: string; status: string; receiving_employee_id: string | null; created_at: string | null }>> {
  let q = supabase
    .from('swap_requests')
    .select('id, shift_date, shift_name, status, receiving_employee_id, created_at')
    .eq('company_id', companyId)
    .eq('requesting_employee_id', requesterId)
    .in('status', ['pending_employee', 'pending_manager']);
  if (createdOnOrAfter) q = q.gte('created_at', createdOnOrAfter);
  const { data } = await q;
  return (data ?? []) as Array<{ id: string; shift_date: string; shift_name: string; status: string; receiving_employee_id: string | null; created_at: string | null }>;
}

export async function withdrawSwap(params: {
  companyId: string;
  requesterId: string;
  requesterName: string;
  /** Undo-all "for today": only swap_requests rows created on/after this UTC-ish bound. */
  createdOnOrAfter?: string;
  /** false when the caller (undo-all) composes ONE combined manager notice. */
  notifyManagers?: boolean;
}): Promise<{ items: WithdrawnSwapItem[]; managerSummary: string | null }> {
  const { companyId, requesterId, requesterName } = params;
  const items: WithdrawnSwapItem[] = [];
  const aegisSmsNumber = await getAegisSmsChannel(companyId);
  const first = firstName(requesterName);

  // 1 — an unsent confirm gate simply evaporates.
  const pending = await getPendingSwap(companyId, requesterId);
  if (pending && !pending.awaiting) {
    await clearPendingSwap(companyId, requesterId);
    items.push({ kind: 'unsent_confirm', label: `the swap of your ${pending.shift_name} shift on ${formatShortDate(pending.shift_date)}`, teammates_told: [], manager_knew: false });
  } else if (pending?.awaiting) {
    await clearPendingSwap(companyId, requesterId);
  }

  // 2 — live directed outreach: tell the teammate, close the record.
  for (const o of await findSwapOutreachByRequester(companyId, requesterId)) {
    const { data: empData } = await supabase.from('employees').select('*').eq('id', o.receiver_id).single();
    const emp = empData as Employee | null;
    const told: string[] = [];
    if (emp) {
      await sendOutreachMessage({
        receiverId: emp.id,
        receiverEmail: emp.contact_email ?? null,
        receiverPhone: emp.contact_phone ?? null,
        aegisSmsNumber,
        subject: `No longer needed — ${requesterName}'s ${o.shift_name} shift`,
        text: `${textOpener(emp.name)}quick update: ${first} no longer needs the ${o.shift_name} shift on ${formatShortDate(o.shift_date)} covered, so you're all set — nothing to do. Thanks!`,
        company_id: companyId,
      });
      told.push(emp.name);
    }
    await clearSwapOutreach(companyId, o.receiver_id);
    items.push({ kind: 'outreach', label: `your ask for the ${o.shift_name} shift on ${formatShortDate(o.shift_date)}`, teammates_told: told, manager_knew: false });
  }

  // 3 — a live broadcast: mark WITHDRAWN (kept, so late replies get the kind
  // refusal), and tell everyone it reached.
  const broadcast = await getSwapBroadcast(companyId, requesterId);
  if (broadcast && broadcast.status === 'open') {
    await storeSwapBroadcast({ ...broadcast, status: 'withdrawn' });
    const told: string[] = [];
    for (const contactedId of broadcast.contacted_ids ?? []) {
      const { data: empData } = await supabase.from('employees').select('*').eq('id', contactedId).single();
      const emp = empData as Employee | null;
      if (!emp) continue;
      await sendOutreachMessage({
        receiverId: emp.id,
        receiverEmail: emp.contact_email ?? null,
        receiverPhone: emp.contact_phone ?? null,
        aegisSmsNumber,
        subject: `No longer needed — ${requesterName}'s ${broadcast.shift_name} shift`,
        text: `${textOpener(emp.name)}quick update: ${first} no longer needs the ${broadcast.shift_name} shift on ${formatShortDate(broadcast.shift_date)} covered, so you're all set — nothing to do. Thanks!`,
        company_id: companyId,
      });
      told.push(emp.name);
    }
    items.push({ kind: 'broadcast', label: `your ask for the ${broadcast.shift_name} shift on ${formatShortDate(broadcast.shift_date)}`, teammates_told: told, manager_knew: false });
  }

  // 4 — pending swap_requests rows: cancel (optimistic guard), retire the
  // manager's live approve/deny tokens, log.
  const rows = await loadPendingSwapRows(companyId, requesterId, params.createdOnOrAfter);
  for (const r of rows) {
    const { error } = await supabase
      .from('swap_requests')
      .update({ status: 'cancelled', decided_at: new Date().toISOString() })
      .eq('id', r.id)
      .eq('company_id', companyId)
      .eq('status', r.status);
    if (error) {
      console.error(`[swap-withdraw] failed to cancel swap_requests ${r.id}: ${error.message}`);
      continue;
    }
    await supabase
      .from('aegis_memory')
      .delete()
      .eq('company_id', companyId)
      .like('source', 'decision_token:%')
      .like('content', `%${r.id}%`);
    await logActivity({
      company_id: companyId,
      action: 'swap_withdrawn_by_requester',
      entity_type: 'swap_request',
      entity_id: r.id,
      summary: `${requesterName} withdrew their ${r.shift_name} swap on ${r.shift_date} (was ${r.status}).`,
      metadata: { requester_id: requesterId, previous_status: r.status },
    });
    items.push({ kind: 'swap_request', label: `the ${r.shift_name} shift swap on ${formatShortDate(r.shift_date)}`, teammates_told: [], manager_knew: r.status === 'pending_manager' });
  }

  // One manager notice — only when a manager actually had something in flight.
  const managerFacing = items.filter(i => i.manager_knew);
  const managerSummary = managerFacing.length > 0
    ? `${requesterName} withdrew ${joinNaturalSwap(managerFacing.map(i => i.label.replace(/^your /, 'their ')))} — nothing to approve anymore; the request is closed and any approve/deny links for it are dead.`
    : null;
  if (managerSummary && params.notifyManagers !== false) {
    await sendManagerResolutionNotice({
      companyId,
      decidedByUserId: null,
      decidedByName: null,
      summary: managerSummary,
      subject: `Withdrawn — ${requesterName}'s shift swap`,
      body: managerSummary,
    });
  }
  return { items, managerSummary };
}

function joinNaturalSwap(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The requester says "cancel the swap" / "I don't need it covered anymore" /
// "scrap the swap" (C-2 step 3 cancelled a TIME-OFF draft instead). Routed via
// the classifier's cancel_swap intent + deterministic backstop.
export async function handleCancelSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  if (!contact.employee_id) {
    await reply(contact, message, "I can only manage swaps for an employee record I recognise — please check with your manager.");
    return;
  }
  const { items } = await withdrawSwap({
    companyId: contact.company_id,
    requesterId: contact.employee_id,
    requesterName: contact.name,
  });
  if (items.length === 0) {
    await reply(contact, message,
      `${textOpener(contact.name)}I don't see a swap of yours in flight — nothing out with teammates and nothing waiting on your manager. If you meant a time-off request, say "cancel my time off" and I'll sort that instead.`);
    return;
  }
  const told = [...new Set(items.flatMap(i => i.teammates_told))];
  const managerNote = items.some(i => i.manager_knew) ? " I've let your manager know too." : '';
  const toldNote = told.length > 0
    ? ` I've told ${joinNaturalSwap(told)} it's no longer needed.`
    : '';
  await reply(contact, message,
    `Done — I've called off ${joinNaturalSwap(items.map(i => i.label))}.${toldNote}${managerNote} Your schedule stays as it is.`);
}

// A teammate takes back their acceptance ("nevermind", "i can't actually swap
// maiseys shift") AFTER it went to the manager: cancel the pending row under
// their name and tell both the manager and the requester (C-2 defect c — they
// used to be told "no active swap request" while one sat in the manager's inbox).
export async function withdrawAcceptance(
  message: InboundMessage,
  contact: VerifiedContact,
): Promise<boolean> {
  if (!contact.employee_id) return false;
  const { data } = await supabase
    .from('swap_requests')
    .select('id, shift_date, shift_name, status, requesting_employee_id')
    .eq('company_id', contact.company_id)
    .eq('receiving_employee_id', contact.employee_id)
    .in('status', ['pending_employee', 'pending_manager'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { id: string; shift_date: string; shift_name: string; status: string; requesting_employee_id: string } | null;
  if (!row) return false;
  // Captured BEFORE the write — `row.status` after an update is not a receipt.
  const prevStatus = row.status;

  const { error } = await supabase
    .from('swap_requests')
    .update({ status: 'cancelled', decided_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('company_id', contact.company_id)
    .eq('status', prevStatus);
  if (error) {
    console.error(`[swap-withdraw] failed to withdraw acceptance on ${row.id}: ${error.message}`);
    await reply(contact, message, "I couldn't take that back just now — please try again in a moment or tell your manager directly.");
    return true;
  }
  await supabase
    .from('aegis_memory')
    .delete()
    .eq('company_id', contact.company_id)
    .like('source', 'decision_token:%')
    .like('content', `%${row.id}%`);
  await logActivity({
    company_id: contact.company_id,
    action: 'swap_acceptance_withdrawn',
    entity_type: 'swap_request',
    entity_id: row.id,
    summary: `${contact.name} withdrew their offer to take the ${row.shift_name} shift on ${row.shift_date} (was ${prevStatus}).`,
    metadata: { receiver_id: contact.employee_id, previous_status: prevStatus },
  });

  const { data: reqData } = await supabase.from('employees').select('*').eq('id', row.requesting_employee_id).single();
  const requester = reqData as Employee | null;

  if (prevStatus === 'pending_manager') {
    await sendManagerResolutionNotice({
      companyId: contact.company_id,
      decidedByUserId: null,
      decidedByName: null,
      summary: `${contact.name} can no longer take ${requester ? `${firstName(requester.name)}'s` : 'the'} ${row.shift_name} shift on ${formatShortDate(row.shift_date)} — that swap is withdrawn, nothing to approve anymore.`,
      subject: `Withdrawn — ${row.shift_name} swap on ${formatShortDate(row.shift_date)}`,
      body: `${contact.name} withdrew their offer to take ${requester ? `${requester.name}'s` : 'the'} ${row.shift_name} shift on ${formatShortDate(row.shift_date)}. The request is closed and any approve/deny links for it are dead. ${requester ? `${firstName(requester.name)} has been told the shift still needs covering.` : ''}`,
    });
  }
  if (requester) {
    const aegisSmsNumber = await getAegisSmsChannel(contact.company_id);
    await sendOutreachMessage({
      receiverId: requester.id,
      receiverEmail: requester.contact_email ?? null,
      receiverPhone: requester.contact_phone ?? null,
      aegisSmsNumber,
      subject: `Update on your ${row.shift_name} shift`,
      text: `${textOpener(requester.name)}heads up — ${firstName(contact.name)} can't take your ${row.shift_name} shift on ${formatShortDate(row.shift_date)} after all, so it still needs covering. Want me to ask the rest of the team?`,
      company_id: contact.company_id,
    });
  }
  await reply(contact, message,
    `No problem — I've taken you off ${requester ? `${firstName(requester.name)}'s` : 'that'} ${row.shift_name} shift on ${formatShortDate(row.shift_date)} and let ${requester ? `${firstName(requester.name)}` : 'them'}${prevStatus === 'pending_manager' ? ' and your manager' : ''} know. Thanks for flagging it.`);
  return true;
}

export async function handleRespondSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>,
  decision: 'accept' | 'decline'
): Promise<void> {
  // ── W-2 (C-2): a texted answer to a BROADCAST finally lands somewhere ──────
  //
  // Broadcast recipients only ever had links; Margaret's texted "i can take it"
  // was answered with a generic question, and her "nevermind" with "no problem"
  // — then the still-open link committed her anyway. Now:
  //  • an ACCEPT from someone a live broadcast reached commits through the same
  //    guarded path the link uses (first-commit-wins), and a withdrawn/locked
  //    offer gets the kind, truthful refusal;
  //  • a DECLINE/retraction from someone whose acceptance is already pending
  //    with the manager withdraws it and tells everyone involved.
  if (contact.employee_id) {
    if (decision === 'accept') {
      const broadcast = await findBroadcastContactingEmployee(contact.company_id, contact.employee_id);
      if (broadcast) {
        const result = await commitSwapPickup({
          company_id: contact.company_id,
          requester_id: broadcast.requester_id,
          receiver_id: contact.employee_id,
        });
        await reply(contact, message, result.message);
        return;
      }
    } else {
      const withdrew = await withdrawAcceptance(message, contact);
      if (withdrew) return;
      // A decline aimed at a broadcast that reached them: acknowledge it.
      const broadcast = await findBroadcastContactingEmployee(contact.company_id, contact.employee_id);
      if (broadcast) {
        await reply(contact, message, 'No problem — thanks for letting me know!');
        return;
      }
    }
  }

  // BUG-6 residual: a bare affirmation/negation ("yes"/"no") that reaches HERE means
  // the classifier labeled it a swap response but the router found no pending swap (or
  // TO/availability/onboarding) to intercept it first — i.e., whatever it was confirming
  // has expired or was already handled. Don't imply a phantom swap ("no active swap
  // request pending for you") — that's the confusing line employees saw. Guide them to
  // resend instead. Content-bearing swap replies still get the swap-specific message.
  const bare = message.body.trim().toLowerCase().replace(/[!.\s]+$/g, '');
  const isBareConfirmation =
    /^(y|ya|yes|yep|yeah|yup|sure|ok|okay|correct|confirm|confirmed|no|nope|nah)$/i.test(bare);
  if (isBareConfirmation) {
    await reply(contact, message,
      "I don't have anything pending for you to confirm right now — if you were confirming a time-off request or a shift swap, it may have expired. Just resend the details and I'll take care of it."
    );
    return;
  }
  await reply(contact, message,
    "I don't have an active swap request pending for you. If you got a swap request from me, please check your recent messages."
  );
}

// Redirect: manager sent SMS/email approval — tell them to use the email button
export async function handleApproveSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  await reply(contact, message,
    'To approve a swap, please use the Approve button in your Aegis notification email.'
  );
}

export async function handleDenySwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>
): Promise<void> {
  await reply(contact, message,
    'To deny a swap, please use the Deny button in your Aegis notification email.'
  );
}
