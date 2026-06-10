import { generateActionToken } from '../lib/aegis-actions/tokens';
import { getHomebaseUrl } from '../config/urls';
import type {
  RunScheduleBuildResult,
  ScheduleAssignment,
  ScheduleGap,
  FlaggedIssue,
  ShiftOverrideMismatch,
} from './schedule-build';
import type { ClosedDate } from '../lib/engine/canvas';
import type { EmployeeDisposition } from '../lib/engine/dispositions';
import type { MissingWage, WageEstimate } from '../lib/schedule-simulator';

// ── Public API ────────────────────────────────────────────────────────────────

export interface BuildScheduleResultEmailParams {
  result: RunScheduleBuildResult;
  schedule_id: string;
  company_id: string;
  company_name: string;
  week_start: string;
  week_end: string;
  manager_email: string;
  manager_user_id?: string;
  wages: WageEstimate;
  // Optional list of all active employees so we can resolve max_weekly_hours
  // for the "Top staff hours" table. When missing, hours are still shown but
  // % of max is rendered as "—".
  employee_max_hours?: Map<string, { name: string; max_weekly_hours: number }>;
}

export interface BuildScheduleResultEmail {
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

// "Jun 1–7, 2026" same month/year
// "May 31–Jun 6, 2026" cross-month
// "Dec 30, 2025–Jan 5, 2026" cross-year
export function formatWeekRange(start: string, end: string): string {
  const s = parseYmd(start);
  const e = parseYmd(end);
  const sMo = MONTH_ABBR[s.m - 1];
  const eMo = MONTH_ABBR[e.m - 1];
  if (s.y === e.y && s.m === e.m) {
    return `${sMo} ${s.d}–${e.d}, ${e.y}`;
  }
  if (s.y === e.y) {
    return `${sMo} ${s.d}–${eMo} ${e.d}, ${e.y}`;
  }
  return `${sMo} ${s.d}, ${s.y}–${eMo} ${e.d}, ${e.y}`;
}

function formatWeekdayShort(ymd: string): string {
  const { y, m, d } = parseYmd(ymd);
  // Construct a UTC date at noon so the weekday matches the calendar date
  // regardless of the runtime timezone.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return WEEKDAY_ABBR[dt.getUTCDay()];
}

function formatShortDate(ymd: string): string {
  const { m, d } = parseYmd(ymd);
  return `${MONTH_ABBR[m - 1]} ${d}`;
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

// ── Disposition humanisation ──────────────────────────────────────────────────

function dispositionLabel(reason: EmployeeDisposition['reason']): string {
  switch (reason) {
    case 'not_qualified': return 'not qualified for the role';
    case 'on_time_off': return 'on approved time off';
    case 'max_hours_reached': return 'at maximum weekly hours';
    case 'max_consecutive_days_reached': return 'at maximum consecutive worked days';
    case 'in_conflict': return 'has a hard conflict with assigned staff';
    case 'availability_mismatch': return 'not available for this shift time';
    case 'doubles_blocked': return 'blocked by the doubles policy';
    case 'eligible_but_unchosen': return 'eligible but not chosen by ranker';
  }
}

// ── Section builders (HTML) ───────────────────────────────────────────────────

interface CoverageInfo {
  rate: number;            // 0–100, one decimal
  filled: number;
  required: number;
  badgeLabel: string;
  badgeBg: string;
  badgeFg: string;
}

function computeCoverage(result: RunScheduleBuildResult): CoverageInfo {
  const required = result.totalRequired;
  const filled = result.totalFilled;
  const rate = required > 0 ? Math.round((filled / required) * 1000) / 10 : 100;

  let badgeLabel: string;
  let badgeBg: string;
  let badgeFg: string;
  if (rate >= 100) {
    badgeLabel = 'Fully Staffed';
    badgeBg = '#d1fae5';
    badgeFg = '#065f46';
  } else if (rate >= 75) {
    badgeLabel = 'Partial Coverage';
    badgeBg = '#fef3c7';
    badgeFg = '#92400e';
  } else {
    badgeLabel = 'Critical Gaps';
    badgeBg = '#fee2e2';
    badgeFg = '#991b1b';
  }
  return { rate, filled, required, badgeLabel, badgeBg, badgeFg };
}

function headerSectionHtml(companyName: string, weekRange: string, cov: CoverageInfo): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">
  <tr>
    <td style="vertical-align:middle;">
      <div style="font-size:20px;font-weight:600;color:#111827;line-height:1.2;">${escapeHtml(companyName)}</div>
      <div style="font-size:14px;color:#6b7280;margin-top:4px;">Schedule — week of ${escapeHtml(weekRange)}</div>
    </td>
    <td style="vertical-align:middle;text-align:right;white-space:nowrap;">
      <span style="display:inline-block;padding:6px 12px;font-size:12px;font-weight:600;background:${cov.badgeBg};color:${cov.badgeFg};border-radius:9999px;">${escapeHtml(cov.badgeLabel)}</span>
    </td>
  </tr>
</table>`;
}

function coverageSectionHtml(cov: CoverageInfo, gaps: ScheduleGap[]): string {
  const headline = `<div style="font-size:15px;color:#111827;margin-bottom:8px;"><strong>${cov.filled}</strong> of <strong>${cov.required}</strong> slots filled (${cov.rate}%)</div>`;
  if (gaps.length === 0) {
    return `
<div style="margin:0 0 20px;">
  ${headline}
  <div style="font-size:14px;color:#065f46;">All shifts fully covered.</div>
</div>`;
  }
  const items = gaps.map(g => {
    const dateLabel = `${formatWeekdayShort(g.date)} ${formatShortDate(g.date)}`;
    const shortReason = (g.reason ?? '').split('.')[0] || 'no eligible candidates';
    const dispList = g.per_employee_dispositions.length > 0
      ? `<ul style="margin:6px 0 0;padding-left:18px;color:#4b5563;font-size:13px;">${g.per_employee_dispositions.map(d => `<li style="margin:0 0 2px;">${escapeHtml(d.name)} — ${escapeHtml(dispositionLabel(d.reason))}</li>`).join('')}</ul>`
      : '';
    return `
    <li style="margin:0 0 10px;font-size:14px;color:#374151;line-height:1.5;">
      <strong>${escapeHtml(dateLabel)} — ${escapeHtml(g.shift_name)} ${escapeHtml(g.role)}</strong>
      <span style="color:#6b7280;"> (${g.filled_count}/${g.required_count})</span>:
      ${escapeHtml(shortReason)}
      ${dispList}
    </li>`;
  }).join('');
  return `
<div style="margin:0 0 20px;">
  ${headline}
  <div style="font-size:13px;color:#6b7280;margin-bottom:8px;">${gaps.length} unfilled slot${gaps.length === 1 ? '' : 's'}:</div>
  <ul style="margin:0;padding-left:18px;">${items}</ul>
</div>`;
}

function closedDatesSectionHtml(closedDates: ClosedDate[]): string {
  if (closedDates.length === 0) return '';
  const items = closedDates.map(c => {
    const dateLabel = `${formatWeekdayShort(c.date)} ${formatShortDate(c.date)}`;
    return `
    <li style="margin:0 0 4px;font-size:14px;color:#374151;">
      <strong>${escapeHtml(dateLabel)}</strong>: ${escapeHtml(c.event_title)}
    </li>`;
  }).join('');
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Closed dates honored</div>
  <ul style="margin:0;padding-left:18px;">${items}</ul>
</div>`;
}

function flaggedIssueSubLabel(issue: FlaggedIssue): string {
  if (issue.type === 'unsatisfied_sex_coverage') {
    const { start, end } = issue.metadata.time_window;
    return `${start.slice(0, 5)}–${end.slice(0, 5)} (coverage)`;
  }
  return issue.shift_name;
}

function flaggedIssuesSectionHtml(issues: FlaggedIssue[]): string {
  if (issues.length === 0) return '';
  const cards = issues.map(issue => {
    const meta = (issue.metadata ?? {}) as Record<string, unknown>;
    const dispositions = (meta.per_employee_dispositions as EmployeeDisposition[] | undefined) ?? [];
    const dispList = dispositions.length > 0
      ? `<ul style="margin:8px 0 0;padding-left:18px;color:#4b5563;font-size:13px;">${dispositions.map(d => `<li style="margin:0 0 2px;">${escapeHtml(d.name)} — ${escapeHtml(dispositionLabel(d.reason))}</li>`).join('')}</ul>`
      : '';
    const dateLabel = `${formatWeekdayShort(issue.date)} ${formatShortDate(issue.date)}`;
    return `
<div style="margin:0 0 12px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;">
  <div style="font-size:14px;font-weight:600;color:#92400e;margin-bottom:4px;">${escapeHtml(dateLabel)} — ${escapeHtml(flaggedIssueSubLabel(issue))}</div>
  <div style="font-size:13px;color:#374151;line-height:1.5;">${escapeHtml(issue.description)}</div>
  ${dispList}
</div>`;
  }).join('');
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Flagged issues</div>
  ${cards}
</div>`;
}

interface HoursRow {
  employee_id: string;
  name: string;
  role: string;
  hours: number;
  max_hours: number | null;
  pct_of_max: number | null;
}

function computeHoursRows(
  assignments: ScheduleAssignment[],
  empMaxMap?: Map<string, { name: string; max_weekly_hours: number }>
): HoursRow[] {
  // First role we see for the employee is taken as their primary in the table.
  const accum = new Map<string, { name: string; role: string; hours: number }>();
  for (const a of assignments) {
    const cur = accum.get(a.employee_id);
    if (cur) {
      cur.hours += a.hours;
    } else {
      accum.set(a.employee_id, { name: a.employee_name, role: a.role, hours: a.hours });
    }
  }

  const rows: HoursRow[] = Array.from(accum.entries()).map(([id, v]) => {
    const max = empMaxMap?.get(id)?.max_weekly_hours ?? null;
    const pct = max && max > 0 ? Math.round((v.hours / max) * 1000) / 10 : null;
    return {
      employee_id: id,
      name: v.name,
      role: v.role,
      hours: Math.round(v.hours * 10) / 10,
      max_hours: max,
      pct_of_max: pct,
    };
  }).sort((a, b) => b.hours - a.hours);

  const top5 = rows.slice(0, 5);
  const over80NotInTop5 = rows
    .slice(5)
    .filter(r => r.pct_of_max !== null && r.pct_of_max >= 80);

  return [...top5, ...over80NotInTop5];
}

function topHoursSectionHtml(rows: HoursRow[]): string {
  if (rows.length === 0) return '';
  const body = rows.map(r => {
    const pct = r.pct_of_max === null ? '—' : `${r.pct_of_max}%`;
    const pctColor = r.pct_of_max !== null && r.pct_of_max >= 90
      ? '#b91c1c'
      : r.pct_of_max !== null && r.pct_of_max >= 80
        ? '#b45309'
        : '#374151';
    const maxLabel = r.max_hours === null ? '—' : `${r.max_hours}h`;
    return `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#111827;">${escapeHtml(r.name)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#6b7280;">${escapeHtml(r.role)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;text-align:right;">${r.hours}h</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#6b7280;text-align:right;">${maxLabel}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;color:${pctColor};text-align:right;font-weight:600;">${pct}</td>
    </tr>`;
  }).join('');
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Top staff hours</div>
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;">
    <thead>
      <tr style="background:#f9fafb;">
        <th align="left" style="padding:8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Name</th>
        <th align="left" style="padding:8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Role</th>
        <th align="right" style="padding:8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Hours</th>
        <th align="right" style="padding:8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Max</th>
        <th align="right" style="padding:8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">% of max</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

function wagesSectionHtml(wages: WageEstimate): string {
  const total = wages.total_estimated.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  const missing: MissingWage[] = wages.missing_wages ?? [];
  const missingBlock = missing.length === 0 ? '' : `
  <div style="margin-top:8px;padding:10px 12px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;font-size:13px;color:#92400e;">
    <strong>${missing.length} employee${missing.length === 1 ? '' : 's'} have no wage configured</strong> — their hours are excluded from the labor estimate:
    <div style="margin-top:4px;color:#78350f;">${escapeHtml(missing.map(m => m.name).join(', '))}</div>
  </div>`;
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Estimated labor</div>
  <div style="font-size:18px;font-weight:600;color:#111827;">$${total}</div>
  ${missingBlock}
</div>`;
}

function overrideMismatchesSectionHtml(mismatches: ShiftOverrideMismatch[]): string {
  if (mismatches.length === 0) return '';
  const items = mismatches.map(m => `
    <li style="margin:0 0 4px;font-size:13px;color:#374151;">
      <strong>${escapeHtml(formatShortDate(m.date))} ${escapeHtml(m.shift_name)}</strong>: override key
      <code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;">${escapeHtml(m.override_key)}</code>
      didn't match any requirement role
      (available: ${escapeHtml(m.available_roles.join(', '))})
    </li>`).join('');
  return `
<div style="margin:0 0 20px;">
  <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Shift override mismatches</div>
  <ul style="margin:0;padding-left:18px;">${items}</ul>
</div>`;
}

function ctaSectionHtml(distributeUrl: string, homebaseUrl: string): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px;">
  <tr>
    <td align="left">
      <a href="${escapeHtml(distributeUrl)}"
         style="display:inline-block;padding:12px 22px;background:#f97316;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">Distribute Schedule</a>
      <a href="${escapeHtml(homebaseUrl)}/schedule"
         style="display:inline-block;margin-left:14px;padding:12px 0;font-size:14px;color:#4b5563;text-decoration:underline;">View in Homebase</a>
    </td>
  </tr>
</table>
<div style="margin:0 0 20px;font-size:12px;color:#6b7280;line-height:1.5;">
  Distribute Schedule will send the week's shifts to all assigned employees. Distribution can take a moment — confirmation will appear in Homebase.
</div>`;
}

// ── Plain-text builder ────────────────────────────────────────────────────────

function buildPlainText(params: {
  companyName: string;
  weekRange: string;
  cov: CoverageInfo;
  gaps: ScheduleGap[];
  closedDates: ClosedDate[];
  issues: FlaggedIssue[];
  hoursRows: HoursRow[];
  wages: WageEstimate;
  mismatches: ShiftOverrideMismatch[];
  distributeUrl: string;
  homebaseUrl: string;
}): string {
  const lines: string[] = [];

  lines.push(`${params.companyName} — Schedule for week of ${params.weekRange}`);
  lines.push(`Status: ${params.cov.badgeLabel}`);
  lines.push('');

  lines.push('COVERAGE');
  lines.push(`${params.cov.filled} of ${params.cov.required} slots filled (${params.cov.rate}%)`);
  if (params.gaps.length === 0) {
    lines.push('All shifts fully covered.');
  } else {
    lines.push(`${params.gaps.length} unfilled slot${params.gaps.length === 1 ? '' : 's'}:`);
    for (const g of params.gaps) {
      const dateLabel = `${formatWeekdayShort(g.date)} ${formatShortDate(g.date)}`;
      const shortReason = (g.reason ?? '').split('.')[0] || 'no eligible candidates';
      lines.push(`- ${dateLabel} — ${g.shift_name} ${g.role} (${g.filled_count}/${g.required_count}): ${shortReason}`);
      for (const d of g.per_employee_dispositions) {
        lines.push(`    · ${d.name} — ${dispositionLabel(d.reason)}`);
      }
    }
  }
  lines.push('');

  if (params.closedDates.length > 0) {
    lines.push('CLOSED DATES HONORED');
    for (const c of params.closedDates) {
      lines.push(`- ${formatWeekdayShort(c.date)} ${formatShortDate(c.date)}: ${c.event_title}`);
    }
    lines.push('');
  }

  if (params.issues.length > 0) {
    lines.push('FLAGGED ISSUES');
    for (const issue of params.issues) {
      const dateLabel = `${formatWeekdayShort(issue.date)} ${formatShortDate(issue.date)}`;
      lines.push(`- ${dateLabel} — ${flaggedIssueSubLabel(issue)}: ${issue.description}`);
      const meta = (issue.metadata ?? {}) as Record<string, unknown>;
      const dispositions = (meta.per_employee_dispositions as EmployeeDisposition[] | undefined) ?? [];
      for (const d of dispositions) {
        lines.push(`    · ${d.name} — ${dispositionLabel(d.reason)}`);
      }
    }
    lines.push('');
  }

  if (params.hoursRows.length > 0) {
    lines.push('TOP STAFF HOURS');
    for (const r of params.hoursRows) {
      const pct = r.pct_of_max === null ? '' : ` (${r.pct_of_max}% of max)`;
      lines.push(`- ${r.name} (${r.role}): ${r.hours}h${pct}`);
    }
    lines.push('');
  }

  lines.push('ESTIMATED LABOR');
  lines.push(`$${params.wages.total_estimated.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);
  const missing: MissingWage[] = params.wages.missing_wages ?? [];
  if (missing.length > 0) {
    lines.push(`${missing.length} employee${missing.length === 1 ? '' : 's'} have no wage configured — excluded from estimate:`);
    for (const m of missing) {
      lines.push(`- ${m.name}`);
    }
  }
  lines.push('');

  if (params.mismatches.length > 0) {
    lines.push('SHIFT OVERRIDE MISMATCHES');
    for (const m of params.mismatches) {
      lines.push(`- ${formatShortDate(m.date)} ${m.shift_name}: override key "${m.override_key}" didn't match (available: ${m.available_roles.join(', ')})`);
    }
    lines.push('');
  }

  lines.push('Distribute the schedule to all assigned employees:');
  lines.push(params.distributeUrl);
  lines.push('');
  lines.push('View in Homebase:');
  lines.push(`${params.homebaseUrl}/schedule`);
  lines.push('');
  lines.push("Distribute Schedule will send the week's shifts to all assigned employees. Distribution can take a moment — confirmation will appear in Homebase.");

  return lines.join('\n');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function buildScheduleResultEmail(
  params: BuildScheduleResultEmailParams
): Promise<BuildScheduleResultEmail> {
  const tokenResult = await generateActionToken({
    action_type: 'confirm_distribution',
    payload: {
      schedule_id: params.schedule_id,
      week_start: params.week_start,
      week_end: params.week_end,
      company_name: params.company_name,
    },
    company_id: params.company_id,
    issued_to_email: params.manager_email,
    issued_to_user_id: params.manager_user_id,
    ttl_minutes: 4320,
  });

  const weekRange = formatWeekRange(params.week_start, params.week_end);
  const cov = computeCoverage(params.result);
  const hoursRows = computeHoursRows(params.result.assignments, params.employee_max_hours);
  const homebaseUrl = getHomebaseUrl();

  const subject = `Schedule built for ${params.company_name} — week of ${weekRange}`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#111827;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;background:#ffffff;border-radius:8px;padding:28px;border:1px solid #e5e7eb;">
        <tr><td>
          ${headerSectionHtml(params.company_name, weekRange, cov)}
          ${coverageSectionHtml(cov, params.result.gaps)}
          ${closedDatesSectionHtml(params.result.closed_dates)}
          ${flaggedIssuesSectionHtml(params.result.flagged_issues)}
          ${topHoursSectionHtml(hoursRows)}
          ${wagesSectionHtml(params.wages)}
          ${overrideMismatchesSectionHtml(params.result.shift_override_mismatches)}
          ${ctaSectionHtml(tokenResult.url, homebaseUrl)}
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
            Aegis · Quria Solutions
          </div>
        </td></tr>
      </table>
    </td>
  </tr>
</table>
</body></html>`;

  const text = buildPlainText({
    companyName: params.company_name,
    weekRange,
    cov,
    gaps: params.result.gaps,
    closedDates: params.result.closed_dates,
    issues: params.result.flagged_issues,
    hoursRows,
    wages: params.wages,
    mismatches: params.result.shift_override_mismatches,
    distributeUrl: tokenResult.url,
    homebaseUrl,
  });

  return { subject, html, text };
}
