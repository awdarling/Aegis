import { supabase } from '../db/client';
import { computeWageEstimate, type WageEstimate } from './schedule-simulator';

// Loads a schedule by id and computes the current wage estimate from its
// assignments. Returns an empty estimate if the row is missing or has no
// assignments. The stored staffing_report.estimated_wages is a snapshot from
// build time; this helper recomputes against the live row.
export async function getCurrentWageEstimate(
  companyId: string,
  scheduleId: string
): Promise<WageEstimate> {
  const { data } = await supabase
    .from('schedules')
    .select('data')
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle();

  const row = data as { data: { assignments?: unknown[] } | null } | null;
  const assignments = (row?.data?.assignments ?? []) as Array<{
    employee_id: string;
    employee_name: string;
    role: string;
    start_time: string;
    end_time: string;
    hours?: number;
  }>;

  return computeWageEstimate(companyId, assignments);
}
