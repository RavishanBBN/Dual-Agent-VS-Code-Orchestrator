import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Everything except the VS Code composition layer (extension.ts, config.ts, dashboardProvider.ts).
      include: ['src/core/**/*.ts', 'src/adapters/**/*.ts', 'src/ui/messages.ts'],
      exclude: ['src/core/types.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
