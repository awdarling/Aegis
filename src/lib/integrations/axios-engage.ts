import type { PayrollAdapter } from './payroll-adapter';

export class AxiosEngageAdapter implements PayrollAdapter {
  private readonly apiKey: string;
  private readonly companyIdentifier: string;

  constructor(params: { apiKey: string; companyIdentifier: string }) {
    this.apiKey = params.apiKey;
    this.companyIdentifier = params.companyIdentifier;
  }

  async getEmployeeWageRate(params: {
    employeeExternalId: string;
  }): Promise<{ rate: number | null; currency: string }> {
    console.log(
      `[axios-engage] getEmployeeWageRate for employee ${params.employeeExternalId} ` +
      `(company: ${this.companyIdentifier})`
    );

    // TODO: Replace with actual Axios Engage API call once API docs received
    // Expected shape: GET /employees/:id/wage-rate
    // Authorization: Bearer ${this.apiKey}

    return { rate: null, currency: 'USD' };
  }

  async updateEmployeeWageRate(params: {
    employeeExternalId: string;
    newRate: number;
    effectiveDate: string;
    reason?: string;
  }): Promise<{ success: boolean; message: string }> {
    console.log(
      `[axios-engage] updateEmployeeWageRate for employee ${params.employeeExternalId} ` +
      `→ $${params.newRate}/hr effective ${params.effectiveDate}`
    );

    // TODO: Replace with actual Axios Engage API call once API docs received
    // Expected shape: PUT /employees/:id/wage-rate
    // Body: { rate, effective_date, reason }

    return {
      success: false,
      message: 'Axios Engage API not yet configured',
    };
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    console.log(`[axios-engage] testConnection (company: ${this.companyIdentifier})`);

    // TODO: Replace with actual health/ping endpoint

    return {
      success: false,
      message: 'Axios Engage not yet configured — placeholder adapter',
    };
  }
}
