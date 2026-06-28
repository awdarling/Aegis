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
  | 'request_additional_batch'
  | 'recheck_to'
  // #10 undirected swap broadcast — a candidate's two options in the email.
  // 'swap_pickup' → confirm page (one-way pickup); 'swap_trade_select' → the
  // action-card shift-picker (two-way trade). Both land on Homebase pages.
  | 'swap_pickup'
  | 'swap_trade_select';

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
