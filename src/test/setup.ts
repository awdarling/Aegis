// Vitest global setup. Seeds the handful of env vars that are read at module
// load or when building magic-link URLs, so importing the workflow modules
// doesn't fail. These are dummy values — no real service is contacted (Supabase
// + SendGrid are mocked per-test).
process.env.HOMEBASE_URL = process.env.HOMEBASE_URL ?? 'https://homebase.test.local';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
// BASE_URL is read when building magic-link decision URLs (e.g. the coverage
// Accept/Decline email buttons). Seed a valid dummy so importing those modules
// passes env validation.
process.env.BASE_URL = (process.env.BASE_URL && /^https?:\/\//.test(process.env.BASE_URL))
  ? process.env.BASE_URL
  : 'http://localhost:3000';
