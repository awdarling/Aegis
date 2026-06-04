import { classifyIntent, AnthropicOverloadError } from '../ai/claude';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { supabase } from '../db/client';
import type { InboundMessage, VerifiedContact } from '../security/types';

// Workflow handlers
import {
  handleSubmitTimeOff,
  handleApproveTimeOff,
  handleDenyTimeOff,
  handlePendingTimeOffConfirmation,
  handleQueryMyTimeOff,
  getPendingTimeOff,
} from '../workflows/time-off';
import { handleBuildSchedule, handleDistributeSchedule } from '../workflows/schedule-build';
import {
  handleOperationalQuery,
  handleHomebaseEdit,
  handleEditConfirmation,
  getPendingEdit,
} from '../workflows/operational-query';
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
import { handlePayrollCheck } from '../workflows/payroll';
import {
  getOnboardingSession,
  getOnboardingSessionByPhone,
  getOnboardingSessionByEmail,
  handleOnboardingResponse,
  handleInitiateOnboarding,
  getPendingAvailConfirm,
  handleAvailabilityConfirmResponse,
  handleUpdateAvailability,
  getPendingManagerAvailApproval,
  handleManagerAvailabilityApproval,
  getOnboardingFanoutPending,
  handleOnboardingFanoutConfirm,
} from '../workflows/employee-onboarding';
import {
  handleBroadcast,
  handleBroadcastConfirmation,
  getActiveBroadcastSession,
} from '../workflows/broadcast';
import { handleNotifyDayClosure } from '../workflows/day-closure';

// ── Permission sets ───────────────────────────────────────────────────────────

// Intents that require an elevated role (manager OR quria_admin) — employees
// attempting these are blocked. Both managers and quria_admins are permitted;
// the check below only filters out employees. `initiate_onboarding` is allowed
// for both manager and quria_admin.
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
  'run_payroll_check',
  'notify_day_closure',
]);

// Intents available only to quria_admin — managers attempting these are blocked.
const QURIA_ONLY_INTENTS = new Set([
  'broadcast_message',
  'quria_diagnostic',
]);

// ── Main router ───────────────────────────────────────────────────────────────

export async function routeIntent(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<void> {
  console.log('[router] entered', {
    sender: message.sender,
    recipient: message.recipient,
    channel: message.channel,
    body: message.body.slice(0, 120),
    role: contact.role,
  });
  try {
    await routeIntentInner(message, contact);
  } catch (err) {
    if (err instanceof AnthropicOverloadError) {
      const overloadMsg =
        contact.role === 'employee'
          ? 'Aegis is temporarily unavailable due to high demand on our servers. Please try again in a few minutes.'
          : "Aegis couldn't complete that request right now — our AI provider is experiencing high load. Please try again in 2-3 minutes. Your request was not processed.";
      console.error('[router] Anthropic overloaded after retries; notifying sender');
      try {
        await reply(contact, message, overloadMsg);
      } catch (replyErr) {
        console.error('[router] failed to send overload notice:', replyErr);
      }
      return;
    }
    throw err;
  }
}

async function routeIntentInner(
  message: InboundMessage,
  contact: VerifiedContact
): Promise<void> {
  // Phone-keyed onboarding lookup. Runs before role-based routing so that an
  // inbound SMS from a phone with an active onboarding session is handled as an
  // onboarding reply even when identity verification matched the sender to a
  // different role (e.g., a Quria admin whose personal phone is also the phone
  // of a test employee being onboarded).
  if (message.channel === 'sms') {
    const phoneSession = await getOnboardingSessionByPhone(message.sender);
    if (phoneSession) {
      await handleOnboardingResponse(message, contact, phoneSession);
      console.log('[router] EARLY RETURN', { reason: 'onboarding_phone_session' });
      return;
    }
  }

  // Email-keyed onboarding lookup. Same rationale as the phone-keyed check
  // above — ensures a reply to an onboarding email is routed back into the
  // workflow regardless of how identity verification resolved the sender.
  if (message.channel === 'email') {
    const emailSession = await getOnboardingSessionByEmail(message.sender);
    if (emailSession) {
      await handleOnboardingResponse(message, contact, emailSession);
      console.log('[router] EARLY RETURN', { reason: 'onboarding_email_session' });
      return;
    }
  }

  // Pre-classification: employee session checks
  if (contact.role === 'employee' && contact.employee_id) {
    const pendingTO = await getPendingTimeOff(contact.company_id, contact.employee_id);
    if (pendingTO) {
      await handlePendingTimeOffConfirmation(message, contact, pendingTO);
      console.log('[router] EARLY RETURN', { reason: 'pending_time_off_confirmation' });
      return;
    }

    const activeOutreach = await getActiveOutreach(contact.company_id, contact.employee_id);
    if (activeOutreach) {
      await handleEmployeeCoverageResponse(message, contact, activeOutreach);
      console.log('[router] EARLY RETURN', { reason: 'coverage_outreach_response' });
      return;
    }

    const swapOutreach = await getActiveSwapOutreach(contact.company_id, contact.employee_id);
    if (swapOutreach) {
      await handleSwapOutreachResponse(message, contact, swapOutreach);
      console.log('[router] EARLY RETURN', { reason: 'swap_outreach_response' });
      return;
    }

    const pendingSwap = await getPendingSwap(contact.company_id, contact.employee_id);
    if (pendingSwap) {
      await handleSwapConfirmation(message, contact, pendingSwap);
      console.log('[router] EARLY RETURN', { reason: 'pending_swap_confirmation' });
      return;
    }

    const pendingAvailConfirm = await getPendingAvailConfirm(contact.company_id, contact.employee_id);
    if (pendingAvailConfirm) {
      await handleAvailabilityConfirmResponse(message, contact, pendingAvailConfirm);
      console.log('[router] EARLY RETURN', { reason: 'availability_confirm_response' });
      return;
    }

    const onboardingSession = await getOnboardingSession(contact.company_id, contact.employee_id);
    if (onboardingSession) {
      await handleOnboardingResponse(message, contact, onboardingSession);
      console.log('[router] EARLY RETURN', { reason: 'onboarding_employee_session' });
      return;
    }
  }

  // Pre-classification: manager and quria_admin session checks
  if (contact.role === 'manager' || contact.role === 'quria_admin') {
    // Quria-specific: broadcast confirmation session
    if (contact.role === 'quria_admin') {
      const broadcastSession = await getActiveBroadcastSession(
        contact.company_id,
        contact.matched_identifier
      );
      if (broadcastSession) {
        await handleBroadcastConfirmation(message, contact, broadcastSession);
        console.log('[router] EARLY RETURN', { reason: 'broadcast_confirmation' });
        return;
      }
    }

    const pendingEdit = await getPendingEdit(contact.company_id, contact.matched_identifier);
    if (pendingEdit) {
      await handleEditConfirmation(message, contact, pendingEdit);
      console.log('[router] EARLY RETURN', { reason: 'pending_homebase_edit' });
      return;
    }

    const session = await getActiveCoverageSession(contact.company_id, contact.matched_identifier);
    if (session && session.state === 'awaiting_names') {
      await handleManagerCoverageReply(message, contact, session);
      console.log('[router] EARLY RETURN', { reason: 'manager_coverage_reply' });
      return;
    }

    const pendingAvailApproval = await getPendingManagerAvailApproval(contact.company_id);
    if (pendingAvailApproval) {
      await handleManagerAvailabilityApproval(message, contact, pendingAvailApproval);
      console.log('[router] EARLY RETURN', { reason: 'manager_avail_approval' });
      return;
    }

    const pendingFanout = await getOnboardingFanoutPending(
      contact.company_id,
      contact.matched_identifier
    );
    if (pendingFanout) {
      await handleOnboardingFanoutConfirm(message, contact, pendingFanout);
      console.log('[router] EARLY RETURN', { reason: 'onboarding_fanout_confirm' });
      return;
    }
  }

  // Classify intent — each role gets its own allowed intent list
  const { text: companyContext, timezone: companyTimezone } = await loadCompanyContext(contact.company_id);
  const classification = await classifyIntent(message.body, contact.role, companyContext, companyTimezone);

  console.log('[router] classified', {
    intent: classification.intent,
    confidence: classification.confidence,
    extracted: classification.extracted,
  });

  // Authorization: employee attempting a manager-only action
  if (contact.role === 'employee' && MANAGER_ONLY_INTENTS.has(classification.intent)) {
    await logSecurityUnauthorized(message, contact);
    await reply(
      contact,
      message,
      "That's something your manager handles. Contact them directly if you need help with this."
    );
    return;
  }

  // Authorization: manager attempting a quria-only action
  if (contact.role === 'manager' && QURIA_ONLY_INTENTS.has(classification.intent)) {
    await reply(contact, message, 'That action requires Quria administrator access.');
    return;
  }

  await logActivity({
    company_id: contact.company_id,
    actor: contact.role === 'quria_admin' ? 'quria_admin' : 'aegis',
    action: 'intent_classified',
    summary: `${contact.role} ${contact.name} → intent: ${classification.intent} (${classification.confidence})`,
    metadata: {
      intent: classification.intent,
      confidence: classification.confidence,
      channel: message.channel,
      sender: message.sender,
      ...(contact.role === 'quria_admin' && {
        quria_staff_email: contact.quria_staff_email,
        target_company_id: contact.company_id,
      }),
    },
  });

  try {
    switch (classification.intent) {
      case 'submit_time_off':
        console.log('[router] dispatching to handleSubmitTimeOff');
        await handleSubmitTimeOff(message, contact, classification.extracted);
        break;

      case 'query_my_time_off':
        console.log('[router] dispatching to handleQueryMyTimeOff');
        await handleQueryMyTimeOff(message, contact, classification.extracted);
        break;

      case 'approve_time_off':
        console.log('[router] dispatching to handleApproveTimeOff');
        await handleApproveTimeOff(message, contact, classification.extracted);
        break;

      case 'deny_time_off':
        console.log('[router] dispatching to handleDenyTimeOff');
        await handleDenyTimeOff(message, contact, classification.extracted);
        break;

      case 'build_schedule':
        console.log('[router] dispatching to handleBuildSchedule');
        await handleBuildSchedule(message, contact, classification.extracted);
        break;

      case 'initiate_swap':
        console.log('[router] dispatching to handleInitiateSwap');
        await handleInitiateSwap(message, contact, classification.extracted);
        break;

      case 'respond_swap_accept':
        console.log('[router] dispatching to handleRespondSwap (accept)');
        await handleRespondSwap(message, contact, classification.extracted, 'accept');
        break;

      case 'respond_swap_decline':
        console.log('[router] dispatching to handleRespondSwap (decline)');
        await handleRespondSwap(message, contact, classification.extracted, 'decline');
        break;

      case 'approve_swap':
        console.log('[router] dispatching to handleApproveSwap');
        await handleApproveSwap(message, contact, classification.extracted);
        break;

      case 'deny_swap':
        console.log('[router] dispatching to handleDenySwap');
        await handleDenySwap(message, contact, classification.extracted);
        break;

      case 'request_emergency_coverage':
        console.log('[router] dispatching to handleEmergencyCoverage');
        await handleEmergencyCoverage(message, contact, classification.extracted);
        break;

      case 'initiate_onboarding':
        console.log('[router] dispatching to handleInitiateOnboarding');
        await handleInitiateOnboarding(message, contact, classification.extracted);
        break;

      case 'update_availability':
        console.log('[router] dispatching to handleUpdateAvailability');
        await handleUpdateAvailability(message, contact, classification.extracted);
        break;

      case 'distribute_schedule':
        console.log('[router] dispatching to handleDistributeSchedule');
        await handleDistributeSchedule(message, contact, classification.extracted);
        break;

      case 'homebase_edit':
        console.log('[router] dispatching to handleHomebaseEdit');
        await handleHomebaseEdit(message, contact, classification.extracted);
        break;

      case 'run_payroll_check':
        console.log('[router] dispatching to handlePayrollCheck');
        await handlePayrollCheck(message, contact, classification.extracted);
        break;

      case 'broadcast_message':
        console.log('[router] dispatching to handleBroadcast');
        await handleBroadcast(message, contact, classification.extracted);
        break;

      case 'notify_day_closure':
        console.log('[router] dispatching to handleNotifyDayClosure');
        await handleNotifyDayClosure(message, contact, classification.extracted);
        break;

      case 'quria_diagnostic':
        console.log('[router] dispatching to quria_diagnostic (stub)');
        await reply(contact, message, 'Quria diagnostic is not yet implemented.');
        break;

      case 'operational_query':
      case 'general_question':
        console.log('[router] dispatching to handleOperationalQuery');
        await handleOperationalQuery(message, contact, classification.extracted);
        break;

      default:
        console.log('[router] dispatching to default (no matching intent)');
        await reply(
          contact,
          message,
          "I didn't quite understand that. Could you rephrase? For help, reply with \"help\"."
        );
    }
  } catch (err) {
    if (err instanceof AnthropicOverloadError) throw err;
    console.error('[router] workflow error:', err);
    await reply(
      contact,
      message,
      'Something went wrong on my end. Please try again in a moment.'
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadCompanyContext(companyId: string): Promise<{ text: string; timezone: string }> {
  const [companyRes, profileRes] = await Promise.all([
    supabase
      .from('companies')
      .select('name, timezone, industry')
      .eq('id', companyId)
      .single(),
    supabase
      .from('company_profiles')
      .select('business_type, description, operating_hours, manager_priorities')
      .eq('company_id', companyId)
      .maybeSingle(),
  ]);

  const company = companyRes.data;
  const profile = profileRes.data;

  const timezone = company?.timezone ?? 'America/New_York';

  const lines = [
    `Company: ${company?.name ?? 'Unknown'} (timezone: ${timezone})`,
  ];
  if (company?.industry) lines.push(`Industry: ${company.industry}`);
  if (profile?.business_type) lines.push(`Business type: ${profile.business_type}`);
  if (profile?.operating_hours) lines.push(`Operating hours: ${profile.operating_hours}`);
  if (profile?.manager_priorities) lines.push(`Manager priorities: ${profile.manager_priorities}`);

  return { text: lines.join('\n'), timezone };
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
