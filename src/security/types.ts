export type Channel = 'email' | 'sms';
export type ContactRole = 'employee' | 'manager' | 'quria_admin';

export interface VerifiedContact {
  role: ContactRole;
  company_id: string;
  // Entity identity — one of these will be populated depending on role
  employee_id: string | null;
  user_id: string | null;
  name: string;
  // The normalized identifier that matched
  matched_identifier: string;
  channel: Channel;
  // Populated only for quria_admin — used for audit trail metadata
  quria_staff_email?: string;
}

export interface InboundMessage {
  sender: string;       // normalized: E.164 phone or lowercase email
  recipient: string;    // the Aegis channel value (Twilio number or inbound email address)
  body: string;
  channel: Channel;
  raw_subject?: string; // email only
  thread_id?: string;   // email Message-ID for threading
}
