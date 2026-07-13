// ── ONE QUESTION, ONE ANSWER ──────────────────────────────────────────────────
//
// "Can this employee work this slot?"
//
// That question was being answered in EIGHT different places, each with its own
// copy of the logic:
//
//   engine/eligibility.ts      build: who can be scheduled
//   workflows/schedule-build   cascade pool + gap reasons
//   lib/schedule-simulator     time-off: would approving this open a gap?
//   workflows/shift-swap       can this person pick up / swap into this shift?
//   workflows/emergency-coverage  who can we call when someone drops out?
//   engine/dispositions        "why wasn't X scheduled?"
//   Homebase GapResolverPanel  who can the manager drop into this gap?
//   Homebase validate-assignment  is this manual assignment legal?
//
// Six of them compared the employee's roles against a SINGLE role string. So when
// a manager configured a slot to accept "Lifeguard OR Headguard" — a normal thing
// to want, in any business — the engine honoured it, and the swap workflow told
// the same Headguard they were "not qualified" for the very same shift.
//
// This is Rule 0's twin, for LOGIC rather than DATA:
//
//   RULE 0b — ONE QUESTION, ONE FUNCTION.
//   If two workflows need the same answer, they call the SAME function.
//   A workflow that reimplements the check is a bug waiting to disagree with
//   its siblings. Duplicated logic rots exactly like duplicated data: someone
//   fixes one copy, the others silently drift, and the product lies to a
//   different user through a different channel.
//
// NOTHING in here is client-specific. There is no role vocabulary, no fixed
// number of roles, no assumption about what a business calls its jobs. A client
// can define any roles they like and accept any combination of them on any shift;
// every workflow will agree, because every workflow asks the same function.

import { supabase } from '../db/client';

/** Anything that names a role and (maybe) the wider set that may fill it. */
export interface RoleSpec {
  role: string;
  accepted_roles?: string[] | null;
}

/**
 * Every role that may fill this slot.
 *
 * Falls back to `[role]` when `accepted_roles` is absent or empty. Two reasons
 * that matters: schedules published BEFORE accepted_roles was carried on
 * assignments still parse, and a malformed row can never make a slot unfillable
 * by everyone (an empty accepted set would exclude the entire company).
 */
export function acceptedRolesOf(spec: RoleSpec): string[] {
  return spec.accepted_roles?.length ? spec.accepted_roles : [spec.role];
}

/**
 * THE qualification check. Every workflow routes through this.
 *
 * An employee qualifies if they hold ANY of the roles the manager said can fill
 * the slot — not merely the preferred one.
 */
export function isQualified(employeeRoles: string[] | null | undefined, acceptedRoles: string[]): boolean {
  if (!employeeRoles?.length || !acceptedRoles.length) return false;
  return acceptedRoles.some(r => employeeRoles.includes(r));
}

/** Convenience: check an employee-shaped object against a slot-shaped object. */
export function canFill(
  employee: { qualified_roles: string[] | null },
  spec: RoleSpec,
): boolean {
  return isQualified(employee.qualified_roles, acceptedRolesOf(spec));
}

/**
 * How we NAME the requirement to a human: "Lifeguard", or "Lifeguard or Headguard".
 *
 * Manager-facing copy must match what the manager configured. Saying "no Lifeguard
 * available" when a Headguard would have done is a lie by omission — it hides the
 * fact that the shift COULD be covered.
 */
export function roleLabel(acceptedRoles: string[]): string {
  if (acceptedRoles.length === 0) return 'staff';
  if (acceptedRoles.length === 1) return acceptedRoles[0];
  return acceptedRoles.join(' or ');
}

/** Convenience: label straight from a role spec. */
export function roleLabelOf(spec: RoleSpec): string {
  return roleLabel(acceptedRolesOf(spec));
}

/**
 * DB fallback for callers that only have a shift NAME and a role — chiefly the
 * swap paths, which act on a `ScheduleAssignment` read back out of a schedule
 * that may have been published before assignments carried `accepted_roles`.
 *
 * Resolves the requirement's accepted_roles from the manager's own configuration
 * (shift_requirements → shift_types). Never throws: on any miss it returns
 * `[role]`, which is exactly the old single-role behaviour — so a lookup failure
 * degrades to "no worse than before", never to "nobody is qualified".
 */
export async function resolveAcceptedRoles(
  companyId: string,
  shiftName: string,
  role: string,
): Promise<string[]> {
  try {
    const { data } = await supabase
      .from('shift_requirements')
      .select('accepted_roles, role, shift_types!inner(name)')
      .eq('company_id', companyId)
      .eq('role', role)
      .eq('shift_types.name', shiftName)
      .limit(1)
      .maybeSingle();

    const row = data as { accepted_roles: string[] | null; role: string } | null;
    return row?.accepted_roles?.length ? row.accepted_roles : [role];
  } catch {
    return [role];
  }
}
