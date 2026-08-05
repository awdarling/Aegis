import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture what logActivity inserts into activity_log, so we can pin that a real
// person (manager) is credited by name and that the default (aegis) is unchanged.
const h = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[] }));
vi.mock('../../db/client', () => ({
  supabase: {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        h.inserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  },
}));

import { logActivity } from '../activity-log';

beforeEach(() => {
  h.inserts = [];
});

describe('logActivity — actor attribution', () => {
  it('credits a named manager when actor + actor_name are given (email-link decision)', async () => {
    await logActivity({
      company_id: 'c1',
      actor: 'manager',
      actor_name: 'Jamie Manager',
      action: 'time_off_approved',
      entity_type: 'time_off_request',
      entity_id: 'r1',
      summary: 'Time-off request for Sam approved by Jamie Manager via email link',
    });
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].actor).toBe('manager');
    expect(h.inserts[0].actor_name).toBe('Jamie Manager');
  });

  it("defaults actor to 'aegis' and names to null when omitted (unchanged behavior)", async () => {
    await logActivity({ company_id: 'c1', action: 'schedule_built', summary: 'Schedule built' });
    expect(h.inserts[0].actor).toBe('aegis');
    expect(h.inserts[0].actor_name).toBeNull();
    expect(h.inserts[0].actor_avatar_url).toBeNull();
  });
});
