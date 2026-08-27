import { supabase } from '../db/client';

// ── "Today" in the TENANT's timezone ─────────────────────────────────────────
//
// CLAUDE.md hard rule: anything that resolves a date must use the company's own
// local date (companies.timezone), never the server's UTC clock. Several files
// grew their own copy of this; new code should call these instead of adding
// another. Format is YYYY-MM-DD (the 'en-CA' locale), which sorts and compares
// as a plain string against every date column we store.

export const DEFAULT_TENANT_TIMEZONE = 'America/New_York';

export function todayInTimezone(tz: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TENANT_TIMEZONE }).format(now);
  }
}

// Reads companies.timezone once and returns today's local date for that tenant.
// Falls back to the platform default when the row has no timezone.
export async function tenantToday(companyId: string): Promise<string> {
  const { data } = await supabase
    .from('companies')
    .select('timezone')
    .eq('id', companyId)
    .maybeSingle();
  const tz = (data as { timezone?: string | null } | null)?.timezone || DEFAULT_TENANT_TIMEZONE;
  return todayInTimezone(tz);
}

/** Both at once, for callers that also need the zone (e.g. to localise a timestamp). */
export async function tenantTodayAndZone(companyId: string): Promise<{ today: string; timezone: string }> {
  const { data } = await supabase
    .from('companies')
    .select('timezone')
    .eq('id', companyId)
    .maybeSingle();
  const timezone = (data as { timezone?: string | null } | null)?.timezone || DEFAULT_TENANT_TIMEZONE;
  return { today: todayInTimezone(timezone), timezone };
}
