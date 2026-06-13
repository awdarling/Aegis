import { defineConfig } from 'vitest/config';

// Aegis test runner (AEGIS-EMAIL-1 prerequisite). Conventional vitest setup:
// node environment, tests live next to the code in __tests__ dirs, a setup file
// seeds the few env vars module-load needs. Tests mock Supabase + SendGrid —
// nothing touches a real DB or sends a real email.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
