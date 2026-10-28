import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Everything except modules that import vscode (extension.ts, config.ts, and the view classes in src/ui).
      include: ['src/core/**/*.ts', 'src/adapters/**/*.ts', 'src/ui/presentation.ts'],
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
