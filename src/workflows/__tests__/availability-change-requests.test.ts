import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Driveable supabase stub ───────────────────────────────────────────────────
// Records every from()/insert()/update()/eq() call so we can assert the supersede
// ordering (withdraw prior pending permanent BEFORE insert) without a live DB.
type Call = { table: string; op: string; args: unknown };
const calls: Call[] = [];
let insertReturnsId = 'new-row-id';

function makeQuery(table: string) {
  const q: Record<string, unknown> = {};
  q.insert = (args: unknown) => { calls.push({ table, op: 'insert', args }); return q; };
  q.update = (args: unknown) => { calls.push({ table, op: 'update', args }); return q; };
  q.delete = () => { calls.push({ table, op: 'delete', args: null }); return q; };
  q.eq = (col: string, val: unknown) => { calls.push({ table, op: `eq:${col}`, args: val }); return q; };
  q.select = () => q;
  q.maybeSingle = async () => ({ data: { id: insertReturnsId }, error: null });
  return q;
}

vi.mock('../../db/client', () => ({
  supabase: { from: (table: string) => makeQuery(table) },
}));

import {
  resolveChangeKind,
  insertPendingAvailabilityChange,
  type AvailabilityChangeSnapshot,
} from '../availability-change-requests';

const baseSnap: AvailabilityChangeSnapshot = {
  employee_id: 'emp-1',
  employee_name: 'Maria',
  company_id: 'co-1',
  current_availability: [{ day_of_week: 1, start_time: '09:00', end_time: '17:00' }],
  proposed_availability: [{ day_of_week: 2, start_time: '09:00', end_time: '17:00' }],
  availability_raw: 'drop mondays, add tuesdays',
  employee_sender: 'maria@example.com',
  employee_recipient: 'aegis@aegis.quriasolutions.com',
  employee_channel: 'email',
  thread_id: null,
  raw_subject: null,
};

beforeEach(() => { calls.length = 0; insertReturnsId = 'new-row-id'; });

describe('resolveChangeKind', () => {
  it('is permanent when no end date and no rotation', () => {
    expect(resolveChangeKind({ custom_end_date: null, rotation: null })).toBe('permanent');
  });
  it('is date_limited when an end date is present', () => {
    expect(resolveChangeKind({ custom_end_date: '2026-09-01', rotation: null })).toBe('date_limited');
  });
  it('is rotating when a rotation is present (rotation wins over end date)', () => {
    const rotation = { cycle_weeks: 2, cycle_start_date: '2026-08-11', weeks: [] } as unknown as AvailabilityChangeSnapshot['rotation'];
    expect(resolveChangeKind({ custom_end_date: '2026-09-01', rotation })).toBe('rotating');
  });
});

describe('insertPendingAvailabilityChange — permanent supersede', () => {
  it('withdraws any prior pending permanent row BEFORE inserting the new one', async () => {
    const id = await insertPendingAvailabilityChange({ snapshot: baseSnap, sourceChannel: 'email' });
    expect(id).toBe('new-row-id');

    const withdrawIdx = calls.findIndex(c => c.op === 'update' && (c.args as Record<string, unknown>).status === 'withdrawn');
    const insertIdx = calls.findIndex(c => c.op === 'insert');
    expect(withdrawIdx).toBeGreaterThanOrEqual(0);        // a withdraw happened
    expect(insertIdx).toBeGreaterThanOrEqual(0);          // an insert happened
    expect(withdrawIdx).toBeLessThan(insertIdx);          // withdraw came first

    // The withdraw is scoped to this employee's pending PERMANENT rows only.
    const scoped = calls.filter(c => c.op.startsWith('eq:'));
    expect(scoped.some(c => c.op === 'eq:change_kind' && c.args === 'permanent')).toBe(true);
    expect(scoped.some(c => c.op === 'eq:status' && c.args === 'pending')).toBe(true);

    // The inserted row carries the self-contained snapshot + resolved kind.
    const insertCall = calls[insertIdx].args as Record<string, unknown>;
    expect(insertCall.change_kind).toBe('permanent');
    expect(insertCall.status).toBe('pending');
    expect(insertCall.proposed_change).toBe(baseSnap);
  });

  it('does NOT withdraw for a date_limited change (temporary overrides stack)', async () => {
    await insertPendingAvailabilityChange({
      snapshot: { ...baseSnap, custom_end_date: '2026-09-01' },
      sourceChannel: 'email',
    });
    const withdrew = calls.some(c => c.op === 'update' && (c.args as Record<string, unknown>).status === 'withdrawn');
    expect(withdrew).toBe(false);
    const insertCall = calls.find(c => c.op === 'insert')!.args as Record<string, unknown>;
    expect(insertCall.change_kind).toBe('date_limited');
  });
});
