/**
 * Smoke test for src/workflows/time-off-manager-email.ts (Phase 3).
 *
 * Builds the manager email for a full-day request and a partial-day request,
 * validates subject/html/text and that both approve+deny tokens land in
 * aegis_action_tokens with the correct action_types and shared payload.
 *
 * Run: npx tsx scripts/smoke-time-off-manager-email.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });

import { supabase } from '../src/db/client';
import { hashToken } from '../src/lib/aegis-actions/tokens';
import { buildTimeOffManagerEmail, type TimeOffRecommendation } from '../src/workflows/time-off-manager-email';
import type { Employee, TimeOffRequest, PartialDayDetail } from '../src/db/types';
import type { SimulationResult } from '../src/lib/schedule-simulator';

const COMPANY_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const COMPANY_NAME = 'Watermark';
const MANAGER_EMAIL = 'manager-smoke@test.local';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fixtureEmployee(): Employee {
  return {
    id: 'e-smoke-1',
    company_id: COMPANY_ID,
    name: 'Riley Test',
    primary_role: 'lead',
    qualified_roles: ['lead', 'support'],
    max_weekly_hours: 40,
    contact_phone: '+15551234567',
    contact_email: 'riley@example.com',
    active: true,
    created_at: new Date().toISOString(),
    individual_wage: null,
    is_veteran: false,
  };
}

function fixtureFullDayRequest(): TimeOffRequest {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    employee_id: 'e-smoke-1',
    company_id: COMPANY_ID,
    start_date: '2026-06-05',
    end_date: '2026-06-07',
    reason: 'family wedding',
    status: 'pending',
    requested_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
    aegis_recommendation: null,
    aegis_reasoning: null,
    time_off_type: 'full_day',
    partial_days: null,
  };
}

function fixturePartialDayRequest(): TimeOffRequest {
  const partial_days: PartialDayDetail[] = [
    {
      date: '2026-06-10',
      type: 'custom_hours',
      shift_id: null,
      shift_name: null,
      start_time: '13:00',
      end_time: '17:00',
    },
    {
      date: '2026-06-11',
      type: 'custom_hours',
      shift_id: null,
      shift_name: null,
      start_time: '13:00',
      end_time: '17:00',
    },
  ];
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    employee_id: 'e-smoke-1',
    company_id: COMPANY_ID,
    start_date: '2026-06-10',
    end_date: '2026-06-11',
    reason: 'medical appointment',
    status: 'pending',
    requested_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
    aegis_recommendation: null,
    aegis_reasoning: null,
    time_off_type: 'partial',
    partial_days,
  };
}

function fixtureSimulation(periodStart: string, periodEnd: string): SimulationResult {
  return {
    overall_feasible: false,
    affected_shifts: [
      {
        date: periodStart,
        shift_name: 'Day',
        role: 'lead',
        required_count: 2,
        covered_without: 2,
        covered_with: 1,
        shift_start: '08:00',
        shift_end: '16:00',
      },
    ],
    coverage_gaps: [
      { date: periodStart, shift_name: 'Day', role: 'lead', shortfall: 1 },
    ],
    available_alternates: [],
    coverage_rate_before: 100.0,
    coverage_rate_after: 92.3,
    period_start: periodStart,
    period_end: periodEnd,
    special_notes_affecting_period: [],
  };
}

const RECOMMENDATION_REASONING =
  'Approving this would leave the lead role short by 1 on Friday, and no available alternates are qualified for that role on that date.';

function fixtureRecommendation(): TimeOffRecommendation {
  return {
    type: 'neutral',
    reasoning: RECOMMENDATION_REASONING,
  };
}

// ── Per-variant runner ───────────────────────────────────────────────────────

async function runVariant(
  label: string,
  tor: TimeOffRequest,
  expectedDateFragment: string
): Promise<void> {
  const employee = fixtureEmployee();
  const simulation = fixtureSimulation(tor.start_date, tor.end_date);
  const recommendation = fixtureRecommendation();

  const { subject, html, text } = await buildTimeOffManagerEmail({
    time_off_request: tor,
    employee,
    company_id: COMPANY_ID,
    company_name: COMPANY_NAME,
    manager_email: MANAGER_EMAIL,
    simulation,
    recommendation,
  });

  // Subject contains employee name + date fragment
  assert(subject.includes(employee.name), `[${label}] subject should contain employee name: ${subject}`);
  assert(
    subject.includes(expectedDateFragment),
    `[${label}] subject should contain "${expectedDateFragment}": ${subject}`
  );

  // Both CTA button texts present
  assert(html.includes('>Approve<'), `[${label}] html should contain Approve button text`);
  assert(html.includes('>Deny<'), `[${label}] html should contain Deny button text`);

  // Two magic-link URLs in the html, and they differ
  const hrefs = Array.from(html.matchAll(/href="([^"]+\/api\/aegis-action\?token=[^"]+)"/g))
    .map(m => decodeHtmlAttr(m[1]));
  assert(hrefs.length === 2, `[${label}] expected 2 magic-link URLs in html, got ${hrefs.length}`);
  assert(hrefs[0] !== hrefs[1], `[${label}] approve and deny URLs must differ`);

  // Recommendation reasoning appears in both HTML and text
  assert(
    html.includes(RECOMMENDATION_REASONING),
    `[${label}] html should contain recommendation reasoning text`
  );
  assert(
    text.includes(RECOMMENDATION_REASONING),
    `[${label}] text should contain recommendation reasoning text`
  );

  // Employee name in both bodies
  assert(html.includes(employee.name), `[${label}] html should contain employee name`);
  assert(text.includes(employee.name), `[${label}] text should contain employee name`);

  // Partial-day variant: per-day windows render
  if (tor.time_off_type === 'partial' && tor.partial_days) {
    assert(
      html.includes('1:00 PM') || html.includes('13:00'),
      `[${label}] partial-day html should mention the 1pm window`
    );
    assert(
      text.includes('1:00 PM') || text.includes('13:00'),
      `[${label}] partial-day text should mention the 1pm window`
    );
  }

  // Round-trip both tokens through the DB and verify shape + payload.
  const verified: string[] = [];
  for (const href of hrefs) {
    const tokenParam = new URL(href).searchParams.get('token');
    assert(tokenParam, `[${label}] magic-link should have ?token=: ${href}`);
    const tokenHash = hashToken(tokenParam!);

    const { data: row, error } = await supabase
      .from('aegis_action_tokens')
      .select('id, action_type, payload, company_id, issued_to_email, consumed_at')
      .eq('token_hash', tokenHash)
      .single();
    assert(!error, `[${label}] lookup by token_hash failed: ${error?.message}`);
    assert(row, `[${label}] token row missing for url ${href}`);
    const actionType = row!.action_type as string;
    assert(
      actionType === 'approve_to' || actionType === 'deny_to',
      `[${label}] unexpected action_type: ${actionType}`
    );
    const payload = row!.payload as Record<string, unknown>;
    assert(
      payload.time_off_request_id === tor.id,
      `[${label}] payload.time_off_request_id mismatch: ${JSON.stringify(payload)}`
    );
    assert(
      payload.employee_id === employee.id,
      `[${label}] payload.employee_id mismatch: ${JSON.stringify(payload)}`
    );
    assert(
      payload.start_date === tor.start_date,
      `[${label}] payload.start_date mismatch`
    );
    assert(
      payload.end_date === tor.end_date,
      `[${label}] payload.end_date mismatch`
    );
    assert(
      payload.company_name === COMPANY_NAME,
      `[${label}] payload.company_name mismatch`
    );
    assert(row!.company_id === COMPANY_ID, `[${label}] company_id mismatch`);
    assert(row!.issued_to_email === MANAGER_EMAIL, `[${label}] issued_to_email mismatch`);
    assert(row!.consumed_at === null, `[${label}] consumed_at should be null on insert`);
    verified.push(row!.id as string);
  }
  // The pair must contain one approve_to and one deny_to.
  const actions = await supabase
    .from('aegis_action_tokens')
    .select('action_type')
    .in('id', verified);
  const types = (actions.data ?? []).map(r => (r as { action_type: string }).action_type).sort();
  assert(
    types[0] === 'approve_to' && types[1] === 'deny_to',
    `[${label}] expected one approve_to + one deny_to, got ${JSON.stringify(types)}`
  );

  // Cleanup
  const { error: delErr } = await supabase
    .from('aegis_action_tokens')
    .delete()
    .in('id', verified);
  assert(!delErr, `[${label}] cleanup delete failed: ${delErr?.message}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runVariant('full-day', fixtureFullDayRequest(), 'Jun 5–7, 2026');
  await runVariant('partial-day', fixturePartialDayRequest(), 'Jun 10–11, 2026');
  console.log('✓ All smoke-time-off-manager-email assertions passed');
}

main().catch((err) => {
  console.error('[smoke-time-off-manager-email] failed:', err);
  process.exit(1);
});
