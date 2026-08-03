import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Voice-consistency regression guard (Group 1). Scans the source of the touched
// user-facing files and asserts the robotic / third-person patterns we removed
// stay gone: no "(yes/no)" mechanics, no log-style "Done - ${...}" openers, no
// JSON.stringify-quoted values in the manager confirm/done copy, and no place
// where Aegis narrates its OWN actions in the third person.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('voice consistency (source scan)', () => {
  it('operational-query: no (yes/no) mechanics or log-style Done openers', () => {
    const s = read('src/workflows/operational-query.ts');
    expect(s).not.toContain('(yes/no)');
    expect(s).not.toContain('Done - ${');
    expect(s).not.toContain('Done \u2014 ${');
  });

  it('operational-query: manager confirm/done values are not JSON-quoted', () => {
    const s = read('src/workflows/operational-query.ts');
    expect(s).not.toContain('updated to ${JSON.stringify(pending.new_value)}');
    expect(s).toContain('formatPlainValue(pending.new_value)');
  });

  it('no third-person self-references in touched copy', () => {
    expect(read('src/workflows/operational-query.ts')).not.toContain('how Aegis builds schedules');
    expect(read('src/webhooks/decision.ts')).not.toContain('Aegis has notified');
    expect(read('src/workflows/employee-onboarding.ts')).not.toContain('from Aegis each week');
    expect(read('src/workflows/shift-swap.ts')).not.toContain('swap request from Aegis');
  });

  it('onboarding time-off no longer hard-gates a clear no with Reply YES', () => {
    const s = read('src/workflows/employee-onboarding.ts');
    expect(s).not.toContain('Reply YES if');
    expect(s).toContain('isClearNoTimeOff');
  });

  it('emergency-coverage: humanized tier labels, no primary_role noise on candidate lines', () => {
    const s = read('src/workflows/emergency-coverage.ts');
    expect(s).not.toContain("'PREFERRED'");
    expect(s).not.toContain('(${c.employee.primary_role})');
    expect(s).toContain('Best options');
  });
});
