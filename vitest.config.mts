import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/core/context.ts',
        'src/core/errors.ts',
        'src/core/orchestrator.ts',
        'src/core/report.ts',
        'src/core/store.ts',
        'src/core/usage.ts',
        'src/core/workflows.ts',
        'src/adapters/parsers.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
