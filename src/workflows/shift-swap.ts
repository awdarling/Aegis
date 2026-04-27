import type { InboundMessage, VerifiedContact } from '../security/types';
import { logActivity } from '../logger/activity-log';
import { reply } from '../router/intent-router';

// ── Employee: initiate a shift swap request ───────────────────────────────────

export async function handleInitiateSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7c
  await logActivity({
    company_id: contact.company_id,
    action: 'swap_initiate_received',
    summary: `${contact.name} initiated a shift swap (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Your swap request has been received. This feature is coming soon.');
}

// ── Employee: respond to Aegis swap outreach ──────────────────────────────────

export async function handleRespondSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>,
  decision: 'accept' | 'decline'
): Promise<void> {
  // TODO: implement — Phase 7c
  await logActivity({
    company_id: contact.company_id,
    action: `swap_respond_${decision}`,
    summary: `${contact.name} responded to swap outreach: ${decision} (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, `Your ${decision} has been recorded. This feature is coming soon.`);
}

// ── Manager: approve a swap pending their review ──────────────────────────────

export async function handleApproveSwap(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7c
  await logActivity({
    company_id: contact.company_id,
    action: 'swap_approve_received',
    summary: `Manager ${contact.name} approved a swap (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Swap approval noted. This feature is coming soon.');
}

// ── Manager: deny a swap ──────────────────────────────────────────────────────

export async function handleDenySwap(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7c
  await logActivity({
    company_id: contact.company_id,
    action: 'swap_deny_received',
    summary: `Manager ${contact.name} denied a swap (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Swap denial noted. This feature is coming soon.');
}
