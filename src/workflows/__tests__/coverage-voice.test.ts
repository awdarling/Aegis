import { describe, it, expect } from 'vitest';
import { COVERAGE_TIER_LABELS, formatCoverageCandidateLine } from '../emergency-coverage';

describe('COVERAGE_TIER_LABELS', () => {
  it('uses humanized sentence-case tier labels', () => {
    expect(COVERAGE_TIER_LABELS[1]).toBe('Best options');
    expect(COVERAGE_TIER_LABELS[2]).toBe('Would hit overtime');
    expect(COVERAGE_TIER_LABELS[3]).toBe('Already working today');
  });
});

describe('formatCoverageCandidateLine', () => {
  it('shows name + phone + hours, drops the primary_role noise', () => {
    const line = formatCoverageCandidateLine(1, 'Sam Rivera', '+16165550114', 12, '');
    expect(line).toContain('Sam Rivera');
    expect(line).toContain('12.0h so far this week');
    expect(line.startsWith('1. Sam Rivera')).toBe(true);
    // phone present -> two separators
    expect((line.match(/\u2022/g) ?? []).length).toBe(2);
  });
  it('omits the phone cleanly when there is none (no empty gap, no "null")', () => {
    const line = formatCoverageCandidateLine(2, 'Sam Rivera', null, 8, ' (would be 40h)');
    expect(line).toContain('Sam Rivera');
    expect(line).toContain('8.0h so far this week');
    expect(line).toContain('(would be 40h)');
    expect(line).not.toContain('null');
    expect((line.match(/\u2022/g) ?? []).length).toBe(1);
  });
});
