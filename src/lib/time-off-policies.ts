import { supabase } from '../db/client';

// Typed view of the two time-off policy limits the violation checker cares
// about. Both fields are null when the company hasn't configured that policy.
export interface TimeOffPolicies {
  max_consecutive_days_off: number | null;
  min_notice_period_days: number | null;
}

export interface TimeOffViolations {
  consecutiveDays: { totalSpan: number; limit: number; exceeded: boolean } | null;
  notice: { daysGiven: number; daysRequired: number; insufficient: boolean } | null;
}

const POLICY_KEYS = {
  max_consecutive_days_off: 'max_consecutive_days_off',
  min_notice_period_days: 'min_notice_period_days',
} as const;

// ── Date helpers (timezone-safe: never `new Date('YYYY-MM-DD')`) ──────────────

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
}

function formatYmd(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function ymdToDate(ymd: string): Date {
  const { y, m, d } = parseYmd(ymd);
  // Noon anchor avoids DST boundary surprises when adding/subtracting days.
  return new Date(y, m - 1, d, 12, 0, 0);
}

function addDays(ymd: string, delta: number): string {
  const dt = ymdToDate(ymd);
  dt.setDate(dt.getDate() + delta);
  return formatYmd(dt);
}

function daysInclusive(start: string, end: string): number {
  const s = ymdToDate(start);
  const e = ymdToDate(end);
  return Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
}

function daysBetween(start: string, end: string): number {
  const s = ymdToDate(start);
  const e = ymdToDate(end);
  return Math.round((e.getTime() - s.getTime()) / 86_400_000);
}

function todayInTimezone(tz: string): string {
  // en-CA formats as YYYY-MM-DD which we can split-parse.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// ── Policy loader ─────────────────────────────────────────────────────────────

export async function loadTimeOffPolicies(company_id: string): Promise<TimeOffPolicies> {
  const { data } = await supabase
    .from('policies')
    .select('policy_key, policy_value')
    .eq('company_id', company_id)
    .eq('policy_type', 'time_off')
    .in('policy_key', [POLICY_KEYS.max_consecutive_days_off, POLICY_KEYS.min_notice_period_days]);

  const rows = (data ?? []) as Array<{ policy_key: string; policy_value: string }>;

  const parseInt10 = (raw: string | undefined): number | null => {
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  const byKey = new Map(rows.map(r => [r.policy_key, r.policy_value]));

  return {
    max_consecutive_days_off: parseInt10(byKey.get(POLICY_KEYS.max_consecutive_days_off)),
    min_notice_period_days: parseInt10(byKey.get(POLICY_KEYS.min_notice_period_days)),
  };
}

// ── Violation computation ─────────────────────────────────────────────────────

export async function computeTimeOffViolations(params: {
  employee_id: string;
  start_date: string;
  end_date: string;
  company_id: string;
}): Promise<TimeOffViolations> {
  const policies = await loadTimeOffPolicies(params.company_id);

  const consecutiveDays = await computeConsecutiveDaysViolation(params, policies);
  const notice = await computeNoticeViolation(params, policies);

  return { consecutiveDays, notice };
}

async function computeConsecutiveDaysViolation(
  params: { employee_id: string; start_date: string; end_date: string; company_id: string },
  policies: TimeOffPolicies
): Promise<TimeOffViolations['consecutiveDays']> {
  const limit = policies.max_consecutive_days_off;
  if (limit == null) return null;

  // Pull all approved TOs for the employee once, then chain in memory.
  // Scoping by employee_id only keeps the query simple and the dataset bounded.
  const { data } = await supabase
    .from('time_off_requests')
    .select('id, start_date, end_date')
    .eq('employee_id', params.employee_id)
    .eq('company_id', params.company_id)
    .eq('status', 'approved');

  const approved = (data ?? []) as Array<{ id: string; start_date: string; end_date: string }>;

  let leftBoundary = params.start_date;
  let rightBoundary = params.end_date;
  let totalSpan = daysInclusive(params.start_date, params.end_date);
  const chained = new Set<string>();

  let extended = true;
  while (extended) {
    extended = false;
    const dayBefore = addDays(leftBoundary, -1);
    const dayAfter = addDays(rightBoundary, 1);

    const leftMatch = approved.find(t => !chained.has(t.id) && t.end_date === dayBefore);
    if (leftMatch) {
      chained.add(leftMatch.id);
      totalSpan += daysInclusive(leftMatch.start_date, leftMatch.end_date);
      leftBoundary = leftMatch.start_date;
      extended = true;
    }

    const rightMatch = approved.find(t => !chained.has(t.id) && t.start_date === dayAfter);
    if (rightMatch) {
      chained.add(rightMatch.id);
      totalSpan += daysInclusive(rightMatch.start_date, rightMatch.end_date);
      rightBoundary = rightMatch.end_date;
      extended = true;
    }
  }

  return { totalSpan, limit, exceeded: totalSpan > limit };
}

async function computeNoticeViolation(
  params: { start_date: string; company_id: string },
  policies: TimeOffPolicies
): Promise<TimeOffViolations['notice']> {
  const daysRequired = policies.min_notice_period_days;
  if (daysRequired == null) return null;

  const { data: companyRow } = await supabase
    .from('companies')
    .select('timezone')
    .eq('id', params.company_id)
    .single();

  const tz = (companyRow as { timezone: string } | null)?.timezone ?? 'UTC';
  const today = todayInTimezone(tz);

  const daysGiven = daysBetween(today, params.start_date);

  return { daysGiven, daysRequired, insufficient: daysGiven < daysRequired };
}
