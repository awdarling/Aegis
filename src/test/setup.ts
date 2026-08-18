// Vitest global setup.
//
// `src/config/env.ts` validates the environment at MODULE LOAD and calls
// process.exit(1) when a required var is missing. On a clean checkout with no
// `.env` file that killed 9 test files at import time and silently reduced the
// suite from 753 tests to 697 — which reads like a regression and isn't one.
// So we seed dummy values here for everything the schema requires.
//
// These are dummy values. Nothing real is contacted: Supabase, SendGrid, Telnyx
// and Anthropic are all mocked per-test. A real `.env` still wins — every
// assignment below is `??`, so a developer's local values are never overwritten.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// Required by the env schema (src/config/env.ts) — module load fails without them.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-service-role-key';
process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY ?? 'SG.test-key';
process.env.SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL ?? 'aegis@test.local';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-key';

// Read when building magic-link URLs back into Homebase.
process.env.HOMEBASE_URL = process.env.HOMEBASE_URL ?? 'https://homebase.test.local';

// BASE_URL is read when building magic-link decision URLs (e.g. the coverage
// Accept/Decline email buttons). Seed a valid dummy so importing those modules
// passes env validation — and override a malformed real value rather than
// letting the URL check fail the whole suite.
process.env.BASE_URL = (process.env.BASE_URL && /^https?:\/\//.test(process.env.BASE_URL))
  ? process.env.BASE_URL
  : 'http://localhost:3000';
