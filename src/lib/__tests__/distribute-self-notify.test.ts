import { describe, it, expect } from 'vitest';
import { isInitiatingManagerContact } from '../distribute-guard';

describe('isInitiatingManagerContact (distribute self-notification suppression, batch 2d)', () => {
  it('is false when nothing is excluded', () => {
    expect(isInitiatingManagerContact({ contact_email: 'm@x.com', contact_phone: '+1' }, [])).toBe(false);
  });
  it('matches on email or phone', () => {
    expect(isInitiatingManagerContact({ contact_email: 'm@x.com' }, ['m@x.com'])).toBe(true);
    expect(isInitiatingManagerContact({ contact_phone: '+16165550114' }, ['+16165550114'])).toBe(true);
  });
  it('does not match a different employee', () => {
    expect(isInitiatingManagerContact({ contact_email: 'e@x.com', contact_phone: '+15' }, ['m@x.com', '+19'])).toBe(false);
  });
  it('handles null/absent contact fields safely', () => {
    expect(isInitiatingManagerContact({ contact_email: null, contact_phone: null }, ['m@x.com'])).toBe(false);
    expect(isInitiatingManagerContact({}, ['m@x.com'])).toBe(false);
  });
});
