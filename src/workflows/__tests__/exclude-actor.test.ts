import { describe, it, expect } from 'vitest';
import { excludeActor } from '../time-off';

// N1 — the deciding manager must never be a recipient of their own decision notice.
describe('excludeActor — N1 self-notification guard', () => {
  const managers = [
    { id: 'mgr-jack', email: 'jack@club.com' },
    { id: 'mgr-dana', email: 'dana@club.com' },
    { id: 'owner-sam', email: 'sam@club.com' },
  ];

  it('drops the actor who took the decision', () => {
    const out = excludeActor(managers, 'mgr-jack');
    expect(out.map((m) => m.id)).toEqual(['mgr-dana', 'owner-sam']);
    expect(out.find((m) => m.id === 'mgr-jack')).toBeUndefined();
  });

  it('excludes nobody when the decision is unattributed (null decided_by)', () => {
    expect(excludeActor(managers, null)).toHaveLength(3);
    expect(excludeActor(managers, undefined)).toHaveLength(3);
  });

  it('an actor not in the recipient list is a no-op', () => {
    expect(excludeActor(managers, 'someone-else')).toHaveLength(3);
  });

  it('does not mutate the input array', () => {
    const copy = [...managers];
    excludeActor(managers, 'mgr-jack');
    expect(managers).toEqual(copy);
  });
});
