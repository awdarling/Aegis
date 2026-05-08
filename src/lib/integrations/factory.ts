import { supabase } from '../../db/client';
import { NorthStarAdapter } from './northstar';
import { AxiosEngageAdapter } from './axios-engage';
import type { TimeClockAdapter } from './time-clock-adapter';
import type { PayrollAdapter } from './payroll-adapter';

export async function getTimeClockAdapter(companyId: string): Promise<TimeClockAdapter | null> {
  const { data, error } = await supabase
    .from('time_clock_integrations')
    .select('provider, api_key, api_base_url, location_id, active')
    .eq('company_id', companyId)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error('[factory] time_clock_integrations query failed:', error.message);
    return null;
  }

  if (!data) return null;

  const row = data as {
    provider: string;
    api_key: string | null;
    api_base_url: string | null;
    location_id: string | null;
    active: boolean;
  };

  if (row.provider === 'northstar') {
    return new NorthStarAdapter({
      apiKey: row.api_key ?? '',
      apiBaseUrl: row.api_base_url ?? '',
      locationId: row.location_id ?? undefined,
    });
  }

  console.warn(`[factory] unsupported time clock provider: ${row.provider}`);
  return null;
}

export async function getPayrollAdapter(companyId: string): Promise<PayrollAdapter | null> {
  const { data, error } = await supabase
    .from('payroll_integrations')
    .select('provider, api_key, company_identifier, active')
    .eq('company_id', companyId)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error('[factory] payroll_integrations query failed:', error.message);
    return null;
  }

  if (!data) return null;

  const row = data as {
    provider: string;
    api_key: string | null;
    company_identifier: string | null;
    active: boolean;
  };

  if (row.provider === 'axios_engage') {
    return new AxiosEngageAdapter({
      apiKey: row.api_key ?? '',
      companyIdentifier: row.company_identifier ?? '',
    });
  }

  console.warn(`[factory] unsupported payroll provider: ${row.provider}`);
  return null;
}
