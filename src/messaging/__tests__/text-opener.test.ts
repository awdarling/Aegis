import { describe, it, expect } from 'vitest';
import { greeting, textOpener, firstName } from '../greeting';

// textOpener is the warm inline opener for TEXT replies — it replaces the
// email-style "Hi <name>," header that read too formal in a text thread. Manager
// notification EMAILS keep greeting() on purpose; that split is what these lock.
describe('textOpener', () => {
  it('weaves the first name in with an em-dash lead, no email header', () => {
    expect(textOpener('Sam Rivera')).toBe('Hey Sam — ');
    expect(textOpener('Dana')).toBe('Hey Dana — ');
  });

  it('drops the name gracefully when there is none', () => {
    expect(textOpener('')).toBe('Hey — ');
    expect(textOpener(null)).toBe('Hey — ');
    expect(textOpener(undefined)).toBe('Hey — ');
  });

  it('is distinct from the formal email greeting (which is unchanged)', () => {
    expect(greeting('Sam Rivera')).toBe('Hi Sam,');
    expect(textOpener('Sam Rivera')).not.toContain('Hi ');
    expect(textOpener('Sam Rivera')).not.toContain(',');
  });

  it('uses the same first-name extraction as greeting', () => {
    expect(textOpener('Sam Rivera')).toContain(firstName('Sam Rivera'));
  });
});
