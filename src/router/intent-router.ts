import { classifyIntent, AnthropicOverloadError } from '../ai/claude';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { supabase } from '../db/client';
import type { InboundMessage, VerifiedContact } from '../security/types';
import { parseYesNo } from '../utils/yes-no';

// Workflow handlers
import {
  handleSubmitTimeOff,
  handleApproveTimeOff,
  handleDenyTimeOff,
  handlePendingTimeOffConfirmation,
  handleQueryMyTimeOff,
  handleRecheckTimeOff,
  getPendingTimeOff,
} from '../workflows/time-off';
import { handleBuildSchedule, handleDistributeSchedule } from '../workflows/schedule-build';
import {
  handleOperationalQuery,
  handleMyShiftsQuery,
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
  routeManagerCoverageReply,
  handleEmployeeCoverageResponse,
  getActiveOutreach,
} from '../workflows/emergency-coverage';
import { handlePayrollCheck } from '../workflows/payroll';
import {
  getOnboardingSession,
  getOnboardingSessionByPhone,
  getOnboardingSessionByEmail,
  handleOnboardingResponse,
  handleInitiateOnboarding,
  handleAddEmployee,
  getPendingAvailConfirm,
  handleAvailabilityConfirmResponse,
  handleUpdateAvailability,
  getPendingManagerAvailApproval,
  handleManagerAvailabilityApproval,
  getOnboardingFanoutPending,
  handleOnboardingFanoutConfirm,
  getPendingIntentSwitch,
  clearPendingIntentSwitch,
  clearPendingAvailConfirm,
  buildAvailChangeConfirmBody,
  classifyAffirmation,
  classifySwitchReply,
  handleMyAvailabilityQuery,
  getPendingAvailTargetDisambig,
  clearPendingAvailTargetDisambig,
  classifyAvailTarget,
} from '../workflows/employee-onboarding';
import {
  handleBroadcast,
  handleBroadcastConfirmation,
  getActiveBroadcastSession,
} from '../workflows/broadcast';
import { handleNotifyDayClosure } from '../workflows/day-closure';
import { buildCapabilitiesReply, allowedActionsLine, isCapabilitiesQuery, type CapabilityRole } from './capabilities';

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
  'add_employee',
  'homebase_edit',
  'run_payroll_check',
  'notify_day_closure',
  'recheck_time_off',
]);

// Intents available only to quria_admin — managers attempting these are blocked.
// broadcast_message is NOT here: managers may broadcast to their OWN company
// (Batch-1 F4); handleBroadcast scopes targeting by role (managers-only targeting
// stays a quria-admin action).
const QURIA_ONLY_INTENTS = new Set([
  'quria_diagnostic',
]);

// ── Main router ───────────────────────────────────────────────────────────────

// Availability approval is inbox-only (batch 2c): only an email yes/no reply (or
// the email buttons, handled elsewhere) applies a decision. SMS replies and
// non-decision messages (e.g. a fresh call-out) must NOT be captured by the
// pending availability prompt.
export function shouldProcessAvailApprovalReply(channel: 'sms' | 'email', body: string): boolean {
  return channel === 'email' && parseYesNo(body) !== 'unclear';
}

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
          ? "Sorry — I'm a little swamped at the moment and couldn't get to that. Give me a couple of minutes and send it again?"
          : "Sorry about that — I'm under heavy load right now and couldn't finish your request. Nothing went through, so give it 2-3 minutes and resend and I'll take care of it.";
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
  // Pre-classification pending-session handling runs before the dispatch
  // try/catch below. Wrap it so an unexpected throw here surfaces a graceful
  // reply instead of escaping to routeIntent's overload-only catch and dying
  // silently (no reply to the sender).
  try {
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

  // Deterministic capabilities short-circuit. A standalone "what can you do?"
  // must ALWAYS get the role-aware capabilities reply, regardless of prior
  // conversational context. It runs AFTER the onboarding-session lookups above
  // (a guided onboarding flow keeps its own handling) but BEFORE every other
  // pending-state handler, because those handlers otherwise swallow it: the live
  // bug was a manager with an open emergency-coverage session ("awaiting_names")
  // whose "What can you do?" was read as a decline and punted with "I'll leave it
  // with you…". The LLM classifier is also unreliable here once context exists,
  // so we never rely on it for this.
  if (isCapabilitiesQuery(message.body)) {
    console.log('[router] deterministic capabilities short-circuit');
    await reply(
      contact,
      message,
      buildCapabilitiesReply(contact.role as CapabilityRole, contact.name)
    );
    return;
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

    // A pending "want to switch to a different request?" offer takes priority
    // over the availability-confirm loop it interrupted. YES resumes the original
    // request; NO keeps the availability change; anything else falls through to
    // the availability-confirm handler below (which may re-offer or apply a real
    // correction).
    const pendingSwitch = await getPendingIntentSwitch(contact.company_id, contact.employee_id);
    if (pendingSwitch) {
      const decision = classifyAffirmation(message.body);
      if (decision === 'yes') {
        await clearPendingIntentSwitch(contact.company_id, contact.employee_id);
        await clearPendingAvailConfirm(contact.company_id, contact.employee_id);
        const resumed: InboundMessage = { ...message, body: pendingSwitch.interrupting_body };
        console.log('[router] intent switch confirmed → resuming interrupted request');
        await routeIntentInner(resumed, contact);
        return;
      }
      if (decision === 'no') {
        await clearPendingIntentSwitch(contact.company_id, contact.employee_id);
        const avail = await getPendingAvailConfirm(contact.company_id, contact.employee_id);
        if (avail) {
          await reply(
            contact,
            message,
            `No problem — keeping your availability update. ${buildAvailChangeConfirmBody(avail.proposed_availability, { customEndDate: avail.custom_end_date ?? null })}`
          );
        } else {
          await reply(contact, message, `No problem. What would you like to do?`);
        }
        console.log('[router] EARLY RETURN', { reason: 'intent_switch_declined' });
        return;
      }
      // Deterministic fast-path couldn't decide (a clean yes/no is free; this reply
      // wasn't one). Spend ONE small classification so a natural "yea, I want to
      // switch" isn't misread as ambiguous. Only genuinely unclear replies fall
      // through to the availability-confirm handler below.
      const smart = await classifySwitchReply(message.body, pendingSwitch.intent);
      if (smart === 'switch') {
        await clearPendingIntentSwitch(contact.company_id, contact.employee_id);
        await clearPendingAvailConfirm(contact.company_id, contact.employee_id);
        const resumed: InboundMessage = { ...message, body: pendingSwitch.interrupting_body };
        console.log('[router] intent switch confirmed (llm) → resuming interrupted request');
        await routeIntentInner(resumed, contact);
        return;
      }
      if (smart === 'keep') {
        await clearPendingIntentSwitch(contact.company_id, contact.employee_id);
        const availKeep = await getPendingAvailConfirm(contact.company_id, contact.employee_id);
        if (availKeep) {
          await reply(
            contact,
            message,
            `No problem — keeping your availability update. ${buildAvailChangeConfirmBody(availKeep.proposed_availability, { customEndDate: availKeep.custom_end_date ?? null })}`
          );
        } else {
          await reply(contact, message, `No problem. What would you like to do?`);
        }
        console.log('[router] EARLY RETURN', { reason: 'intent_switch_declined_llm' });
        return;
      }
      // Still genuinely unclear: drop the offer and let the availability-confirm
      // handler below interpret this message (a real correction applies; a fresh
      // different-intent re-offers).
      await clearPendingIntentSwitch(contact.company_id, contact.employee_id);
    }

    // F7 — a pending "normal or temporary?" disambiguation. A clear answer replays
    // the original change against the chosen target; an unclear reply drops the
    // offer and falls through (so a pivot to a different request isn't trapped).
    const pendingAvailTarget = await getPendingAvailTargetDisambig(contact.company_id, contact.employee_id);
    if (pendingAvailTarget) {
      const choice = classifyAvailTarget(message.body);
      if (choice === 'normal' || choice === 'temporary') {
        await clearPendingAvailTargetDisambig(contact.company_id, contact.employee_id);
        const replay: InboundMessage = { ...message, body: pendingAvailTarget.original_body };
        const extractedTarget: Record<string, unknown> = choice === 'temporary'
          ? { avail_target: 'temporary', end_date: pendingAvailTarget.override_end_date ?? '' }
          : { avail_target: 'normal' };
        await handleUpdateAvailability(replay, contact, extractedTarget);
        console.log('[router] EARLY RETURN', { reason: `avail_target_resolved_${choice}` });
        return;
      }
      // Unclear → drop the disambiguation and let this message route fresh.
      await clearPendingAvailTargetDisambig(contact.company_id, contact.employee_id);
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
    // Broadcast confirmation session — managers and quria admins both broadcast
    // (Batch-1 F4), so both need their YES/NO confirmation caught here.
    const broadcastSession = await getActiveBroadcastSession(
      contact.company_id,
      contact.matched_identifier
    );
    if (broadcastSession) {
      await handleBroadcastConfirmation(message, contact, broadcastSession);
      console.log('[router] EARLY RETURN', { reason: 'broadcast_confirmation' });
      return;
    }

    const pendingEdit = await getPendingEdit(contact.company_id, contact.matched_identifier);
    if (pendingEdit) {
      await handleEditConfirmation(message, contact, pendingEdit);
      console.log('[router] EARLY RETURN', { reason: 'pending_homebase_edit' });
      return;
    }

    // D19 — a manager may have several call-outs open at once; the router asks
    // coverage which one this reply belongs to (and to disambiguate if needed).
    const handledCoverage = await routeManagerCoverageReply(message, contact);
    if (handledCoverage) {
      console.log('[router] EARLY RETURN', { reason: 'manager_coverage_reply' });
      return;
    }

    // Availability approval is INBOX-ONLY (batch 2c): a manager decides via the
    // email Approve/Deny buttons, or by replying yes/no to that email — never
    // over SMS (an employment action must not ride an SMS reply), and a message
    // that isn't a clear yes/no (e.g. a fresh call-out) must fall through to its
    // real intent instead of being swallowed by the pending prompt.
    const pendingAvailApproval = await getPendingManagerAvailApproval(contact.company_id);
    if (pendingAvailApproval && shouldProcessAvailApprovalReply(message.channel, message.body)) {
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
  } catch (err) {
    if (err instanceof AnthropicOverloadError) throw err;
    console.error('[router] pre-classification handler error:', err);
    await reply(contact, message, "Something went wrong on my end and I couldn't finish that — could you send your request again with the details? I may have lost the thread on that one.");
    return;
  }

  // Classify intent — each role gets its own allowed intent list
  const { text: companyContext, timezone: companyTimezone } = await loadCompanyContext(contact.company_id);
  const classification = await classifyIntent(message.body, contact.role, companyContext, companyTimezone);

  console.log('[router] classified', {
    intent: classification.intent,
    confidence: classification.confidence,
    extracted: classification.extracted,
  });

  // Authorization: employee attempting a manager-only action. Don't dead-end —
  // kindly explain it's a manager call, then name what they CAN ask for (the
  // same canonical list the capabilities reply uses).
  if (contact.role === 'employee' && MANAGER_ONLY_INTENTS.has(classification.intent)) {
    await logSecurityUnauthorized(message, contact);
    await reply(
      contact,
      message,
      `Ah, that one's a manager call — they can get it sorted for you. Happy to help with anything on your end, though: ${allowedActionsLine('employee')}. Just say the word — or ask me "what can you do?" and I'll lay out everything I can do for you.`
    );
    return;
  }

  // Authorization: manager attempting a quria-only action
  if (contact.role === 'manager' && QURIA_ONLY_INTENTS.has(classification.intent)) {
    await reply(contact, message, "That one's reserved for a Quria administrator, sorry — reach out to them and they can take it from here.");
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

      case 'query_my_shifts':
        console.log('[router] dispatching to handleMyShiftsQuery');
        await handleMyShiftsQuery(message, contact, classification.extracted);
        break;

      case 'query_my_time_off':
        console.log('[router] dispatching to handleQueryMyTimeOff');
        await handleQueryMyTimeOff(message, contact, classification.extracted);
        break;

      case 'query_my_availability':
        console.log('[router] dispatching to handleMyAvailabilityQuery');
        await handleMyAvailabilityQuery(message, contact, classification.extracted);
        break;

      case 'approve_time_off':
        console.log('[router] dispatching to handleApproveTimeOff');
        await handleApproveTimeOff(message, contact, classification.extracted);
        break;

      case 'deny_time_off':
        console.log('[router] dispatching to handleDenyTimeOff');
        await handleDenyTimeOff(message, contact, classification.extracted);
        break;

      case 'recheck_time_off':
        console.log('[router] dispatching to handleRecheckTimeOff');
        await handleRecheckTimeOff(message, contact, classification.extracted);
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

      case 'add_employee':
        console.log('[router] dispatching to handleAddEmployee');
        await handleAddEmployee(message, contact, classification.extracted);
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

      case 'capabilities':
        console.log('[router] dispatching to capabilities (role-aware help)');
        await reply(
          contact,
          message,
          buildCapabilitiesReply(contact.role as CapabilityRole, contact.name)
        );
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
          "Hmm, I didn't quite follow that one — mind putting it another way? And if you're not sure what I can do for you, just ask \"what can you do?\" and I'll walk you through it."
        );
    }
  } catch (err) {
    if (err instanceof AnthropicOverloadError) throw err;
    console.error('[router] workflow error:', err);
    await reply(
      contact,
      message,
      "Something went wrong on my end and I couldn't finish that — could you send your request again with the details? I may have lost the thread on that one."
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
