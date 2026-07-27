import { describe, it, expect, vi, beforeEach } from 'vitest';

// B1 / D4 — strict exact-match inbound routing. These tests pin the removal of
// the old "route to the sole email-configured company" fallback, which was a
// cross-tenant hazard the moment a second tenant existed.
//
// Mirrors the mock pattern used by the workflow tests: mock env + the Supabase
// client + quria-verification so importing the module touches nothing real. The
// Supabase mock is a tiny controllable query builder whose responders the tests
// swap per-case via the hoisted `h` object.
const h = vi.hoisted(() => ({
  // company_channels .select().eq().eq().maybeSingle()
  channelResponder: (_filters: Record<string, unknown>) =>
    ({ data: null as { company_id: string } | null, error: null as { message: string } | null }),
  // employees .select().eq().or().eq().maybeSingle()
  empResponder: (_filters: Record<string, unknown>) =>
    ({ data: null as Record<string, unknown> | null, error: null }),
  // users .select().eq().eq().maybeSingle()
  userResponder: (_filters: Record<string, unknown>) =>
    ({ data: null as Record<string, unknown> | null, error: null }),
  // captured security_events inserts
  securityInserts: [] as Record<string, unknown>[],
}));

vi.mock('../../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.local', SUPABASE_SERVICE_ROLE_KEY: 'test' },
}));
vi.mock('../quria-verification', () => ({
  checkQuriaStaff: vi.fn(async () => null),
}));
vi.mock('../../db/client', () => ({
  supabase: {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters[col] = val; return builder; },
        or(str: string) { filters._or = str; return builder; },
        maybeSingle() {
          if (table === 'company_channels') return Promise.resolve(h.channelResponder(filters));
          if (table === 'employees') return Promise.resolve(h.empResponder(filters));
          if (table === 'users') return Promise.resolve(h.userResponder(filters));
          return Promise.resolve({ data: null, error: null });
        },
        insert(row: Record<string, unknown>) {
          if (table === 'security_events') h.securityInserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  },
}));

import { resolveCompanyId, verifySender } from '../sender-verification';
import type { InboundMessage } from '../types';

beforeEach(() => {
  h.channelResponder = () => ({ data: null, error: null });
  h.empResponder = () => ({ data: null, error: null });
  h.userResponder = () => ({ data: null, error: null });
  h.securityInserts = [];
});

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function inbound(recipient: string, sender = 'someone@example.com'): InboundMessage {
  return {
    channel: 'email',
    sender,
    recipient,
    body: 'hello',
  } as InboundMessage;
}

describe('resolveCompanyId — strict exact-match routing (B1/D4)', () => {
  it('routes an exact recipient match to that tenant', async () => {
    h.channelResponder = (f) => {
      expect(f.channel_type).toBe('email');
      expect(f.channel_value).toBe('aegis@a.quriasolutions.com');
      return { data: { company_id: TENANT_A }, error: null };
    };
    expect(await resolveCompanyId('email', 'aegis@a.quriasolutions.com')).toBe(TENANT_A);
  });

  it('returns null (drops) when no channel row matches — NO sole-company fallback', async () => {
    // Simulates a single-tenant DB receiving mail at an address with no row.
    // The old fallback would have routed this into the sole tenant; strict
    // routing drops it.
    h.channelResponder = () => ({ data: null, error: null });
    expect(await resolveCompanyId('email', 'stranger@nowhere.com')).toBeNull();
  });

  it('returns null on a lookup error rather than guessing a tenant', async () => {
    h.channelResponder = () => ({ data: null, error: { message: 'boom' } });
    expect(await resolveCompanyId('email', 'aegis@a.quriasolutions.com')).toBeNull();
  });
});

describe('verifySender — no cross-tenant routing (B1/D4)', () => {
  it('drops + logs a security_event when the recipient matches no tenant', async () => {
    h.channelResponder = () => ({ data: null, error: null });
    const result = await verifySender(inbound('unknown@aegis.quriasolutions.com'));
    expect(result.ok).toBe(false);
    expect(h.securityInserts).toHaveLength(1);
    expect(h.securityInserts[0].event_type).toBe('unknown_sender');
    expect(h.securityInserts[0].company_id).toBeNull(); // never attributed to a tenant
  });

  it('routes an exact match to the correct tenant with no cross-talk', async () => {
    // Recipient is tenant B's address; the sender is an employee of tenant B.
    h.channelResponder = (f) =>
      f.channel_value === 'aegis@b.quriasolutions.com'
        ? { data: { company_id: TENANT_B }, error: null }
        : { data: null, error: null };
    h.empResponder = (f) => {
      expect(f.company_id).toBe(TENANT_B); // contact lookup scoped to the resolved tenant
      return {
        data: {
          id: 'emp-b',
          name: 'Bailey B',
          contact_phone: null,
          contact_email: 'someone@example.com',
          company_id: TENANT_B,
          active: true,
          aegis_access: 'employee',
        },
        error: null,
      };
    };

    const result = await verifySender(
      inbound('aegis@b.quriasolutions.com', 'someone@example.com')
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contact.company_id).toBe(TENANT_B);
      expect(result.contact.employee_id).toBe('emp-b');
    }
    expect(h.securityInserts).toHaveLength(0);
  });
});
