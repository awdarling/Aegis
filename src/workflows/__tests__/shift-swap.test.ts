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
} from '../shift-swap';
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
