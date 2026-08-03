import { describe, it, expect, vi } from 'vitest';
import type { PartialDayDetail } from '../../db/types';

// H1: the manager time-off email must render a partial-day window (e.g. a
// morning), not a whole day. These pin the exported partial-day formatters that
// the manager email now uses. Mock the module's runtime deps so importing it
// touches nothing real (the formatters themselves are pure).
vi.mock('../../lib/aegis-actions/tokens', () => ({ generateActionToken: vi.fn() }));
vi.mock('../../messaging/greeting', () => ({ greeting: () => 'Hi', firstName: (n: string) => n }));
vi.mock('../../config/urls', () => ({ getHomebaseUrl: () => 'https://x.test' }));
vi.mock('../../messaging/brand', () => ({
  BRAND: {}, brandedEmailShell: (x: unknown) => x, brandedButtonRow: () => '', brandActionCard: () => '',
}));

import { describePartialDay, buildPartialSummaryText } from '../time-off-manager-email';

const morning: PartialDayDetail = {
  date: '2026-08-12', type: 'custom_hours', start_time: '09:00', end_time: '13:00',
};

describe('partial-day rendering used by the manager email (H1)', () => {
  it('describePartialDay shows the date AND the time window (not a whole day)', () => {
    const s = describePartialDay(morning);
    expect(s).toMatch(/Aug 12/);
    expect(s).toMatch(/9:00\s?AM/i);
    expect(s).toMatch(/1:00\s?PM/i);
  });

  it('buildPartialSummaryText summarizes the window', () => {
    const s = buildPartialSummaryText([morning]);
    expect(s).toMatch(/9:00\s?AM/i);
    expect(s).toMatch(/1:00\s?PM/i);
  });

  it('a shift-off partial names the shift, not a full day', () => {
    const shiftOff: PartialDayDetail = { date: '2026-08-12', type: 'shift_off', shift_name: 'AM' };
    expect(describePartialDay(shiftOff)).toMatch(/AM off/);
  });
});
