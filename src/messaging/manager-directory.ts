// ── Who are this company's managers, and how do we reach them? ───────────────
//
// ONE question, ONE function (Rule 0b). Before this module there were ten
// separate answers to it across the codebase, four of which hand-rolled the
// same fragile email string-match, and none of which agreed on which managers
// to notify.
//
// THE MODEL (Alexander, 2026-08-18):
//   "A manager is still an employee. It's just an employee with a different
//    role in the organization."
//
// So the PERSON is the `employees` row — that is where a name, a phone and an
// email live. The `users` row is a login plus a permission set ATTACHED to that
// person via users.employee_id. There is deliberately no users.phone: one human
// must not have two phone numbers on file (Rule 0, one fact one place).
//
// WHAT THIS FIXES
//   1. users had no link to employees, so a manager's phone was found by
//      matching users.email against employees.contact_email — case-SENSITIVELY,
//      in four hand-written copies. A miss returned null and the text was
//      skipped with no log and no fallback.
//   2. `.maybeSingle()` on that match ALSO returns null when two employees share
//      an email, and the error was never checked. Two sandbox employees share
//      one address in this very database today, so that is not hypothetical.
//   3. users.access_revoked_at was checked NOWHERE in Aegis. A revoked test
//      manager received 410 emails over two months, the last one the day before
//      this was written.
//   4. Two incompatible recipient policies ran side by side: "first manager
//      wins" (with an alphabetical sort, so it picked a manager over an owner)
//      and "fan out to everyone". The same time-off request notified a different
//      set of people depending on whether the employee texted or emailed.

import { supabase } from '../db/client';
import { getAegisSmsChannel } from './notify';

// ── Notification categories ──────────────────────────────────────────────────
//
// An owner who never works the floor still needs a person record so Aegis can
// reach them, but should not be buried in shift-swap traffic. Each category is
// independently switchable per person, stored on employees.notification_prefs.
//
// An ABSENT key means "use the default for my role": an owner defaults to OFF
// for everything, everyone else defaults to ON. So an owner can switch a
// category on to see what Aegis actually feels like, then switch it off again,
// without anyone editing config for them.
export type NotifyCategory = 'approvals' | 'trades' | 'schedule_posts' | 'reports';

// Categories that are ACTION ITEMS — someone has to decide something. These get
// the safety valve below: they are never allowed to reach nobody.
const ACTION_CATEGORIES: ReadonlySet<NotifyCategory> = new Set<NotifyCategory>(['approvals']);

export interface ManagerContact {
  /** users.id — the login. */
  userId: string;
  /** employees.id — the person. Null when this login isn't linked to anyone yet. */
  employeeId: string | null;
  name: string;
  role: 'manager' | 'owner';
  /** Login email. Always present (users.email is NOT NULL). */
  email: string;
  /**
   * The manager's PERSONAL mobile, from their employee record. Never the
   * tenant's Aegis outbound number — that is what we send FROM, and confusing
   * the two is how Aegis once ended up texting itself.
   */
  phone: string | null;
  /** How the person record was found. 'email_match' is the legacy path and warns. */
  linkSource: 'employee_id' | 'email_match' | 'none';
  /** Raw preferences from the employee row. Empty when unlinked. */
  prefs: Partial<Record<NotifyCategory, boolean>>;
}

export interface ManagerDirectory {
  /** Every non-revoked manager/owner for the company, linked or not. */
  managers: ManagerContact[];
  /** The tenant's Aegis outbound SMS number, or null when unconfigured. */
  smsChannel: string | null;
  /** Managers with no phone on file — kept so callers can log honestly. */
  unreachableBySms: ManagerContact[];
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  employee_id: string | null;
}

interface EmployeeRow {
  id: string;
  name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  active: boolean;
  notification_prefs: Record<string, unknown> | null;
}

function readPrefs(raw: Record<string, unknown> | null): Partial<Record<NotifyCategory, boolean>> {
  const out: Partial<Record<NotifyCategory, boolean>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of ['approvals', 'trades', 'schedule_posts', 'reports'] as NotifyCategory[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/**
 * Does this manager want messages in this category?
 *
 * Explicit preference wins. Otherwise the role default: an owner is opted OUT of
 * everything (they didn't hire themselves to read swap alerts), everyone else is
 * opted IN. A login with no person record yet gets the role default too, so
 * linking someone never silently changes what they receive.
 */
export function wantsCategory(m: ManagerContact, category: NotifyCategory): boolean {
  const explicit = m.prefs[category];
  if (typeof explicit === 'boolean') return explicit;
  return m.role !== 'owner';
}

/**
 * THE manager lookup. Every workflow that needs to reach a manager calls this
 * and nothing else.
 *
 * Resolution order per login:
 *   1. users.employee_id  → the person. This is the design.
 *   2. case-insensitive, trimmed match on employees.contact_email — the legacy
 *      path, kept so the system keeps working during the backfill. Logs a
 *      warning naming the person so the gap is visible and fixable.
 *   3. neither → phone stays null and we log LOUDLY. Previously this was
 *      silent, which is the whole reason a manager could be unreachable for
 *      months without anyone noticing.
 *
 * Revoked logins (access_revoked_at) are excluded. Role 'quria' is excluded:
 * platform admins have a users row for company-scoped access, not to receive a
 * client's operational traffic — their own contact details live in quria_staff.
 */
export async function resolveManagers(companyId: string): Promise<ManagerDirectory> {
  const [{ data: userRows, error: userErr }, smsChannel] = await Promise.all([
    supabase
      .from('users')
      .select('id, email, name, role, employee_id')
      .eq('company_id', companyId)
      .in('role', ['manager', 'owner'])
      .is('access_revoked_at', null),
    getAegisSmsChannel(companyId),
  ]);

  if (userErr) {
    // Fail loud, not silent. A lookup failure used to look identical to "this
    // company has no managers".
    console.error(
      `[manager-directory] FAILED to load managers for company ${companyId}: ${userErr.message}. ` +
      'No manager will be notified for this event.'
    );
    return { managers: [], smsChannel, unreachableBySms: [] };
  }

  const users = (Array.isArray(userRows) ? userRows : []) as UserRow[];
  if (users.length === 0) {
    console.error(
      `[manager-directory] company ${companyId} has NO active manager or owner login. ` +
      'Nothing can be routed to a manager for this company until one exists.'
    );
    return { managers: [], smsChannel, unreachableBySms: [] };
  }

  // One query for the whole company's people, then match in memory. Avoids the
  // per-manager round trip the old code did inside a loop, and lets us SEE a
  // duplicate email instead of having .maybeSingle() swallow it as null.
  const { data: empRows, error: empErr } = await supabase
    .from('employees')
    .select('id, name, contact_phone, contact_email, active, notification_prefs')
    .eq('company_id', companyId);

  if (empErr) {
    console.error(
      `[manager-directory] FAILED to load people for company ${companyId}: ${empErr.message}. ` +
      'Managers will be resolved without phone numbers; SMS will be skipped this run.'
    );
  }

  const employees = (Array.isArray(empRows) ? empRows : []) as EmployeeRow[];
  const byId = new Map<string, EmployeeRow>();
  const byEmail = new Map<string, EmployeeRow[]>();
  for (const e of employees) {
    byId.set(e.id, e);
    const key = (e.contact_email ?? '').trim().toLowerCase();
    if (!key) continue;
    const bucket = byEmail.get(key);
    if (bucket) bucket.push(e);
    else byEmail.set(key, [e]);
  }

  const managers: ManagerContact[] = [];
  const unreachableBySms: ManagerContact[] = [];

  for (const u of users) {
    let person: EmployeeRow | null = null;
    let linkSource: ManagerContact['linkSource'] = 'none';

    if (u.employee_id) {
      person = byId.get(u.employee_id) ?? null;
      if (person) {
        linkSource = 'employee_id';
      } else {
        // The foreign key makes this near-impossible, so if it happens say so.
        console.error(
          `[manager-directory] login ${u.email} points at employee ${u.employee_id}, ` +
          `which is not in company ${companyId}. Treating as unlinked.`
        );
      }
    }

    if (!person) {
      const key = (u.email ?? '').trim().toLowerCase();
      const candidates = byEmail.get(key) ?? [];
      if (candidates.length === 1) {
        person = candidates[0];
        linkSource = 'email_match';
        console.warn(
          `[manager-directory] ${u.name ?? u.email} is reachable only by matching their login ` +
          `email to a person record. Link them properly (Homebase → Access → Link to person) ` +
          `so a typo or an email change can't make them unreachable.`
        );
      } else if (candidates.length > 1) {
        // The old code used .maybeSingle() here, which returns null on multiple
        // rows AND never checked the error — so this case silently produced "no
        // phone" and the text was skipped.
        console.error(
          `[manager-directory] ${u.name ?? u.email}: ${candidates.length} people in company ` +
          `${companyId} share that email address, so we cannot tell which one is them. ` +
          'They will NOT receive a text until their login is linked to the right person.'
        );
      }
    }

    const contact: ManagerContact = {
      userId: u.id,
      employeeId: person?.id ?? null,
      name: person?.name ?? u.name ?? u.email,
      role: u.role === 'owner' ? 'owner' : 'manager',
      email: u.email,
      // An inactive person is "not here right now" — uncontactable by design.
      phone: person && person.active ? person.contact_phone : null,
      linkSource,
      prefs: readPrefs(person?.notification_prefs ?? null),
    };

    if (!contact.phone) {
      unreachableBySms.push(contact);
      if (linkSource === 'none') {
        console.error(
          `[manager-directory] ${contact.name} (${contact.email}) has no person record in ` +
          `company ${companyId}, so Aegis cannot text them — only email them. ` +
          'Create their employee record and link it in Homebase → Access.'
        );
      } else if (person && !person.active) {
        console.warn(
          `[manager-directory] ${contact.name} is linked to a person marked inactive, ` +
          'so they are treated as uncontactable by text. Reactivate them if that is wrong.'
        );
      } else {
        console.warn(
          `[manager-directory] ${contact.name} has a person record but no phone number on it, ` +
          'so they will be emailed instead of texted.'
        );
      }
    }

    managers.push(contact);
  }

  // Owner first, then manager, then by name — so "the one manager to tell"
  // is a deliberate, stable choice. The old code sorted by role ASCENDING,
  // which is alphabetical, which put 'manager' before 'owner' — the opposite of
  // what its own comment claimed.
  managers.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { managers, smsChannel, unreachableBySms };
}

/**
 * The managers who should receive a message in this category.
 *
 * SAFETY VALVE: if honouring everyone's preferences would leave an ACTION ITEM
 * with no recipient, it goes to every manager anyway and the override is logged.
 * A time-off request must never silently reach nobody — "no orphan outputs".
 */
export function recipientsFor(
  dir: ManagerDirectory,
  category: NotifyCategory,
  companyId: string
): ManagerContact[] {
  const opted = dir.managers.filter((m) => wantsCategory(m, category));
  if (opted.length > 0) return opted;
  if (dir.managers.length === 0) return [];
  if (!ACTION_CATEGORIES.has(category)) {
    console.warn(
      `[manager-directory] nobody at company ${companyId} wants '${category}' notifications. ` +
      'Skipping — this is not an action item.'
    );
    return [];
  }
  console.warn(
    `[manager-directory] every manager at company ${companyId} has opted out of '${category}', ` +
    'but this one needs a decision. Sending to all managers anyway so it does not vanish.'
  );
  return dir.managers;
}

/**
 * The single manager to tell, when a workflow genuinely wants one recipient
 * (a signal, not an approval). Owner first, then alphabetical — see the sort in
 * resolveManagers. Prefers someone we can actually reach.
 */
export function primaryRecipient(
  dir: ManagerDirectory,
  category: NotifyCategory,
  companyId: string
): ManagerContact | null {
  const pool = recipientsFor(dir, category, companyId);
  if (pool.length === 0) return null;
  return pool.find((m) => m.phone) ?? pool[0];
}

/**
 * Can we send this manager a text right now? Encapsulates the three things that
 * all have to be true, so no caller has to remember them.
 */
export function canSms(
  dir: ManagerDirectory,
  m: ManagerContact,
  emailOnly: boolean
): m is ManagerContact & { phone: string } {
  return !emailOnly && !!m.phone && !!dir.smsChannel;
}
