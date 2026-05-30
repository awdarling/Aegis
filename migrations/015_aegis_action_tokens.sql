-- Migration 015: aegis_action_tokens
-- Single-use, expiring tokens for email-mode action buttons
CREATE TABLE IF NOT EXISTS public.aegis_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  action_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_to_email text,
  issued_to_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  issued_to_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_aegis_action_tokens_hash
  ON public.aegis_action_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_aegis_action_tokens_company_expires
  ON public.aegis_action_tokens (company_id, expires_at);

ALTER TABLE public.aegis_action_tokens ENABLE ROW LEVEL SECURITY;
-- No public RLS policies; service-role key bypasses RLS for all token operations
