import type { ClockRecord } from '../payroll-reconciler';

export interface TimeClockAdapter {
  fetchClockRecords(params: {
    periodStart: string;
    periodEnd: string;
    locationId?: string;
  }): Promise<ClockRecord[]>;

  testConnection(): Promise<{
    success: boolean;
    message: string;
  }>;
}
