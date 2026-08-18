// ── "That's handled — nothing for you to do" ─────────────────────────────────
//
// When one manager decides something, the OTHER managers are still holding a
// live Approve/Deny button for a request that no longer exists. They need to be
// told. But being told is not an action item, and Alexander's policy is explicit:
//
//   Email is only for (a) someone with no text number or no consent, or (b) an
//   action item with a click-through button. Everything else texts first.
//
// A "resolved" notice is neither, so it TEXTS first and falls back to a THREADED
// email reply — one that collapses under the original request in the manager's
// inbox rather than arriving as a fresh unread item saying "no action is needed".
// A new email that exists purely to say "ignore this" is the thing we are trying
// to stop.
//
// The text carries real context — who, what, for when, and who decided — never a
// bare "you have a notification".
//
// ONE implementation, reused by every workflow that resolves something a manager
// was asked about: time-off decisions, availability decisions, and (once the L3
// branch lands) time-off cancellations, which today send a brand-new email to
// every manager saying no action is needed.

import { env } from '../config/env';
import { sendSms } from './sms';
import { sendEmail } from './email';
import { managerAlertSms } from './greeting';
import { normalizeReSubject } from './reply';
import { resolveManagers, recipientsFor, canSms, type ManagerContact } from './manager-directory';

export interface ResolutionNoticeResult {
  texted: number;
  emailed: number;
  skipped: number;
}

export interface ResolutionNoticeInput {
  companyId: string;
  /**
   * The users.id of whoever made the decision. They already know — they are the
   * one who clicked. Excluded from the notice. When null (the shared magic-link
   * path, where we cannot attribute the click — Data Contract D17) nobody is
   * excluded, so an unattributed decision still tells everyone.
   */
  decidedByUserId?: string | null;
  /** Display name of the decider, for the copy. Falls back to "A manager". */
  decidedByName?: string | null;
  /**
   * The one-line summary. Must carry who / what / for when — this is the whole
   * message on the SMS leg. e.g. "Sam's request for Aug 20–22 off is approved".
   */
  summary: string;
  /** Subject for the email leg. Prefixed with Re: by the caller's threading. */
  subject: string;
  /** Body for the email leg. Plain text; kept short — it says nothing is needed. */
  body: string;
  /**
   * Message-ID of the ORIGINAL request email, per manager, so the notice
   * collapses under it instead of opening a new thread. Return null for a
   * manager whose original had no Message-ID (e.g. a pre-fix request) and the
   * notice still sends, just unthreaded.
   */
  inReplyTo?: (m: ManagerContact) => string | null;
  /** Message-ID to stamp on the notice itself, so later replies can thread to it. */
  messageId?: (m: ManagerContact) => string | null;
}

/**
 * Tell every OTHER manager that something they were asked about is now settled.
 * Text first, threaded email as the fallback. Never a new "no action needed"
 * email to someone who can be texted.
 */
export async function sendManagerResolutionNotice(
  input: ResolutionNoticeInput
): Promise<ResolutionNoticeResult> {
  const dir = await resolveManagers(input.companyId);

  // 'approvals' is the right category: these are the people who were asked to
  // decide, so they are the people who need to know it is decided. The safety
  // valve does not apply — nobody has to act, so an all-opted-out company
  // legitimately hears nothing.
  const audience = recipientsFor(dir, 'approvals', input.companyId)
    .filter((m) => !input.decidedByUserId || m.userId !== input.decidedByUserId);

  const result: ResolutionNoticeResult = { texted: 0, emailed: 0, skipped: 0 };

  for (const m of audience) {
    // ── SMS first ────────────────────────────────────────────────────────────
    if (canSms(dir, m, env.EMAIL_ONLY)) {
      try {
        const ok = await sendSms({
          // The recipient is a MANAGER, not an employee under the opt-in regime.
          allowPreConsent: true,
          to: m.phone,
          from: dir.smsChannel!,
          body: managerAlertSms({
            managerName: m.name,
            summary: input.summary,
            // No inbox hand-off: there is nothing waiting for them. Pointing a
            // manager at their email to read "nothing needed" is the bug.
            inbox: null,
          }),
          company_id: input.companyId,
        });
        if (ok) { result.texted++; continue; }
        console.warn(
          `[resolution-notice] text to ${m.name} failed; falling back to a threaded email.`
        );
      } catch (err) {
        console.warn(`[resolution-notice] text to ${m.name} threw; falling back to email:`, err);
      }
    }

    // ── Threaded email fallback ──────────────────────────────────────────────
    if (!m.email) {
      result.skipped++;
      console.warn(
        `[resolution-notice] ${m.name} has neither a usable phone nor an email — ` +
        'they still think this is waiting on them.'
      );
      continue;
    }

    try {
      const inReplyTo = input.inReplyTo?.(m) ?? undefined;
      await sendEmail({
        to: m.email,
        subject: inReplyTo ? normalizeReSubject(input.subject) : input.subject,
        text: input.body,
        company_id: input.companyId,
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        ...(input.messageId?.(m) ? { message_id: input.messageId(m)! } : {}),
      });
      result.emailed++;
    } catch (err) {
      result.skipped++;
      console.warn(`[resolution-notice] email to ${m.email} failed:`, err);
    }
  }

  return result;
}
