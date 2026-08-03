import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Copy/branding regression guard (batch 3a/3b) — scans schedule-build.ts source.
const src = readFileSync(resolve(process.cwd(), 'src/workflows/schedule-build.ts'), 'utf8');

describe('schedule email copy routes problems to the manager (3a)', () => {
  it('no schedule email tells the employee to reply to Aegis', () => {
    expect(src).not.toContain('reply to this email');
  });
  it('directs schedule problems to the manager instead', () => {
    expect(src).toContain("reach out to your manager and they'll get it fixed");
    expect(src).toContain('check with your manager');
  });
});

describe('employee schedule SMS drops the awkward tenant "Name:" prefix (3b)', () => {
  it('no "${companyName}:" prefix remains', () => {
    expect(src).not.toContain('${companyName}:');
  });
  it('drops the tenant name from routine schedule SMS (identity is set at opt-in)', () => {
    expect(src).toContain('Your schedule for ${weekLabel} is posted');
    expect(src).toContain('Your shifts for ${weekLabel}:');
    expect(src).not.toContain('Your ${companyName} schedule for');
    expect(src).not.toContain('${companyName} shifts for');
  });
});
