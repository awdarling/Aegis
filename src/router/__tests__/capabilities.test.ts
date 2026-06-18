import { describe, it, expect } from 'vitest';
import {
  buildCapabilitiesReply,
  allowedActionsLine,
  capabilityGroups,
} from '../capabilities';

describe('capabilityGroups', () => {
  it('employee sees only their own-schedule actions', () => {
    const groups = capabilityGroups('employee');
    expect(groups).toHaveLength(1);
    const all = groups.flatMap((g) => g.items).join(' ');
    expect(all).toMatch(/time off/i);
    expect(all).not.toMatch(/Build a schedule/i);
    expect(all).not.toMatch(/Approve or deny/i);
  });

  it('manager sees employee actions PLUS manager actions', () => {
    const groups = capabilityGroups('manager');
    expect(groups.length).toBeGreaterThan(1);
    const all = groups.flatMap((g) => g.items).join(' ');
    expect(all).toMatch(/time off/i);          // still has employee actions
    expect(all).toMatch(/Build a schedule/i);  // plus manager actions
    expect(all).toMatch(/Approve or deny/i);
    expect(all).not.toMatch(/broadcast/i);     // but not Quria-only
  });

  it('quria_admin sees manager actions PLUS quria extras', () => {
    const all = capabilityGroups('quria_admin').flatMap((g) => g.items).join(' ');
    expect(all).toMatch(/Build a schedule/i);
    expect(all).toMatch(/broadcast/i);
  });
});

describe('buildCapabilitiesReply', () => {
  it('greets by first name and lists employee actions for an employee', () => {
    const reply = buildCapabilitiesReply('employee', 'Shmubba Sploosh');
    expect(reply).toMatch(/^Hey Shmubba —/);
    expect(reply).toMatch(/Request time off/);
    expect(reply).not.toMatch(/Build a schedule/);
  });

  it('lists manager actions for a manager', () => {
    const reply = buildCapabilitiesReply('manager', 'Alexander');
    expect(reply).toMatch(/Build a schedule/);
    expect(reply).toMatch(/As a manager/);
  });

  it('works without a name', () => {
    const reply = buildCapabilitiesReply('employee');
    expect(reply).toMatch(/^Hey —/);
  });
});

describe('allowedActionsLine', () => {
  it('names the employee actions as a natural list', () => {
    expect(allowedActionsLine('employee')).toBe(
      'time off, your availability, your shifts, and shift swaps'
    );
  });
});
