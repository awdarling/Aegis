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
import { handleBuildSchedule, handleDistributeSchedule } from '../workflows/schedule-build';
import { handleOperationalQuery, handleHomebaseEdit, handleEditConfirmation, getPendingEdit } from '../workflows/operational-query';
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
import {
  getOnboardingSession,
  handleOnboardingResponse,
  handleInitiateOnboarding,
  getPendingAvailConfirm,
  handleAvailabilityConfirmResponse,
  handleUpdateAvailability,
  getPendingManagerAvailApproval,
  handleManagerAvailabilityApproval,
} from '../workflows/employee-onboarding';

// Intents that require manager role — employee attempting these is an unauthorized_action
const MANAGER_ONLY_INTENTS = new Set([
  'build_schedule',
  'distribute_schedule',
  'approve_time_off',
  'deny_time_off',
  'approve_swap',
  'deny_swap',
  'request_emergency_coverage',
  'initiate_onboarding',
  'homebase_edit',
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

    // Check for pending availability update confirmation (employee confirming parsed availability)
    const pendingAvailConfirm = await getPendingAvailConfirm(contact.company_id, contact.employee_id);
    if (pendingAvailConfirm) {
      await handleAvailabilityConfirmResponse(message, contact, pendingAvailConfirm);
      return;
    }

    // Check for active onboarding session
    const onboardingSession = await getOnboardingSession(contact.company_id, contact.employee_id);
    if (onboardingSession) {
      await handleOnboardingResponse(message, contact, onboardingSession);
      return;
    }
  }

  // Pre-classification: manager checks (edit confirmation, coverage session)
  if (contact.role === 'manager') {
    const pendingEdit = await getPendingEdit(contact.company_id, contact.matched_identifier);
    if (pendingEdit) {
      await handleEditConfirmation(message, contact, pendingEdit);
      return;
    }

    const session = await getActiveCoverageSession(contact.company_id, contact.matched_identifier);
    if (session && session.state === 'awaiting_names') {
      await handleManagerCoverageReply(message, contact, session);
      return;
    }

    // Check for pending employee availability approval
    const pendingAvailApproval = await getPendingManagerAvailApproval(contact.company_id);
    if (pendingAvailApproval) {
      await handleManagerAvailabilityApproval(message, contact, pendingAvailApproval);
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

      case 'initiate_onboarding':
        await handleInitiateOnboarding(message, contact, classification.extracted);
        break;

      case 'update_availability':
        await handleUpdateAvailability(message, contact, classification.extracted);
        break;

      case 'distribute_schedule':
        await handleDistributeSchedule(message, contact, classification.extracted);
        break;

      case 'homebase_edit':
        await handleHomebaseEdit(message, contact, classification.extracted);
        break;

      case 'operational_query':
      case 'operational_question':
      case 'general_question':
        await handleOperationalQuery(message, contact, classification.extracted);
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
