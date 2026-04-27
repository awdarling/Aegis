import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Service role client — bypasses RLS. Never expose to clients.
// Untyped at the client level; explicit row types from ./types are used at call sites.
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  }
);
