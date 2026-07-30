import { describe, it, expect } from 'vitest';
import { aegisSystemFacts, aegisScopeGuard } from '../system-knowledge';

// system-knowledge.ts is the single source of the grounding + scope guard that
// keep every free-form answer correct and in-lane. These assertions lock the two
// properties that were actually broken in production.

describe('aegisSystemFacts (employee grounding)', () => {
  const facts = aegisSystemFacts('employee');

  it('states employees interact by text/email, with no app to log into', () => {
    expect(facts).toMatch(/text or email/i);
    expect(facts).toMatch(/no employee app|no employee app or portal/i);
  });

  it('hard-bans directing an employee to Homebase to self-serve (the exact bug)', () => {
    expect(facts).toMatch(/NEVER/);
    expect(facts).toMatch(/log into Homebase/i);
    expect(facts.toLowerCase()).toContain('homebase');
  });

  it('describes the real time-off flow (tell Aegis → confirm → manager decides)', () => {
    expect(facts).toMatch(/pass it to their manager|route approvals|manager, who approves/i);
  });

  it('reuses the capability list so WHAT and HOW never drift', () => {
    expect(facts).toMatch(/time off/i);
    expect(facts).toMatch(/swap a shift|shift/i);
  });
});

describe('aegisSystemFacts (manager grounding)', () => {
  const facts = aegisSystemFacts('manager');

  it('lets a manager act by message OR Homebase, and notes employees have no Homebase access', () => {
    expect(facts).toMatch(/Homebase/);
    expect(facts).toMatch(/no Homebase access|only by text or email/i);
  });

  it('includes manager-only capabilities', () => {
    expect(facts).toMatch(/schedule|coverage|staffing/i);
  });
});

describe('aegisScopeGuard (anti free-Claude)', () => {
  it('confines Aegis to its lane and declines off-domain for employees', () => {
    const g = aegisScopeGuard('employee');
    expect(g).toMatch(/only help/i);
    expect(g).toMatch(/do NOT answer/i);
    expect(g).toMatch(/trivia|coding|essays|creative writing/i);
    expect(g).toMatch(/scheduling assistant/i);
  });

  it('applies the same guard for managers', () => {
    const g = aegisScopeGuard('manager');
    expect(g).toMatch(/do NOT answer/i);
    expect(g).toMatch(/unrelated to this job/i);
  });
});
