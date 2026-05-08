import { supabase } from '../db/client';
import { handlePayrollCheck } from '../workflows/payroll';
import type { InboundMessage, VerifiedContact } from '../security/types';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STARTUP_DELAY_MS = 60 * 60 * 1000;        // 1 hour offset to avoid collision with coverage scheduler

export function startPayrollScheduler(): void {
  console.log('[payroll-scheduler] starting — daily check will begin in 1 hour');

  setTimeout(() => {
    console.log('[payroll-scheduler] daily check active — running every 24 hours');
    void runDailyCheck();
    setInterval(() => void runDailyCheck(), CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

async function runDailyCheck(): Promise<void> {
  console.log('[payroll-scheduler] running daily payroll check');

  const todayDow = new Date().getUTCDay(); // 0=Sun, 6=Sat

  const { data, error } = await supabase
    .from('payroll_integrations')
    .select('id, company_id, pay_period, payroll_check_day, last_run_at, auto_check_enabled')
    .eq('active', true)
    .eq('auto_check_enabled', true);

  if (error) {
    console.error('[payroll-scheduler] failed to load integrations:', error.message);
    return;
  }

  const integrations = (data ?? []) as Array<{
    id: string;
    company_id: string;
    pay_period: 'weekly' | 'biweekly' | 'semimonthly';
    payroll_check_day: number;
    last_run_at: string | null;
    auto_check_enabled: boolean;
  }>;

  console.log(`[payroll-scheduler] found ${integrations.length} active auto-check integration(s)`);

  for (const integration of integrations) {
    try {
      await checkIntegration(integration, todayDow);
    } catch (err) {
      console.error(`[payroll-scheduler] error processing company ${integration.company_id}:`, err);
      // Continue — one failure never stops the rest
    }
  }
}

async function checkIntegration(
  integration: {
    company_id: string;
    pay_period: 'weekly' | 'biweekly' | 'semimonthly';
    payroll_check_day: number;
    last_run_at: string | null;
  },
  todayDow: number
): Promise<void> {
  // Check if today's day of week matches the configured check day
  if (todayDow !== integration.payroll_check_day) {
    return;
  }

  // Check if last_run_at is far enough in the past based on pay_period
  if (integration.last_run_at) {
    const lastRun = new Date(integration.last_run_at);
    const now = new Date();
    const daysSinceLastRun = (now.getTime() - lastRun.getTime()) / (24 * 60 * 60 * 1000);

    const minDays = integration.pay_period === 'weekly' ? 6 : 13;
    if (daysSinceLastRun < minDays) {
      console.log(
        `[payroll-scheduler] skipping company ${integration.company_id} — ` +
        `last run was ${daysSinceLastRun.toFixed(1)} days ago (min ${minDays})`
      );
      return;
    }
  }

  console.log(`[payroll-scheduler] triggering payroll check for company ${integration.company_id}`);

  // Find the manager's contact info
  const { data: userData } = await supabase
    .from('users')
    .select('id, email, name, role')
    .eq('company_id', integration.company_id)
    .in('role', ['owner', 'manager'])
    .limit(1)
    .maybeSingle();

  if (!userData) {
    console.warn(`[payroll-scheduler] no manager found for company ${integration.company_id} — skipping`);
    return;
  }

  const user = userData as { id: string; email: string; name: string; role: string };

  const syntheticMessage: InboundMessage = {
    sender: user.email,
    recipient: 'aegis@system',
    body: 'run_payroll_check',
    channel: 'email',
  };

  const syntheticContact: VerifiedContact = {
    role: 'manager',
    company_id: integration.company_id,
    employee_id: null,
    user_id: user.id,
    name: user.name,
    matched_identifier: user.email,
    channel: 'email',
  };

  await handlePayrollCheck(syntheticMessage, syntheticContact, {});
}
