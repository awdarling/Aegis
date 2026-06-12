import { generateActionToken } from '../lib/aegis-actions/tokens';
import { greeting } from '../messaging/greeting';
import { getHomebaseUrl } from '../config/urls';
import type { Employee, PartialDayDetail, TimeOffRequest } from '../db/types';
import type { SimulationResult } from '../lib/schedule-simulator';
import type { TimeOffViolations } from '../lib/time-off-policies';

// ── Public API ────────────────────────────────────────────────────────────────

export type TimeOffRecommendationType = 'approve' | 'deny' | 'neutral';

export interface TimeOffRecommendation {
  type: TimeOffRecommendationType;
  reasoning: string;
}

export interface BuildTimeOffManagerEmailParams {
  time_off_request: TimeOffRequest;
  employee: Employee;
  company_id: string;
  company_name: string;
  manager_email: string;
  manager_user_id?: string;
  /** Manager's name for the greeting line; falls back to "there" when absent. */
  manager_name?: string;
  simulation?: SimulationResult;
  recommendation?: TimeOffRecommendation;
  violations?: TimeOffViolations | null;
}

export interface BuildTimeOffManagerEmail {
  subject: string;
  html: string;
  text: string;
}

// ── Date helpers (local-time YYYY-MM-DD parsing only) ─────────────────────────

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
}

// Single-date: "Fri, Jun 5, 2026"
// Same-month range: "Jun 1–7, 2026"
// Cross-month: "May 31–Jun 6, 2026"
// Cross-year: "Dec 30, 2025–Jan 5, 2026"
export function formatDateRange(start: string, end: string): string {
  const s = parseYmd(start);
  const e = parseYmd(end);
  const sMo = MONTH_ABBR[s.m - 1];
  const eMo = MONTH_ABBR[e.m - 1];

  if (start === end) {
    const wd = WEEKDAY_ABBR[new Date(Date.UTC(s.y, s.m - 1, s.d, 12, 0, 0)).getUTCDay()];
    return `${wd}, ${sMo} ${s.d}, ${s.y}`;
  }
  if (s.y === e.y && s.m === e.m) {
    return `${sMo} ${s.d}–${e.d}, ${e.y}`;
  }
  if (s.y === e.y) {
    return `${sMo} ${s.d}–${eMo} ${e.d}, ${e.y}`;
  }
  return `${sMo} ${s.d}, ${s.y}–${eMo} ${e.d}, ${e.y}`;
}

function formatShortDate(ymd: string): string {
  const { m, d } = parseYmd(ymd);
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

function formatWeekdayShort(ymd: string): string {
  const { y, m, d } = parseYmd(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return WEEKDAY_ABBR[dt.getUTCDay()];
}

function formatTime(t: string): string {
  const [hStr, mStr] = t.slice(0, 5).split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Request-details rendering ─────────────────────────────────────────────────

function describePartialDay(d: PartialDayDetail): string {
  if (d.shift_name) {
    return `${formatWeekdayShort(d.date)} ${formatShortDate(d.date)} — ${d.shift_name} off`;
  }
  if (d.start_time && d.end_time) {
    return `${formatWeekdayShort(d.date)} ${formatShortDate(d.date)} — ${formatTime(d.start_time)}–${formatTime(d.end_time)}`;
  }
  return `${formatWeekdayShort(d.date)} ${formatShortDate(d.date)} — partial`;
}

function buildPartialSummaryText(partialDays: PartialDayDetail[]): string {
  // If every day shares the same window/shift, collapse to one line.
  const sample = partialDays[0];
  const allSame = partialDays.every(
    d =>
      d.start_time === sample.start_time &&
      d.end_time === sample.end_time &&
      d.shift_name === sample.shift_name
  );
  if (allSame) {
    if (sample.shift_name) {
      return `${sample.shift_name} off every day in the range`;
    }
    if (sample.start_time && sample.end_time) {
      return `${formatTime(sample.start_time)}–${formatTime(sample.end_time)} off every day in the range`;
    }
  }
  return partialDays.map(describePartialDay).join('; ');
}

// ── Section builders (HTML) ───────────────────────────────────────────────────

function headerSectionHtml(employeeName: string, dateRange: string): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">
  <tr>
    <td style="vertical-align:middle;">
      <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;">Time-off request</div>
      <div style="font-size:20px;font-weight:600;color:#111827;line-height:1.2;margin-top:4px;">${escapeHtml(employeeName)}</div>
      <div style="font-size:14px;color:#6b7280;margin-top:4px;">${escapeHtml(dateRange)}</div>
    </td>
  </tr>
</table>`;
}

function requestDetailsHtml(
  tor: TimeOffRequest,
  dateRange: string
): string {
  const isPartial = tor.time_off_type === 'partial' && tor.partial_days && tor.partial_days.length > 0;
  const dayCount = (() => {
    if (isPartial && tor.partial_days) return tor.partial_days.length;
    // Inclusive day count from YYYY-MM-DD endpoints.
    const s = parseYmd(tor.start_date);
    const e = parseYmd(tor.end_date);
    const ms = Date.UTC(e.y, e.m - 1, e.d) - Date.UTC(s.y, s.m - 1, s.d);
    return Math.round(ms / (24 * 60 * 60 * 1000)) + 1;
  })();

  let typeBlock: string;
  if (isPartial && tor.partial_days) {
    const items = tor.partial_days
      .map(d => `<li style="margin:0 0 4px;font-size:14px;color:#374151;">${escapeHtml(describePartialDay(d))}</li>`)
      .join('');
    typeBlock = `
    <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-top:12px;margin-bottom:6px;">Partial days</div>
    <ul style="margin:0;padding-left:18px;">${items}</ul>`;
  } else {
    typeBlock = `
    <div style="font-size:14px;color:#374151;margin-top:8px;"><strong>Full day${dayCount === 1 ? '' : 's'}</strong> requested (${dayCount} day${dayCount === 1 ? '' : 's'} total).</div>`;
  }

  const reason = (tor.reason ?? '').trim();
  const reasonBlock = reason
    ? `<div style="font-size:14px;color:#374151;margin-top:12px;"><strong>Reason:</strong> ${escapeHtml(reason)}</div>`
    : '';

  return `
<div style="margin:0 0 20px;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
  <div style="font-size:14px;color:#374151;"><strong>Dates:</strong> ${escapeHtml(dateRange)}</div>
  ${typeBlock}
  ${reasonBlock}
</div>`;
}

// Returns the bullet text lines for the Policy Considerations section, or []
// when nothing should be rendered (null violations, or all checks passed).
function violationLines(violations: TimeOffViolations | null | undefined): string[] {
  if (!violations) return [];
  const out: string[] = [];
  if (violations.consecutiveDays?.exceeded) {
    const v = violations.consecutiveDays;
    out.push(
      `Consecutive days off: ${v.totalSpan}-day contiguous block (combined with adjacent approved TOs), exceeding the ${v.limit}-day company limit.`
    );
  }
  if (violations.notice?.insufficient) {
    const v = violations.notice;
    const dayWord = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
    out.push(
      `Notice period: Submitted ${dayWord(v.daysGiven)} before start date, less than the ${dayWord(v.daysRequired)} minimum.`
    );
  }
  return out;
}

function policyConsiderationsHtml(lines: string[]): string {
  if (lines.length === 0) return '';
  const items = lines.map(l => `<li style="margin:0 0 6px;font-size:14px;color:#92400e;">${escapeHtml(l)}</li>`).join('');
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#92400e;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Policy considerations</div>
  <div style="padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #d97706;border-radius:6px;">
    <ul style="margin:0;padding-left:18px;">${items}</ul>
  </div>
</div>`;
}

function coverageImpactHtml(simulation: SimulationResult): string {
  const gaps = simulation.coverage_gaps;
  if (gaps.length === 0) {
    return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Coverage impact</div>
  <div style="padding:12px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;font-size:14px;color:#065f46;">
    No coverage impact — all shifts would still be filled.
  </div>
</div>`;
  }
  const items = gaps.map(g => {
    const dateLabel = `${formatWeekdayShort(g.date)} ${formatShortDate(g.date)}`;
    return `
    <li style="margin:0 0 6px;font-size:14px;color:#374151;">
      <strong>${escapeHtml(dateLabel)} — ${escapeHtml(g.shift_name)} ${escapeHtml(g.role)}</strong>:
      short by ${g.shortfall} ${g.shortfall === 1 ? 'person' : 'people'}
    </li>`;
  }).join('');
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Coverage impact</div>
  <div style="padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:14px;color:#991b1b;margin-bottom:10px;">
    If approved, this would create ${gaps.length} coverage gap${gaps.length === 1 ? '' : 's'}:
  </div>
  <ul style="margin:0;padding-left:18px;">${items}</ul>
</div>`;
}

function recommendationBadgeStyles(t: TimeOffRecommendationType): { bg: string; fg: string; label: string } {
  switch (t) {
    case 'approve':
      return { bg: '#d1fae5', fg: '#065f46', label: 'Approve' };
    case 'deny':
      return { bg: '#fee2e2', fg: '#991b1b', label: 'Deny' };
    case 'neutral':
      return { bg: '#e5e7eb', fg: '#374151', label: 'Neutral' };
  }
}

function recommendationHtml(rec: TimeOffRecommendation): string {
  const s = recommendationBadgeStyles(rec.type);
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Aegis recommendation</div>
  <div style="padding:14px 16px;background:#ffffff;border:1px solid #e5e7eb;border-left:4px solid ${s.fg};border-radius:6px;">
    <span style="display:inline-block;padding:4px 10px;font-size:12px;font-weight:600;background:${s.bg};color:${s.fg};border-radius:9999px;margin-bottom:8px;">${escapeHtml(s.label)}</span>
    <div style="font-size:14px;color:#374151;line-height:1.5;">${escapeHtml(rec.reasoning)}</div>
  </div>
</div>`;
}

function ctaSectionHtml(
  approveUrl: string,
  denyUrl: string,
  homebaseUrl: string,
  employeeName: string
): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;">
  <tr>
    <td align="left">
      <a href="${escapeHtml(approveUrl)}"
         style="display:inline-block;padding:12px 24px;background:#16a34a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;margin-right:8px;">Approve</a>
      <a href="${escapeHtml(denyUrl)}"
         style="display:inline-block;padding:12px 24px;background:#dc2626;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">Deny</a>
    </td>
  </tr>
</table>
<div style="margin:0 0 14px;">
  <a href="${escapeHtml(homebaseUrl)}/data?tab=time-off"
     style="font-size:14px;color:#4b5563;text-decoration:underline;">Review in Homebase</a>
</div>
<div style="margin:0 0 20px;font-size:12px;color:#6b7280;line-height:1.5;">
  Clicking Approve or Deny will record your decision. Until full magic-link wiring is complete, please also confirm the status in Homebase to finalize the notification to ${escapeHtml(employeeName)}.
</div>`;
}

// ── Plain-text builder ────────────────────────────────────────────────────────

function buildPlainText(params: {
  employeeName: string;
  companyName: string;
  dateRange: string;
  tor: TimeOffRequest;
  simulation?: SimulationResult;
  recommendation?: TimeOffRecommendation;
  policyLines: string[];
  approveUrl: string;
  denyUrl: string;
  homebaseUrl: string;
}): string {
  const lines: string[] = [];

  lines.push(`Time-off request — ${params.employeeName}`);
  lines.push(`Company: ${params.companyName}`);
  lines.push('');

  if (params.policyLines.length > 0) {
    lines.push('POLICY CONSIDERATIONS');
    for (const l of params.policyLines) {
      lines.push(`- ${l}`);
    }
    lines.push('');
  }

  lines.push('REQUEST DETAILS');
  lines.push(`Dates: ${params.dateRange}`);
  const isPartial =
    params.tor.time_off_type === 'partial' &&
    params.tor.partial_days &&
    params.tor.partial_days.length > 0;
  if (isPartial && params.tor.partial_days) {
    lines.push('Partial days:');
    for (const d of params.tor.partial_days) {
      lines.push(`- ${describePartialDay(d)}`);
    }
  } else {
    lines.push('Full day(s) requested.');
  }
  const reason = (params.tor.reason ?? '').trim();
  if (reason) {
    lines.push(`Reason: ${reason}`);
  }
  lines.push('');

  if (params.simulation) {
    lines.push('COVERAGE IMPACT');
    if (params.simulation.coverage_gaps.length === 0) {
      lines.push('No coverage impact — all shifts would still be filled.');
    } else {
      lines.push(`If approved, this would create ${params.simulation.coverage_gaps.length} coverage gap${params.simulation.coverage_gaps.length === 1 ? '' : 's'}:`);
      for (const g of params.simulation.coverage_gaps) {
        const dateLabel = `${formatWeekdayShort(g.date)} ${formatShortDate(g.date)}`;
        lines.push(`- ${dateLabel} — ${g.shift_name} ${g.role}: short by ${g.shortfall} ${g.shortfall === 1 ? 'person' : 'people'}`);
      }
    }
    lines.push('');
  }

  if (params.recommendation) {
    const s = recommendationBadgeStyles(params.recommendation.type);
    lines.push(`AEGIS RECOMMENDATION: ${s.label.toUpperCase()}`);
    lines.push(params.recommendation.reasoning);
    lines.push('');
  }

  lines.push('Approve this request:');
  lines.push(params.approveUrl);
  lines.push('');
  lines.push('Deny this request:');
  lines.push(params.denyUrl);
  lines.push('');
  lines.push('Review in Homebase:');
  lines.push(`${params.homebaseUrl}/data?tab=time-off`);
  lines.push('');
  lines.push(`Clicking Approve or Deny will record your decision. Until full magic-link wiring is complete, please also confirm the status in Homebase to finalize the notification to ${params.employeeName}.`);

  return lines.join('\n');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function buildTimeOffManagerEmail(
  params: BuildTimeOffManagerEmailParams
): Promise<BuildTimeOffManagerEmail> {
  const tor = params.time_off_request;
  const employee = params.employee;
  const isPartial = tor.time_off_type === 'partial' && tor.partial_days && tor.partial_days.length > 0;
  const partialSummary = isPartial && tor.partial_days ? buildPartialSummaryText(tor.partial_days) : undefined;

  const sharedPayload = {
    time_off_request_id: tor.id,
    employee_id: employee.id,
    employee_name: employee.name,
    start_date: tor.start_date,
    end_date: tor.end_date,
    time_off_type: tor.time_off_type ?? 'full_day',
    ...(partialSummary ? { partial_summary: partialSummary } : {}),
    company_name: params.company_name,
  };

  const [approveTok, denyTok] = await Promise.all([
    generateActionToken({
      action_type: 'approve_to',
      payload: sharedPayload,
      company_id: params.company_id,
      issued_to_email: params.manager_email,
      issued_to_user_id: params.manager_user_id,
      ttl_minutes: 4320,
    }),
    generateActionToken({
      action_type: 'deny_to',
      payload: sharedPayload,
      company_id: params.company_id,
      issued_to_email: params.manager_email,
      issued_to_user_id: params.manager_user_id,
      ttl_minutes: 4320,
    }),
  ]);

  const dateRange = formatDateRange(tor.start_date, tor.end_date);
  const homebaseUrl = getHomebaseUrl();

  const subject = `Time-off request from ${employee.name} — ${dateRange}`;

  const policyLines = violationLines(params.violations);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#111827;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;background:#ffffff;border-radius:8px;padding:28px;border:1px solid #e5e7eb;">
        <tr><td>
          <p style="margin:0 0 16px;font-size:15px;color:#111827;">${escapeHtml(greeting(params.manager_name))}</p>
          ${headerSectionHtml(employee.name, dateRange)}
          ${policyConsiderationsHtml(policyLines)}
          ${requestDetailsHtml(tor, dateRange)}
          ${params.simulation ? coverageImpactHtml(params.simulation) : ''}
          ${params.recommendation ? recommendationHtml(params.recommendation) : ''}
          ${ctaSectionHtml(approveTok.url, denyTok.url, homebaseUrl, employee.name)}
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
            Aegis · Quria Solutions · ${escapeHtml(params.company_name)}
          </div>
        </td></tr>
      </table>
    </td>
  </tr>
</table>
</body></html>`;

  const text = `${greeting(params.manager_name)}\n\n` + buildPlainText({
    employeeName: employee.name,
    companyName: params.company_name,
    dateRange,
    tor,
    simulation: params.simulation,
    recommendation: params.recommendation,
    policyLines,
    approveUrl: approveTok.url,
    denyUrl: denyTok.url,
    homebaseUrl,
  });

  return { subject, html, text };
}
