// S-3 (actor half): "may this login still act as a manager?" — one function,
// fail closed. Consumed by /webhooks/decision and /webhooks/departure at click.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as { id: string; access_revoked_at: string | null } | null,
  error: null as { message: string } | null,
  lastFilters: {} as Record<string, unknown>,
}));
vi.mock('../../db/client', () => ({
  supabase: {
    from() {
      const b: Record<string, unknown> = {
        select() { return b; },
        eq(c: string, v: unknown) { h.lastFilters[c] = v; return b; },
        maybeSingle() { return Promise.resolve({ data: h.row, error: h.error }); },
      };
      return b;
    },
  },
}));

import { managerStillActive } from '../manager-active';

beforeEach(() => { h.row = null; h.error = null; h.lastFilters = {}; });

describe('managerStillActive', () => {
  it('a live login may act', async () => {
    h.row = { id: 'mgr-1', access_revoked_at: null };
    expect(await managerStillActive('mgr-1')).toBe(true);
    expect(h.lastFilters.id).toBe('mgr-1');
  });
  it('a revoked login may NOT act', async () => {
    h.row = { id: 'mgr-1', access_revoked_at: '2026-06-18T00:00:00Z' };
    expect(await managerStillActive('mgr-1')).toBe(false);
  });
  it('an unknown login may NOT act (fail closed)', async () => {
    expect(await managerStillActive('ghost')).toBe(false);
  });
  it('a lookup error refuses (fail closed)', async () => {
    h.error = { message: 'db down' };
    expect(await managerStillActive('mgr-1')).toBe(false);
  });
  it('a token minted before manager attribution has nothing to check and is allowed through', async () => {
    expect(await managerStillActive(null)).toBe(true);
    expect(await managerStillActive(undefined)).toBe(true);
  });
});
