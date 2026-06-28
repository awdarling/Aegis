// Roadmap item 16 (first slice): per-company monitoring / observer inboxes.
//
// A company can have one or more "monitoring" email addresses (a dedicated
// inbox Alexander controls, e.g. monitorone@quriasolutions.com for Watermark).
// sendEmail BCC's these on EVERY outbound email for that company, giving a
// passive, complete audit/troubleshooting trail — WITHOUT making the address a
// manager (so it never receives manager authority or steals notifications).
//
// Fail-safe by design: a lookup failure returns [] so the real email always
// sends. Inert for any company with no rows configured (no BCC added at all),
// so this is a no-op everywhere until Alexander opts a client in.

import { supabase } from '../db/client';

/** Active monitoring-inbox emails for a company. Never throws — returns [] on any error. */
export async function resolveMonitoringEmails(companyId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('company_monitoring_inboxes')
      .select('email')
      .eq('company_id', companyId)
      .eq('active', true);
    if (error) {
      console.warn('[monitoring] inbox lookup error:', error.message);
      return [];
    }
    return ((data ?? []) as { email: string }[])
      .map((r) => (r.email ?? '').trim())
      .filter((e) => e.length > 0);
  } catch (err) {
    console.warn('[monitoring] inbox lookup failed:', err);
    return [];
  }
}

/**
 * Build the BCC list for an outbound email: de-duplicate the monitoring
 * addresses and drop any that equal the direct recipient (so we never BCC
 * someone their own message). Pure — unit-tested.
 */
export function buildBccList(monitorEmails: string[], recipientTo: string): string[] {
  const to = (recipientTo ?? '').trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of monitorEmails ?? []) {
    const email = (raw ?? '').trim();
    if (!email) continue;
    const lc = email.toLowerCase();
    if (lc === to) continue;
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(email);
  }
  return out;
}
