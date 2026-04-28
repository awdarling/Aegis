import { classifyIntent } from '../ai/claude';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { supabase } from '../db/client';
import type { InboundMessage, VerifiedContact } from '../security/types';

// Workflow handlers — stubs until each phase is built
import {
  handleSubmitTimeOff,
  handleApproveTimeOff,
  handleDenyTimeOff,
  handlePendingTimeOffConfirmation,
  getPendingTimeOff,
} from '../workflows/time-off';
import { handleBuildSchedule } from '../workflows/schedule-build';
import {
  handleInitiateSwap,
  handleRespondSwap,
  handleApproveSwap,
  handleDenySwap,
  handleSwapConfirmation,
  handleSwapOutreachResponse,
  getPendingSwap,
  getActiveSwapOutreach,
} from '../workflows/shift-swap';
import {
  handleEmergencyCoverage,
  handleManagerCoverageReply,
  handleEmployeeCoverageResponse,
  getActiveCoverageSession,
  getActiveOutreach,
} from '../workflows/emergency-coverage';

// Intents that require manager role — employee attempting these is an unauthorized_action
const MANAGER_ONLY_INTENTS = new Set([
  'build_schedule',
  'approve_time_off',
  'deny_time_off',
  'approve_swap',
  'deny_swap',
  'request_emergency_coverage',
  'operational_question',
]);

export async function routeIntent(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<void> {
  // Pre-classification: employee checks (TO confirmation, active outreach)
  if (contact.role === 'employee' && contact.employee_id) {
    const pendingTO = await getPendingTimeOff(contact.company_id, contact.employee_id);
    if (pendingTO) {
      await handlePendingTimeOffConfirmation(message, contact, pendingTO);
      return;
    }

    const activeOutreach = await getActiveOutreach(contact.company_id, contact.employee_id);
    if (activeOutreach) {
      await handleEmployeeCoverageResponse(message, contact, activeOutreach);
      return;
    }

    // Check for active swap outreach (employee being asked to take a shift)
    const swapOutreach = await getActiveSwapOutreach(contact.company_id, contact.employee_id);
    if (swapOutreach) {
      await handleSwapOutreachResponse(message, contact, swapOutreach);
      return;
    }

    // Check for pending swap confirmation (employee confirming their own request)
    const pendingSwap = await getPendingSwap(contact.company_id, contact.employee_id);
    if (pendingSwap) {
      await handleSwapConfirmation(message, contact, pendingSwap);
      return;
    }
  }

  // Pre-classification: manager check — coverage session awaiting name reply
  if (contact.role === 'manager') {
    const session = await getActiveCoverageSession(contact.company_id, contact.matched_identifier);
    if (session && session.state === 'awaiting_names') {
      await handleManagerCoverageReply(message, contact, session);
      return;
    }
  }

  // Load company profile for context injection into the classifier
  const companyContext = await loadCompanyContext(contact.company_id);

  const classification = await classifyIntent(message.body, contact.role, companyContext);

  // Authorization check — log and reply if employee tries a manager-only action
  if (contact.role === 'employee' && MANAGER_ONLY_INTENTS.has(classification.intent)) {
    await logSecurityUnauthorized(message, contact);
    await reply(contact, message, "I'm sorry, I can't help with that. Please contact your manager directly.");
    return;
  }

  await logActivity({
    company_id: contact.company_id,
    action: 'intent_classified',
    summary: `${contact.role} ${contact.name} → intent: ${classification.intent} (${classification.confidence})`,
    metadata: {
      intent: classification.intent,
      confidence: classification.confidence,
      channel: message.channel,
      sender: message.sender,
    },
  });

  try {
    switch (classification.intent) {
      case 'submit_time_off':
        await handleSubmitTimeOff(message, contact, classification.extracted);
        break;

      case 'approve_time_off':
        await handleApproveTimeOff(message, contact, classification.extracted);
        break;

      case 'deny_time_off':
        await handleDenyTimeOff(message, contact, classification.extracted);
        break;

      case 'build_schedule':
        await handleBuildSchedule(message, contact, classification.extracted);
        break;

      case 'initiate_swap':
        await handleInitiateSwap(message, contact, classification.extracted);
        break;

      case 'respond_swap_accept':
        await handleRespondSwap(message, contact, classification.extracted, 'accept');
        break;

      case 'respond_swap_decline':
        await handleRespondSwap(message, contact, classification.extracted, 'decline');
        break;

      case 'approve_swap':
        await handleApproveSwap(message, contact, classification.extracted);
        break;

      case 'deny_swap':
        await handleDenySwap(message, contact, classification.extracted);
        break;

      case 'request_emergency_coverage':
        await handleEmergencyCoverage(message, contact, classification.extracted);
        break;

      case 'general_question':
      case 'operational_question':
        await handleGeneralQuestion(message, contact);
        break;

      default:
        await reply(contact, message,
          "I didn't quite understand that. Could you rephrase? " +
          'For help, reply with "help".'
        );
    }
  } catch (err) {
    console.error('[router] workflow error:', err);
    await reply(contact, message,
      "Something went wrong on my end. Please try again in a moment."
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadCompanyContext(companyId: string): Promise<string> {
  const [companyRes, profileRes] = await Promise.all([
    supabase.from('companies').select('name, timezone, industry').eq('id', companyId).single(),
    supabase.from('company_profiles').select('business_type, description, operating_hours, manager_priorities').eq('company_id', companyId).maybeSingle(),
  ]);

  const company = companyRes.data;
  const profile = profileRes.data;

  const lines = [`Company: ${company?.name ?? 'Unknown'} (timezone: ${company?.timezone ?? 'America/New_York'})`];
  if (company?.industry) lines.push(`Industry: ${company.industry}`);
  if (profile?.business_type) lines.push(`Business type: ${profile.business_type}`);
  if (profile?.operating_hours) lines.push(`Operating hours: ${profile.operating_hours}`);
  if (profile?.manager_priorities) lines.push(`Manager priorities: ${profile.manager_priorities}`);

  return lines.join('\n');
}

async function handleGeneralQuestion(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<void> {
  const { generateReply } = await import('../ai/claude');

  const systemPrompt = `You are Aegis, an AI workforce assistant for a company that uses Homebase scheduling software. ` +
    `You are speaking with ${contact.name}, a ${contact.role}. ` +
    `Answer operational workforce questions concisely. ` +
    `If a question requires access to specific data you cannot see, say so and ask the manager to check Homebase directly.`;

  const responseText = await generateReply(systemPrompt, message.body, []);
  await reply(contact, message, responseText);
}

async function logSecurityUnauthorized(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<void> {
  const { supabase: db } = await import('../db/client');
  await db.from('security_events').insert({
    event_type: 'unauthorized_action',
    channel: message.channel,
    sender_contact: message.sender,
    message_preview: message.body.slice(0, 200),
    resolution: 'blocked',
    company_id: contact.company_id,
  });
  await logActivity({
    company_id: contact.company_id,
    action: 'unauthorized_action_blocked',
    summary: `Employee ${contact.name} attempted manager-only action; blocked`,
    metadata: { sender: message.sender, message_preview: message.body.slice(0, 200) },
  });
}

// Re-export reply for any callers that imported it from here
export { reply };
