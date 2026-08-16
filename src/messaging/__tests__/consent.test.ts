import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB client so canSmsEmployee/setEmployeeConsentState run against a
// controllable builder. The builder supports both the select→eq→eq→maybeSingle
// read path and the update→eq→eq (awaited) write path.
const h = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const updateSpy = vi.fn();
  const updateError = { current: null as { message: string } | null };
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (patch: unknown) => {
        updateSpy(patch);
        return builder;
      },
      eq: () => builder,
      maybeSingle,
      // Awaitable: the update write path is `await ...update().eq().eq()`.
      then: (resolve: (v: { error: { message: string } | null }) => unknown) =>
        resolve({ error: updateError.current }),
    };
    return builder;
  }
  return { maybeSingle, updateSpy, updateError, supabase: { from: () => makeBuilder() } };
});

vi.mock('../../db/client', () => ({ supabase: h.supabase }));

import { canSmsEmployee, setEmployeeConsentState, stateAllowsSms } from '../consent';

describe('stateAllowsSms — the single predicate', () => {
  it('permits only confirmed and resubscribed', () => {
    expect(stateAllowsSms('confirmed')).toBe(true);
    expect(stateAllowsSms('resubscribed')).toBe(true);
    expect(stateAllowsSms('none')).toBe(false);
    expect(stateAllowsSms('declined')).toBe(false);
    expect(stateAllowsSms('opted_out')).toBe(false);
    expect(stateAllowsSms(null)).toBe(false);
    expect(stateAllowsSms(undefined)).toBe(false);
  });
});

describe('canSmsEmployee — per consent state', () => {
  beforeEach(() => h.maybeSingle.mockReset());

  const cases: Array<[string | null, boolean]> = [
    ['confirmed', true],
    ['resubscribed', true],
    ['none', false],
    ['declined', false],
    ['opted_out', false],
    [null, false], // un-backfilled / never invited → blocked (fail closed)
  ];

  for (const [state, expected] of cases) {
    it(`state=${state === null ? 'NULL' : state} → ${expected}`, async () => {
      h.maybeSingle.mockResolvedValue({ data: { sms_consent_state: state }, error: null });
      expect(await canSmsEmployee('co1', 'emp1')).toBe(expected);
    });
  }

  it('no employee row at all → blocked', async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await canSmsEmployee('co1', 'emp1')).toBe(false);
  });

  it('DB error → blocked (fail closed)', async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });
    expect(await canSmsEmployee('co1', 'emp1')).toBe(false);
  });

  it('empty employee_id → blocked without a DB call', async () => {
    expect(await canSmsEmployee('co1', '')).toBe(false);
    expect(h.maybeSingle).not.toHaveBeenCalled();
  });
});

describe('setEmployeeConsentState — writes the durable cache', () => {
  beforeEach(() => {
    h.updateSpy.mockReset();
    h.updateError.current = null;
  });

  it('persists the state + a timestamp', async () => {
    await setEmployeeConsentState('co1', 'emp1', 'confirmed');
    expect(h.updateSpy).toHaveBeenCalledTimes(1);
    const patch = h.updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.sms_consent_state).toBe('confirmed');
    expect(typeof patch.sms_consent_updated_at).toBe('string');
  });

  it('a DB error is swallowed (activity_log stays the source of record)', async () => {
    h.updateError.current = { message: 'nope' };
    await expect(setEmployeeConsentState('co1', 'emp1', 'opted_out')).resolves.toBeUndefined();
  });

  it('empty employee_id is a no-op', async () => {
    await setEmployeeConsentState('co1', '', 'confirmed');
    expect(h.updateSpy).not.toHaveBeenCalled();
  });
});
