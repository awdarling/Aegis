import { describe, it, expect, vi } from 'vitest';

// claude.ts constructs the Anthropic client + reads env at module load. Mock both
// so we can import its PURE helpers without side effects.
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('../../config/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'k', BASE_URL: 'http://localhost:3000', NODE_ENV: 'test' },
}));

import { weekdayAnchors } from '../claude';

// ── Weekday → date anchors (this week + next week) ────────────────────────────
//
// The classifier resolves bare/"this" weekdays from the THIS-week table and
// "next <weekday>" from the NEXT-week table. Both are computed in code so the
// model never does weekday arithmetic. These tests pin the date math the swap
// date-resolution depends on — specifically that a swap can reach NEXT week's
// schedule (next-week occurrence = this-week occurrence + 7).

function find(rows: { name: string; iso: string; isToday: boolean }[], name: string) {
  return rows.find(r => r.name === name)!;
}

describe('weekdayAnchors', () => {
  it('THIS week = nearest upcoming occurrence; NEXT week = +7', () => {
    // 2026-07-29 is a Wednesday.
    const { todayName, thisWeek, nextWeek } = weekdayAnchors('2026-07-29');
    expect(todayName).toBe('Wednesday');

    // Nearest Saturday from Wed 7/29 is 8/01; next Saturday is 8/08.
    expect(find(thisWeek, 'Saturday').iso).toBe('2026-08-01');
    expect(find(nextWeek, 'Saturday').iso).toBe('2026-08-08');

    // Nearest Friday is 7/31; next Friday is 8/07.
    expect(find(thisWeek, 'Friday').iso).toBe('2026-07-31');
    expect(find(nextWeek, 'Friday').iso).toBe('2026-08-07');
  });

  it('every next-week date is exactly 7 days after its this-week date', () => {
    const { thisWeek, nextWeek } = weekdayAnchors('2026-07-29');
    for (const t of thisWeek) {
      const n = find(nextWeek, t.name);
      const diff =
        (new Date(n.iso + 'T12:00:00Z').getTime() - new Date(t.iso + 'T12:00:00Z').getTime()) /
        86400000;
      expect(diff).toBe(7);
    }
  });

  it("today's weekday: THIS week resolves to today (0 days ahead), NEXT week to +7", () => {
    // 2026-07-29 is a Wednesday, so "this Wednesday" is today.
    const { thisWeek, nextWeek } = weekdayAnchors('2026-07-29');
    const wedThis = find(thisWeek, 'Wednesday');
    expect(wedThis.iso).toBe('2026-07-29');
    expect(wedThis.isToday).toBe(true);
    expect(find(nextWeek, 'Wednesday').iso).toBe('2026-08-05');
  });

  it('handles month/year wraparound', () => {
    // 2026-12-31 is a Thursday. Nearest Friday is 2027-01-01; next Friday 2027-01-08.
    const { thisWeek, nextWeek } = weekdayAnchors('2026-12-31');
    expect(find(thisWeek, 'Friday').iso).toBe('2027-01-01');
    expect(find(nextWeek, 'Friday').iso).toBe('2027-01-08');
  });

  it('exposes all seven weekdays in each table', () => {
    const { thisWeek, nextWeek } = weekdayAnchors('2026-07-29');
    const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    expect(thisWeek.map(r => r.name).sort()).toEqual([...names].sort());
    expect(nextWeek.map(r => r.name).sort()).toEqual([...names].sort());
  });
});
