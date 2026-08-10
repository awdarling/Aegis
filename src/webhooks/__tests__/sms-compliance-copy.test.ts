import { describe, it, expect } from 'vitest';
import { HELP_RESPONSE, isStopKeyword, isHelpKeyword } from '../sms';

// Pins the carrier-keyword handling + HELP copy to the REGISTERED A2P 10DLC
// campaign (Telnyx "Aegis SMS Scheduling — Quria Solutions"). Website, code, and
// the Telnyx profile must all match; this locks the code side so it can't silently
// drift from the registration. If the campaign registration changes, update these
// expectations in lockstep.
describe('SMS compliance copy — registered A2P 10DLC campaign', () => {
  it('HELP reply matches the registered HELP message verbatim', () => {
    expect(HELP_RESPONSE).toBe(
      'Aegis by Quria Solutions: Scheduling assistant for your employer. ' +
      'Msg freq varies. Msg & data rates may apply. Reply STOP to opt out. ' +
      'Support: awdarling@quriasolutions.com',
    );
  });

  it('recognizes every registered opt-out keyword (case-insensitive)', () => {
    for (const k of ['STOP', 'STOPALL', 'CANCEL', 'END', 'QUIT', 'UNSUBSCRIBE', 'REVOKE', 'OPTOUT']) {
      expect(isStopKeyword(k)).toBe(true);
      expect(isStopKeyword(k.toLowerCase())).toBe(true);
    }
  });

  it('recognizes the registered HELP keywords', () => {
    expect(isHelpKeyword('HELP')).toBe(true);
    expect(isHelpKeyword('INFO')).toBe(true);
    expect(isHelpKeyword('info')).toBe(true);
  });

  it('does NOT treat opt-in keywords (YES/START/UNSTOP) as opt-out or help', () => {
    for (const k of ['YES', 'START', 'UNSTOP']) {
      expect(isStopKeyword(k)).toBe(false);
      expect(isHelpKeyword(k)).toBe(false);
    }
  });
});
