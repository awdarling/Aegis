import { describe, it, expect } from 'vitest';

// ── D10 regression suite ──────────────────────────────────────────────────────
//
// THE BUG (live at Watermark): a manager can say a slot accepts several roles —
// their Flex shift is set to "Lifeguard OR Headguard". The engine only ever read
// `shift_requirements.role` (the FIRST accepted role), so a Headguard could never
// fill that slot. The build reported a GAP while a qualified person sat available,
// and the manager's stated intent was silently discarded.
//
// This is Rule 0 inverted: instead of hidden data the manager can't see, it was
// visible data the engine ignored.
//
// These tests pin both directions: the wider set must be honoured, and it must
// not accidentally let in someone qualified for NONE of the accepted roles.

import { isQualifiedForSlot, slotRoleLabel } from '../eligibility';
import type { CanvasSlot } from '../types';
import type { Employee } from '../../../db/types';

function emp(id: string, qualified: string[]): Employee {
  return {
    id,
    company_id: 'co-1',
    name: id,
    primary_role: qualified[0] ?? 'Lifeguard',
    qualified_roles: qualified,
    max_weekly_hours: 40,
    contact_phone: null,
    contact_email: `${id}@test.local`,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    individual_wage: null,
    is_veteran: false,
  } as unknown as Employee;
}

function slot(role: string, accepted_roles: string[]): CanvasSlot {
  return {
    date: '2026-07-20',
    shift_type_id: 'st-flex',
    shift_name: 'Flex',
    shift_requirement_id: 'req-flex',
    role,
    accepted_roles,
    start_time: '13:00',
    end_time: '21:00',
    hours: 8,
    required_count: 1,
    slot_index: 0,
    is_priority: false,
  };
}

describe('D10 — a slot accepts every role the manager listed', () => {
  // This is Watermark's real Flex requirement: role='Lifeguard',
  // accepted_roles=['Lifeguard','Headguard'].
  const flex = slot('Lifeguard', ['Lifeguard', 'Headguard']);

  it('the PREFERRED role still qualifies (no behaviour change)', () => {
    expect(isQualifiedForSlot(emp('riley', ['Lifeguard']), flex)).toBe(true);
  });

  it('THE BUG: a Headguard can now fill a "Lifeguard or Headguard" slot', () => {
    // Pre-fix this returned false — the slot went unfilled and the build
    // reported a gap with a qualified Headguard standing right there.
    expect(isQualifiedForSlot(emp('casey', ['Headguard']), flex)).toBe(true);
  });

  it('someone qualified for NEITHER is still rejected', () => {
    expect(isQualifiedForSlot(emp('sam', ['Greeter']), flex)).toBe(false);
  });

  it('an employee qualified for several roles matches on any one of them', () => {
    expect(isQualifiedForSlot(emp('jordan', ['Greeter', 'Headguard']), flex)).toBe(true);
  });

  it('single-role slots are unaffected — the common case must not change', () => {
    const single = slot('Greeter', ['Greeter']);
    expect(isQualifiedForSlot(emp('sam', ['Greeter']), single)).toBe(true);
    expect(isQualifiedForSlot(emp('riley', ['Lifeguard']), single)).toBe(false);
  });

  it('falls back to the preferred role if accepted_roles is empty (never unfillable)', () => {
    // A malformed row must not make a slot impossible for everyone.
    const broken = slot('Lifeguard', []);
    expect(isQualifiedForSlot(emp('riley', ['Lifeguard']), broken)).toBe(true);
    expect(isQualifiedForSlot(emp('sam', ['Greeter']), broken)).toBe(false);
  });
});

describe('D10 — manager-facing copy names every accepted role', () => {
  it('a multi-role slot reads "Lifeguard or Headguard", not just "Lifeguard"', () => {
    // The gap reason a manager reads must match what they configured, or the
    // flag is misleading: "no Lifeguard available" when a Headguard would do.
    expect(slotRoleLabel(slot('Lifeguard', ['Lifeguard', 'Headguard']))).toBe('Lifeguard or Headguard');
  });

  it('a single-role slot reads as just that role', () => {
    expect(slotRoleLabel(slot('Greeter', ['Greeter']))).toBe('Greeter');
  });

  it('falls back to the preferred role when accepted_roles is empty', () => {
    expect(slotRoleLabel(slot('Lifeguard', []))).toBe('Lifeguard');
  });
});
