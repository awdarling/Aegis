import { describe, it, expect } from 'vitest';
import { resolveAvailabilityForWeek, type CustomAvailabilityRow } from '../custom-availability';
import type { Employee } from '../../db/types';

// Minimal employee — the resolver only uses id/company_id (for synthesized slots).
const emp = {
  id: 'e1', company_id: 'c1', name: 'E', primary_role: 'Lifeguard',
  qualified_roles: ['Lifeguard'], max_weekly_hours: 40, contact_phone: null,
  contact_email: null, active: true, created_at: '2026-01-01T00:00:00Z',
  individual_wage: null, is_veteran: false,
} as unknown as Employee;

function rotating(overrides: Partial<CustomAvailabilityRow> = {}): CustomAvailabilityRow {
  return {
    id: 'ca1', employee_id: 'e1', company_id: 'c1', type: 'rotating',
    end_date: '2026-10-10', cycle_weeks: 2, cycle_start_date: '2026-05-20', // a WEDNESDAY
    // week 1 → Monday only; week 2 → Friday only (so the two weeks are easy to tell apart)
    patterns: [
      { week: 1, days: [{ day_of_week: 1, start_time: '08:00', end_time: '22:00' }] },
      { week: 2, days: [{ day_of_week: 5, start_time: '08:00', end_time: '22:00' }] },
    ],
    active: true, created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as CustomAvailabilityRow;
}

const dows = (slots: { day_of_week: number }[]) => slots.map(s => s.day_of_week).sort();

describe('resolveAvailabilityForWeek — rotating cycle alignment (CUSTOM-AVAIL-ALIGN)', () => {
  // Monday-start weeks. cycle_start is a Wednesday (2026-05-20) → the fix must
  // anchor the rotation to the Monday of that week (2026-05-18) so build weeks
  // read ONE rotation-week pattern each, alternating correctly.
  it('week containing the cycle start → rotation week 1 (Monday pattern)', () => {
    const slots = resolveAvailabilityForWeek(emp, '2026-05-18', '2026-05-24', [], rotating());
    expect(dows(slots)).toEqual([1]);
  });

  it('the next Monday-start week → rotation week 2 (Friday pattern)', () => {
    const slots = resolveAvailabilityForWeek(emp, '2026-05-25', '2026-05-31', [], rotating());
    expect(dows(slots)).toEqual([5]);
  });

  it('two weeks later → back to rotation week 1', () => {
    const slots = resolveAvailabilityForWeek(emp, '2026-06-01', '2026-06-07', [], rotating());
    expect(dows(slots)).toEqual([1]);
  });

  it('a later summer week resolves to a single consistent rotation week (not a mid-week blend)', () => {
    // 2026-07-27 (Mon): (aligned start 2026-05-18 → 70 days → 10 weeks → 10%2=0 → week 1)
    const slots = resolveAvailabilityForWeek(emp, '2026-07-27', '2026-08-02', [], rotating());
    expect(dows(slots)).toEqual([1]);
  });

  it('a week-start BEFORE the raw cycle_start but within its aligned week still applies (no false drop)', () => {
    // 2026-05-18 is 2 days before the raw Wednesday cycle_start; the old code
    // returned normal availability here (daysDiff < 0). Now it correctly applies week 1.
    const slots = resolveAvailabilityForWeek(emp, '2026-05-18', '2026-05-24', [], rotating());
    expect(slots.length).toBeGreaterThan(0);
  });
});

describe('resolveAvailabilityForWeek — unchanged behaviors still hold', () => {
  it('no custom → returns normal availability unchanged (same reference)', () => {
    const normal = [{ id: 'n', employee_id: 'e1', company_id: 'c1', day_of_week: 3, start_time: '09:00', end_time: '17:00' }];
    expect(resolveAvailabilityForWeek(emp, '2026-07-27', '2026-08-02', normal, null)).toBe(normal);
  });

  it('inactive custom → falls back to normal', () => {
    const normal: [] = [];
    const r = resolveAvailabilityForWeek(emp, '2026-07-27', '2026-08-02', normal, rotating({ active: false }));
    expect(r).toBe(normal);
  });

  it('expired date_limited (end_date before week start) → falls back to normal', () => {
    const normal: [] = [];
    const dl = rotating({ type: 'date_limited', end_date: '2026-06-05', cycle_weeks: null, cycle_start_date: null,
      patterns: [{ day_of_week: 2, start_time: '09:00', end_time: '17:00' }] } as Partial<CustomAvailabilityRow>);
    expect(resolveAvailabilityForWeek(emp, '2026-07-27', '2026-08-02', normal, dl)).toBe(normal);
  });

  it('active date_limited → applies its patterns', () => {
    const dl = rotating({ type: 'date_limited', end_date: '2026-12-31', cycle_weeks: null, cycle_start_date: null,
      patterns: [{ day_of_week: 2, start_time: '09:00', end_time: '17:00' }] } as Partial<CustomAvailabilityRow>);
    const slots = resolveAvailabilityForWeek(emp, '2026-07-27', '2026-08-02', [], dl);
    expect(dows(slots)).toEqual([2]);
  });
});
