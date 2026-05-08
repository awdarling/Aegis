import type { TimeClockAdapter } from './time-clock-adapter';
import type { ClockRecord } from '../payroll-reconciler';

export class NorthStarAdapter implements TimeClockAdapter {
  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly locationId: string | undefined;

  constructor(params: { apiKey: string; apiBaseUrl: string; locationId?: string }) {
    this.apiKey = params.apiKey;
    this.apiBaseUrl = params.apiBaseUrl;
    this.locationId = params.locationId;
  }

  async fetchClockRecords(params: {
    periodStart: string;
    periodEnd: string;
    locationId?: string;
  }): Promise<ClockRecord[]> {
    const locationId = params.locationId ?? this.locationId;
    console.log(
      `[northstar] fetching clock records for ${params.periodStart} to ${params.periodEnd}` +
      (locationId ? ` (location: ${locationId})` : '')
    );

    // TODO: Replace with actual NorthStar API endpoint and response mapping once API docs received
    // Expected shape:
    //   GET ${this.apiBaseUrl}/clock-records
    //   Authorization: Bearer ${this.apiKey}
    //   Query params: start_date, end_date, location_id
    // Then map each response item to ClockRecord format.

    console.log('[northstar] PLACEHOLDER — real API endpoint not yet configured. Returning empty records.');
    return [];
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    // TODO: Replace with actual health endpoint (e.g. GET ${this.apiBaseUrl}/health or /ping)
    return {
      success: false,
      message: 'NorthStar API not yet configured — placeholder adapter',
    };
  }
}
