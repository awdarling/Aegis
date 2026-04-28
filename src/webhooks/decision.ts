import { Router } from 'express';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import { executeScheduleSwap } from '../workflows/shift-swap';
import { computeWageEstimate } from '../lib/schedule-simulator';
import type { Employee } from '../db/types';

export const decisionWebhook = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

// Time-off token — decision_type is always normalised to 'time_off' on parse
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
  expires_at: string;
}

type DecisionToken = TimeOffDecisionToken | SwapDecisionToken;

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
    await sendEmail({
      to: token.employee_contact,
      subject: `Your time-off request has been ${verb}`,
      text: messageText,
      company_id: token.company_id,
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
    const { data: schedRow } = await supabase.from('schedules').select('id, data')
      .eq('company_id', token.company_id).eq('status', 'published')
      .lte('week_start', token.shift_date).gte('week_end', token.shift_date)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();

    if (schedRow && receiver) {
      const row = schedRow as { id: string; data: { shifts: unknown[] } };
      await executeScheduleSwap(
        token.company_id, row.id, token.shift_date, token.shift_name,
        token.requester_id, token.receiver_id, token.receiver_name
      );
    }

    // Notify both employees
    const approvedMsg = (name: string, role: string) =>
      `Your shift swap has been approved! ${name} will cover the ${token.shift_name} (${role}) shift on ${new Date(token.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`;

    if (requester?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: requester.contact_phone, from: token.aegis_sms_channel, body: approvedMsg(token.receiver_name, token.role), company_id: token.company_id });
    } else if (requester?.contact_email) {
      await sendEmail({ to: requester.contact_email, subject: 'Swap approved', text: approvedMsg(token.receiver_name, token.role), company_id: token.company_id });
    }
    if (receiver?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: receiver.contact_phone, from: token.aegis_sms_channel, body: approvedMsg(token.requester_name, token.role), company_id: token.company_id });
    }
  } else {
    // Denied — notify both
    const deniedMsg = `Your shift swap request for the ${token.shift_name} shift on ${new Date(token.shift_date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} has been denied by your manager. Please contact them if you have questions.`;
    if (requester?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: requester.contact_phone, from: token.aegis_sms_channel, body: deniedMsg, company_id: token.company_id });
    } else if (requester?.contact_email) {
      await sendEmail({ to: requester.contact_email, subject: 'Swap denied', text: deniedMsg, company_id: token.company_id });
    }
    if (receiver?.contact_phone && token.aegis_sms_channel) {
      await sendSms({ to: receiver.contact_phone, from: token.aegis_sms_channel, body: deniedMsg, company_id: token.company_id });
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

  // Branch: swap vs time-off
  if (decisionToken.decision_type === 'swap') {
    await handleSwapDecision(res, requestId, action as 'approve' | 'deny', decisionToken);
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
