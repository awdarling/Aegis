// employees.schedulable — "here, reachable, never rostered" (migration 025).
//
// Alexander, 2026-08-18: an owner who never works the floor still needs a person
// record so Aegis can text them, but must never appear on a schedule. That is a
// DIFFERENT question from `active`, which means "here right now" — and the two
// must not be conflated, because turning an owner inactive would stop Aegis
// contacting them, which is the exact problem we are solving.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('the engine roster excludes people who cannot be scheduled', () => {
  const build = read('src/workflows/schedule-build.ts');

  it('filters the roster on schedulable as well as active', () => {
    expect(build).toMatch(/schedulable\.is\.null,schedulable\.eq\.true/);
  });

  it('still filters on active — schedulable does not replace it', () => {
    expect(build).toMatch(/\.eq\('company_id', companyId\)\.eq\('active', true\)/);
  });

  it('treats a NULL schedulable as schedulable, so a pre-migration tenant is unaffected', () => {
    // The column arrives with DEFAULT true, but a tenant read through an older
    // client, or a row created before the migration lands, can surface NULL.
    // Defaulting NULL to "excluded" would silently empty someone's roster.
    expect(build).toMatch(/schedulable\.is\.null/);
  });
});

describe('schedulable and active stay different questions', () => {
  it('the distribution lists do NOT filter on schedulable', () => {
    // Sending someone the published schedule is contact, not rostering. An
    // owner who wants to see the schedule still gets it; that is governed by
    // their notification preferences, not by whether they work shifts.
    const build = read('src/workflows/schedule-build.ts');
    const distributionQueries = build.match(
      /supabase\.from\('employees'\)\.select\('id, name, contact_email, contact_phone'\)[^\n]*/g
    ) ?? [];
    expect(distributionQueries.length).toBeGreaterThan(0);
    for (const q of distributionQueries) {
      expect(q).not.toMatch(/schedulable/);
    }
  });

  it('the manager directory does not filter on schedulable either', () => {
    // Being unschedulable must never make someone unreachable.
    expect(read('src/messaging/manager-directory.ts')).not.toMatch(/schedulable/);
  });

  it('the migration documents the difference so nobody merges the two flags', () => {
    const m = read('migrations/025_link_users_to_employees.sql');
    expect(m).toMatch(/schedulable boolean NOT NULL DEFAULT true/);
    expect(m).toMatch(/Different from active/);
  });
});
