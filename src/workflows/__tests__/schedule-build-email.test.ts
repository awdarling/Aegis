import { describe, it, expect, vi } from 'vitest';

// schedule-build-email imports the magic-link token layer, which pulls in the
// Supabase client + env validation. Mock those so importing the module here
// doesn't try to validate real env vars (the established pattern in the other
// workflow tests). The render functions under test take their URLs as args, so
// nothing real is contacted.
vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));

import {
  renderScheduleResultBodyHtml,
  buildPlainText,
} from '../schedule-build-email';
import {
  veteranLabelForShiftDate,
  type EngineExperienceRule,
} from '../../lib/engine/experience-rules';
import type {
  RunScheduleBuildResult,
  ScheduleGap,
  FlaggedIssue,
} from '../schedule-build';
import type { WageEstimate } from '../../lib/schedule-simulator';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// In June 2026, the 15th is a Monday → 17th = Wednesday, 20th = Saturday,
// 21st = Sunday. Used to prove day-of-week scoping.
const WED = '2026-06-17';
const SAT = '2026-06-20';
const SUN = '2026-06-21';

const TYPE_ID_BY_NAME: Record<string, string> = {
  Morning: 'st-morning',
  Evening: 'st-evening',
  Midday: 'st-midday',
};

function rule(partial: Partial<EngineExperienceRule>): EngineExperienceRule {
  return {
    shift_type_id: null,
    days_of_week: null,
    role: null,
    mode: 'min_veterans',
    min_count: null,
    season_start: null,
    season_end: null,
    active: true,
    ...partial,
  };
}

// Morning = all-veterans every day; Evening = ≥2 veterans on weekends only.
const RULES: EngineExperienceRule[] = [
  rule({ shift_type_id: 'st-morning', mode: 'all_veterans' }),
  rule({ shift_type_id: 'st-evening', mode: 'min_veterans', min_count: 2, days_of_week: [0, 6] }),
];

// Day-accurate resolver, exactly like the one schedule-build.ts hands the email.
function resolve(shiftName: string, date: string): string | null {
  const id = TYPE_ID_BY_NAME[shiftName];
  return id ? veteranLabelForShiftDate(RULES, id, date) : null;
}

function gap(shift_name: string, date: string): ScheduleGap {
  return {
    date,
    shift_name,
    role: 'Lifeguard',
    required_count: 2,
    filled_count: 1,
    reason: 'no eligible candidates',
    description: 'no eligible candidates',
    per_employee_dispositions: [],
  };
}

const WAGES: WageEstimate = { total_estimated: 1000, by_employee: [], missing_wages: [] };

const COV = {
  rate: 80,
  filled: 8,
  required: 10,
  badgeLabel: 'Partial Coverage',
  badgeBg: '#2e1a0a',
  badgeFg: '#fbbf24',
};

function makeResult(overrides: Partial<RunScheduleBuildResult> = {}): RunScheduleBuildResult {
  return {
    assignments: [],
    gaps: [
      gap('Morning', WED), // full-week rule → tagged even on a weekday
      gap('Evening', SAT), // weekend rule → tagged on Saturday
      gap('Evening', WED), // weekend rule → NOT tagged on a weekday
      gap('Midday', SAT),  // no rule → never tagged
    ],
    flagged_issues: [],
    closed_dates: [],
    totalRequired: 10,
    totalFilled: 8,
    ...overrides,
  };
}

function renderHtml(
  result: RunScheduleBuildResult,
  r?: (s: string, d: string) => string | null
): string {
  return renderScheduleResultBodyHtml({
    companyName: 'Watermark Country Club',
    managerName: 'Alexander',
    weekRange: 'Jun 14–20, 2026',
    cov: COV,
    result,
    hoursRows: [],
    wages: WAGES,
    distributeUrl: 'https://homebase.test.local/x',
    homebaseUrl: 'https://homebase.test.local',
    resolveShiftRuleLabel: r,
  });
}

function renderText(
  result: RunScheduleBuildResult,
  r?: (s: string, d: string) => string | null
): string {
  return buildPlainText({
    companyName: 'Watermark Country Club',
    managerName: 'Alexander',
    weekRange: 'Jun 14–20, 2026',
    cov: COV,
    gaps: result.gaps,
    closedDates: result.closed_dates,
    issues: result.flagged_issues,
    hoursRows: [],
    wages: WAGES,
    distributeUrl: 'https://homebase.test.local/x',
    homebaseUrl: 'https://homebase.test.local',
    resolveShiftRuleLabel: r,
  });
}

// ── veteranLabelForShiftDate ────────────────────────────────────────────────────

describe('veteranLabelForShiftDate', () => {
  it('labels a full-week all-veterans rule on any date', () => {
    expect(veteranLabelForShiftDate(RULES, 'st-morning', WED)).toBe('Veterans only');
    expect(veteranLabelForShiftDate(RULES, 'st-morning', SAT)).toBe('Veterans only');
  });

  it('labels a weekend-scoped min rule only on its days', () => {
    expect(veteranLabelForShiftDate(RULES, 'st-evening', SAT)).toBe('≥2 veterans');
    expect(veteranLabelForShiftDate(RULES, 'st-evening', SUN)).toBe('≥2 veterans');
    expect(veteranLabelForShiftDate(RULES, 'st-evening', WED)).toBeNull();
  });

  it('returns null for a shift with no rule', () => {
    expect(veteranLabelForShiftDate(RULES, 'st-midday', SAT)).toBeNull();
  });

  it('honors a season window', () => {
    const seasonal = [rule({ shift_type_id: 'st-morning', mode: 'all_veterans', season_start: '2026-07-01', season_end: '2026-08-31' })];
    expect(veteranLabelForShiftDate(seasonal, 'st-morning', '2026-06-20')).toBeNull();
    expect(veteranLabelForShiftDate(seasonal, 'st-morning', '2026-07-15')).toBe('Veterans only');
  });
});

// ── Day-accurate tag rendering in the emailed report ────────────────────────────

describe('veteran tag in the schedule-build email (day-accurate)', () => {
  it('HTML: tags full-week rules on any day and day-scoped rules only on their days', () => {
    const html = renderHtml(makeResult(), resolve);

    // Morning's full-week rule tags the weekday row.
    expect(html).toMatch(/Morning Lifeguard<\/strong><span[^>]*>Veterans only<\/span>/);
    // Evening's weekend rule tags the Saturday row...
    expect(html).toMatch(/Sat Jun 20 — Evening Lifeguard<\/strong><span[^>]*>≥2 veterans<\/span>/);
    // ...but NOT the Wednesday row (no tag span right after the </strong>).
    expect(html).toMatch(/Wed Jun 17 — Evening Lifeguard<\/strong>\s*<span style="color:/);
    expect(html).not.toMatch(/Wed Jun 17 — Evening Lifeguard<\/strong><span[^>]*>≥/);
    // Midday has no rule at all.
    expect(html).not.toMatch(/Midday Lifeguard<\/strong><span[^>]*>(Veterans only|≥)/);
  });

  it('plain text: tags follow the same day-accurate rule', () => {
    const text = renderText(makeResult(), resolve);
    expect(text).toContain('Morning Lifeguard · Veterans only (1/2)');
    expect(text).toContain('Sat Jun 20 — Evening Lifeguard · ≥2 veterans (1/2)');
    expect(text).toContain('Wed Jun 17 — Evening Lifeguard (1/2)');
    expect(text).not.toContain('Wed Jun 17 — Evening Lifeguard ·');
    expect(text).toContain('Midday Lifeguard (1/2)');
  });

  it('tags a flagged-issue card on a constrained day', () => {
    const flagged: FlaggedIssue = {
      type: 'unsatisfied_attribute_mix',
      date: SAT,
      shift_name: 'Evening',
      description: 'This shift requires at least 2 veterans, but only 1 could be placed.',
      metadata: {},
    };
    const html = renderHtml(makeResult({ gaps: [], flagged_issues: [flagged] }), resolve);
    expect(html).toMatch(/Evening<span[^>]*>≥2 veterans<\/span>/);
  });

  it('renders cleanly with no resolver (back-compat — no tags anywhere)', () => {
    const html = renderHtml(makeResult());
    const text = renderText(makeResult());
    expect(html).not.toContain('Veterans only');
    expect(html).not.toContain('veterans</span>');
    expect(text).not.toContain(' · Veterans only');
    // The existing report still renders its Distribute action.
    expect(html).toContain('Distribute Schedule');
  });
});
