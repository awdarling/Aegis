import type { InboundMessage, VerifiedContact } from '../security/types';
import { logActivity } from '../logger/activity-log';
import { reply } from '../router/intent-router';

// ── Manager: request emergency coverage candidates ────────────────────────────

export async function handleEmergencyCoverage(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  // TODO: implement — Phase 7d
  await logActivity({
    company_id: contact.company_id,
    action: 'emergency_coverage_received',
    summary: `Manager ${contact.name} requested emergency coverage (pending implementation)`,
    metadata: { extracted },
  });
  await reply(contact, message, 'Emergency coverage request received. This feature is coming soon.');
}
