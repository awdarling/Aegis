import { Router } from 'express';
import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { sendEmail } from '../messaging/email';
import { sendSms } from '../messaging/sms';
import type { Employee } from '../db/types';

export const decisionWebhook = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface DecisionToken {
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

// ── Employee notification ─────────────────────────────────────────────────────

async function notifyEmployee(
  token: DecisionToken,
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
    decisionToken = JSON.parse(row.content) as DecisionToken;
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
