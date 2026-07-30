import { describe, it, expect, afterEach, vi } from 'vitest';

// The RUN_SCHEDULERS flag is what lets a test/staging Aegis instance run without
// the cross-tenant background schedulers (so it can't touch live tenants). Verify
// the env parsing: default on, and explicit "false" (any case) turns it off.
// env.ts reads process.env once at import, so each case resets the module cache.

describe('RUN_SCHEDULERS env flag', () => {
  afterEach(() => {
    delete process.env.RUN_SCHEDULERS;
    vi.resetModules();
  });

  it('defaults to true when unset', async () => {
    delete process.env.RUN_SCHEDULERS;
    vi.resetModules();
    const { env } = await import('../env');
    expect(env.RUN_SCHEDULERS).toBe(true);
  });

  it('is false when set to "false"', async () => {
    process.env.RUN_SCHEDULERS = 'false';
    vi.resetModules();
    const { env } = await import('../env');
    expect(env.RUN_SCHEDULERS).toBe(false);
  });

  it('is case-insensitive ("FALSE" → false)', async () => {
    process.env.RUN_SCHEDULERS = 'FALSE';
    vi.resetModules();
    const { env } = await import('../env');
    expect(env.RUN_SCHEDULERS).toBe(false);
  });

  it('any other value keeps schedulers on (e.g. "true", "1")', async () => {
    process.env.RUN_SCHEDULERS = 'true';
    vi.resetModules();
    const { env } = await import('../env');
    expect(env.RUN_SCHEDULERS).toBe(true);
  });
});
