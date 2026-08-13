// ── Daily offboarding job (NextBuild Feature B) ───────────────────────────────
//
// Once a manager acknowledges a departure by setting employees.last_day, this job
// flips active=false the day AFTER that date passes — so a forgotten offboarding
// never leaves a departed person on next week's schedule. It reuses the existing
// `active` switch (every scheduling/swap/coverage/notify/UI path already excludes
// inactive employees), instead of teaching a dozen systems a new date.
//
// Boundary: an employee WORKS their last day. We deactivate when last_day < today
// (strictly before), so someone whose last_day is today is still active today and
// gets deactivated on the next run. Whole-day granularity, cross-tenant.
//
// Modeled on payroll-scheduler.ts: a startup offset then a 24h interval, gated by
// env.RUN_SCHEDULERS in src/index.ts so only ONE process runs cross-tenant jobs.

import { supabase } from '../db/client';
import { logActivity } from '../logger/activity-log';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STARTUP_DELAY_MS = 2 * 60 * 60 * 1000;   // 2h offset — avoid colliding with coverage (0) + payroll (1h)

export function startEmployeeOffboardingScheduler(): void {
  console.log('[offboarding-scheduler] starting — daily deactivation sweep will begin in 2 hours');

  setTimeout(() => {
    console.log('[offboarding-scheduler] daily sweep active — running every 24 hours');
    void runDailySweep();
    setInterval(() => void runDailySweep(), CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

// Exported for tests + a manual run. Deactivates every active employee whose
// acknowledged last_day is strictly before today (UTC). Returns the count flipped.
export async function runDailySweep(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  console.log(`[offboarding-scheduler] running daily deactivation sweep for last_day < ${today}`);

  // Load the departed-but-still-active roster across all tenants. last_day is a
  // nullable date; NULL rows (no departure) are excluded by the < comparison but we
  // also guard explicitly so intent is clear.
  const { data, error } = await supabase
    .from('employees')
    .select('id, company_id, name, last_day')
    .eq('active', true)
    .not('last_day', 'is', null)
    .lt('last_day', today);

  if (error) {
    console.error('[offboarding-scheduler] failed to load departed employees:', error.message);
    return 0;
  }

  const departed = (data ?? []) as Array<{ id: string; company_id: string; name: string; last_day: string }>;
  if (departed.length === 0) {
    console.log('[offboarding-scheduler] no employees to deactivate today');
    return 0;
  }

  let flipped = 0;
  for (const emp of departed) {
    try {
      const { error: updErr } = await supabase
        .from('employees')
        .update({ active: false })
        .eq('id', emp.id)
        .eq('company_id', emp.company_id)
        .eq('active', true); // guard: only flip a still-active row (idempotent)
      if (updErr) {
        console.error(`[offboarding-scheduler] failed to deactivate ${emp.id}:`, updErr.message);
        continue;
      }

      await logActivity({
        company_id: emp.company_id,
        action: 'employee_deactivated',
        entity_type: 'employee',
        entity_id: emp.id,
        summary: `${emp.name} was deactivated automatically — their acknowledged last day (${emp.last_day}) has passed (offboarding).`,
        metadata: { reason: 'offboarding', last_day: emp.last_day },
      });
      flipped++;
    } catch (err) {
      console.error(`[offboarding-scheduler] error deactivating ${emp.id}:`, err);
      // Continue — one failure never stops the rest.
    }
  }

  console.log(`[offboarding-scheduler] deactivated ${flipped} employee(s)`);
  return flipped;
}
