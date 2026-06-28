import { describe, it, expect, vi } from 'vitest';

// shift-swap pulls in the Supabase client, the Anthropic client, and the
// messaging layer at import. Mock those (env validation + SDK construction) so
// importing the module to reach its PURE helpers doesn't touch anything real.
// Mirrors the mock pattern used by the other workflow tests.
vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test',
    SENDGRID_FROM_EMAIL: 'a@test.local',
    TWILIO_ACCOUNT_SID: 'test',
    TWILIO_AUTH_TOKEN: 'test',
  },
}));
vi.mock('../../db/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(),
  classifyIntent: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn() }));

import {
  computeShiftHours,
  parseYesNo,
  findRequesterShift,
  applySwapToAssignments,
  applyTradeToAssignments,
  chooseTradeShift,
  isReachableForOutreach,
  tradeableShiftsForCandidate,
  partitionSwapCandidates,
  resolveWillingDates,
  weekDatesFrom,
  type TradeSide,
} from '../shift-swap';
import type { Employee } from '../../db/types';
import type { ScheduleAssignment } from '../schedule-build';

function a(partial: Partial<ScheduleAssignment> & { employee_id: string; date: string }): ScheduleAssignment {
  return {
    employee_name: partial.employee_id,
    shift_name: 'Afternoon',
    role: 'Lifeguard',
    start_time: '15:00',
    end_time: '21:00',
    hours: 6,
    ...partial,
  };
}

describe('computeShiftHours', () => {
  it('computes a normal same-day shift', () => {
    expect(computeShiftHours('15:00', '21:00')).toBe(6);
    expect(computeShiftHours('09:00', '15:30')).toBe(6.5);
  });
  it('wraps past midnight', () => {
    expect(computeShiftHours('22:00', '02:00')).toBe(4);
  });
  it('tolerates HH:MM:SS input', () => {
    expect(computeShiftHours('15:00:00', '21:15:00')).toBe(6.3);
  });
});

describe('parseYesNo', () => {
  it('reads affirmatives', () => {
    for (const s of ['yes', 'Yeah', 'yep', 'sure', 'ok', 'okay', 'confirm', "that's right"]) {
      expect(parseYesNo(s)).toBe('yes');
    }
  });
  it('reads negatives', () => {
    for (const s of ['no', 'nope', "can't", 'cancel', 'nah', "don't"]) {
      expect(parseYesNo(s)).toBe('no');
    }
  });
  it('flags ambiguous input as unclear', () => {
    for (const s of ['maybe', 'what time?', 'who is this']) {
      expect(parseYesNo(s)).toBe('unclear');
    }
  });
});

describe('findRequesterShift', () => {
  const data = { assignments: [
    a({ employee_id: 'e1', date: '2026-06-20', shift_name: 'Afternoon' }),
    a({ employee_id: 'e1', date: '2026-06-21', shift_name: 'Morning' }),
    a({ employee_id: 'e2', date: '2026-06-20', shift_name: 'Morning' }),
  ] };
  it('finds the requester shift on the date', () => {
    expect(findRequesterShift(data, 'e1', '2026-06-20')?.shift_name).toBe('Afternoon');
  });
  it('returns null when the requester has nothing that day', () => {
    expect(findRequesterShift(data, 'e2', '2026-06-21')).toBeNull();
  });
});

describe('applySwapToAssignments', () => {
  const assignments = [
    a({ employee_id: 'req', employee_name: 'Requester', date: '2026-06-20', shift_name: 'Afternoon' }),
    a({ employee_id: 'req', employee_name: 'Requester', date: '2026-06-21', shift_name: 'Morning' }),
    a({ employee_id: 'other', employee_name: 'Other', date: '2026-06-20', shift_name: 'Morning' }),
  ];

  it('reassigns only the matching shift to the receiver', () => {
    const out = applySwapToAssignments(assignments, '2026-06-20', 'Afternoon', 'req', 'rcv', 'Receiver');
    const swapped = out.find(x => x.date === '2026-06-20' && x.shift_name === 'Afternoon')!;
    expect(swapped.employee_id).toBe('rcv');
    expect(swapped.employee_name).toBe('Receiver');
    // The requester's OTHER shift is untouched.
    expect(out.find(x => x.date === '2026-06-21')!.employee_id).toBe('req');
    // The unrelated employee is untouched.
    expect(out.find(x => x.employee_id === 'other')).toBeTruthy();
  });

  it('does not mutate the input array', () => {
    const snapshot = JSON.stringify(assignments);
    applySwapToAssignments(assignments, '2026-06-20', 'Afternoon', 'req', 'rcv', 'Receiver');
    expect(JSON.stringify(assignments)).toBe(snapshot);
  });

  it('is a no-op when no shift matches', () => {
    const out = applySwapToAssignments(assignments, '2026-06-25', 'Afternoon', 'req', 'rcv', 'Receiver');
    expect(out.some(x => x.employee_id === 'rcv')).toBe(false);
  });
});

describe('applyTradeToAssignments (true two-way swap)', () => {
  // Requester works Saturday Afternoon; Joe works Friday Morning. They trade.
  const base = [
    a({ employee_id: 'req', employee_name: 'Requester', date: '2026-06-20', shift_name: 'Afternoon' }),
    a({ employee_id: 'joe', employee_name: 'Joe', date: '2026-06-19', shift_name: 'Morning' }),
    a({ employee_id: 'other', employee_name: 'Other', date: '2026-06-20', shift_name: 'Morning' }),
  ];
  const reqSide: TradeSide = { date: '2026-06-20', shift_name: 'Afternoon', employee_id: 'req', employee_name: 'Requester' };
  const joeSide: TradeSide = { date: '2026-06-19', shift_name: 'Morning', employee_id: 'joe', employee_name: 'Joe' };

  it('trades BOTH shifts: each person lands on the other’s shift', () => {
    const out = applyTradeToAssignments(base, reqSide, joeSide);
    const satAfternoon = out.find(x => x.date === '2026-06-20' && x.shift_name === 'Afternoon')!;
    const friMorning = out.find(x => x.date === '2026-06-19' && x.shift_name === 'Morning')!;
    expect(satAfternoon.employee_id).toBe('joe');      // Joe now works the Saturday Afternoon
    expect(satAfternoon.employee_name).toBe('Joe');
    expect(friMorning.employee_id).toBe('req');         // Requester now works Joe's Friday Morning
    expect(friMorning.employee_name).toBe('Requester');
  });

  it('leaves unrelated assignments alone and never mutates the input', () => {
    const snapshot = JSON.stringify(base);
    const out = applyTradeToAssignments(base, reqSide, joeSide);
    expect(out.find(x => x.employee_id === 'other')).toBeTruthy();
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('chooseTradeShift (which of the target’s shifts you take)', () => {
  const data = { assignments: [
    a({ employee_id: 'joe', date: '2026-06-19', shift_name: 'Morning' }),
    a({ employee_id: 'joe', date: '2026-06-21', shift_name: 'Evening' }),
    a({ employee_id: 'sue', date: '2026-06-20', shift_name: 'Morning' }),
  ] };

  it('returns the one shift when the target has exactly one', () => {
    const oneShift = { assignments: [a({ employee_id: 'sue', date: '2026-06-20', shift_name: 'Morning' })] };
    const r = chooseTradeShift(oneShift, 'sue', null);
    expect(r.kind).toBe('one');
    if (r.kind === 'one') expect(r.shift.shift_name).toBe('Morning');
  });

  it('is ambiguous when the target has several and no hint is given', () => {
    const r = chooseTradeShift(data, 'joe', null);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.shifts).toHaveLength(2);
  });

  it('narrows to one with a shift-name hint', () => {
    const r = chooseTradeShift(data, 'joe', { shift_name: 'evening' });
    expect(r.kind).toBe('one');
    if (r.kind === 'one') expect(r.shift.shift_name).toBe('Evening');
  });

  it('narrows to one with a date hint', () => {
    const r = chooseTradeShift(data, 'joe', { date: '2026-06-19' });
    expect(r.kind).toBe('one');
    if (r.kind === 'one') expect(r.shift.date).toBe('2026-06-19');
  });

  it('returns none when the target has no shifts that week', () => {
    expect(chooseTradeShift(data, 'nobody', null).kind).toBe('none');
  });
});

// #10 — the undirected "anyone want my Saturday?" broadcast must work over EMAIL
// (the live channel), not just SMS. Reachability is the gate that decides who the
// broadcast can contact; before this fix it required a phone + SMS channel, so the
// whole broadcast silently did nothing on email.
describe('isReachableForOutreach (email-first broadcast gate)', () => {
  it('an email alone makes a candidate reachable, even with no SMS channel', () => {
    expect(isReachableForOutreach({ contact_email: 'jo@club.com', contact_phone: null }, false)).toBe(true);
  });

  it('a phone is only reachable when there is an active SMS channel', () => {
    expect(isReachableForOutreach({ contact_email: null, contact_phone: '+15551112222' }, true)).toBe(true);
    expect(isReachableForOutreach({ contact_email: null, contact_phone: '+15551112222' }, false)).toBe(false);
  });

  it('email wins regardless of SMS channel state', () => {
    expect(isReachableForOutreach({ contact_email: 'jo@club.com', contact_phone: '+15551112222' }, false)).toBe(true);
    expect(isReachableForOutreach({ contact_email: 'jo@club.com', contact_phone: '+15551112222' }, true)).toBe(true);
  });

  it('no email and no usable phone means unreachable', () => {
    expect(isReachableForOutreach({ contact_email: null, contact_phone: null }, true)).toBe(false);
    expect(isReachableForOutreach({ contact_email: null, contact_phone: null }, false)).toBe(false);
    expect(isReachableForOutreach({ contact_email: '', contact_phone: '' }, true)).toBe(false);
  });
});

// #10 redesign Stage 1 — the analytical core that decides who can SWAP (button B)
// vs only PICK UP (button A), and which of a candidate's shifts are tradeable.
const emp = (id: string, name: string): Employee =>
  ({ id, name } as unknown as Employee);

describe('tradeableShiftsForCandidate', () => {
  const willing = new Set(['2026-07-06', '2026-07-07']); // Mon + Tue the requester can work
  const requesterRoles = ['Lifeguard'];

  it('keeps only shifts on a willing day that the requester is qualified for', () => {
    const shifts = [
      a({ employee_id: 'c1', date: '2026-07-06', role: 'Lifeguard' }),  // willing + qualified ✓
      a({ employee_id: 'c1', date: '2026-07-07', role: 'Headguard' }),  // willing but wrong role ✗
      a({ employee_id: 'c1', date: '2026-07-08', role: 'Lifeguard' }),  // qualified but not a willing day ✗
    ];
    const out = tradeableShiftsForCandidate(shifts, willing, requesterRoles);
    expect(out.map(s => s.date)).toEqual(['2026-07-06']);
  });

  it('returns empty when the candidate has nothing tradeable (pickup-only)', () => {
    const shifts = [a({ employee_id: 'c1', date: '2026-07-09', role: 'Lifeguard' })];
    expect(tradeableShiftsForCandidate(shifts, willing, requesterRoles)).toEqual([]);
    expect(tradeableShiftsForCandidate([], willing, requesterRoles)).toEqual([]);
  });

  it('honors multiple requester-qualified roles', () => {
    const shifts = [a({ employee_id: 'c1', date: '2026-07-06', role: 'Headguard' })];
    expect(tradeableShiftsForCandidate(shifts, willing, ['Lifeguard', 'Headguard'])).toHaveLength(1);
  });
});

describe('partitionSwapCandidates (button A vs A+B)', () => {
  const willing = new Set(['2026-07-06']);
  const requesterRoles = ['Lifeguard'];

  it('everyone is pickup-eligible; only those with a tradeable shift can also swap', () => {
    const ann = emp('a1', 'Ann');   // has a tradeable shift → swap-capable
    const bob = emp('b1', 'Bob');   // works that week but nothing on a willing day → pickup only
    const cal = emp('c1', 'Cal');   // not scheduled at all → pickup only
    const byEmp = new Map([
      ['a1', [a({ employee_id: 'a1', date: '2026-07-06', role: 'Lifeguard' })]],
      ['b1', [a({ employee_id: 'b1', date: '2026-07-09', role: 'Lifeguard' })]],
    ]);

    const part = partitionSwapCandidates([ann, bob, cal], byEmp, willing, requesterRoles);
    expect(part.pickup.map(e => e.id)).toEqual(['a1', 'b1', 'c1']);
    expect(part.swap.map(s => s.employee.id)).toEqual(['a1']);
    expect(part.swap[0].tradeableShifts).toHaveLength(1);
  });

  it('no swap-capable candidates yields an empty swap list (broadcast still allows pickups)', () => {
    const bob = emp('b1', 'Bob');
    const part = partitionSwapCandidates([bob], new Map(), willing, requesterRoles);
    expect(part.pickup).toHaveLength(1);
    expect(part.swap).toEqual([]);
  });
});

describe('weekDatesFrom + resolveWillingDates', () => {
  // Week starting Sunday 2026-07-05.
  const week = weekDatesFrom('2026-07-05');

  it('weekDatesFrom returns the 7 consecutive dates of the week', () => {
    expect(week).toEqual([
      '2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08',
      '2026-07-09', '2026-07-10', '2026-07-11',
    ]);
  });

  it('resolves willing weekdays to the matching dates in that week', () => {
    // Mon(1), Tue(2), Wed(3) → the 6th, 7th, 8th.
    const dates = resolveWillingDates([1, 2, 3], week);
    expect([...dates].sort()).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
  });

  it('Sunday(0) and Saturday(6) map to the week ends', () => {
    const dates = resolveWillingDates([0, 6], week);
    expect([...dates].sort()).toEqual(['2026-07-05', '2026-07-11']);
  });

  it('empty willing-days resolves to no dates', () => {
    expect(resolveWillingDates([], week).size).toBe(0);
  });
});
