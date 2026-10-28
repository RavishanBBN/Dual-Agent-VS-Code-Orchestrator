import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** The extension host bundle, and the PDF reader that runs in a worker thread only when a PDF is attached. */
const host = {
  entryPoints: { extension: 'src/extension.ts', pdfWorker: 'src/core/pdfWorker.ts' },
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

/** The chat panel, which runs in the webview with no Node.js access. */
const webview = {
  entryPoints: { chat: 'src/webview/main.tsx' },
  bundle: true,
  outdir: 'dist/webview',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'css' },
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  for (const options of [host, webview]) await (await esbuild.context(options)).watch();
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
