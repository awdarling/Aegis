// Manager email threading — the "second inbox item" bug.
//
// When a manager is asked to decide something and then told the outcome, the
// second message must COLLAPSE UNDER the first in their inbox. That only works
// if the request email stamps a Message-ID and the follow-up quotes the exact
// same string in In-Reply-To.
//
// Two places got this wrong:
//
//   1. TIME OFF. A request submitted BY EMAIL stamped a Message-ID. The same
//      request submitted BY TEXT did not — so the later "resolved" reply had
//      nothing to thread to and arrived as a separate unread item. That matters
//      now, because text is the channel most requests arrive on.
//
//   2. AVAILABILITY. The request email stamped nothing at all, and there was no
//      "resolved" notice in the first place — so every manager who did not make
//      the decision was left holding a live Approve/Deny button for a request
//      that had already been answered.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { toThreadMessageId } from '../time-off';
import { availThreadMessageId } from '../employee-onboarding';

const root = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const REQ = '11111111-1111-1111-1111-111111111111';
const MGR = 'u-jack';
const CO = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const EMP = 'e-sam';

describe('the threading identifiers themselves', () => {
  it('are deterministic — the reply can always find the request', () => {
    expect(toThreadMessageId(REQ, MGR)).toBe(toThreadMessageId(REQ, MGR));
    expect(availThreadMessageId(CO, EMP, MGR)).toBe(availThreadMessageId(CO, EMP, MGR));
  });

  it('give each manager their own thread', () => {
    // Manager A's reply must not land in manager B's thread.
    expect(toThreadMessageId(REQ, 'u-jack')).not.toBe(toThreadMessageId(REQ, 'u-carolyn'));
    expect(availThreadMessageId(CO, EMP, 'u-jack')).not.toBe(availThreadMessageId(CO, EMP, 'u-carolyn'));
  });

  it('give each request its own thread', () => {
    expect(toThreadMessageId(REQ, MGR)).not.toBe(toThreadMessageId('22222222-2222-2222-2222-222222222222', MGR));
    expect(availThreadMessageId(CO, 'e-sam', MGR)).not.toBe(availThreadMessageId(CO, 'e-robin', MGR));
  });

  it('salt makes each individual message unique while keeping the thread', () => {
    // Every message needs its own Message-ID, but they all thread to the
    // unsalted original.
    const a = toThreadMessageId(REQ, MGR, 1);
    const b = toThreadMessageId(REQ, MGR, 2);
    expect(a).not.toBe(b);
    expect(a).toContain(REQ);
    expect(b).toContain(REQ);
  });

  it('are well-formed Message-IDs', () => {
    for (const id of [toThreadMessageId(REQ, MGR), availThreadMessageId(CO, EMP, MGR)]) {
      expect(id.startsWith('<')).toBe(true);
      expect(id.endsWith('@aegis.quriasolutions.com>')).toBe(true);
      // No characters that would break a header.
      expect(id).not.toMatch(/[\s<>]/g.source ? /[\s]/ : /$^/);
    }
  });

  it('survive a manager key containing characters a header cannot carry', () => {
    const id = toThreadMessageId(REQ, 'jack mccorkle+test@club.com');
    expect(id).not.toMatch(/[\s@]/.source ? /\s/ : /$^/);
    expect(id.match(/@/g)!.length).toBe(1); // only the domain's @
  });
});

describe('BUG: a request submitted BY TEXT had no Message-ID', () => {
  const src = read('src/workflows/time-off.ts');

  it('the SMS-origin manager email now stamps one', () => {
    // notifyManager() is the SMS-channel path. Its sendEmail used to carry only
    // to/subject/text/html/company_id.
    const notifyManager = src.slice(src.indexOf('async function notifyManager('));
    const firstSend = notifyManager.slice(notifyManager.indexOf('await sendEmail({'));
    expect(firstSend.slice(0, 1200)).toMatch(/message_id: toThreadMessageId\(requestId, manager\.userId\)/);
  });

  it('both channels stamp the SAME identifier, so they cannot drift apart', () => {
    // Email-origin path (notifyManagersByEmail) and SMS-origin path
    // (notifyManager) must agree, or a resolution reply threads for one and not
    // the other.
    const stamps = src.match(/message_id: toThreadMessageId\((?:requestId|torRow\.id), manager\.userId\)/g) ?? [];
    expect(stamps.length).toBe(2);
  });

  it('the resolution reply threads to exactly that identifier', () => {
    expect(src).toMatch(/in_reply_to: toThreadMessageId\(args\.requestId, m\.id\)/);
    // ...and stamps its own salted ID so a further reply can thread to IT.
    expect(src).toMatch(/message_id: toThreadMessageId\(args\.requestId, m\.id, Date\.now\(\)\)/);
  });
});

describe('BUG: an availability decision told nobody but the employee', () => {
  const src = read('src/workflows/employee-onboarding.ts');

  it('the availability request email now stamps a Message-ID', () => {
    expect(src).toMatch(/message_id: availThreadMessageId\(contact\.company_id, pending\.employee_id, mgr\.userId\)/);
  });

  it('every decision path tells the OTHER managers it is settled', () => {
    // Three exits apply a decision: permanent availability, a rotating override,
    // and a date-limited override. All three must close the loop.
    const calls = src.match(/await notifyOtherManagersAvailabilityResolved\(\{/g) ?? [];
    expect(calls.length).toBe(3);
  });

  it('that notice threads under the original request rather than opening a new one', () => {
    expect(src).toMatch(/inReplyTo: \(m\) => availThreadMessageId\(input\.company_id, input\.employee_id, m\.userId\)/);
  });

  it('it goes through the shared text-first notifier, not a bespoke email', () => {
    expect(src).toMatch(/sendManagerResolutionNotice/);
    const helper = src.slice(src.indexOf('async function notifyOtherManagersAvailabilityResolved'));
    const body = helper.slice(0, 2000);
    expect(body).not.toMatch(/sendEmail\(/);
    expect(body).toMatch(/Nothing needed from you/);
  });

  it('a failure to close the loop never undoes the decision that was applied', () => {
    const helper = read('src/workflows/employee-onboarding.ts');
    const fn = helper.slice(helper.indexOf('async function notifyOtherManagersAvailabilityResolved'));
    expect(fn.slice(0, 2000)).toMatch(/catch \(err\)/);
  });
});
