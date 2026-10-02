import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'tests/integration/web.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        // Ratchet: whole-codebase floor measured for 3.0 — raise it, never lower it.
        lines: 49,
        statements: 49,
        functions: 55,
        branches: 47,
        // The analysis/governance core keeps the stricter historic bar.
        'src/core/**/*.ts': {
          lines: 70,
          functions: 65,
          branches: 60,
          statements: 70
        }
      }
    }
  }
});
