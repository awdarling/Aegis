// Payroll removal guard — 2026-08-18.
//
// Decision (Alexander, 2026-08-18): payroll is NOT built, so all payroll code
// comes out and Homebase keeps only a "coming soon" page. What is REMOVED is the
// unbuilt payroll check, its cron, and its stub provider adapters. What STAYS is
// every wage feature a manager actually uses — the labour-cost estimate on a
// schedule build, the wage breakdown, the per-role rate table, wages on the
// dashboard, and a manager's ability to set an employee's wage by message.
//
// These tests exist so nobody quietly reintroduces the payroll surface, and so
// the wage features are proven still standing after the sweep.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { MANAGER_INTENTS } from '../../ai/claude';
import { INTERRUPTING_MANAGER_ACTION_INTENTS } from '../../router/interrupt';

const repoRoot = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

describe('payroll removal — the feature is gone', () => {
  it('the payroll source files no longer exist', () => {
    for (const rel of [
      'src/workflows/payroll.ts',
      'src/scheduler/payroll-scheduler.ts',
      'src/lib/payroll-reconciler.ts',
      'src/lib/integrations/payroll-adapter.ts',
      'src/lib/integrations/time-clock-adapter.ts',
      'src/lib/integrations/factory.ts',
      'src/lib/integrations/northstar.ts',
      'src/lib/integrations/axios-engage.ts',
    ]) {
      expect(existsSync(resolve(repoRoot, rel)), `${rel} should be deleted`).toBe(false);
    }
  });

  it('run_payroll_check is not offered to the classifier as a manager intent', () => {
    // MANAGER_INTENTS is injected verbatim into the prompt sent to Claude on
    // every inbound manager message. Leaving it in means Aegis keeps advertising
    // a feature that cannot run.
    expect(MANAGER_INTENTS).not.toContain('run_payroll_check');
  });

  it('run_payroll_check cannot interrupt a pending conversation', () => {
    expect(INTERRUPTING_MANAGER_ACTION_INTENTS.has('run_payroll_check')).toBe(false);
  });

  it('the intent router has no payroll import, case, or manager-intent entry', () => {
    const src = read('src/router/intent-router.ts');
    expect(src).not.toMatch(/workflows\/payroll/);
    expect(src).not.toMatch(/handlePayrollCheck/);
    expect(src).not.toMatch(/run_payroll_check/);
  });

  it('no payroll scheduler is started at boot', () => {
    // This one ran on a 24h timer in production, swept every tenant, and
    // fabricated an inbound message as if a real manager had sent it.
    const src = read('src/index.ts');
    expect(src).not.toMatch(/payroll/i);
    // The two schedulers that DO exist must still be wired up.
    expect(src).toMatch(/startCoverageTimeoutScheduler\(\)/);
    expect(src).toMatch(/startEmployeeOffboardingScheduler\(\)/);
  });

  it('getManagerSmsChannel is gone from the codebase', () => {
    // It queried users, discarded the result, and returned the tenant's own
    // Aegis outbound number — so `to` equalled `from` and Aegis texted itself.
    // A manager's phone comes from their employee record, never from
    // company_channels.
    const src = read('src/workflows/departure.ts');
    expect(existsSync(resolve(repoRoot, 'src/workflows/payroll.ts'))).toBe(false);
    // The warning about the mistake must survive the deletion of the code.
    expect(src).toMatch(/getManagerSmsChannel/);
    expect(src).toMatch(/never from company_channels/);
  });
});

describe('payroll removal — the wage features are untouched', () => {
  it('the wage estimator still exists and still resolves both rate sources', async () => {
    const sim = await import('../../lib/schedule-simulator');
    expect(typeof sim.computeWageEstimate).toBe('function');
    expect(typeof sim.computeWageEstimateFromMaps).toBe('function');
  });

  it('a manager can still edit an employee wage and a role rate', async () => {
    const src = read('src/workflows/operational-query.ts');
    // individual_wage stays editable, wage_rates stays a known table, and the
    // plain-English synonyms a manager would actually type still map.
    expect(src).toMatch(/individual_wage/);
    expect(src).toMatch(/wage_rates/);
    expect(src).toMatch(/'pay rate': 'individual_wage'|'wage': 'individual_wage'/);
    // ...but the push to an outside payroll provider is gone.
    expect(src).not.toMatch(/handleWageRateSync/);
    expect(src).not.toMatch(/from '\.\/payroll'/);
  });

  it('employees still cannot see wages — the privacy backstop survives', () => {
    const src = read('src/workflows/operational-query.ts');
    expect(src).toMatch(/EMPLOYEE_REDACTED_FIELDS/);
    const block = src.slice(src.indexOf('EMPLOYEE_REDACTED_FIELDS'));
    expect(block.slice(0, 400)).toMatch(/individual_wage/);
  });

  it('the schedule build and its email still report estimated labour cost', () => {
    expect(read('src/workflows/schedule-build.ts')).toMatch(/computeWageEstimate|estimated_wages/);
    expect(read('src/workflows/schedule-build-email.ts')).toMatch(/wagesSectionHtml|ESTIMATED LABOR/i);
  });

  it('swaps and emergency coverage still keep the labour cost correct after they change a schedule', () => {
    expect(read('src/workflows/shift-swap.ts')).toMatch(/estimated_wages/);
    expect(read('src/workflows/emergency-coverage.ts')).toMatch(/estimated_wages/);
  });
});
