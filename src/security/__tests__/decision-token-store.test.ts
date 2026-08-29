import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── N-2 / N-4: the hardened aegis_memory token store ─────────────────────────
// Hashing at rest, the legacy plaintext fallback, and the expired-token purge.

const h = vi.hoisted(() => {
  const state = {
    memory: [] as Array<{ id: string; source: string; content: string }>,
    actionTokens: [] as Array<{ id: string; expires_at: string }>,
    deletedMemoryIds: [] as string[][],
    deletedActionTokenCutoffs: [] as string[],
  };
  function makeBuilder(table: string) {
    const f: Record<string, unknown> = {};
    let op = 'select';
    const finish = () => {
      if (table === 'aegis_memory' && op === 'select') {
        if (typeof f.eq_source === 'string') {
          const row = state.memory.find(r => r.source === f.eq_source) ?? null;
          return { data: row ? { id: row.id, content: row.content } : null, error: null };
        }
        if (typeof f.like_source === 'string') {
          const prefix = (f.like_source as string).replace(/%$/, '');
          return { data: state.memory.filter(r => r.source.startsWith(prefix)).map(r => ({ id: r.id, content: r.content })), error: null };
        }
      }
      if (table === 'aegis_memory' && op === 'delete') {
        if (Array.isArray(f.in_id)) {
          state.deletedMemoryIds.push(f.in_id as string[]);
          state.memory = state.memory.filter(r => !(f.in_id as string[]).includes(r.id));
        }
        if (typeof f.eq_source === 'string') {
          state.memory = state.memory.filter(r => r.source !== f.eq_source);
        }
        return { data: null, error: null };
      }
      if (table === 'aegis_action_tokens' && op === 'delete' && typeof f.lt_expires_at === 'string') {
        state.deletedActionTokenCutoffs.push(f.lt_expires_at as string);
        const purged = state.actionTokens.filter(r => r.expires_at < (f.lt_expires_at as string));
        state.actionTokens = state.actionTokens.filter(r => !(r.expires_at < (f.lt_expires_at as string)));
        return { data: purged.map(r => ({ id: r.id })), error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      delete() { op = 'delete'; return b; },
      eq(col: string, val: unknown) { f[`eq_${col}`] = val; return b; },
      like(col: string, val: unknown) { f[`like_${col}`] = val; return b; },
      in(col: string, val: unknown) { f[`in_${col}`] = val; return b; },
      lt(col: string, val: unknown) { f[`lt_${col}`] = val; return b; },
      maybeSingle() { return Promise.resolve(finish()); },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return Promise.resolve(finish()).then(onF, onR); },
    };
    return b;
  }
  return { state, makeBuilder };
});

vi.mock('../../db/client', () => ({ supabase: { from: (t: string) => h.makeBuilder(t) } }));

import {
  hashDecisionToken,
  mintTokenSource,
  findTokenRow,
  purgeExpiredDecisionTokens,
} from '../decision-token-store';

const PAST = new Date(Date.now() - 86400000).toISOString();
const FUTURE = new Date(Date.now() + 86400000).toISOString();

beforeEach(() => {
  h.state.memory = [];
  h.state.actionTokens = [];
  h.state.deletedMemoryIds = [];
  h.state.deletedActionTokenCutoffs = [];
});

describe('hashing at rest (N-2)', () => {
  it('mintTokenSource stores a SHA-256 digest, never the raw value', () => {
    const source = mintTokenSource('decision_token', 'raw-secret-token');
    expect(source).not.toContain('raw-secret-token');
    expect(source).toBe(`decision_token:${hashDecisionToken('raw-secret-token')}`);
    expect(source).toMatch(/^decision_token:[0-9a-f]{64}$/);
  });

  it('findTokenRow finds a hashed row by its raw value', async () => {
    h.state.memory.push({ id: 'm1', source: mintTokenSource('decision_token', 'tok-a'), content: '{"x":1}' });
    const row = await findTokenRow('decision_token', 'tok-a');
    expect(row?.id).toBe('m1');
    expect(row?.source).toBe(mintTokenSource('decision_token', 'tok-a'));
  });

  it('falls back to the legacy PLAINTEXT source so pre-deploy links keep working', async () => {
    h.state.memory.push({ id: 'm2', source: 'decision_token:tok-legacy', content: '{"x":2}' });
    const row = await findTokenRow('decision_token', 'tok-legacy');
    expect(row?.id).toBe('m2');
    expect(row?.source).toBe('decision_token:tok-legacy');
  });

  it('returns null when neither form exists', async () => {
    expect(await findTokenRow('decision_token', 'nope')).toBeNull();
  });
});

describe('purgeExpiredDecisionTokens (N-4)', () => {
  it('deletes expired token rows from both stores and leaves live ones alone', async () => {
    h.state.memory.push(
      { id: 'live', source: mintTokenSource('decision_token', 't1'), content: JSON.stringify({ expires_at: FUTURE }) },
      { id: 'dead', source: mintTokenSource('decision_token', 't2'), content: JSON.stringify({ expires_at: PAST }) },
      { id: 'dead-dep', source: 'departure_token:legacy-plain', content: JSON.stringify({ expires_at: PAST }) },
      { id: 'dead-parked', source: 'callout_decision:mgr-1:req-1', content: JSON.stringify({ expires_at: PAST }) },
      // A malformed row is left alone rather than guessed at.
      { id: 'weird', source: 'decision_token:abc', content: 'not-json' },
    );
    h.state.actionTokens.push(
      { id: 'aat-live', expires_at: FUTURE },
      { id: 'aat-dead', expires_at: PAST },
    );

    const result = await purgeExpiredDecisionTokens();

    expect(result.memoryRows).toBe(3);
    expect(result.actionTokenRows).toBe(1);
    expect(h.state.memory.map(r => r.id).sort()).toEqual(['live', 'weird']);
    expect(h.state.actionTokens.map(r => r.id)).toEqual(['aat-live']);
  });

  it('is a no-op when nothing has expired', async () => {
    h.state.memory.push({ id: 'live', source: mintTokenSource('decision_token', 't1'), content: JSON.stringify({ expires_at: FUTURE }) });
    const result = await purgeExpiredDecisionTokens();
    expect(result.memoryRows).toBe(0);
    expect(h.state.memory).toHaveLength(1);
  });
});
