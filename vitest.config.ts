import { defineConfig } from 'vitest/config';

// Restrict discovery to this repository's TypeScript specs.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
