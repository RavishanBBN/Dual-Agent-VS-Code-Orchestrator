/**
 * Worker-thread entry point, bundled to dist/pdfWorker.js. The host thread posts the PDF's bytes as
 * `workerData` and terminates the worker if it does not answer in time (see `extractPdfTextInWorker`).
 */
import { parentPort, workerData } from 'node:worker_threads';

import { pdfToText } from './pdfText.js';

pdfToText(workerData as Uint8Array).then(
  (text) => parentPort?.postMessage({ text }),
  (error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }),
);
