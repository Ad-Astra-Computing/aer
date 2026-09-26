import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // Scrubs AER_* and refuses any child or fetch that could reach the live service.
    setupFiles: ['src/env-guard.test-setup.ts'],
  },
});
