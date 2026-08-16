import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── L4 regression suite — a trade lands BOTH legs or nothing ─────────────────
//
// THE BUG (live at Watermark, a manager reproduced it 2026-08-16): a two-way
// trade half-applied. Requester A correctly landed on coworker B's shift, but
// the schedule was never updated to take B off that shift and put A's own shift
// onto B. The request was still marked approved, the magic tokens were consumed
// so it couldn't be retried, and both employees were told the trade went through.
//
// MECHANISM: `applyTradeToAssignments` applies the two legs as INDEPENDENT `if`
// branches, and `executeScheduleTrade` then checked
//
//     updatedAssignments.some((a, i) => a.employee_id !== original[i]?.employee_id)
//
// — ANY one row changed. That guard is correct for the ONE-leg
// executeScheduleSwap it was copied from, and silently wrong for a two-leg
// operation: leg B matching alone satisfies it.
//
// THE CONTRACT THESE TESTS PIN: a trade requires EXACTLY ONE matching
// assignment on EACH side. Anything else writes nothing and reports why.
//
// Second half of L4: the Homebase UI approval path claimed in three separate
// files to be "giveaway/pickup only" and implemented that in none of them, so
// approving a TRADE from the Swaps tab ran the one-way executor and dropped the
// return leg. See swap-kind.test.ts + the sendSwapDecisionNotification block
// below.

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'test',
    BASE_URL: 'https://test.local',
    ANTHROPIC_API_KEY: 'test',
    SENDGRID_API_KEY: 'test',
    SENDGRID_FROM_EMAIL: 'a@test.local',
    EMAIL_ONLY: true,
  },
}));

const state: {
  scheduleRow: unknown;
  writeError: { message: string } | null;
  updates: Array<Record<string, unknown>>;
} = { scheduleRow: null, writeError: null, updates: [] };

vi.mock('../../db/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            single: async () => ({ data: state.scheduleRow, error: null }),
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        state.updates.push(patch);
        return { eq: async () => ({ error: state.writeError }) };
      },
    }),
  },
}));

vi.mock('../../ai/claude', () => ({
  generateReply: vi.fn(),
  classifyIntent: vi.fn(),
  weekdayAnchors: vi.fn(),
  AnthropicOverloadError: class AnthropicOverloadError extends Error {},
}));
vi.mock('../../messaging/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../messaging/sms', () => ({ sendSms: vi.fn() }));
vi.mock('../../messaging/reply', () => ({ reply: vi.fn(), sendInThreadAck: vi.fn() }));
vi.mock('../../logger/activity-log', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/schedule-simulator', () => ({ computeWageEstimate: vi.fn(async () => 0) }));

import {
  executeScheduleTrade,
  applyTradeToAssignments,
  applyTradeToAssignmentsDetailed,
} from '../shift-swap';
import type { ScheduleAssignment } from '../schedule-build';

const SCHEDULE_ID = 'sched-1';
const COMPANY = 'co-1';

// The live shape: A works Afternoon on the 18th, B works Morning on the 19th.
// They agree to trade.
const A_DATE = '2026-07-18';
const B_DATE = '2026-07-19';
const sideA = { date: A_DATE, shift_name: 'Afternoon', employee_id: 'emp-a', employee_name: 'A' };
const sideB = { date: B_DATE, shift_name: 'Morning', employee_id: 'emp-b', employee_name: 'B' };

function assignment(employee_id: string, date: string, shift_name = 'Afternoon'): ScheduleAssignment {
  return {
    employee_id,
    employee_name: employee_id,
    date,
    shift_name,
    role: 'Lifeguard',
    start_time: '15:00',
    end_time: '21:00',
    hours: 6,
  } as ScheduleAssignment;
}

function bothLegs(): ScheduleAssignment[] {
  return [assignment('emp-a', A_DATE, 'Afternoon'), assignment('emp-b', B_DATE, 'Morning')];
}

beforeEach(() => {
  state.scheduleRow = null;
  state.writeError = null;
  state.updates = [];
});

// ── The transform now reports per-leg, which is the whole fix ────────────────

describe('L4 · applyTradeToAssignmentsDetailed counts each leg separately', () => {
  it('reports 1 and 1 when both legs are on the schedule', () => {
    const out = applyTradeToAssignmentsDetailed(bothLegs(), sideA, sideB);
    expect(out.aMatched).toBe(1);
    expect(out.bMatched).toBe(1);
  });

  it('THE BUG SHAPE: reports 0 and 1 when only the coworker leg is present', () => {
    // Exactly the live failure — A's own assignment is not where the trade
    // token says it is (schedule edited since, or the requester's shift was
    // resolved wrongly at request time), but B's is.
    const only = [assignment('emp-b', B_DATE, 'Morning')];
    const out = applyTradeToAssignmentsDetailed(only, sideA, sideB);
    expect(out.aMatched).toBe(0);
    expect(out.bMatched).toBe(1);
    // And note the array DID change — which is why the old `.some()` guard
    // waved this through as a success.
    expect(out.assignments[0].employee_id).toBe('emp-a');
  });

  it('reports 1 and 0 in the mirror case', () => {
    const only = [assignment('emp-a', A_DATE, 'Afternoon')];
    const out = applyTradeToAssignmentsDetailed(only, sideA, sideB);
    expect(out.aMatched).toBe(1);
    expect(out.bMatched).toBe(0);
  });

  it('counts duplicate rows rather than hiding them', () => {
    const dup = [...bothLegs(), assignment('emp-a', A_DATE, 'Afternoon')];
    const out = applyTradeToAssignmentsDetailed(dup, sideA, sideB);
    expect(out.aMatched).toBe(2);
  });

  it('the original applyTradeToAssignments contract is unchanged', () => {
    // Existing callers and tests depend on this returning a bare array.
    const before = bothLegs();
    const after = applyTradeToAssignments(before, sideA, sideB);
    expect(Array.isArray(after)).toBe(true);
    expect(after[0].employee_id).toBe('emp-b');
    expect(after[1].employee_id).toBe('emp-a');
    expect(before[0].employee_id).toBe('emp-a'); // input never mutated
  });
});

// ── The executor: both legs, or nothing ─────────────────────────────────────

describe('L4 · executeScheduleTrade refuses a half-applied trade', () => {
  it('applies BOTH legs on the happy path — asserted on what was WRITTEN', () => {
    // The pre-existing suite only asserted `ok === true` here, never inspecting
    // the payload — which is exactly why a one-leg write could pass as success.
    state.scheduleRow = { id: SCHEDULE_ID, data: { assignments: bothLegs() }, staffing_report: {} };

    return executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB).then(r => {
      expect(r.ok).toBe(true);
      expect(state.updates).toHaveLength(1);

      const written = (state.updates[0].data as { assignments: ScheduleAssignment[] }).assignments;
      const aRow = written.find(x => x.date === A_DATE && x.shift_name === 'Afternoon')!;
      const bRow = written.find(x => x.date === B_DATE && x.shift_name === 'Morning')!;

      expect(aRow.employee_id).toBe('emp-b');       // B took A's shift
      expect(aRow.employee_name).toBe('B');
      expect(bRow.employee_id).toBe('emp-a');       // A took B's shift
      expect(bRow.employee_name).toBe('A');
    });
  });

  it('THE REPORTED BUG: only leg B present → refuses, and writes NOTHING', async () => {
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [assignment('emp-b', B_DATE, 'Morning')] },
      staffing_report: {},
    };

    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('partial_trade');
      // The manager must be able to act on this, so the message has to name the
      // shift that wasn't there.
      expect(r.reason).toContain('Afternoon');
      expect(r.reason).toMatch(/half-changed|Nothing was changed/i);
    }
    // The critical assertion: the half-trade never reached the database.
    expect(state.updates).toHaveLength(0);
  });

  it('only leg A present → also refuses and writes nothing', async () => {
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [assignment('emp-a', A_DATE, 'Afternoon')] },
      staffing_report: {},
    };
    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('partial_trade');
      expect(r.reason).toContain('Morning');
    }
    expect(state.updates).toHaveLength(0);
  });

  it('NEITHER leg present is still the distinct, less dangerous code', async () => {
    // Kept separate from partial_trade: "nothing matched" was already failing
    // correctly before L4. Only the partial case was being reported as success.
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [assignment('someone-else', A_DATE)] },
      staffing_report: {},
    };
    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_matching_assignment');
    expect(state.updates).toHaveLength(0);
  });

  it('a duplicated assignment refuses rather than double-moving someone', async () => {
    // Two rows sharing (date, shift_name, employee_id) is corrupt data. Applying
    // both would put the counterparty on the same shift twice.
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [...bothLegs(), assignment('emp-a', A_DATE, 'Afternoon')] },
      staffing_report: {},
    };
    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('partial_trade');
    expect(state.updates).toHaveLength(0);
  });

  it('a same-day trade between two different shifts still lands both legs', async () => {
    // Guards against a fix that keyed on date alone.
    const sameDayA = { date: A_DATE, shift_name: 'Morning', employee_id: 'emp-a', employee_name: 'A' };
    const sameDayB = { date: A_DATE, shift_name: 'Afternoon', employee_id: 'emp-b', employee_name: 'B' };
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: {
        assignments: [assignment('emp-a', A_DATE, 'Morning'), assignment('emp-b', A_DATE, 'Afternoon')],
      },
      staffing_report: {},
    };
    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sameDayA, sameDayB);
    expect(r.ok).toBe(true);
    const written = (state.updates[0].data as { assignments: ScheduleAssignment[] }).assignments;
    expect(written.find(x => x.shift_name === 'Morning')!.employee_id).toBe('emp-b');
    expect(written.find(x => x.shift_name === 'Afternoon')!.employee_id).toBe('emp-a');
  });

  it('D2 holds: a failed write is reported, not swallowed', async () => {
    state.scheduleRow = { id: SCHEDULE_ID, data: { assignments: bothLegs() }, staffing_report: {} };
    state.writeError = { message: 'boom' };
    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('write_failed');
  });

  it('untouched assignments are left exactly alone', async () => {
    const bystander = assignment('emp-c', '2026-07-20', 'Flex');
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [...bothLegs(), bystander] },
      staffing_report: {},
    };
    await executeScheduleTrade(COMPANY, SCHEDULE_ID, sideA, sideB);
    const written = (state.updates[0].data as { assignments: ScheduleAssignment[] }).assignments;
    expect(written.find(x => x.shift_name === 'Flex')!.employee_id).toBe('emp-c');
    expect(written).toHaveLength(3);
  });
});
