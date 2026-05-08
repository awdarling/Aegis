export interface PayrollAdapter {
  getEmployeeWageRate(params: {
    employeeExternalId: string;
  }): Promise<{ rate: number | null; currency: string }>;

  updateEmployeeWageRate(params: {
    employeeExternalId: string;
    newRate: number;
    effectiveDate: string;
    reason?: string;
  }): Promise<{ success: boolean; message: string }>;

  testConnection(): Promise<{
    success: boolean;
    message: string;
  }>;
}
