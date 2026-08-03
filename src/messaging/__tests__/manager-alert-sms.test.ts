import { describe, it, expect } from 'vitest';
import { managerAlertSms } from '../greeting';

describe('managerAlertSms — one human voice for manager notifications', () => {
  it('leads with the warm opener + the who/what/when/why summary', () => {
    const out = managerAlertSms({
      managerName: 'Dana Reed',
      summary: 'Sam Rivera wants Aug 6 off for a family thing.',
      inbox: 'approve',
    });
    expect(out.startsWith('Hey Dana — ')).toBe(true);
    expect(out).toContain('Sam Rivera wants Aug 6 off for a family thing.');
  });

  it('the approve hand-off points to the email approve/deny link, at the manager\'s discretion', () => {
    const out = managerAlertSms({ managerName: 'Dana', summary: 'X.', inbox: 'approve' });
    expect(out).toContain('approve/deny link in your email');
    expect(out).toContain('whenever you get a chance');
  });

  it('the action hand-off points to email without an approve/deny link', () => {
    const out = managerAlertSms({ managerName: 'Dana', summary: 'X.', inbox: 'action' });
    expect(out).toContain('how to handle it are in your email');
    expect(out).not.toContain('approve/deny');
  });

  it('a pure FYI (no inbox) is just opener + summary, no email hand-off', () => {
    const out = managerAlertSms({ summary: "Jordan's pay rate is now $18/hr — synced to Engage." });
    expect(out).toBe("Hey — Jordan's pay rate is now $18/hr — synced to Engage.");
    expect(out).not.toContain('your email');
  });

  it('falls back to a name-less opener when no manager name is known', () => {
    expect(managerAlertSms({ summary: 'Something happened.' }).startsWith('Hey — ')).toBe(true);
  });
});
