export type ActionType =
  | 'approve_to'
  | 'deny_to'
  | 'approve_availability'
  | 'deny_availability'
  | 'approve_custom_availability'
  | 'deny_custom_availability'
  | 'accept_emergency_coverage'
  | 'decline_emergency_coverage'
  | 'confirm_distribution'
  | 'request_additional_batch';

export interface GenerateTokenParams {
  action_type: ActionType;
  payload: Record<string, unknown>;
  company_id: string;
  issued_to_email: string;
  issued_to_employee_id?: string;
  issued_to_user_id?: string;
  ttl_minutes?: number;
}

export interface GenerateTokenResult {
  url: string;
  raw_token: string;
  token_hash: string;
  expires_at: string;
}
