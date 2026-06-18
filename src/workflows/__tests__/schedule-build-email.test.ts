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
import { buildShiftRuleLabels } from '../../lib/engine/experience-rules';
import type { EngineExperienceRule } from '../../lib/engine/experience-rules';
import type {
  RunScheduleBuildResult,
  ScheduleGap,
  FlaggedIssue,
} from '../schedule-build';
import type { WageEstimate } from '../../lib/schedule-simulator';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Three shift types: Morning (all-veterans rule), Evening (≥2 rule),
// Midday (no rule). The veteran tag must land on the first two and never the
// third, matching the wording the Homebase grid shows.
const SHIFT_TYPES = [
  { id: 'st-morning', name: 'Morning' },
  { id: 'st-evening', name: 'Evening' },
  { id: 'st-midday', name: 'Midday' },
];

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

const RULES: EngineExperienceRule[] = [
  rule({ shift_type_id: 'st-morning', mode: 'all_veterans' }),
  rule({ shift_type_id: 'st-evening', mode: 'min_veterans', min_count: 2 }),
];

function gap(shift_name: string): ScheduleGap {
  return {
    date: '2026-06-20', // a Saturday
    shift_name,
    role: 'Lifeguard',
    required_count: 2,
    filled_count: 1,
    reason: 'no eligible candidates',
    description: 'no eligible candidates',
    per_employee_dispositions: [],
  };
}

const WAGES: WageEstimate = {
  total_estimated: 1000,
  by_employee: [],
  missing_wages: [],
};

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
    gaps: [gap('Morning'), gap('Evening'), gap('Midday')],
    flagged_issues: [],
    closed_dates: [],
    shift_override_mismatches: [],
    totalRequired: 10,
    totalFilled: 8,
    ...overrides,
  };
}

function renderHtml(result: RunScheduleBuildResult, labels: Record<string, string>): string {
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
    shiftRuleLabels: labels,
  });
}

function renderText(result: RunScheduleBuildResult, labels: Record<string, string>): string {
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
    mismatches: result.shift_override_mismatches,
    distributeUrl: 'https://homebase.test.local/x',
    homebaseUrl: 'https://homebase.test.local',
    shiftRuleLabels: labels,
  });
}

// ── buildShiftRuleLabels ────────────────────────────────────────────────────────

describe('buildShiftRuleLabels', () => {
  it('maps all-veterans → "Veterans only" and min-N → "≥N veterans", keyed by shift name', () => {
    const labels = buildShiftRuleLabels(RULES, SHIFT_TYPES);
    expect(labels).toEqual({
      Morning: 'Veterans only',
      Evening: '≥2 veterans',
    });
  });

  it('defaults a min rule with no count to ≥1, and ignores inactive / type-less rules', () => {
    const labels = buildShiftRuleLabels(
      [
        rule({ shift_type_id: 'st-morning', mode: 'min_veterans', min_count: null }),
        rule({ shift_type_id: 'st-evening', mode: 'all_veterans', active: false }),
        rule({ shift_type_id: null, mode: 'all_veterans' }),
      ],
      SHIFT_TYPES
    );
    expect(labels).toEqual({ Morning: '≥1 veterans' });
  });

  it('first rule per shift wins', () => {
    const labels = buildShiftRuleLabels(
      [
        rule({ shift_type_id: 'st-morning', mode: 'all_veterans' }),
        rule({ shift_type_id: 'st-morning', mode: 'min_veterans', min_count: 3 }),
      ],
      SHIFT_TYPES
    );
    expect(labels).toEqual({ Morning: 'Veterans only' });
  });
});

// ── Tag rendering in the emailed report ─────────────────────────────────────────

describe('veteran tag in the schedule-build email', () => {
  it('HTML: tags the constrained gap rows (and only those) with the grid wording', () => {
    const labels = buildShiftRuleLabels(RULES, SHIFT_TYPES);
    const html = renderHtml(makeResult(), labels);

    // The grid-matching labels appear...
    expect(html).toContain('Veterans only');
    expect(html).toContain('≥2 veterans');

    // ...attached to the right shift rows. The Morning row carries the
    // all-veterans tag right after its <strong> shift label.
    expect(html).toMatch(/Morning Lifeguard<\/strong><span[^>]*>Veterans only<\/span>/);
    expect(html).toMatch(/Evening Lifeguard<\/strong><span[^>]*>≥2 veterans<\/span>/);

    // The unconstrained Midday row gets no tag.
    expect(html).toMatch(/Midday Lifeguard<\/strong>\s*<span style="color:/);
    expect(html).not.toMatch(/Midday Lifeguard<\/strong><span[^>]*>(Veterans only|≥)/);
  });

  it('plain text: tags the constrained gap rows (and only those)', () => {
    const labels = buildShiftRuleLabels(RULES, SHIFT_TYPES);
    const text = renderText(makeResult(), labels);

    expect(text).toContain('Morning Lifeguard · Veterans only (1/2)');
    expect(text).toContain('Evening Lifeguard · ≥2 veterans (1/2)');
    // Midday has no rule, so no tag between the role and the count.
    expect(text).toContain('Midday Lifeguard (1/2)');
    expect(text).not.toContain('Midday Lifeguard ·');
  });

  it('tags a flagged-issue card for a constrained shift', () => {
    const flagged: FlaggedIssue = {
      type: 'unsatisfied_attribute_mix',
      date: '2026-06-20',
      shift_name: 'Morning',
      description: 'This shift is set to require all veterans, but only 1 of 2 position(s) could be filled by veterans.',
      metadata: {},
    };
    const labels = buildShiftRuleLabels(RULES, SHIFT_TYPES);
    const html = renderHtml(makeResult({ gaps: [], flagged_issues: [flagged] }), labels);
    expect(html).toMatch(/Morning<span[^>]*>Veterans only<\/span>/);
  });

  it('renders cleanly with no labels (back-compat — no tags anywhere)', () => {
    const html = renderHtml(makeResult(), {});
    const text = renderText(makeResult(), {});
    expect(html).not.toContain('Veterans only');
    expect(html).not.toContain('veterans</span>');
    expect(text).not.toContain(' · Veterans only');
    // The existing report still renders its Distribute action.
    expect(html).toContain('Distribute Schedule');
  });
});
