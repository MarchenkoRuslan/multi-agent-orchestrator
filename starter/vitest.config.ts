import { defineConfig } from 'vitest/config';

// Only the project's own tests: PR snapshots under .reviews/ contain the reviewed repository's tests,
// which must never be executed.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.reviews/**', 'dist/**']
  }
});
