import { randomUUID } from 'crypto';
import { supabase } from '../db/client';
import { coerceJsonObject } from '../utils/coerce-json';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { sendSms } from '../messaging/sms';
import { sendEmail } from '../messaging/email';
import { greeting, firstName } from '../messaging/greeting';
import { generateReply } from '../ai/claude';
import { computeWageEstimate } from '../lib/schedule-simulator';
import { env } from '../config/env';
import {
  BRAND,
  brandedEmailShell,
  brandedButtonRow,
  brandActionCard,
} from '../messaging/brand';
import { generateActionToken } from '../lib/aegis-actions/tokens';
import type { InboundMessage, VerifiedContact } from '../security/types';
import type { Employee, Policy } from '../db/types';
import type { ScheduleAssignment } from './schedule-build';

// ── Schedule types (shared shape with emergency-coverage and schedule-build) ──

interface ScheduleData {
  assignments: ScheduleAssignment[];
}

// ── Public state types ────────────────────────────────────────────────────────

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
  expires_at: string;
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

export type SwapCommitGuard = { allowed: true } | { allowed: false; reason: 'expired' | 'locked' };

// First-commit-wins: only an OPEN broadcast accepts a commit. A locked one is
// already being handled by whoever committed first; a missing one has expired.
// (Residual race between read + lock is acceptable here — the manager approval is
// the final gate; a DB-level atomic guard is a logged hardening follow-up.)
export function swapBroadcastCommitGuard(
  broadcast: { status: 'open' | 'locked' } | null,
): SwapCommitGuard {
  if (!broadcast) return { allowed: false, reason: 'expired' };
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
      message: guard.reason === 'locked'
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
    notes: `${receiver.name} offered to pick up the shift via the broadcast — one-way pickup (no trade).`,
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
      message: guard.reason === 'locked'
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

  // Ask the requester to Agree/Decline the trade (email-first magic-link). Their
  // email comes from their record; fall back to the channel sender if needed.
  const { data: reqData } = await supabase.from('employees').select('id, name, contact_email')
    .eq('id', params.requester_id).single();
  const requesterRec = reqData as { id: string; name: string; contact_email: string | null } | null;
  const requesterEmail = requesterRec?.contact_email
    ?? (b.requester_channel === 'email' ? b.requester_sender : null);
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
      receiverEmail: receiver.contact_email ?? null,
      receiverPhone: receiver.contact_phone ?? null,
      aegisSmsNumber,
      subject: `Update on the ${p.shift_name} trade`,
      text: `${greeting(receiver.name)} thanks for offering to trade — ${firstName(p.requester_name)} decided to keep their original shift, so this trade won't go ahead. No action needed on your end.`,
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
    notes: `Two-way trade agreed by both via the broadcast: ${p.requester_name} gives ${p.shift_name} (${p.shift_date}) and takes ${p.target_shift_name} (${p.target_shift_date}).`,
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
    receiverEmail: receiver.contact_email ?? null,
    receiverPhone: receiver.contact_phone ?? null,
    aegisSmsNumber,
    subject: `Your trade with ${firstName(p.requester_name)} — pending manager`,
    text: `${greeting(receiver.name)} ${firstName(p.requester_name)} agreed to the trade! It's with your manager for the final OK now — I'll let you know the moment it's confirmed.`,
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

// Escape user-supplied / dynamic text before inlining into branded HTML.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseYesNo(body: string): 'yes' | 'no' | 'unclear' {
  const lower = body.trim().toLowerCase();
  if (/^(yes|yeah|yep|sure|ok|okay|correct|confirm|that'?s right|right)/.test(lower)) return 'yes';
  if (/^(no|nope|can'?t|wrong|incorrect|cancel|nah|don'?t)/.test(lower)) return 'no';
  return 'unclear';
}

// Can we reach this candidate for facilitated (undirected) swap outreach?
// EMAIL-FIRST: an email address is enough on its own — SMS is only usable once
// the company has an active SMS channel (post-A2P). Without this, the broadcast
// was SMS-only and silently did nothing on the live email channel.
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
  status: 'open' | 'locked';
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
  candidate: { id: string; name: string; email: string };
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
}): Promise<{ subject: string; text: string; html: string }> {
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
    issued_to_email: params.candidate.email,
    issued_to_employee_id: params.candidate.id,
    ttl_minutes: ttl,
  });
  let swapUrl: string | null = null;
  if (params.swapEligible) {
    const swapTok = await generateActionToken({
      action_type: 'swap_trade_select',
      payload: { ...sharedSnapshot, mode: 'swap', tradeable_shifts: params.tradeableShifts ?? [] },
      company_id: params.company_id,
      issued_to_email: params.candidate.email,
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
    `${greeting(params.candidate.name)} this is Aegis. ` +
    `${params.requester_name} can't work their ${shiftDesc} and is hoping a teammate can help out.` +
    (willingList ? ` In return, ${firstName(params.requester_name)} can work: ${willingList}.` : '') +
    ` You can pick the shift up and add it to your schedule.${swapLineText} ` +
    `Just tap the button in this email to let me know.`;

  const buttons = [
    { url: pickupTok.url, label: "I'll pick it up", variant: 'primary' as const },
    ...(swapUrl ? [{ url: swapUrl, label: 'I\'d like to swap', variant: 'secondary' as const }] : []),
  ];

  const detail =
    `<p style="margin:0 0 12px;font-size:15px;color:${BRAND.textPrimary};line-height:1.6;">` +
    `${escapeHtml(params.requester_name)} can't work their <strong>${escapeHtml(params.shift_name)}</strong> ` +
    `(${escapeHtml(params.shift_start)}–${escapeHtml(params.shift_end)}, ${escapeHtml(params.shift_role)}) on <strong>${escapeHtml(dateLong)}</strong>.</p>` +
    (willingList
      ? `<p style="margin:0 0 14px;font-size:14px;color:${BRAND.silver};line-height:1.6;">In return, ${escapeHtml(firstName(params.requester_name))} can work: ${escapeHtml(willingList)}.</p>`
      : '') +
    `<p style="margin:0 0 16px;font-size:14px;color:${BRAND.silver};line-height:1.6;">` +
    (swapUrl
      ? `Pick it up and add it to your schedule, or swap one of your own shifts for it.`
      : `Pick it up and add it to your schedule.`) +
    `</p>` +
    brandedButtonRow(buttons);

  const bodyHtml =
    `<p style="margin:0 0 18px;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">` +
    `${escapeHtml(greeting(params.candidate.name))} ${escapeHtml(params.requester_name)} needs a hand with a shift — can you help?</p>` +
    brandActionCard('Shift available', detail);

  const html = brandedEmailShell({ bodyHtml, preheader: subject });
  return { subject, text, html };
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
    `${greeting(params.requester.name)} good news — ${params.receiver_name} can take your ${giveUp}. ` +
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
  return assignments.map(asg => {
    if (asg.date === a.date && asg.shift_name === a.shift_name && asg.employee_id === a.employee_id) {
      return { ...asg, employee_id: b.employee_id, employee_name: b.employee_name };
    }
    if (asg.date === b.date && asg.shift_name === b.shift_name && asg.employee_id === b.employee_id) {
      return { ...asg, employee_id: a.employee_id, employee_name: a.employee_name };
    }
    return asg;
  });
}

// Executes an approved swap: updates the schedule data and recalculates wages.
// Exported so the decision webhook can call it after manager approval.
export async function executeScheduleSwap(
  companyId: string,
  scheduleId: string,
  shiftDate: string,
  shiftName: string,
  requesterId: string,
  receiverId: string,
  receiverName: string
): Promise<void> {
  const { data: schedRow } = await supabase.from('schedules').select('id, data, staffing_report')
    .eq('id', scheduleId).is('deleted_at', null).single();
  if (!schedRow) return;

  const row = schedRow as { id: string; data: ScheduleData; staffing_report: Record<string, unknown> | null };
  const updatedAssignments = applySwapToAssignments(
    row.data.assignments, shiftDate, shiftName, requesterId, receiverId, receiverName
  );

  const updatedData: ScheduleData = { ...row.data, assignments: updatedAssignments };
  const wages = await computeWageEstimate(companyId, updatedAssignments);

  await supabase.from('schedules').update({
    data: updatedData as unknown as Record<string, unknown>,
    staffing_report: { ...(row.staffing_report ?? {}), estimated_wages: wages },
  }).eq('id', scheduleId);
}

// Which of the target's shifts the requester is trading FOR. Resolves your
// "I name it; Aegis asks only if it's unclear" rule (item 18): if the named
// person has exactly one shift that week (or the hint narrows it to one), use
// it; if several still match, it's ambiguous and the caller should ask which.
export type TradeShiftChoice =
  | { kind: 'one'; shift: ScheduleAssignment }
  | { kind: 'none' }
  | { kind: 'ambiguous'; shifts: ScheduleAssignment[] };

export function chooseTradeShift(
  schedData: ScheduleData,
  targetId: string,
  hint: { shift_name?: string | null; date?: string | null } | null
): TradeShiftChoice {
  const targetShifts = schedData.assignments.filter(a => a.employee_id === targetId);
  if (targetShifts.length === 0) return { kind: 'none' };

  let candidates = targetShifts;
  if (hint?.date) candidates = candidates.filter(a => a.date === hint.date);
  if (hint?.shift_name) {
    const h = hint.shift_name.toLowerCase();
    candidates = candidates.filter(a => a.shift_name.toLowerCase().includes(h));
  }

  if (candidates.length === 1) return { kind: 'one', shift: candidates[0] };
  if (candidates.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', shifts: candidates };
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
): Promise<void> {
  const { data: schedRow } = await supabase.from('schedules').select('id, data, staffing_report')
    .eq('id', scheduleId).is('deleted_at', null).single();
  if (!schedRow) return;

  const row = schedRow as { id: string; data: ScheduleData; staffing_report: Record<string, unknown> | null };
  const updatedAssignments = applyTradeToAssignments(row.data.assignments, sideA, sideB);

  const updatedData: ScheduleData = { ...row.data, assignments: updatedAssignments };
  const wages = await computeWageEstimate(companyId, updatedAssignments);

  await supabase.from('schedules').update({
    data: updatedData as unknown as Record<string, unknown>,
    staffing_report: { ...(row.staffing_report ?? {}), estimated_wages: wages },
  }).eq('id', scheduleId);
}

// ── Swap validation ───────────────────────────────────────────────────────────

async function validateSwap(params: {
  company_id: string;
  requester_id: string;
  receiver: Employee;
  shift_date: string;
  role: string;
  shift_hours: number;
  policies: Policy[];
}): Promise<ValidationResult> {
  const { company_id, requester_id, receiver, shift_date, role, shift_hours, policies } = params;

  // 1. Qualification check
  if (!receiver.qualified_roles.includes(role)) {
    return { valid: false, reason: `${receiver.name} is not qualified for the ${role} role.` };
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

async function buildSwapCandidates(params: {
  company_id: string;
  requester_id: string;
  shift_date: string;
  role: string;
  shift_start: string;
  shift_end: string;
  shift_hours: number;
}): Promise<Employee[]> {
  const { company_id, requester_id, shift_date, role, shift_start, shift_end, shift_hours } = params;
  const dayOfWeek = new Date(shift_date + 'T12:00:00Z').getUTCDay();

  const [empRes, availRes, toRes, schedRes] = await Promise.all([
    supabase.from('employees').select('*').eq('company_id', company_id).eq('active', true),
    supabase.from('availability').select('*').eq('company_id', company_id),
    supabase.from('time_off_requests').select('employee_id')
      .eq('company_id', company_id).eq('status', 'approved')
      .lte('start_date', shift_date).gte('end_date', shift_date),
    supabase.from('schedules').select('data').is('deleted_at', null)
      .eq('company_id', company_id).eq('status', 'published')
      .lte('week_start', shift_date).gte('week_end', shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const availability = (availRes.data ?? []) as { employee_id: string; day_of_week: number; start_time: string; end_time: string }[];
  const onTO = new Set((toRes.data ?? []).map((r: { employee_id: string }) => r.employee_id));

  const schedData = schedRes.data ? (schedRes.data as { data: ScheduleData }).data : null;
  const weeklyHoursMap = new Map<string, number>();
  if (schedData) {
    for (const a of schedData.assignments) {
      const h = a.hours ?? computeShiftHours(a.start_time, a.end_time);
      weeklyHoursMap.set(a.employee_id, (weeklyHoursMap.get(a.employee_id) ?? 0) + h);
    }
  }

  const availByEmp = new Map<string, typeof availability>();
  for (const a of availability) {
    if (!availByEmp.has(a.employee_id)) availByEmp.set(a.employee_id, []);
    availByEmp.get(a.employee_id)!.push(a);
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

  const candidates = employees.filter(emp => {
    if (emp.id === requester_id) return false;
    if (onTO.has(emp.id)) return false;
    if (neverConflictIds.has(emp.id)) return false;
    if (!emp.qualified_roles.includes(role)) return false;
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

async function extractSwapDetails(body: string, today: string): Promise<{
  shift_date: string | null;
  shift_name: string | null;
  target_employee_name: string | null;
  target_shift_date: string | null;
  target_shift_name: string | null;
  willing_days: number[];
}> {
  const system =
    `You are a data extractor for a workforce scheduling system. Today is ${today}. ` +
    'A shift swap is a TRADE: the sender gives up one of their shifts and takes one of a coworker\'s shifts. ' +
    'Extract: shift_date/shift_name = the SENDER\'s shift they want to give up; ' +
    'target_employee_name = the coworker they want to trade with (null if they didn\'t name anyone); ' +
    'target_shift_date/target_shift_name = the COWORKER\'s shift the sender wants to take in return (null if not stated). ' +
    'willing_days = the weekdays the SENDER says they CAN work in return, as integers 0=Sunday..6=Saturday (e.g. "I can work Mon/Tue/Wed" → [1,2,3]); empty array if they did not say. ' +
    'Example: "swap my Saturday AM for Joe\'s Friday PM" → shift_name "Saturday AM", target_employee_name "Joe", target_shift_name "Friday PM". ' +
    'Respond with ONLY valid JSON: {"shift_date":"YYYY-MM-DD"|null,"shift_name":string|null,"target_employee_name":string|null,"target_shift_date":"YYYY-MM-DD"|null,"target_shift_name":string|null,"willing_days":number[]}';
  const text = await generateReply(system, body, []);
  const parsed = coerceJsonObject<{
    shift_date: string | null; shift_name: string | null; target_employee_name: string | null;
    target_shift_date: string | null; target_shift_name: string | null; willing_days?: unknown;
  }>(text);
  const willing_days = Array.isArray(parsed?.willing_days)
    ? (parsed!.willing_days as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6)
    : [];
  return {
    shift_date: parsed?.shift_date ?? null,
    shift_name: parsed?.shift_name ?? null,
    target_employee_name: parsed?.target_employee_name ?? null,
    target_shift_date: parsed?.target_shift_date ?? null,
    target_shift_name: parsed?.target_shift_name ?? null,
    willing_days,
  };
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

  // Find manager
  const { data: managerData } = await supabase.from('users').select('id, email, name')
    .eq('company_id', company_id).in('role', ['manager', 'owner'])
    .order('role', { ascending: true }).limit(1).maybeSingle();
  if (!managerData) return;
  const manager = managerData as { id: string; email: string; name: string };

  // Manager phone (optional)
  const { data: managerEmpData } = await supabase.from('employees').select('contact_phone')
    .eq('company_id', company_id).eq('contact_email', manager.email).maybeSingle();
  const managerPhone = (managerEmpData as { contact_phone: string | null } | null)?.contact_phone ?? null;

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

  const bodyHtml = `${introHtml}
${brandActionCard(`Action needed · Shift ${isTrade ? 'trade' : 'swap'}`, `${detailsHtml}${ctaHtml}`)}`;

  const html = brandedEmailShell({
    bodyHtml,
    preheader: `Shift swap — ${requester.name} ↔ ${receiver.name} (${formatShortDate(shift_date)})`,
  });

  await sendEmail({ to: manager.email, subject, text, html, company_id });

  if (managerPhone && params.aegis_sms_channel) {
    await sendSms({
      to: managerPhone,
      from: params.aegis_sms_channel,
      body: `${requester.name} and ${receiver.name} want to swap the ${shift_name} shift on ${formatShortDate(shift_date)}. Full details and approval options are in your email from Aegis.`,
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

  // Create approved swap_request record
  const { data: swapRow } = await supabase.from('swap_requests').insert({
    company_id,
    requesting_employee_id: requester.id,
    receiving_employee_id: receiver.id,
    shift_date,
    shift_name,
    role,
    status: 'approved',
    initiated_by: 'aegis',
    decided_at: new Date().toISOString(),
    decided_by: 'aegis',
    notes: 'Auto-approved — no manager approval required per company policy.',
  }).select('id').single();

  const swapId = (swapRow as { id: string } | null)?.id ?? 'unknown';

  // Update schedule
  if (schedule_id) {
    await executeScheduleSwap(company_id, schedule_id, shift_date, shift_name, requester.id, receiver.id, receiver.name);
  }

  const dateStr = formatDisplayDate(shift_date);
  const shiftDesc = `${shift_name} (${shift_start}–${shift_end}, ${role}) on ${dateStr}`;

  // Notify requester
  const requesterMsg: InboundMessage = {
    sender: params.requester_sender, recipient: params.requester_recipient, body: '',
    channel: params.requester_channel, raw_subject: params.requester_raw_subject, thread_id: params.requester_thread_id,
  };
  const requesterContact: VerifiedContact = {
    role: 'employee', company_id, employee_id: requester.id, user_id: null,
    name: requester.name, matched_identifier: params.requester_sender, channel: params.requester_channel,
  };
  await reply(requesterContact, requesterMsg, `${greeting(requester.name)} your swap has been confirmed! ${receiver.name} will cover your ${shiftDesc}.`);

  // Notify receiver — EMAIL-FIRST (SMS only once A2P clears).
  await sendOutreachMessage({
    receiverEmail: receiver.contact_email ?? null,
    receiverPhone: receiver.contact_phone ?? null,
    aegisSmsNumber: params.aegis_sms_channel,
    subject: `You're covering a ${shift_name} shift on ${formatShortDate(shift_date)}`,
    text: `${greeting(receiver.name)} your swap with ${requester.name} is confirmed. You're covering the ${shiftDesc}.`,
    company_id,
  });

  await logActivity({
    company_id,
    action: 'swap_approved',
    entity_type: 'swap_request',
    entity_id: swapId,
    summary: `Swap approved: ${requester.name} ↔ ${receiver.name} for ${shift_name} on ${shift_date}`,
    metadata: { requester_id: requester.id, receiver_id: receiver.id, shift_date, shift_name, role, schedule_updated: !!schedule_id },
  });
}

// ── Main handlers ─────────────────────────────────────────────────────────────

export async function handleInitiateSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await extractSwapDetails(message.body, today);

  const shiftDate = raw.shift_date ?? today;
  const shiftNameHint = raw.shift_name ?? null;
  const targetName = raw.target_employee_name ?? null;

  // Find the requester's shift in the schedule
  const schedule = await findSchedule(contact.company_id, shiftDate);
  let shift: ScheduleAssignment | null = null;
  if (schedule) {
    shift = findRequesterShift(schedule.data, contact.employee_id!, shiftDate);
    // If we have a hint but no exact match, try to find by shift_name
    if (!shift && shiftNameHint) {
      shift = schedule.data.assignments.find(a =>
        a.date === shiftDate && a.shift_name.toLowerCase().includes(shiftNameHint.toLowerCase())
      ) ?? null;
    }
  }

  if (!shift) {
    await reply(contact, message,
      `I couldn't find a shift for you on ${formatDisplayDate(shiftDate)}${shiftNameHint ? ` matching "${shiftNameHint}"` : ''}. ` +
      "Double-check the date, or reach out to your manager if you think there's a shift missing."
    );
    return;
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
      const list = choice.shifts
        .map(s => `${s.shift_name} on ${formatDisplayDate(s.date)} (${s.start_time}–${s.end_time})`)
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
      receiver: targetEmployee, shift_date: shiftDate, role: shift.role, shift_hours: shiftHours, policies,
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
      receiver: requesterEmployee, shift_date: targetShift.date, role: targetShift.role, shift_hours: targetShiftHours, policies,
    });
    if (!youTakeTheirs.valid) {
      await reply(contact, message,
        `This swap can't proceed — you wouldn't be able to take ${targetEmployee.name}'s ${targetShift.shift_name} shift: ${youTakeTheirs.reason} Want to try a different shift or coworker?`);
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
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    await storePendingSwap(pending);

    await reply(contact, message,
      `Just to confirm the trade: you'd give up your ${shift.shift_name} shift on ${formatDisplayDate(shiftDate)} and pick up ${targetEmployee.name}'s ${targetShift.shift_name} shift on ${formatDisplayDate(targetShift.date)}. Reply "yes" to send it to ${firstName(targetEmployee.name)}, or "no" to cancel.`
    );
  } else {
    // Mode 2: facilitated — quick feasibility check
    const candidates = await buildSwapCandidates({
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      shift_date: shiftDate,
      role: shift.role,
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
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    await storePendingSwap(pending);

    const candidateNote = candidates.length > 0
      ? `I found ${candidates.length} potential candidate${candidates.length !== 1 ? 's' : ''}. `
      : 'I didn\'t find any available candidates right now, but ';

    await reply(contact, message,
      `You want someone to take your ${shift.shift_name} shift (${shift.role}, ${shift.start_time}–${shift.end_time}) on ${formatDisplayDate(shiftDate)}. ${candidateNote}Confirm? Reply "yes" to proceed or "no" to cancel.`
    );
  }
}

// Reach an employee email-first (branded email) with an SMS fallback. Used for
// swap outreach so the flow works for email-only employees — replies route back
// via the same swap_outreach record keyed by the employee.
async function sendOutreachMessage(params: {
  receiverEmail: string | null;
  receiverPhone: string | null;
  aegisSmsNumber: string | null;
  subject: string;
  text: string;
  company_id: string;
}): Promise<'email' | 'sms' | 'none'> {
  const { receiverEmail, receiverPhone, aegisSmsNumber, subject, text, company_id } = params;
  if (receiverEmail) {
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = brandedEmailShell({
      bodyHtml: `<p style="margin:0;font-size:16px;color:${BRAND.textPrimary};line-height:1.65;">${safe}</p>`,
      preheader: subject,
    });
    await sendEmail({ to: receiverEmail, subject, text, html, company_id });
    return 'email';
  }
  if (receiverPhone && aegisSmsNumber) {
    await sendSms({ to: receiverPhone, from: aegisSmsNumber, body: text, company_id });
    return 'sms';
  }
  return 'none';
}

// Called from router pre-check when swap_pending:{employeeId} exists.
export async function handleSwapConfirmation(
  message: InboundMessage,
  contact: VerifiedContact,
  pending: PendingSwap & { _memory_id?: string }
): Promise<void> {
  const answer = parseYesNo(message.body);

  if (answer === 'unclear') {
    await reply(contact, message,
      'Please reply "yes" to confirm your swap request or "no" to cancel.'
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

    // From the target's side: they give up THEIR shift and pick up the requester's.
    const yourShift = pending.target_shift_name
      ? `your ${pending.target_shift_name} shift on ${formatDisplayDate(pending.target_shift_date ?? pending.shift_date)}`
      : 'your shift';
    const theirShift = `their ${pending.shift_name} shift (${pending.shift_start}–${pending.shift_end}, ${pending.role}) on ${formatDisplayDate(pending.shift_date)}`;
    const askText =
      `${greeting(receiver.name)} this is Aegis. ${contact.name} would like to trade shifts with you — ` +
      `you'd give up ${yourShift} and pick up ${theirShift}. Want to do it? Reply YES or NO.`;

    await sendOutreachMessage({
      receiverEmail, receiverPhone, aegisSmsNumber,
      subject: `Shift trade request from ${contact.name}`,
      text: askText, company_id: contact.company_id,
    });

    await reply(contact, message,
      `I've reached out to ${receiver.name} about the trade. I'll let you know as soon as I hear back.`
    );

    await logActivity({
      company_id: contact.company_id,
      action: 'swap_outreach_sent',
      summary: `Trade outreach sent to ${receiver.name} for ${contact.name} — give ${pending.shift_name} / take ${pending.target_shift_name ?? '?'} on ${pending.shift_date}`,
      metadata: { requester_id: contact.employee_id, receiver_id: receiver.id, shift_date: pending.shift_date, mode: 'directed', trade: !!pending.target_shift_name },
    });
  } else {
    // Mode 2: facilitated
    const shiftHours = computeShiftHours(pending.shift_start, pending.shift_end);
    const candidates = await buildSwapCandidates({
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      shift_date: pending.shift_date,
      role: pending.role,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      shift_hours: shiftHours,
    });

    if (candidates.length === 0) {
      await reply(contact, message,
        `Unfortunately no qualified, available employees were found to cover your ${pending.shift_name} shift on ${formatDisplayDate(pending.shift_date)}. ` +
        'Please contact your manager directly.'
      );
      await logActivity({
        company_id: contact.company_id,
        action: 'swap_no_candidates',
        summary: `No swap candidates found for ${contact.name}'s ${pending.shift_name} on ${pending.shift_date}`,
        metadata: { requester_id: contact.employee_id, shift_date: pending.shift_date, role: pending.role },
      });
      return;
    }

    // EMAIL-FIRST broadcast (SMS only once A2P clears). Contact the first
    // reachable candidate; the remaining reachable ones queue for first-yes-wins.
    const hasSms = !!aegisSmsNumber;
    const firstIdx = candidates.findIndex(c => isReachableForOutreach(c, hasSms));
    if (firstIdx === -1) {
      await reply(contact, message,
        `I found qualified employees, but none have an email${hasSms ? ' or phone' : ''} on file I can reach right now. Please contact your manager for help covering this shift.`
      );
      return;
    }
    const firstCandidate = candidates[firstIdx];
    const remaining = candidates.slice(firstIdx + 1).filter(c => isReachableForOutreach(c, hasSms)).map(c => c.id);
    const reachableCount = 1 + remaining.length;

    const outreach: SwapOutreach = {
      mode: 'facilitated',
      company_id: contact.company_id,
      requester_id: contact.employee_id!,
      requester_name: contact.name,
      requester_channel: message.channel,
      requester_sender: message.sender,
      requester_recipient: message.recipient,
      requester_raw_subject: message.raw_subject,
      requester_thread_id: message.thread_id,
      receiver_id: firstCandidate.id,
      receiver_phone: firstCandidate.contact_phone ?? '',
      receiver_email: firstCandidate.contact_email ?? undefined,
      aegis_sms_channel: aegisSmsNumber ?? '',
      shift_date: pending.shift_date,
      shift_name: pending.shift_name,
      role: pending.role,
      shift_start: pending.shift_start,
      shift_end: pending.shift_end,
      schedule_id: pending.schedule_id,
      candidate_queue: remaining,
      outreach_sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    };
    await storeSwapOutreach(outreach);

    await sendOutreachMessage({
      receiverEmail: firstCandidate.contact_email ?? null,
      receiverPhone: firstCandidate.contact_phone ?? null,
      aegisSmsNumber,
      subject: `Can you take a ${pending.shift_name} shift on ${formatShortDate(pending.shift_date)}?`,
      text:
        `${greeting(firstCandidate.name)} this is Aegis. ` +
        `${contact.name} is looking for someone to take their ${pending.shift_name} shift ` +
        `(${pending.shift_start}–${pending.shift_end}, ${pending.role}) on ${formatDisplayDate(pending.shift_date)}. ` +
        'Would you like to take this shift? Reply YES or NO.',
      company_id: contact.company_id,
    });

    await reply(contact, message,
      `I'm reaching out to ${reachableCount} available employee${reachableCount !== 1 ? 's' : ''}. I'll let you know as soon as someone accepts.`
    );

    await logActivity({
      company_id: contact.company_id,
      action: 'swap_outreach_sent',
      summary: `Facilitated swap outreach started for ${contact.name}'s ${pending.shift_name} on ${pending.shift_date} — contacting ${firstCandidate.name}`,
      metadata: { requester_id: contact.employee_id, first_candidate: firstCandidate.id, total_candidates: reachableCount, shift_date: pending.shift_date },
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
      `Please reply "yes" to accept the ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)} or "no" to decline.`
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
      receiverEmail: nextEmp.contact_email ?? null,
      receiverPhone: nextEmp.contact_phone ?? null,
      aegisSmsNumber: smsChannel,
      subject: `Can you take a ${outreach.shift_name} shift on ${formatShortDate(outreach.shift_date)}?`,
      text:
        `${greeting(nextEmp.name)} this is Aegis. ` +
        `${outreach.requester_name} is looking for someone to take their ${outreach.shift_name} shift ` +
        `(${outreach.shift_start}–${outreach.shift_end}, ${outreach.role}) on ${formatDisplayDate(outreach.shift_date)}. ` +
        'Would you like to take this shift? Reply YES or NO.',
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

  // Ask Claude if manager approval is required
  let requiresApproval = false;
  if (policies.length > 0) {
    const policyText = policies.map(p => `${p.policy_key}: ${p.policy_value}${p.description ? ' — ' + p.description : ''}`).join('\n');
    const system = 'Based on these swap policies, does manager approval EXPLICITLY appear to be required before a swap is executed? Respond ONLY with valid JSON: {"requires_approval":true|false}';
    const text = await generateReply(system, policyText, []);
    const parsed = coerceJsonObject<{ requires_approval: boolean }>(text);
    requiresApproval = parsed?.requires_approval ?? false;
  }

  // A two-way trade ALWAYS needs the manager's sign-off (item 18 design).
  if (outreach.target_shift_name) requiresApproval = true;

  await logActivity({
    company_id: outreach.company_id,
    action: 'swap_accepted',
    summary: `${contact.name} accepted swap for ${outreach.requester_name}'s ${outreach.shift_name} on ${outreach.shift_date}`,
    metadata: { receiver_id: contact.employee_id, requester_id: outreach.requester_id, shift_date: outreach.shift_date, requires_approval: requiresApproval },
  });

  if (!requiresApproval) {
    await reply(contact, message,
      `You're confirmed for the ${outreach.shift_name} shift (${outreach.shift_start}–${outreach.shift_end}) on ${formatDisplayDate(outreach.shift_date)}. Swap complete!`
    );
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
      notes: `Both employees agreed via Aegis. ${outreach.mode === 'facilitated' ? 'Facilitated swap.' : 'Directed swap.'}`,
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
export async function handleRespondSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  _extracted: Record<string, unknown>,
  _decision: 'accept' | 'decline'
): Promise<void> {
  await reply(contact, message,
    "I don't have an active swap request pending for you. If you received a swap request from Aegis, please check your recent messages."
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
