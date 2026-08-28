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

// Plain-string date arithmetic on YYYY-MM-DD (UTC-noon anchor so DST can't
// shift the calendar day). Used by the call-out window ("today or tomorrow").
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Minutes from now until a wall-clock moment in the tenant's timezone
 * (e.g. the start of a shift). Negative when the moment has passed.
 *
 * Both sides are rendered as NAIVE local datetimes in the same zone and
 * compared as if UTC — correct because the zone offset cancels. This avoids
 * the recurring bug of parsing `${date}T${time}Z` (which silently treats a
 * tenant-local shift start as UTC).
 */
export function minutesUntilTenantTime(
  timezone: string,
  date: string,
  time: string,
  now: Date = new Date(),
): number {
  let nowNaive: string;
  try {
    nowNaive = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now).replace(' ', 'T');
  } catch {
    return minutesUntilTenantTime(DEFAULT_TENANT_TIMEZONE, date, time, now);
  }
  const target = Date.parse(`${date}T${time.slice(0, 5)}:00Z`);
  const current = Date.parse(`${nowNaive}Z`);
  return Math.round((target - current) / 60000);
}
