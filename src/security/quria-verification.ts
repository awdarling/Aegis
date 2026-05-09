import { supabase } from '../db/client';

export interface QuriaStaffRow {
  id: string;
  email: string;
  name: string;
  contact_phone: string | null;
  active: boolean;
}

// Look up a Quria staff member by their contact identifier.
// For SMS: matches contact_phone (E.164). For email: matches email.
// Returns null if not found or on DB error.
export async function checkQuriaStaff(params: {
  channel: 'sms' | 'email';
  identifier: string;
}): Promise<QuriaStaffRow | null> {
  const field = params.channel === 'sms' ? 'contact_phone' : 'email';

  const { data, error } = await supabase
    .from('quria_staff')
    .select('id, email, name, contact_phone, active')
    .eq(field, params.identifier)
    .maybeSingle();

  if (error) {
    console.error('[quria-verification] lookup error:', error.message);
    return null;
  }

  return data ?? null;
}
