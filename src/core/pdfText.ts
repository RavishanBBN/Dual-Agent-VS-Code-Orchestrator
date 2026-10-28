import { extractText } from 'unpdf';

/**
 * The text of each page of a PDF, with page markers. Run it through `pdfWorker.ts`, not on the host thread;
 * the worker ends after each document, which releases everything pdf.js allocated.
 */
export async function pdfToText(data: Uint8Array): Promise<string> {
  const { text } = await extractText(new Uint8Array(data), { mergePages: false });
  return text.map((page, index) => `--- Page ${index + 1} ---\n${page.trim()}`).join('\n\n');
}
