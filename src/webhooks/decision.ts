import { Router } from 'express';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { normalizeReSubject } from '../messaging/reply';
import { executeScheduleSwap, executeScheduleTrade } from '../workflows/shift-swap';
import { processCoverageButtonDecision, processCoverageBatchButton } from '../workflows/emergency-coverage';
import { computeWageEstimate } from '../lib/schedule-simulator';
import type { Employee } from '../db/types';

export const decisionWebhook = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

// Time-off token — decision_type is always normalised to 'time_off' on parse.
// thread_id/raw_subject carry the inbound email's Message-ID and Subject so
// the approve/deny notice to the employee threads back into the original
// conversation. Both are null for SMS submissions.
interface TimeOffDecisionToken {
  decision_type: 'time_off';
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  employee_id: string;
  employee_name: string;
  employee_channel: 'sms' | 'email';
  employee_contact: string;
  aegis_sms_channel: string | null;
  thread_id?: string | null;
  raw_subject?: string | null;
  expires_at: string;
}

// Swap token
interface SwapDecisionToken {
  decision_type: 'swap';
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  requester_id: string;
  requester_name: string;
  requester_channel: 'sms' | 'email';
  requester_contact: string;
  aegis_sms_channel: string | null;
  receiver_id: string;
  receiver_name: string;
  shift_date: string;
  shift_name: string;
  role: string;
  // Two-way trade (item 18): the target's shift the requester takes in return.
  // Present → execute a true trade; absent → legacy one-way reassignment.
  target_shift_date?: string | null;
  target_shift_name?: string | null;
  target_role?: string | null;
  target_shift_start?: string | null;
  target_shift_end?: string | null;
  expires_at: string;
}

// Coverage token — emergency-coverage Accept/Decline buttons. action is
// 'approve' (= accept the shift) | 'deny' (= decline), reusing the route's
// existing action vocabulary. The live outreach is looked up fresh by
// company_id + employee_id, so the token only needs identity + expiry.
interface CoverageDecisionToken {
  decision_type: 'coverage';
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  employee_id: string;
  employee_name: string;
  expires_at: string;
}

// Coverage "send another batch?" token (#11) — the MANAGER's button on the
// next-batch prompt. action 'approve' = send the next batch | 'deny' = stop.
// The live session is looked up fresh by company_id + manager_contact.
interface CoverageBatchDecisionToken {
  decision_type: 'coverage_batch';
  action: 'approve' | 'deny';
  request_id: string;
  company_id: string;
  manager_contact: string;
  expires_at: string;
}

type DecisionToken = TimeOffDecisionToken | SwapDecisionToken | CoverageDecisionToken | CoverageBatchDecisionToken;

// ── HTML response helpers ─────────────────────────────────────────────────────

function confirmationPage(employeeName: string, action: 'approve' | 'deny'): string {
  const verb = action === 'approve' ? 'approved' : 'denied';
  const color = action === 'approve' ? '#16a34a' : '#dc2626';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Decision Recorded — Aegis</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 8px; padding: 40px; max-width: 400px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    .icon { font-size: 48px; }
    h1 { font-size: 22px; margin: 16px 0 8px; color: ${color}; }
    p { color: #6b7280; font-size: 15px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${action === 'approve' ? '✅' : '❌'}</div>
    <h1>Decision Recorded</h1>
    <p>Request ${verb}. Aegis has notified ${employeeName}.</p>
  </div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Error — Aegis</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 8px; padding: 40px; max-width: 400px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    h1 { font-size: 20px; color: #dc2626; }
    p { color: #6b7280; font-size: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Unable to Process</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

// ── Time-off notification ─────────────────────────────────────────────────────

async function notifyEmployee(
  token: TimeOffDecisionToken,
  employee: Employee,
  action: 'approve' | 'deny'
): Promise<void> {
  const verb = action === 'approve' ? 'approved' : 'denied';
  const messageText =
    action === 'approve'
      ? `Great news! Your time-off request has been approved. Enjoy your time off!`
      : `Your time-off request has been denied. Please contact your manager if you have questions or would like to discuss alternatives.`;

  if (token.employee_channel === 'sms' && token.aegis_sms_channel) {
    await sendSms({
      to: token.employee_contact,
      from: token.aegis_sms_channel,
      body: messageText,
      company_id: token.company_id,
    });
  } else if (token.employee_channel === 'email') {
    const subject = token.raw_subject
      ? normalizeReSubject(token.raw_subject)
      : `Your time-off request has been ${verb}`;
    await sendEmail({
      to: token.employee_contact,
      subject,
      text: messageText,
      company_id: token.company_id,
      thread_id: token.thread_id ?? undefined,
    });
  }
}

// ── Swap decision handler ─────────────────────────────────────────────────────

async function handleSwapDecision(
  res: import('express').Response,
  requestId: string,
  action: 'approve' | 'deny',
  token: SwapDecisionToken
): Promise<void> {
  // Load swap request
  const { data: swapRow, error: swapError } = await supabase
    .from('swap_requests')
    .select('*')
    .eq('id', requestId)
    .eq('company_id', token.company_id)
    .single();

  if (swapError || !swapRow) {
    res.status(404).send(errorPage('Swap request not found. It may have already been processed.'));
    return;
  }

  const swap = swapRow as {
    id: string; status: string; requesting_employee_id: string; receiving_employee_id: string | null;
    shift_date: string; shift_name: string; role: string;
  };

  if (swap.status !== 'pending_manager') {
    res.status(409).send(errorPage(`This swap has already been ${swap.status}. No further action is needed.`));
    return;
  }

  // Load both employee records
  const [requesterRes, receiverRes] = await Promise.all([
    supabase.from('employees').select('*').eq('id', token.requester_id).single(),
    supabase.from('employees').select('*').eq('id', token.receiver_id).single(),
  ]);

  const requester = requesterRes.data as Employee | null;
  const receiver = receiverRes.data as Employee | null;

  // Update swap_request status
  await supabase.from('swap_requests').update({
    status: action === 'approve' ? 'approved' : 'denied',
    decided_at: new Date().toISOString(),
    decided_by: 'manager',
  }).eq('id', requestId);

  // Consume both sibling tokens
  await consumeSwapTokens(token.company_id, requestId);

  if (action === 'approve') {
    // Find the schedule covering this shift date
    const { data: schedRow } = await supabase.from('schedules').select('id, data').is('deleted_at', null)
      .eq('company_id', token.company_id).eq('status', 'published')
      .lte('week_start', token.shift_date).gte('week_end', token.shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();

    const isTrade = !!(token.target_shift_name && token.target_shift_date);
    if (schedRow && receiver) {
      const row = schedRow as { id: string; data: { assignments: unknown[] } };
      if (isTrade) {
        // True two-way trade: the requester and target switch shifts.
        await executeScheduleTrade(
          token.company_id, row.id,
          { date: token.shift_date, shift_name: token.shift_name, employee_id: token.requester_id, employee_name: token.requester_name },
          { date: token.target_shift_date!, shift_name: token.target_shift_name!, employee_id: token.receiver_id, employee_name: token.receiver_name },
        );
      } else {
        await executeScheduleSwap(
          token.company_id, row.id, token.shift_date, token.shift_name,
          token.requester_id, token.receiver_id, token.receiver_name
        );
      }
    }

    // Notify both employees — for a trade, each person hears the shift they now work.
    const dateLong = new Date(token.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const targetDateLong = token.target_shift_date
      ? new Date(token.target_shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : dateLong;
    const approvedMsg = (name: string, role: string) =>
      `Your shift swap has been approved! ${name} will cover the ${token.shift_name} (${role}) shift on ${dateLong}.`;
    const tradeMsg = (worksShift: string, worksDate: string) =>
      `Your shift trade has been approved! You're now on the ${worksShift} shift on ${worksDate}.`;

    const requesterMsg = isTrade ? tradeMsg(token.target_shift_name!, targetDateLong) : approvedMsg(token.receiver_name, token.role);
    const receiverMsg = isTrade ? tradeMsg(token.shift_name, dateLong) : approvedMsg(token.requester_name, token.role);
    const subj = isTrade ? 'Shift trade approved' : 'Swap approved';

    if (requester?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: requester.contact_phone, from: token.aegis_sms_channel, body: requesterMsg, company_id: token.company_id });
    } else if (requester?.contact_email) {
      await sendEmail({ to: requester.contact_email, subject: subj, text: requesterMsg, company_id: token.company_id });
    }
    if (receiver?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: receiver.contact_phone, from: token.aegis_sms_channel, body: receiverMsg, company_id: token.company_id });
    } else if (receiver?.contact_email) {
      await sendEmail({ to: receiver.contact_email, subject: subj, text: receiverMsg, company_id: token.company_id });
    }
  } else {
    // Denied — notify both
    const isTrade = !!(token.target_shift_name && token.target_shift_date);
    const deniedMsg = `Your shift ${isTrade ? 'trade' : 'swap'} request for the ${token.shift_name} shift on ${new Date(token.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} has been denied by your manager. Please contact them if you have questions.`;
    const subj = isTrade ? 'Shift trade denied' : 'Swap denied';
    if (requester?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: requester.contact_phone, from: token.aegis_sms_channel, body: deniedMsg, company_id: token.company_id });
    } else if (requester?.contact_email) {
      await sendEmail({ to: requester.contact_email, subject: subj, text: deniedMsg, company_id: token.company_id });
    }
    if (receiver?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: receiver.contact_phone, from: token.aegis_sms_channel, body: deniedMsg, company_id: token.company_id });
    } else if (receiver?.contact_email) {
      await sendEmail({ to: receiver.contact_email, subject: subj, text: deniedMsg, company_id: token.company_id });
    }
  }

  await logActivity({
    company_id: token.company_id,
    action: `swap_${action}d`,
    entity_type: 'swap_request',
    entity_id: requestId,
    summary: `Swap between ${token.requester_name} and ${token.receiver_name} ${action}d by manager via email`,
    metadata: { requester_id: token.requester_id, receiver_id: token.receiver_id, shift_date: token.shift_date, shift_name: token.shift_name },
  });

  res.send(confirmationPage(`${token.requester_name} & ${token.receiver_name}`, action));
}

async function consumeSwapTokens(companyId: string, requestId: string): Promise<void> {
  const { data: rows } = await supabase.from('aegis_memory').select('id, content')
    .eq('company_id', companyId).like('source', 'decision_token:%');
  if (!rows) return;
  const ids = (rows as { id: string; content: string }[])
    .filter(r => { try { return (JSON.parse(r.content) as { request_id?: string }).request_id === requestId; } catch { return false; } })
    .map(r => r.id);
  if (ids.length > 0) await supabase.from('aegis_memory').delete().in('id', ids);
}

// ── Coverage Accept/Decline (decision_type: 'coverage') ───────────────────────

function coverageResultPage(employeeName: string, outcome: 'accepted' | 'declined' | 'already_filled' | 'not_found', shiftName: string): string {
  const map = {
    accepted: { icon: '✅', color: '#16a34a', title: "You're covered in", body: `Thanks, ${employeeName}! You're confirmed for the ${shiftName} shift. Your manager has been notified.` },
    declined: { icon: '👍', color: '#6b7280', title: 'Thanks for letting us know', body: `No problem, ${employeeName} — we'll find someone else for the ${shiftName} shift.` },
    already_filled: { icon: 'ℹ️', color: '#2563eb', title: 'Already covered', body: `Thanks for responding! The ${shiftName} shift has already been filled — no action needed.` },
    not_found: { icon: '⌛', color: '#dc2626', title: 'No longer active', body: `This coverage request is no longer active. If you think that's a mistake, reply to the email or contact your manager.` },
  }[outcome];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Coverage — Aegis</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 8px; padding: 40px; max-width: 420px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    .icon { font-size: 48px; }
    h1 { font-size: 22px; margin: 16px 0 8px; color: ${map.color}; }
    p { color: #6b7280; font-size: 15px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${map.icon}</div>
    <h1>${map.title}</h1>
    <p>${map.body}</p>
  </div>
</body>
</html>`;
}

async function handleCoverageDecision(
  res: import('express').Response,
  requestId: string,
  action: 'approve' | 'deny',
  token: CoverageDecisionToken,
): Promise<void> {
  const result = await processCoverageButtonDecision({
    companyId: token.company_id,
    employeeId: token.employee_id,
    employeeName: token.employee_name,
    action: action === 'approve' ? 'accept' : 'decline',
  });
  // Single-use: drop both of this request's tokens so the link can't be replayed.
  await consumeSwapTokens(token.company_id, requestId);
  res.send(coverageResultPage(token.employee_name, result.outcome, result.shiftName));
}

// ── Coverage "send another batch?" (decision_type: 'coverage_batch') ──────────

function coverageBatchResultPage(outcome: 'sent' | 'stopped' | 'exhausted' | 'not_found', shiftName: string): string {
  const map = {
    sent: { icon: '📣', color: '#16a34a', title: 'On it', body: `I'm reaching out to the next batch of employees for the ${shiftName} shift. I'll let you know the moment someone accepts.` },
    stopped: { icon: '👍', color: '#6b7280', title: "Got it", body: `I'll leave the ${shiftName} shift with you. Reply any time if you'd like me to find more coverage.` },
    exhausted: { icon: 'ℹ️', color: '#2563eb', title: 'Everyone contacted', body: `I've now reached everyone qualified and available for the ${shiftName} shift. You'll need to contact staff directly.` },
    not_found: { icon: '⌛', color: '#dc2626', title: 'No longer active', body: `This coverage request is no longer active. If you think that's a mistake, reply to the email or contact Aegis directly.` },
  }[outcome];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Coverage — Aegis</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 8px; padding: 40px; max-width: 420px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    .icon { font-size: 48px; }
    h1 { font-size: 22px; margin: 16px 0 8px; color: ${map.color}; }
    p { color: #6b7280; font-size: 15px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${map.icon}</div>
    <h1>${map.title}</h1>
    <p>${map.body}</p>
  </div>
</body>
</html>`;
}

async function handleCoverageBatchDecision(
  res: import('express').Response,
  requestId: string,
  action: 'approve' | 'deny',
  token: CoverageBatchDecisionToken,
): Promise<void> {
  const result = await processCoverageBatchButton({
    companyId: token.company_id,
    managerContact: token.manager_contact,
    action: action === 'approve' ? 'send' : 'stop',
  });
  // Single-use: drop both of this request's tokens so the link can't be replayed.
  await consumeSwapTokens(token.company_id, requestId);
  res.send(coverageBatchResultPage(result.outcome, result.shiftName));
}

// ── Route handler ─────────────────────────────────────────────────────────────

decisionWebhook.get('/', async (req, res) => {
  const { action, requestId, token } = req.query as Record<string, string>;

  // Validate required params
  if (!action || !requestId || !token) {
    res.status(400).send(errorPage('Invalid or missing parameters. This link may be malformed.'));
    return;
  }

  if (action !== 'approve' && action !== 'deny') {
    res.status(400).send(errorPage('Unknown action. Please use the links from your Aegis email.'));
    return;
  }

  // Look up the decision token in aegis_memory
  const { data: tokenData } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .eq('source', `decision_token:${token}`)
    .maybeSingle();

  if (!tokenData) {
    res
      .status(404)
      .send(
        errorPage(
          'This link has already been used or has expired. If you need to change a decision, please contact Aegis directly.'
        )
      );
    return;
  }

  let decisionToken: DecisionToken;
  try {
    const row = tokenData as { id: string; content: string };
    // Normalise: tokens stored before swap support have no decision_type — default to 'time_off'
    const raw = JSON.parse(row.content) as Record<string, unknown>;
    decisionToken = { decision_type: 'time_off', ...raw } as DecisionToken;
  } catch {
    res.status(500).send(errorPage('An internal error occurred. Please try again.'));
    return;
  }

  // Check expiry
  if (new Date(decisionToken.expires_at) < new Date()) {
    await supabase
      .from('aegis_memory')
      .delete()
      .eq('source', `decision_token:${token}`);
    res.status(410).send(errorPage('This link has expired. Please ask the employee to resubmit their request.'));
    return;
  }

  // Verify requestId matches token
  if (decisionToken.request_id !== requestId) {
    res.status(400).send(errorPage('This link does not match the request. Please use the links from your Aegis email.'));
    return;
  }

  // Verify action matches token (each token has a fixed action)
  if (decisionToken.action !== action) {
    res.status(400).send(errorPage('Action mismatch. Please use the correct Approve or Deny button from your email.'));
    return;
  }

  // Branch: swap vs coverage vs time-off
  if (decisionToken.decision_type === 'swap') {
    await handleSwapDecision(res, requestId, action as 'approve' | 'deny', decisionToken);
    return;
  }

  if (decisionToken.decision_type === 'coverage') {
    await handleCoverageDecision(res, requestId, action as 'approve' | 'deny', decisionToken);
    return;
  }

  if (decisionToken.decision_type === 'coverage_batch') {
    await handleCoverageBatchDecision(res, requestId, action as 'approve' | 'deny', decisionToken);
    return;
  }

  // Look up the time-off request
  const { data: torData, error: torError } = await supabase
    .from('time_off_requests')
    .select('*')
    .eq('id', requestId)
    .eq('company_id', decisionToken.company_id)
    .single();

  if (torError || !torData) {
    res.status(404).send(errorPage('Time-off request not found. It may have already been processed.'));
    return;
  }

  const tor = torData as { id: string; status: string; employee_id: string; start_date: string; end_date: string; reason: string | null };

  if (tor.status !== 'pending') {
    res
      .status(409)
      .send(
        errorPage(
          `This request has already been ${tor.status}. No further action is needed.`
        )
      );
    return;
  }

  // Load employee record for notification
  const { data: empData } = await supabase
    .from('employees')
    .select('*')
    .eq('id', decisionToken.employee_id)
    .eq('company_id', decisionToken.company_id)
    .single();

  const employee = empData as Employee | null;

  // Update time_off_requests status
  await supabase
    .from('time_off_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'denied',
      decided_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  // Consume the token — delete both approve and deny tokens for this request
  await supabase
    .from('aegis_memory')
    .delete()
    .like('source', 'decision_token:%')
    .eq('content', JSON.stringify({ ...decisionToken }));

  // Also clean up the sibling token by querying for the same request_id
  const { data: siblingTokens } = await supabase
    .from('aegis_memory')
    .select('id, content')
    .like('source', 'decision_token:%')
    .eq('company_id', decisionToken.company_id);

  if (siblingTokens) {
    const siblings = (siblingTokens as { id: string; content: string }[]).filter(row => {
      try {
        const parsed = JSON.parse(row.content) as { request_id?: string };
        return parsed.request_id === requestId;
      } catch {
        return false;
      }
    });
    if (siblings.length > 0) {
      await supabase
        .from('aegis_memory')
        .delete()
        .in('id', siblings.map(s => s.id));
    }
  }

  // Log the decision
  await logActivity({
    company_id: decisionToken.company_id,
    action: `time_off_${action}d`,
    entity_type: 'time_off_request',
    entity_id: requestId,
    summary: `Time-off request for ${decisionToken.employee_name} ${action}d via email link`,
    metadata: {
      employee_id: decisionToken.employee_id,
      start_date: tor.start_date,
      end_date: tor.end_date,
      reason: tor.reason,
    },
  });

  // Record a pattern in aegis_memory for future reference
  await supabase.from('aegis_memory').insert({
    company_id: decisionToken.company_id,
    memory_type: 'pattern',
    source: 'time_off_decision_history',
    content: JSON.stringify({
      employee_id: decisionToken.employee_id,
      employee_name: decisionToken.employee_name,
      action,
      start_date: tor.start_date,
      end_date: tor.end_date,
      reason: tor.reason,
      decided_at: new Date().toISOString(),
    }),
  });

  // Notify employee
  if (employee) {
    try {
      await notifyEmployee(decisionToken, employee, action);
    } catch (err) {
      console.error('[decision] employee notification failed:', err);
    }
  }

  // Return HTML confirmation page to the manager's browser
  const employeeName = decisionToken.employee_name;
  res.send(confirmationPage(employeeName, action));
});
