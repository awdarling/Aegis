import { describe, it, expect } from 'vitest';
import { buildBccList } from '../monitoring';

describe('buildBccList', () => {
  it('returns the monitoring addresses for a normal recipient', () => {
    expect(buildBccList(['monitorone@quriasolutions.com'], 'sarah@example.com'))
      .toEqual(['monitorone@quriasolutions.com']);
  });

  it('never BCCs the direct recipient their own message (case-insensitive)', () => {
    expect(buildBccList(['Monitor@quriasolutions.com'], 'monitor@quriasolutions.com')).toEqual([]);
  });

  it('de-duplicates repeated / mixed-case monitor addresses', () => {
    expect(buildBccList(['m@q.com', 'M@Q.com', 'm@q.com'], 'x@y.com')).toEqual(['m@q.com']);
  });

  it('drops empty / whitespace entries', () => {
    expect(buildBccList(['', '   ', 'm@q.com'], 'x@y.com')).toEqual(['m@q.com']);
  });

  it('no monitors configured → empty list (so sendEmail adds no BCC)', () => {
    expect(buildBccList([], 'x@y.com')).toEqual([]);
  });

  it('supports multiple distinct monitor inboxes', () => {
    expect(buildBccList(['a@q.com', 'b@q.com'], 'x@y.com')).toEqual(['a@q.com', 'b@q.com']);
  });
});
