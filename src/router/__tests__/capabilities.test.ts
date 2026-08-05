import { describe, it, expect } from 'vitest';
import {
  buildCapabilitiesReply,
  allowedActionsLine,
  capabilityGroups,
  isCapabilitiesQuery,
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
    // No doubled header: the single employee group drops its "Here to help with:"
    // sub-heading, which otherwise reads redundantly right under the intro line.
    expect(reply).not.toMatch(/Here to help with/i);
  });

  it('lists manager actions for a manager, keeping section headings', () => {
    const reply = buildCapabilitiesReply('manager', 'Alexander');
    expect(reply).toMatch(/Build a schedule/);
    expect(reply).toMatch(/As a manager/);
    // Managers have multiple groups, so the section labels stay meaningful.
    expect(reply).toMatch(/For your own schedule/);
  });

  it('works without a name', () => {
    const reply = buildCapabilitiesReply('employee');
    expect(reply).toMatch(/^Hey —/);
  });
});

describe('isCapabilitiesQuery', () => {
  it('matches standalone capabilities questions regardless of casing/punctuation', () => {
    for (const s of [
      'What can you do?',
      'what can you do',
      'What can you help with?',
      'what can you help me with',
      'What do you do?',
      'how can you help',
      'How can you help me?',
      'what are you able to do',
      'what else can you do',
      'Hey Aegis, what can you do?',
    ]) {
      expect(isCapabilitiesQuery(s), s).toBe(true);
    }
  });

  it('does NOT fire on real requests that happen to contain "what can you do"', () => {
    for (const s of [
      'what can you do about getting Saturday covered',
      'I need someone to cover the PM shift on Saturday, someone called out.',
      'Avery Stone just called out for her Saturday morning lifeguard shift. I need help finding coverage.',
      'can you build next week',
      'what time is my shift on Friday',
      '',
    ]) {
      expect(isCapabilitiesQuery(s), s).toBe(false);
    }
  });
});

describe('allowedActionsLine', () => {
  it('names the employee actions as a natural list', () => {
    expect(allowedActionsLine('employee')).toBe(
      'time off, your availability, your shifts, and shift swaps'
    );
  });
});
