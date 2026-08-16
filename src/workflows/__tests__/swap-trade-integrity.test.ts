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

// ── [SWAP-SHIFT-RESOLVE] — the requester's OWN shift, and only theirs ────────
//
// Alexander's mandate for L4 is that swaps be FULLY FUNCTIONAL, not merely safe.
// The executor fix above makes a bad trade fail closed instead of half-applying;
// this is the other half — stopping the bad side A from being constructed at
// all, so a legitimate trade actually WORKS.
//
// The old code, when the requester had no assignment on the named date, fell
// back to a search with NO employee_id filter and could return a COWORKER's row
// as side A. Short hints like "AM"/"PM" (exactly what the router prompt asks
// for) substring-match real shift names, so the match was usually the trade
// counterparty's own shift — an unmatchable leg by construction.

import { resolveRequesterShiftOnDate, narrowByShiftDescriptor, findRequesterShift } from '../shift-swap';
import type { ScheduleData } from '../schedule-build';

const ME = 'emp-me';
const COWORKER = 'emp-coworker';
const DAY = '2026-07-18';

function asg(employee_id: string, date: string, shift_name: string, start: string, end: string): ScheduleAssignment {
  return {
    employee_id, employee_name: employee_id, date, shift_name,
    role: 'Lifeguard', start_time: start, end_time: end, hours: 6,
  } as ScheduleAssignment;
}
const sched = (assignments: ScheduleAssignment[]): ScheduleData =>
  ({ assignments, gaps: [] } as unknown as ScheduleData);

describe('L4 · resolveRequesterShiftOnDate never returns someone else\'s shift', () => {
  it('THE BUG: a coworker\'s matching shift is NOT returned when I have none that day', () => {
    // Exactly the live shape: I'm not working Saturday, my coworker is on "AM
    // Weekend", and I said "AM". The old fallback returned THEIR row as side A.
    const data = sched([asg(COWORKER, DAY, 'AM Weekend', '09:00', '15:30')]);
    const r = resolveRequesterShiftOnDate(data, ME, DAY, 'AM');
    expect(r.kind).toBe('none');
  });

  it('and the same is true with no hint at all', () => {
    const data = sched([asg(COWORKER, DAY, 'AM Weekend', '09:00', '15:30')]);
    expect(resolveRequesterShiftOnDate(data, ME, DAY, null).kind).toBe('none');
  });

  it('returns MY shift when I have exactly one that day', () => {
    const data = sched([
      asg(ME, DAY, 'Afternoon', '15:00', '21:15'),
      asg(COWORKER, DAY, 'AM Weekend', '09:00', '15:30'),
    ]);
    const r = resolveRequesterShiftOnDate(data, ME, DAY, null);
    expect(r.kind).toBe('one');
    if (r.kind === 'one') expect(r.shift.employee_id).toBe(ME);
  });

  it('DOUBLE-SHIFT DAY: the hint picks the right one instead of a coin flip', () => {
    // findRequesterShift ignores the name entirely and returns the FIRST match,
    // so pre-fix this silently gave away whichever happened to be first.
    const data = sched([
      asg(ME, DAY, 'AM Weekday', '11:00', '15:30'),
      asg(ME, DAY, 'Afternoon', '15:00', '21:15'),
    ]);
    const pm = resolveRequesterShiftOnDate(data, ME, DAY, 'my PM shift');
    expect(pm.kind).toBe('one');
    if (pm.kind === 'one') expect(pm.shift.shift_name).toBe('Afternoon');

    const am = resolveRequesterShiftOnDate(data, ME, DAY, 'the AM one');
    expect(am.kind).toBe('one');
    if (am.kind === 'one') expect(am.shift.shift_name).toBe('AM Weekday');
  });

  it('DOUBLE-SHIFT DAY with no usable hint: ASKS rather than guessing', () => {
    const data = sched([
      asg(ME, DAY, 'AM Weekday', '11:00', '15:30'),
      asg(ME, DAY, 'Afternoon', '15:00', '21:15'),
    ]);
    const r = resolveRequesterShiftOnDate(data, ME, DAY, null);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.shifts).toHaveLength(2);
  });

  it('soft narrowing never empties the set (no false "you have no shift")', () => {
    const data = sched([
      asg(ME, DAY, 'AM Weekday', '11:00', '15:30'),
      asg(ME, DAY, 'Afternoon', '15:00', '21:15'),
    ]);
    // A descriptor matching neither must leave BOTH to ask about.
    const r = resolveRequesterShiftOnDate(data, ME, DAY, 'the purple one');
    expect(r.kind).toBe('ambiguous');
    expect(narrowByShiftDescriptor(data.assignments, 'the purple one')).toHaveLength(2);
  });

  it('findRequesterShift keeps its old contract (existing callers/tests)', () => {
    const data = sched([asg(ME, DAY, 'Afternoon', '15:00', '21:15')]);
    expect(findRequesterShift(data, ME, DAY)?.shift_name).toBe('Afternoon');
    expect(findRequesterShift(data, COWORKER, DAY)).toBe(null);
  });
});

// ── END-TO-END: a real trade lands BOTH legs after the resolver fix ──────────

describe('L4 · END-TO-END — a correctly-resolved trade applies both legs', () => {
  it('resolver → token sides → executor: both people switch places', async () => {
    // The full chain the live bug ran through, with the two ends now joined:
    // (1) resolve the requester's own shift from a real schedule, using the same
    //     kind of loose descriptor an employee actually texts, then
    // (2) build the trade sides exactly as the decision token does, and
    // (3) execute — asserting on what was WRITTEN, both legs.
    const REQ = 'emp-a';
    const CO = 'emp-b';
    const MY_DAY = '2026-07-18';
    const THEIR_DAY = '2026-07-19';

    const liveAssignments = [
      asg(REQ, MY_DAY, 'AM Weekday', '11:00', '15:30'),
      asg(REQ, MY_DAY, 'Afternoon', '15:00', '21:15'),   // I work a double that day
      asg(CO, THEIR_DAY, 'Flex', '13:00', '21:00'),
      asg('emp-bystander', MY_DAY, 'Weekday Greeter', '12:00', '19:30'),
    ];

    // (1) "swap my afternoon shift on the 18th" — must pick MY Afternoon, not my
    // AM, and never the bystander's.
    const mine = resolveRequesterShiftOnDate(
      sched(liveAssignments), REQ, MY_DAY, 'my afternoon shift',
    );
    expect(mine.kind).toBe('one');
    if (mine.kind !== 'one') return;
    expect(mine.shift.employee_id).toBe(REQ);
    expect(mine.shift.shift_name).toBe('Afternoon');

    // (2) the coworker's return leg, resolved by the sibling function
    const theirs = chooseTradeShiftForTest(liveAssignments, CO);

    // (3) execute
    state.scheduleRow = { id: SCHEDULE_ID, data: { assignments: liveAssignments }, staffing_report: {} };
    const r = await executeScheduleTrade(
      COMPANY, SCHEDULE_ID,
      { date: mine.shift.date, shift_name: mine.shift.shift_name, employee_id: REQ, employee_name: 'A' },
      { date: theirs.date, shift_name: theirs.shift_name, employee_id: CO, employee_name: 'B' },
    );

    expect(r.ok).toBe(true);
    const written = (state.updates[0].data as { assignments: ScheduleAssignment[] }).assignments;

    // BOTH legs landed.
    const myOldShift = written.find(x => x.date === MY_DAY && x.shift_name === 'Afternoon')!;
    const theirOldShift = written.find(x => x.date === THEIR_DAY && x.shift_name === 'Flex')!;
    expect(myOldShift.employee_id).toBe(CO);    // B took my Afternoon
    expect(theirOldShift.employee_id).toBe(REQ); // I took their Flex

    // My OTHER shift that day is untouched — the double-shift day didn't cost me
    // the wrong shift.
    expect(written.find(x => x.date === MY_DAY && x.shift_name === 'AM Weekday')!.employee_id).toBe(REQ);
    // And the bystander is untouched.
    expect(written.find(x => x.shift_name === 'Weekday Greeter')!.employee_id).toBe('emp-bystander');
  });

  it('REGRESSION: the pre-fix side A (a coworker\'s row) is now refused, not half-applied', async () => {
    // Belt and braces — if a bad side A ever reaches the executor again from any
    // other path, it must refuse rather than write one leg.
    const bad = { date: DAY, shift_name: 'AM Weekend', employee_id: 'emp-a', employee_name: 'A' };
    const good = { date: '2026-07-19', shift_name: 'Morning', employee_id: 'emp-b', employee_name: 'B' };
    state.scheduleRow = {
      id: SCHEDULE_ID,
      data: { assignments: [asg('emp-coworker', DAY, 'AM Weekend', '09:00', '15:30'), assignment('emp-b', '2026-07-19', 'Morning')] },
      staffing_report: {},
    };
    const r = await executeScheduleTrade(COMPANY, SCHEDULE_ID, bad, good);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('partial_trade');
    expect(state.updates).toHaveLength(0);
  });
});

// Small local helper so the E2E test doesn't depend on chooseTradeShift's own
// hint semantics — it just needs the coworker's single shift.
function chooseTradeShiftForTest(assignments: ScheduleAssignment[], coworkerId: string): ScheduleAssignment {
  return assignments.find(a => a.employee_id === coworkerId)!;
}
