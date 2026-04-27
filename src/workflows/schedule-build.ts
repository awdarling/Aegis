import type { InboundMessage, VerifiedContact } from '../security/types';
import { logActivity } from '../logger/activity-log';
import { reply } from '../router/intent-router';

// ── Manager: request a schedule build for a week ──────────────────────────────

export async function handleBuildSchedule(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7b
  await logActivity({
    company_id: contact.company_id,
    action: 'schedule_build_received',
    summary: `Manager ${contact.name} requested a schedule build (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Schedule build request received. This feature is coming soon.');
}
