// Vitest global setup. Seeds the handful of env vars that are read at module
// load or when building magic-link URLs, so importing the workflow modules
// doesn't fail. These are dummy values — no real service is contacted (Supabase
// + SendGrid are mocked per-test).
process.env.HOMEBASE_URL = process.env.HOMEBASE_URL ?? 'https://homebase.test.local';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
