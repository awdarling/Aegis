import { describe, it, expect } from 'vitest';
import { parseTelnyxInbound, isStopKeyword, isHelpKeyword } from '../sms';

describe('parseTelnyxInbound — Telnyx webhook shape', () => {
  it('parses an inbound message.received into a normalized InboundMessage', () => {
    const body = {
      data: {
        event_type: 'message.received',
        payload: {
          from: { phone_number: '+16165550123' },
          to: [{ phone_number: '+16166164898' }],
          text: '  I need next Friday off  ',
        },
      },
    };
    const { eventType, message } = parseTelnyxInbound(body);
    expect(eventType).toBe('message.received');
    expect(message).toEqual({
      sender: '+16165550123',
      recipient: '+16166164898',
      body: 'I need next Friday off',
      channel: 'sms',
    });
  });

  it('ignores a delivery-receipt event (message.sent) — no inbound message', () => {
    const body = { data: { event_type: 'message.sent', payload: { to: [{ phone_number: '+1' }] } } };
    const { eventType, message } = parseTelnyxInbound(body);
    expect(eventType).toBe('message.sent');
    expect(message).toBeNull();
  });

  it('ignores message.finalized (final delivery status)', () => {
    const { message } = parseTelnyxInbound({ data: { event_type: 'message.finalized', payload: {} } });
    expect(message).toBeNull();
  });

  it('handles a missing/empty payload without throwing', () => {
    expect(parseTelnyxInbound({}).message).toBeNull();
    expect(parseTelnyxInbound({ data: { event_type: 'message.received' } }).message).toEqual({
      sender: '',
      recipient: '',
      body: '',
      channel: 'sms',
    });
  });
});

describe('carrier-reserved keyword detection (spec §2.2 / §3.7)', () => {
  it('recognizes STOP and its variants (case-insensitive, trimmed)', () => {
    for (const kw of ['STOP', 'stop', '  Stop ', 'STOPALL', 'cancel', 'END', 'quit', 'unsubscribe', 'revoke', 'optout']) {
      expect(isStopKeyword(kw)).toBe(true);
    }
  });

  it('recognizes HELP / INFO', () => {
    for (const kw of ['HELP', 'help', ' Info ', 'INFO']) {
      expect(isHelpKeyword(kw)).toBe(true);
    }
  });

  it('does NOT treat opt-in words or normal messages as STOP/HELP', () => {
    for (const kw of ['YES', 'START', 'help me swap my shift', 'I want to stop working Fridays', "what's my schedule?"]) {
      expect(isStopKeyword(kw)).toBe(false);
      expect(isHelpKeyword(kw)).toBe(false);
    }
  });
});
