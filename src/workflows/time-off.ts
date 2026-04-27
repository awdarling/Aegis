import type { InboundMessage, VerifiedContact } from '../security/types';
import { logActivity } from '../logger/activity-log';
import { reply } from '../router/intent-router';

// ── Employee: submit a time-off request ───────────────────────────────────────

export async function handleSubmitTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7a
  await logActivity({
    company_id: contact.company_id,
    action: 'time_off_submit_received',
    summary: `${contact.name} submitted a time-off request (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Your time-off request has been received. This feature is coming soon.');
}

// ── Manager: approve a pending time-off request ───────────────────────────────

export async function handleApproveTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7a
  await logActivity({
    company_id: contact.company_id,
    action: 'time_off_approve_received',
    summary: `Manager ${contact.name} approved a time-off request (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Time-off approval noted. This feature is coming soon.');
}

// ── Manager: deny a pending time-off request ──────────────────────────────────

export async function handleDenyTimeOff(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7a
  await logActivity({
    company_id: contact.company_id,
    action: 'time_off_deny_received',
    summary: `Manager ${contact.name} denied a time-off request (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Time-off denial noted. This feature is coming soon.');
}
