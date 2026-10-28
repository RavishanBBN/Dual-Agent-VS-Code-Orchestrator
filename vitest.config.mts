import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Everything except modules that import vscode (extension.ts, config.ts, and the view and chat host
      // classes in src/ui) and the webview's Preact components, which the smoke test exercises instead.
      include: ['src/core/**/*.ts', 'src/adapters/**/*.ts', 'src/ui/presentation.ts', 'src/ui/chat/protocol.ts', 'src/ui/chat/transcript.ts', 'src/webview/markdown.ts'],
      // The PDF worker is a thin entry point around pdfText.ts, which is tested directly.
      exclude: ['src/core/types.ts', 'src/core/pdfWorker.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
