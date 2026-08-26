// S-3 (actor half), SECURITY_AUDIT_MASTER §2 / §8 — 2026-08-24.
//
// A manager's approve/deny link is a self-contained token that outlives the
// moment it was minted. Revoking the manager's Homebase access must also revoke
// the link. This is the ONE place that answers "may this login still act as a
// manager right now?" (Rule 0b). Fail closed: unknown login or a lookup error
// means no.

import { supabase } from '../db/client';

export async function managerStillActive(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return true; // token predates manager attribution — nothing to check against
  const { data, error } = await supabase
    .from('users')
    .select('id, access_revoked_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('[manager-active] lookup failed — refusing (fail closed):', error.message);
    return false;
  }
  if (!data) return false;
  return (data as { access_revoked_at: string | null }).access_revoked_at == null;
}
