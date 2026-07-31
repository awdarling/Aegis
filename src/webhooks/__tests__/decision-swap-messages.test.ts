import { describe, it, expect, vi } from 'vitest';

// buildSwapDecisionMessages is pure, but decision.ts pulls express + the DB +
// messaging at module load, so mock those to import the helper side-effect-free.
vi.mock('../../config/env', () => ({ env: { EMAIL_ONLY: true } }));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ normalizeReSubject: vi.fn() }));
vi.mock('../../messaging/brand', () => ({ BRAND: {}, logoUrl: () => '' }));
vi.mock('../../workflows/shift-swap', () => ({ executeScheduleSwap: vi.fn(), executeScheduleTrade: vi.fn() }));
vi.mock('../../workflows/emergency-coverage', () => ({ processCoverageButtonDecision: vi.fn(), processCoverageBatchButton: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import { buildSwapDecisionMessages } from '../decision';

// A giveaway: Sam gives his Sat shift to Riley; Riley covers, Sam is off. There
// is NO return shift, so isTrade = false.
const GIVEAWAY = {
  shift_name: 'AM Lifeguard',
  receiver_name: 'Riley Brooks',
  target_shift_name: null,
};

describe('buildSwapDecisionMessages — giveaway (WM coverer-name bug)', () => {
  const { requesterMsg, receiverMsg } = buildSwapDecisionMessages(
    GIVEAWAY,
    false,
    'Saturday, August 1',
    'Saturday, August 1',
  );

  it('tells the giver that the RECEIVER covers, and that they are off', () => {
    expect(requesterMsg).toContain('Riley Brooks will cover your AM Lifeguard shift');
    expect(requesterMsg).toContain("you're off");
  });

  it('tells the coverer THEY cover — never that the giver covers', () => {
    expect(receiverMsg).toContain("You'll cover the AM Lifeguard shift");
    // The bug rendered "<giver> will cover" to the coverer. Both messages must
    // ground on the receiver; neither may name anyone else as the coverer.
    expect(receiverMsg).not.toMatch(/will cover/);
    expect(receiverMsg).not.toContain('Sam');
  });
});

describe('buildSwapDecisionMessages — trade (unchanged perspective)', () => {
  const { requesterMsg, receiverMsg } = buildSwapDecisionMessages(
    { shift_name: 'AM Lifeguard', receiver_name: 'Riley Brooks', target_shift_name: 'PM Front Desk' },
    true,
    'Saturday, August 1',
    'Sunday, August 2',
  );

  it('each person hears the shift they now work', () => {
    expect(requesterMsg).toContain('shift trade has been approved');
    expect(requesterMsg).toContain("You're now on the PM Front Desk shift on Sunday, August 2");
    expect(receiverMsg).toContain("You're now on the AM Lifeguard shift on Saturday, August 1");
  });
});
