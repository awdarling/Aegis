-- Migration: 001_create_company_channels
-- Purpose: Maps Twilio phone numbers and inbound SendGrid email addresses
--          to their corresponding company_id. This is how Aegis resolves
--          which tenant owns an inbound message before sender verification.
--
-- channel_type 'sms'   → channel_value is an E.164 phone number, e.g. +15551234567
-- channel_type 'email' → channel_value is the full inbound address, e.g. acme@mail.aegis.yourdomain.com

CREATE TABLE IF NOT EXISTS public.company_channels (
  id           uuid NOT NULL DEFAULT uuid_generate_v4(),
  company_id   uuid NOT NULL,
  channel_type text NOT NULL CHECK (channel_type = ANY (ARRAY['sms'::text, 'email'::text])),
  channel_value text NOT NULL,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_channels_pkey PRIMARY KEY (id),
  CONSTRAINT company_channels_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
  CONSTRAINT company_channels_value_unique UNIQUE (channel_type, channel_value)
);

-- Index for the fast lookup path: given a channel_value (Twilio number or inbound email),
-- find the company_id instantly.
CREATE INDEX IF NOT EXISTS idx_company_channels_lookup
  ON public.company_channels (channel_type, channel_value);

-- Restrict to service role — no public access
ALTER TABLE public.company_channels ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.company_channels IS
  'Maps Aegis inbound channels (Twilio phone numbers, SendGrid email addresses) to company_id. One row per channel per company.';
