/**
 * Smoke test for src/workflows/schedule-build-email.ts (Phase 2 email
 * formatter). Builds a synthetic RunScheduleBuildResult with the diagnostic
 * shapes a real Watermark build would produce, runs the formatter, and
 * validates subject/html/text plus the round-trip of the magic-link token
 * through the aegis_action_tokens table.
 *
 * Run: npx tsx scripts/smoke-schedule-build-email.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });

import { supabase } from '../src/db/client';
import { hashToken } from '../src/lib/aegis-actions/tokens';
import { buildScheduleResultEmail } from '../src/workflows/schedule-build-email';
import type {
  RunScheduleBuildResult,
  ScheduleAssignment,
  ScheduleGap,
  FlaggedIssue,
  ShiftOverrideMismatch,
} from '../src/workflows/schedule-build';
import type { ClosedDate } from '../src/lib/engine/canvas';
import type { EmployeeDisposition } from '../src/lib/engine/dispositions';
import type { WageEstimate } from '../src/lib/schedule-simulator';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const COMPANY_NAME = 'Watermark';
const SCHEDULE_ID = 'smoke-schedule-uuid-fake';
const WEEK_START = '2026-06-01';
const WEEK_END = '2026-06-07';
const MANAGER_EMAIL = 'manager-smoke@test.local';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Fixture builders ─────────────────────────────────────────────────────────

function buildFixture(): {
  result: RunScheduleBuildResult;
  wages: WageEstimate;
  employeeMaxHours: Map<string, { name: string; max_weekly_hours: number }>;
  // Names we expect to surface in both HTML and plain-text bodies.
  expectedNames: string[];
} {
  // 4 active employees in our fixture pool.
  const employeeMaxHours = new Map<string, { name: string; max_weekly_hours: number }>([
    ['e1', { name: 'Alice Worker',     max_weekly_hours: 40 }],
    ['e2', { name: 'Bob Reserve',      max_weekly_hours: 40 }],
    ['e3', { name: 'Carla Newhire',    max_weekly_hours: 30 }],
    ['e4', { name: 'Diego Veteran',    max_weekly_hours: 35 }],
  ]);

  // Assignments: Alice at 38h (95% of 40 → triggers the "over 80%" rule),
  // Bob at 24h, Diego at 16h. Carla intentionally unassigned (lets us
  // ensure her name still surfaces via the missing-wage list).
  const assignments: ScheduleAssignment[] = [
    { date: '2026-06-01', employee_id: 'e1', employee_name: 'Alice Worker', shift_name: 'Day', role: 'lead',     start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-02', employee_id: 'e1', employee_name: 'Alice Worker', shift_name: 'Day', role: 'lead',     start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-03', employee_id: 'e1', employee_name: 'Alice Worker', shift_name: 'Day', role: 'lead',     start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-04', employee_id: 'e1', employee_name: 'Alice Worker', shift_name: 'Day', role: 'lead',     start_time: '08:00', end_time: '14:00', hours: 6 },
    { date: '2026-06-05', employee_id: 'e1', employee_name: 'Alice Worker', shift_name: 'Day', role: 'lead',     start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-01', employee_id: 'e2', employee_name: 'Bob Reserve',  shift_name: 'Day', role: 'support',  start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-02', employee_id: 'e2', employee_name: 'Bob Reserve',  shift_name: 'Day', role: 'support',  start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-03', employee_id: 'e2', employee_name: 'Bob Reserve',  shift_name: 'Day', role: 'support',  start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-04', employee_id: 'e4', employee_name: 'Diego Veteran', shift_name: 'Day', role: 'lead',    start_time: '08:00', end_time: '16:00', hours: 8 },
    { date: '2026-06-05', employee_id: 'e4', employee_name: 'Diego Veteran', shift_name: 'Day', role: 'lead',    start_time: '08:00', end_time: '16:00', hours: 8 },
  ];

  const gapDispositions: EmployeeDisposition[] = [
    { employee_id: 'e2', name: 'Bob Reserve',  reason: 'doubles_blocked' },
    { employee_id: 'e3', name: 'Carla Newhire', reason: 'not_qualified' },
    { employee_id: 'e4', name: 'Diego Veteran', reason: 'on_time_off' },
  ];

  const gaps: ScheduleGap[] = [
    {
      date: '2026-06-06',
      shift_name: 'Day',
      role: 'lead',
      required_count: 2,
      filled_count: 0,
      reason: 'All qualified employees are already scheduled for an overlapping shift on 2026-06-06',
      description:
        'lead slot on 2026-06-06 Day unfilled. 3 employees qualified for lead: Bob Reserve (doubles), Carla Newhire (not qualified), Diego Veteran (time off).',
      per_employee_dispositions: gapDispositions,
      start_time: '08:00',
      end_time: '16:00',
    },
  ];

  // Two flagged issues. Both share the only legal `type` (the engine emits
  // 'unsatisfied_attribute_mix' for every flag today) — the smoke is about
  // formatting fidelity, not vocabulary breadth. The first reads like a
  // closed-day style note; the second is a real attribute_mix shortage with
  // per_employee_dispositions in metadata.
  const flagged_issues: FlaggedIssue[] = [
    {
      type: 'unsatisfied_attribute_mix',
      date: '2026-06-06',
      shift_name: 'Day',
      description: 'Closed-day flag: 2026-06-06 marked closed but a coverage requirement remained — investigate.',
      metadata: { kind: 'closed_day_residual' },
    },
    {
      type: 'unsatisfied_attribute_mix',
      date: '2026-06-04',
      shift_name: 'Day',
      description: 'Attribute mix unsatisfied on 2026-06-04 Day — need at least 1 veteran on shift, none assigned.',
      metadata: {
        attribute: 'is_veteran',
        value: 'true',
        required: 1,
        actual: 0,
        per_employee_dispositions: [
          { employee_id: 'e4', name: 'Diego Veteran',   reason: 'max_hours_reached' },
          { employee_id: 'e2', name: 'Bob Reserve',     reason: 'not_qualified' },
        ] as EmployeeDisposition[],
      },
    },
  ];

  const closed_dates: ClosedDate[] = [
    { date: '2026-06-07', event_title: 'Annual Inventory Close' },
  ];

  const shift_override_mismatches: ShiftOverrideMismatch[] = [];

  const result: RunScheduleBuildResult = {
    assignments,
    gaps,
    flagged_issues,
    closed_dates,
    shift_override_mismatches,
    totalRequired: 12,
    totalFilled: 10,
  };

  const wages: WageEstimate = {
    total_estimated: 8420,
    by_employee: [
      { employee_id: 'e1', employee_name: 'Alice Worker',  hours: 38, hourly_rate: 28, estimated_pay: 1064 },
      { employee_id: 'e2', employee_name: 'Bob Reserve',   hours: 24, hourly_rate: 22, estimated_pay: 528 },
      { employee_id: 'e4', employee_name: 'Diego Veteran', hours: 16, hourly_rate: 30, estimated_pay: 480 },
    ],
    missing_wages: [
      { employee_id: 'm1', name: 'Eve Tempworker',  role: 'support' },
      { employee_id: 'm2', name: 'Frank Onboarding', role: 'lead' },
      { employee_id: 'm3', name: 'Grace Floater',   role: 'support' },
    ],
  };

  const expectedNames = [
    'Alice Worker',
    'Bob Reserve',
    'Carla Newhire',
    'Diego Veteran',
    'Eve Tempworker',
    'Frank Onboarding',
    'Grace Floater',
  ];

  return { result, wages, employeeMaxHours, expectedNames };
}

// ── Main flow ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixture = buildFixture();

  const { subject, html, text } = await buildScheduleResultEmail({
    result: fixture.result,
    schedule_id: SCHEDULE_ID,
    company_id: COMPANY_ID,
    company_name: COMPANY_NAME,
    week_start: WEEK_START,
    week_end: WEEK_END,
    manager_email: MANAGER_EMAIL,
    wages: fixture.wages,
    employee_max_hours: fixture.employeeMaxHours,
  });

  assert(subject.includes('Schedule built'), `subject should contain "Schedule built": ${subject}`);
  assert(subject.includes(COMPANY_NAME), `subject should contain "${COMPANY_NAME}": ${subject}`);

  assert(html.includes('Distribute Schedule'), 'html should contain CTA text "Distribute Schedule"');

  // Magic-link URL: extract it from the rendered html. The CTA section
  // emits href="<url>" — find it and confirm the token row exists.
  const hrefMatch = html.match(/href="([^"]+\/api\/aegis-action\?token=[^"]+)"/);
  assert(hrefMatch, 'html should contain a /api/aegis-action?token= URL');
  const distributeUrl = decodeHtmlAttr(hrefMatch![1]);
  assert(html.includes(hrefMatch![1]), 'html body should literally contain the magic-link URL');

  for (const name of fixture.expectedNames) {
    assert(html.includes(name), `html should contain employee name "${name}"`);
    assert(text.includes(name), `text should contain employee name "${name}"`);
  }

  assert(text.length > 200, `text length should exceed 200, got ${text.length}`);
  assert(html.length > 1000, `html length should exceed 1000, got ${html.length}`);

  // Round-trip the token through the DB. Parse out the raw token from the URL,
  // hash it the same way tokens.ts does, and look up the row.
  const tokenParam = new URL(distributeUrl).searchParams.get('token');
  assert(tokenParam, `distribute url should have a ?token= query: ${distributeUrl}`);
  const expectedHash = hashToken(tokenParam!);

  const { data: row, error: lookupErr } = await supabase
    .from('aegis_action_tokens')
    .select('id, action_type, payload, company_id, issued_to_email, consumed_at, expires_at')
    .eq('token_hash', expectedHash)
    .single();

  assert(!lookupErr, `lookup by token_hash failed: ${lookupErr?.message}`);
  assert(row, 'token row should exist in aegis_action_tokens');
  assert(
    row!.action_type === 'confirm_distribution',
    `action_type mismatch: ${row!.action_type}`
  );
  const payload = row!.payload as Record<string, unknown>;
  assert(
    payload.schedule_id === SCHEDULE_ID,
    `payload.schedule_id mismatch: ${JSON.stringify(payload)}`
  );
  assert(
    payload.week_start === WEEK_START,
    `payload.week_start mismatch: ${JSON.stringify(payload)}`
  );
  assert(
    payload.company_name === COMPANY_NAME,
    `payload.company_name mismatch: ${JSON.stringify(payload)}`
  );
  assert(row!.company_id === COMPANY_ID, `company_id mismatch: ${row!.company_id}`);
  assert(
    row!.issued_to_email === MANAGER_EMAIL,
    `issued_to_email mismatch: ${row!.issued_to_email}`
  );
  assert(
    row!.consumed_at === null,
    `consumed_at should be null on fresh insert: ${row!.consumed_at}`
  );

  // Cleanup
  const { error: delErr } = await supabase
    .from('aegis_action_tokens')
    .delete()
    .eq('id', row!.id);
  assert(!delErr, `cleanup delete failed: ${delErr?.message}`);

  console.log('✓ All smoke-schedule-build-email assertions passed');
}

function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

main().catch((err) => {
  console.error('[smoke-schedule-build-email] failed:', err);
  process.exit(1);
});
