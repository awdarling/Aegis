-- 024_company_channels_comment_telnyx.sql
-- Purpose: correct a stale table comment. The comment on public.company_channels
-- still says "Twilio phone numbers". Telnyx has been the only SMS provider since
-- 2026-07-29; there is no Twilio anywhere in Aegis or Homebase. The comment is
-- visible to anyone (person or agent) inspecting the schema, so it is one more
-- place the system tells a new reader something false.
--
-- COMMENT-ONLY. No data, no columns, no indexes, no behaviour change.
-- Safe to run on production at any time.

COMMENT ON TABLE public.company_channels IS
  'Maps Aegis inbound channels (Telnyx phone numbers, SendGrid email addresses) to company_id. One row per channel per company.';

-- Verification — run this after. Expect the returned text to say "Telnyx", not "Twilio":
--   SELECT obj_description('public.company_channels'::regclass, 'pg_class') AS table_comment;
