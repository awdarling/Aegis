import { describe, it, expect } from 'vitest';
import {
  computeChangedEmployeeIds,
  employeeShiftSignature,
  type ShiftLike,
} from '../../lib/schedule-diff';

// Helper to build an assignment with sensible defaults.
function a(partial: Partial<ShiftLike> & { employee_id: string; date: string }): ShiftLike {
  return {
    employee_name: partial.employee_name ?? partial.employee_id,
    shift_name: partial.shift_name ?? 'PM',
    role: partial.role ?? 'Lifeguard',
    start_time: partial.start_time ?? '15:00',
    end_time: partial.end_time ?? '21:00',
    hours: partial.hours ?? 6,
    ...partial,
  };
}

describe('employeeShiftSignature', () => {
  it('is order-independent', () => {
    const s1 = employeeShiftSignature([
      a({ employee_id: 'e1', date: '2026-06-15' }),
      a({ employee_id: 'e1', date: '2026-06-16' }),
    ]);
    const s2 = employeeShiftSignature([
      a({ employee_id: 'e1', date: '2026-06-16' }),
      a({ employee_id: 'e1', date: '2026-06-15' }),
    ]);
    expect(s1).toBe(s2);
  });

  it('changes when a time changes', () => {
    const base = a({ employee_id: 'e1', date: '2026-06-15' });
    const moved = a({ employee_id: 'e1', date: '2026-06-15', start_time: '16:00' });
    expect(employeeShiftSignature([base])).not.toBe(employeeShiftSignature([moved]));
  });

  it('empty week has a stable signature', () => {
    expect(employeeShiftSignature([])).toBe(employeeShiftSignature([]));
  });
});

describe('computeChangedEmployeeIds (republish changed-only notify)', () => {
  it('returns no one when the schedules are identical', () => {
    const rows = [
      a({ employee_id: 'e1', date: '2026-06-15' }),
      a({ employee_id: 'e2', date: '2026-06-16' }),
    ];
    expect(computeChangedEmployeeIds(rows, [...rows]).size).toBe(0);
  });

  it('flags an employee whose shift moved, but not an unchanged coworker', () => {
    const old = [
      a({ employee_id: 'e1', date: '2026-06-15', start_time: '15:00' }),
      a({ employee_id: 'e2', date: '2026-06-16' }),
    ];
    const next = [
      a({ employee_id: 'e1', date: '2026-06-15', start_time: '16:00' }), // moved
      a({ employee_id: 'e2', date: '2026-06-16' }),                      // unchanged
    ];
    const changed = computeChangedEmployeeIds(old, next);
    expect(changed.has('e1')).toBe(true);
    expect(changed.has('e2')).toBe(false);
    expect(changed.size).toBe(1);
  });

  it('flags an employee who was added to the new schedule', () => {
    const old = [a({ employee_id: 'e1', date: '2026-06-15' })];
    const next = [
      a({ employee_id: 'e1', date: '2026-06-15' }),
      a({ employee_id: 'e3', date: '2026-06-17' }), // newly added
    ];
    const changed = computeChangedEmployeeIds(old, next);
    expect(changed.has('e3')).toBe(true);
    expect(changed.has('e1')).toBe(false);
  });

  it('flags an employee who was dropped entirely from the new schedule', () => {
    const old = [
      a({ employee_id: 'e1', date: '2026-06-15' }),
      a({ employee_id: 'e2', date: '2026-06-16' }),
    ];
    const next = [a({ employee_id: 'e1', date: '2026-06-15' })]; // e2 dropped
    const changed = computeChangedEmployeeIds(old, next);
    expect(changed.has('e2')).toBe(true);
    expect(changed.has('e1')).toBe(false);
  });

  it('flags an employee who picked up an extra shift', () => {
    const old = [a({ employee_id: 'e1', date: '2026-06-15' })];
    const next = [
      a({ employee_id: 'e1', date: '2026-06-15' }),
      a({ employee_id: 'e1', date: '2026-06-18' }), // extra shift same employee
    ];
    expect(computeChangedEmployeeIds(old, next).has('e1')).toBe(true);
  });

  it('flags a role change on the same slot', () => {
    const old = [a({ employee_id: 'e1', date: '2026-06-15', role: 'Lifeguard' })];
    const next = [a({ employee_id: 'e1', date: '2026-06-15', role: 'Headguard' })];
    expect(computeChangedEmployeeIds(old, next).has('e1')).toBe(true);
  });
});
