import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';
import { reply } from '../messaging/reply';
import { sendEmail } from '../messaging/email';
import { BRAND, brandedEmailShell } from '../messaging/brand';
import { reconcilePayroll } from '../lib/payroll-reconciler';
import { getTimeClockAdapter, getPayrollAdapter } from '../lib/integrations/factory';
import type { ScheduledShift, ReconciliationResult, DiscrepancyRecord } from '../lib/payroll-reconciler';
import type { InboundMessage, VerifiedContact } from '../security/types';

// ── handlePayrollCheck ────────────────────────────────────────────────────────

export async function handlePayrollCheck(
  message: InboundMessage,
  contact: VerifiedContact,
  extracted: Record<string, unknown>
): Promise<void> {
  const companyId = contact.company_id;

  // 1. Load payroll integration config
  const { data: integrationData, error: integrationError } = await supabase
    .from('payroll_integrations')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true)
    .maybeSingle();

  if (integrationError) {
    console.error('[payroll] failed to load payroll_integrations:', integrationError.message);
  }

  if (!integrationData) {
    await reply(
      contact,
      message,
      'No payroll integration configured. Set one up in Homebase under Payroll settings.'
    );
    return;
  }

  const integration = integrationData as {
    id: string;
    pay_period: 'weekly' | 'biweekly' | 'semimonthly';
    last_run_at: string | null;
  };

  // 2. Determine pay period dates
  const { periodStart, periodEnd } = resolvePeriod(extracted, integration);

  // 3. Load scheduled shifts for the period
  const scheduledShifts = await loadScheduledShifts(companyId, periodStart, periodEnd);

  // 4. Load time clock adapter
  const clockAdapter = await getTimeClockAdapter(companyId);
  if (!clockAdapter) {
    await reply(
      contact,
      message,
      'Time clock integration not configured. Set up NorthStar in Homebase.'
    );
    return;
  }

  // 5. Fetch clock records
  let clockRecords;
  try {
    clockRecords = await clockAdapter.fetchClockRecords({ periodStart, periodEnd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[payroll] clock record fetch failed:', msg);
    await logActivity({
      company_id: companyId,
      action: 'payroll_check_clock_fetch_failed',
      summary: `Failed to fetch clock records from time clock integration: ${msg}`,
      metadata: { period_start: periodStart, period_end: periodEnd, error: msg },
    });
    await reply(
      contact,
      message,
      `Failed to fetch clock records: ${msg}. Please check your NorthStar integration settings.`
    );
    return;
  }

  // 6. Load wage rates — individual_wage first, then role-based wage_rates
  const wageRates = await loadWageRates(companyId);

  // 7. Reconcile
  const result = reconcilePayroll({
    companyId,
    periodStart,
    periodEnd,
    scheduledShifts,
    clockRecords,
    wageRates,
  });

  // 8. Update last_run_at
  await supabase
    .from('payroll_integrations')
    .update({ last_run_at: new Date().toISOString() })
    .eq('company_id', companyId);

  // 9. Log to activity_log
  await logActivity({
    company_id: companyId,
    action: 'payroll_check_complete',
    summary: `Payroll check ${periodStart}–${periodEnd}: ${result.clean_count} clean, ${result.issue_count} issues`,
    metadata: {
      period_start: periodStart,
      period_end: periodEnd,
      total_employees: result.total_employees,
      clean_count: result.clean_count,
      issue_count: result.issue_count,
      total_scheduled_hours: result.total_scheduled_hours,
      total_actual_hours: result.total_actual_hours,
      total_hour_variance: result.total_hour_variance,
      estimated_wage_variance: result.estimated_wage_variance,
    },
  });

  // 10/11. Reply
  if (result.issue_count === 0) {
    await reply(
      contact,
      message,
      `Payroll check complete for ${periodStart} to ${periodEnd}. ` +
      `All ${result.total_employees} employees look clean. No discrepancies found.`
    );
    return;
  }

  await reply(
    contact,
    message,
    `Payroll check found ${result.issue_count} issue(s) for ${periodStart}–${periodEnd}. ` +
    `Sending details to your email.`
  );

  const emailHtml = buildReconciliationEmail(result);
  const emailText = buildReconciliationText(result);

  await sendEmail({
    to: message.channel === 'email' ? message.sender : contact.matched_identifier,
    subject: `Payroll Reconciliation — ${periodStart} to ${periodEnd}`,
    text: emailText,
    html: emailHtml,
    company_id: companyId,
    thread_id: message.thread_id,
  });
}

// ── handleWageRateSync ────────────────────────────────────────────────────────

export async function handleWageRateSync(params: {
  companyId: string;
  employeeId: string;
  employeeName: string;
  newRate: number;
  changedBy: string;
}): Promise<void> {
  const { companyId, employeeId, employeeName, newRate, changedBy } = params;

  const adapter = await getPayrollAdapter(companyId);
  if (!adapter) {
    console.log(`[payroll] no payroll adapter for company ${companyId} — skipping wage sync`);
    return;
  }

  const result = await adapter.updateEmployeeWageRate({
    employeeExternalId: employeeId,
    newRate,
    effectiveDate: new Date().toISOString().slice(0, 10),
    reason: `Updated by ${changedBy} via Aegis`,
  });

  if (result.success) {
    await logActivity({
      company_id: companyId,
      action: 'wage_rate_synced',
      entity_type: 'employee',
      entity_id: employeeId,
      summary: `${employeeName}'s wage synced to Engage at $${newRate}/hr`,
      metadata: { employee_name: employeeName, new_rate: newRate, changed_by: changedBy },
    });

    // Notify manager via SMS if aegis_sms_channel exists
    const managerPhone = await getManagerSmsChannel(companyId);
    if (managerPhone) {
      const { sendSms } = await import('../messaging/sms');
      const aegisChannel = await getAegisSmsChannel(companyId);
      if (aegisChannel) {
        await sendSms({
          to: managerPhone,
          from: aegisChannel,
          body: `${employeeName}'s wage updated to $${newRate}/hr in Engage.`,
          company_id: companyId,
        });
      }
    }
  } else {
    await logActivity({
      company_id: companyId,
      action: 'wage_rate_sync_failed',
      entity_type: 'employee',
      entity_id: employeeId,
      summary: `Failed to sync ${employeeName}'s wage to Engage: ${result.message}`,
      metadata: { employee_name: employeeName, new_rate: newRate, reason: result.message },
    });

    const managerPhone = await getManagerSmsChannel(companyId);
    if (managerPhone) {
      const { sendSms } = await import('../messaging/sms');
      const aegisChannel = await getAegisSmsChannel(companyId);
      if (aegisChannel) {
        await sendSms({
          to: managerPhone,
          from: aegisChannel,
          body: `Could not sync ${employeeName}'s wage to Engage: ${result.message}. Please update manually.`,
          company_id: companyId,
        });
      }
    }
  }
}

// ── Period helpers ────────────────────────────────────────────────────────────

function resolvePeriod(
  extracted: Record<string, unknown>,
  integration: { pay_period: 'weekly' | 'biweekly' | 'semimonthly'; last_run_at: string | null }
): { periodStart: string; periodEnd: string } {
  if (typeof extracted.period_start === 'string' && typeof extracted.period_end === 'string') {
    return { periodStart: extracted.period_start, periodEnd: extracted.period_end };
  }

  const today = new Date();
  const periodEnd = today.toISOString().slice(0, 10);

  if (integration.last_run_at) {
    const lastRun = new Date(integration.last_run_at);
    const periodStart = lastRun.toISOString().slice(0, 10);
    return { periodStart, periodEnd };
  }

  // Default: fall back based on pay_period
  const daysBack = integration.pay_period === 'weekly' ? 7 : 14;
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - daysBack);
  return { periodStart: start.toISOString().slice(0, 10), periodEnd };
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadScheduledShifts(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<ScheduledShift[]> {
  const { data, error } = await supabase
    .from('schedules')
    .select('data, week_start, week_end')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .eq('status', 'published')
    .lte('week_start', periodEnd)
    .gte('week_end', periodStart);

  if (error) {
    console.error('[payroll] failed to load schedules:', error.message);
    return [];
  }

  const shifts: ScheduledShift[] = [];

  for (const row of (data ?? []) as Array<{
    data: { assignments?: Array<{
      employee_id: string;
      employee_name: string;
      date: string;
      shift_name: string;
      start_time: string;
      end_time: string;
      hours?: number;
      role: string;
    }>};
    week_start: string;
    week_end: string;
  }>) {
    const rowAssignments = row.data?.assignments ?? [];
    for (const s of rowAssignments) {
      if (s.date >= periodStart && s.date <= periodEnd) {
        const hours = s.hours ?? computeHours(s.start_time, s.end_time);
        shifts.push({
          employee_id: s.employee_id,
          employee_name: s.employee_name,
          date: s.date,
          shift_name: s.shift_name,
          start_time: s.start_time,
          end_time: s.end_time,
          scheduled_hours: hours,
          role: s.role,
        });
      }
    }
  }

  return shifts;
}

function computeHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let minutes = (eh * 60 + em) - (sh * 60 + sm);
  if (minutes < 0) minutes += 24 * 60; // overnight shift
  return Math.round((minutes / 60) * 100) / 100;
}

async function loadWageRates(companyId: string): Promise<Map<string, number>> {
  const wageRates = new Map<string, number>();

  // Load all active employees with individual_wage and primary_role
  const { data: employees } = await supabase
    .from('employees')
    .select('id, primary_role, individual_wage')
    .eq('company_id', companyId)
    .eq('active', true);

  // Load role-based wage rates as fallback
  const { data: roleRates } = await supabase
    .from('wage_rates')
    .select('role, hourly_rate')
    .eq('company_id', companyId);

  const roleRateMap = new Map<string, number>();
  for (const rr of (roleRates ?? []) as Array<{ role: string; hourly_rate: number }>) {
    roleRateMap.set(rr.role, rr.hourly_rate);
  }

  for (const emp of (employees ?? []) as Array<{
    id: string;
    primary_role: string;
    individual_wage: number | null;
  }>) {
    const rate = emp.individual_wage ?? roleRateMap.get(emp.primary_role) ?? 0;
    wageRates.set(emp.id, rate);
  }

  return wageRates;
}

async function getManagerSmsChannel(companyId: string): Promise<string | null> {
  const { data } = await supabase
    .from('users')
    .select('email')
    .eq('company_id', companyId)
    .in('role', ['owner', 'manager'])
    .limit(1)
    .maybeSingle();

  // We look for manager phone in company_channels (sms type, non-Aegis)
  const { data: channels } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', companyId)
    .eq('channel_type', 'sms')
    .limit(1)
    .maybeSingle();

  return (channels as { channel_value: string } | null)?.channel_value ?? null;
}

async function getAegisSmsChannel(companyId: string): Promise<string | null> {
  const { data } = await supabase
    .from('company_channels')
    .select('channel_value')
    .eq('company_id', companyId)
    .eq('channel_type', 'sms')
    .limit(1)
    .maybeSingle();

  return (data as { channel_value: string } | null)?.channel_value ?? null;
}

// ── Email rendering ───────────────────────────────────────────────────────────

function discrepancyBadgeColor(type: string): string {
  switch (type) {
    case 'no_show': return '#dc2626';
    case 'forgot_clock_out': return '#d97706';
    case 'late_clock_in':
    case 'early_clock_out': return '#ea580c';
    case 'early_clock_in':
    case 'late_clock_out': return '#ca8a04';
    case 'unscheduled_shift': return '#7c3aed';
    default: return '#16a34a';
  }
}

function discrepancyLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderIssueCard(r: DiscrepancyRecord): string {
  const badge = `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${discrepancyBadgeColor(r.discrepancy_type)};color:#fff;font-size:12px;font-weight:600;">${discrepancyLabel(r.discrepancy_type)}</span>`;
  const scheduledHrs = r.scheduled_hours !== null ? `${r.scheduled_hours.toFixed(2)} hrs` : '—';
  const actualHrs = r.actual_hours !== null ? `${r.actual_hours.toFixed(2)} hrs` : '—';
  const diff = r.difference >= 0 ? `+${r.difference.toFixed(2)}` : r.difference.toFixed(2);
  const diffColor = r.difference >= 0 ? BRAND.goodText : BRAND.badText;

  return `
<div style="background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};border-radius:8px;padding:16px;margin-bottom:12px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
    <strong style="font-size:15px;color:${BRAND.textPrimary};">${r.employee_name}</strong>
    ${badge}
  </div>
  <div style="font-size:13px;color:${BRAND.textSecondary};margin-bottom:4px;">${r.date}${r.scheduled_shift ? ` · ${r.scheduled_shift}` : ''}</div>
  <div style="display:flex;gap:24px;font-size:13px;margin-bottom:8px;color:${BRAND.textPrimary};">
    <span>Scheduled: <strong>${scheduledHrs}</strong></span>
    <span>Actual: <strong>${actualHrs}</strong></span>
    <span>Variance: <strong style="color:${diffColor};">${diff} hrs</strong></span>
  </div>
  ${r.actual_clock_in || r.actual_clock_out ? `<div style="font-size:12px;color:${BRAND.textMuted};margin-bottom:4px;">Clock in: ${r.actual_clock_in ?? '—'} · Clock out: ${r.actual_clock_out ?? '—'}</div>` : ''}
  <div style="font-size:13px;color:${BRAND.textSecondary};font-style:italic;">${r.notes}</div>
</div>`;
}

function renderCleanRow(r: DiscrepancyRecord): string {
  const hrs = r.actual_hours !== null ? `${r.actual_hours.toFixed(2)} hrs` : '—';
  return `<tr style="background:${BRAND.surface2};"><td style="padding:6px 8px;font-size:13px;color:${BRAND.textPrimary};border-bottom:1px solid ${BRAND.borderDefault};">${r.employee_name}</td><td style="padding:6px 8px;font-size:13px;color:${BRAND.textSecondary};border-bottom:1px solid ${BRAND.borderDefault};">${r.date}</td><td style="padding:6px 8px;font-size:13px;color:${BRAND.textSecondary};border-bottom:1px solid ${BRAND.borderDefault};">${hrs}</td><td style="padding:6px 8px;font-size:13px;color:${BRAND.goodText};border-bottom:1px solid ${BRAND.borderDefault};">Clean</td></tr>`;
}

function buildReconciliationEmail(result: ReconciliationResult, companyName?: string): string {
  const runDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const variance = result.estimated_wage_variance >= 0
    ? `+$${result.estimated_wage_variance.toFixed(2)}`
    : `-$${Math.abs(result.estimated_wage_variance).toFixed(2)}`;

  const issueCards = result.issue_records.map(renderIssueCard).join('');
  const cleanRows = result.clean_records.map(renderCleanRow).join('');

  // Conclusion-first intro: what I checked and what (if anything) needs a look.
  const intro = result.issue_count > 0
    ? `I reconciled the schedule against the time clock for ${result.period_start}–${result.period_end}. ${result.issue_count} record${result.issue_count === 1 ? '' : 's'} need${result.issue_count === 1 ? 's' : ''} a second look — they're flagged below, with the rest coming back clean.`
    : `I reconciled the schedule against the time clock for ${result.period_start}–${result.period_end}, and everything came back clean — nothing needs your attention.`;

  const bodyHtml = `
<h2 style="font-size:22px;font-weight:700;margin:0 0 6px;color:${BRAND.textPrimary};">Payroll reconciliation</h2>
<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BRAND.textPrimary};">${intro}</p>
<p style="color:${BRAND.textSecondary};margin:0 0 24px;font-size:13px;">Pay period: <strong style="color:${BRAND.textPrimary};">${result.period_start}</strong> to <strong style="color:${BRAND.textPrimary};">${result.period_end}</strong> · Run: ${runDate}</p>

<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;">
  <div style="flex:1;min-width:120px;border-radius:8px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};padding:12px 16px;">
    <div style="font-size:24px;font-weight:700;color:${BRAND.textPrimary};">${result.total_employees}</div>
    <div style="font-size:12px;color:${BRAND.textSecondary};">Total Employees</div>
  </div>
  <div style="flex:1;min-width:120px;border-radius:8px;background:${BRAND.goodBg};border:1px solid ${BRAND.goodBorder};padding:12px 16px;">
    <div style="font-size:24px;font-weight:700;color:${BRAND.goodText};">${result.clean_count}</div>
    <div style="font-size:12px;color:${BRAND.goodText};">Clean</div>
  </div>
  <div style="flex:1;min-width:120px;border-radius:8px;background:${BRAND.badBg};border:1px solid ${BRAND.badBorder};padding:12px 16px;">
    <div style="font-size:24px;font-weight:700;color:${BRAND.badText};">${result.issue_count}</div>
    <div style="font-size:12px;color:${BRAND.badText};">Need Attention</div>
  </div>
  <div style="flex:1;min-width:120px;border-radius:8px;background:${BRAND.surface2};border:1px solid ${BRAND.borderDefault};padding:12px 16px;">
    <div style="font-size:24px;font-weight:700;color:${BRAND.textPrimary};">${variance}</div>
    <div style="font-size:12px;color:${BRAND.textSecondary};">Est. Wage Variance</div>
  </div>
</div>

${result.issue_count > 0 ? `
<h3 style="font-size:16px;font-weight:600;margin-bottom:12px;color:${BRAND.badText};">Issues requiring attention (${result.issue_count})</h3>
${issueCards}
` : ''}

${result.clean_count > 0 ? `
<h3 style="font-size:16px;font-weight:600;margin-bottom:12px;color:${BRAND.goodText};">Clean records (${result.clean_count})</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid ${BRAND.borderDefault};border-radius:6px;">
  <thead>
    <tr style="background:${BRAND.surface3};">
      <th style="text-align:left;padding:8px;font-weight:600;color:${BRAND.silver};">Employee</th>
      <th style="text-align:left;padding:8px;font-weight:600;color:${BRAND.silver};">Date</th>
      <th style="text-align:left;padding:8px;font-weight:600;color:${BRAND.silver};">Hours</th>
      <th style="text-align:left;padding:8px;font-weight:600;color:${BRAND.silver};">Status</th>
    </tr>
  </thead>
  <tbody>${cleanRows}</tbody>
</table>
` : ''}

<hr style="margin:28px 0;border:none;border-top:1px solid ${BRAND.borderDefault};">
<p style="font-size:13px;color:${BRAND.textSecondary};">
  Scheduled: <strong style="color:${BRAND.textPrimary};">${result.total_scheduled_hours.toFixed(2)} hrs</strong> ·
  Actual: <strong style="color:${BRAND.textPrimary};">${result.total_actual_hours.toFixed(2)} hrs</strong> ·
  Variance: <strong style="color:${BRAND.textPrimary};">${result.total_hour_variance >= 0 ? '+' : ''}${result.total_hour_variance.toFixed(2)} hrs</strong> ·
  Est. wage variance: <strong style="color:${BRAND.textPrimary};">${variance}</strong>
</p>`;

  return brandedEmailShell({
    bodyHtml,
    companyName,
    preheader: `Payroll reconciliation — ${result.period_start} to ${result.period_end}`,
  });
}

function buildReconciliationText(result: ReconciliationResult): string {
  const intro = result.issue_count > 0
    ? `I reconciled the schedule against the time clock for ${result.period_start}–${result.period_end}. ${result.issue_count} record${result.issue_count === 1 ? '' : 's'} need${result.issue_count === 1 ? 's' : ''} a second look — flagged below, with the rest clean.`
    : `I reconciled the schedule against the time clock for ${result.period_start}–${result.period_end}, and everything came back clean — nothing needs your attention.`;
  const lines: string[] = [
    intro,
    '',
    `PAYROLL RECONCILIATION — ${result.period_start} to ${result.period_end}`,
    `Employees: ${result.total_employees} | Clean: ${result.clean_count} | Issues: ${result.issue_count}`,
    `Scheduled: ${result.total_scheduled_hours.toFixed(2)} hrs | Actual: ${result.total_actual_hours.toFixed(2)} hrs | Variance: ${result.total_hour_variance.toFixed(2)} hrs`,
    '',
  ];

  if (result.issue_records.length > 0) {
    lines.push('ISSUES:');
    for (const r of result.issue_records) {
      lines.push(`  ${r.employee_name} (${r.date}) — ${discrepancyLabel(r.discrepancy_type)}: ${r.notes}`);
    }
    lines.push('');
  }

  if (result.clean_records.length > 0) {
    lines.push('CLEAN:');
    for (const r of result.clean_records) {
      lines.push(`  ${r.employee_name} (${r.date}) — ${r.actual_hours?.toFixed(2) ?? '?'} hrs`);
    }
  }

  return lines.join('\n');
}
