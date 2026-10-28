import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { strToU8, zipSync, type Zippable } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AttachmentError,
  attachmentText,
  detectKind,
  extractPdfTextInWorker,
  looksSensitive,
  mentionAttachment,
  officeText,
  removeAttachmentFolder,
  safeFileName,
  storeAttachment,
  unpackArchive,
} from '../src/core/attachments.js';
import { pdfToText } from '../src/core/pdfText.js';
import { removeTemporaryDirectories, temporaryDirectory } from './helpers.js';

afterEach(removeTemporaryDirectories);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A one-page PDF whose only content is `text`, built by hand so the test needs no fixture file. */
function samplePdf(text: string): Uint8Array {
  const body = `BT /F1 18 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

function zip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Zippable = {};
  for (const [name, content] of Object.entries(entries)) files[name] = typeof content === 'string' ? strToU8(content) : content;
  return zipSync(files);
}

describe('attachment detection', () => {
  it('classifies files by content, using the extension only where content is ambiguous', () => {
    expect(detectKind('screen.png', PNG)).toEqual({ kind: 'image', mediaType: 'image/png' });
    expect(detectKind('photo.dat', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: 'image', mediaType: 'image/jpeg' });
    expect(detectKind('a.gif', strToU8('GIF89a...'))).toMatchObject({ kind: 'image', mediaType: 'image/gif' });
    expect(detectKind('a.webp', strToU8('RIFF\0\0\0\0WEBPVP8 '))).toMatchObject({ kind: 'image', mediaType: 'image/webp' });
    expect(detectKind('report', samplePdf('x'))).toEqual({ kind: 'pdf' });
    expect(detectKind('bundle.zip', zip({ 'a.txt': 'a' }))).toEqual({ kind: 'archive' });
    expect(detectKind('Spec.DOCX', zip({ 'word/document.xml': '<w:document/>' }))).toEqual({ kind: 'document' });
    expect(detectKind('analysis.ipynb', strToU8('{"cells": []}'))).toEqual({ kind: 'notebook' });
    expect(detectKind('main.ts', strToU8('export const ünïcode = 1;\n'))).toEqual({ kind: 'text' });
    // A PNG renamed to .txt is still an image; a binary file is refused rather than sent as garbage.
    expect(detectKind('notes.txt', PNG).kind).toBe('image');
    expect(() => detectKind('program.exe', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toThrow(AttachmentError);
  });

  it('makes file names safe on every platform', () => {
    expect(safeFileName('report.pdf')).toBe('report.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\notes.md')).toBe('notes.md');
    expect(safeFileName('file:stream.txt')).toBe('file_stream.txt');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('trailing. . ')).toBe('trailing');
    expect(safeFileName('..')).toBe('attachment');
    const long = safeFileName(`${'x'.repeat(300)}.json`);
    expect(long).toHaveLength(100);
    expect(long.endsWith('.json')).toBe(true);
  });

  it('flags names that suggest credentials', () => {
    expect(looksSensitive('.env.local')).toBe(true);
    expect(looksSensitive('server.pem')).toBe(true);
    expect(looksSensitive('notes.md')).toBe(false);
  });
});

describe('storing attachments', () => {
  it('stores pasted text and picked images privately with safe names', async () => {
    const folder = path.join(await temporaryDirectory('attach'), 'conversation');
    const text = await storeAttachment(folder, { name: 'notes.md', data: strToU8('# Notes\n') });
    expect(text).toMatchObject({ name: 'notes.md', kind: 'text', size: 8 });
    expect(path.dirname(text.path)).toBe(folder);
    expect(await readFile(text.path, 'utf8')).toBe('# Notes\n');

    const picked = path.join(path.dirname(folder), 'screen shot.png');
    await writeFile(picked, PNG);
    const image = await storeAttachment(folder, { name: 'screen shot.png', path: picked });
    expect(image).toMatchObject({ kind: 'image', mediaType: 'image/png', size: PNG.length });
    expect(path.basename(image.path)).toMatch(/^[0-9a-f]{12}-screen shot\.png$/);
  });

  it('refuses files over the size limit and folders', async () => {
    const root = await temporaryDirectory('attach');
    await expect(storeAttachment(root, { name: 'big.txt', data: new Uint8Array(25 * 1024 * 1024 + 1) })).rejects.toThrow('larger than 25 MB');
    await expect(storeAttachment(path.join(root, 'out'), { name: 'dir', path: root })).rejects.toThrow('not a file');
  });

  it('unpacks archives safely: no path traversal, no decompression bombs, no duplicate overwrites', async () => {
    const root = await temporaryDirectory('attach');
    const archive = zip({
      'src/index.ts': 'export {};',
      'docs/readme.md': '# Readme',
      '../escape.txt': 'outside',
      'nested/../../escape2.txt': 'outside',
      '/absolute.txt': 'absolute',
      'C:/drive.txt': 'drive',
      'bomb.bin': new Uint8Array(2 * 1024 * 1024),
      'inner.zip': zip({ 'deep.txt': 'deep' }),
    });
    const stored = await storeAttachment(root, { name: 'project.zip', data: archive });
    expect(stored.kind).toBe('archive');
    const extracted = stored.extractedPath ?? '';
    expect(await readFile(path.join(extracted, 'src', 'index.ts'), 'utf8')).toBe('export {};');
    expect(existsSync(path.join(extracted, 'inner.zip'))).toBe(true);
    // Nested archives are kept as files, not unpacked.
    expect(existsSync(path.join(extracted, 'deep.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'escape.txt'))).toBe(false);
    expect(existsSync(path.join(path.dirname(root), 'escape2.txt'))).toBe(false);
    expect(existsSync(path.join(extracted, 'bomb.bin'))).toBe(false);
    const note = stored.notes?.join(' ') ?? '';
    expect(note).toContain('bomb.bin (compression ratio suggests a decompression bomb)');
    expect(note).toContain('../escape.txt (unsafe path)');
    expect(note).toContain('/absolute.txt (unsafe path)');
    expect(note).toContain('C:/drive.txt (unsafe path)');
    expect(await readFile(stored.textPath ?? '', 'utf8')).toContain('src/index.ts (10 bytes)');
  });

  // Writing 5,000 files takes several seconds on Windows, where each new file is scanned.
  it('stops counting archive entries at the limit', { timeout: 120_000 }, async () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < 5_002; index += 1) entries[`f${index}.txt`] = 'x';
    const target = path.join(await temporaryDirectory('attach'), 'out');
    const { skipped } = await unpackArchive(zip(entries), target);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toContain('too many entries');
    expect(await readdir(target)).toHaveLength(5_000);
  });

  it('reports an archive that cannot be read', async () => {
    const root = await temporaryDirectory('attach');
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    await expect(storeAttachment(root, { name: 'broken.zip', data: broken })).rejects.toThrow('could not be read');
  });
});

describe('Office text', () => {
  it('extracts Word paragraphs, tabs, breaks, headers, and entities', () => {
    const document = zip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world &amp; more</w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two</w:t></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p></w:body></w:document>',
      'word/header1.xml': '<w:hdr><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>',
      'word/styles.xml': '<w:styles><w:t>not content</w:t></w:styles>',
    });
    const { text } = officeText('spec.docx', document);
    expect(text).toBe('Hello\tworld & more\nLine\ntwo\n\nHeader text');
  });

  it('extracts PowerPoint slides in order, with their notes', () => {
    const slide = (body: string): string => `<p:sld><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:sld>`;
    const deck = zip({
      'ppt/slides/slide10.xml': slide('Tenth'),
      'ppt/slides/slide2.xml': slide('Second'),
      'ppt/notesSlides/notesSlide2.xml': slide('Speaker note'),
    });
    expect(officeText('deck.pptx', deck).text).toBe('--- Slide 2 ---\nSecond\n\nNotes:\nSpeaker note\n\n--- Slide 10 ---\nTenth');
  });

  it('extracts Excel sheets as tab-separated rows, keeping empty columns', () => {
    const workbook = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Totals &amp; more" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><r><t>Ali</t></r><r><t>ce</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Score</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>',
    });
    expect(officeText('book.xlsx', workbook).text).toBe('--- Sheet: Totals & more ---\nName\t\tScore\nAlice\t\t42');
  });

  it('stores the extracted text beside an Office file', async () => {
    const root = await temporaryDirectory('attach');
    const stored = await storeAttachment(root, {
      name: 'spec.docx',
      data: zip({ 'word/document.xml': '<w:document><w:p><w:r><w:t>Requirement one</w:t></w:r></w:p></w:document>' }),
    });
    expect(stored.kind).toBe('document');
    expect(await readFile(stored.textPath ?? '', 'utf8')).toBe('Requirement one');
  });
});

describe('PDF text', () => {
  it('reads the text of a real PDF with pdf.js', async () => {
    expect(await pdfToText(samplePdf('Quarterly results are up'))).toBe('--- Page 1 ---\nQuarterly results are up');
  });

  it('stores extracted PDF text for Codex, or explains why there is none', async () => {
    const root = await temporaryDirectory('attach');
    const stored = await storeAttachment(root, { name: 'results.pdf', data: samplePdf('Revenue grew') }, { extractPdfText: pdfToText });
    expect(await readFile(stored.textPath ?? '', 'utf8')).toContain('Revenue grew');

    const failed = await storeAttachment(root, { name: 'scan.pdf', data: samplePdf('x') }, { extractPdfText: () => Promise.reject(new Error('encrypted')) });
    expect(failed.textPath).toBeUndefined();
    expect(failed.notes).toEqual(['Text could not be extracted: encrypted']);

    const unavailable = await storeAttachment(root, { name: 'plain.pdf', data: samplePdf('x') });
    expect(unavailable.notes?.[0]).toContain('only Claude can read this PDF');
  });

  it('runs extraction in a worker that is stopped when it takes too long', async () => {
    const root = await temporaryDirectory('pdfworker');
    const answering = path.join(root, 'answer.cjs');
    await writeFile(answering, "const { parentPort, workerData } = require('node:worker_threads'); parentPort.postMessage({ text: 'bytes:' + workerData.length });");
    const failing = path.join(root, 'fail.cjs');
    await writeFile(failing, "require('node:worker_threads').parentPort.postMessage({ error: 'bad xref' });");
    const hanging = path.join(root, 'hang.cjs');
    await writeFile(hanging, 'for (;;) {}');

    expect(await extractPdfTextInWorker(answering, new Uint8Array(7))).toBe('bytes:7');
    await expect(extractPdfTextInWorker(failing, new Uint8Array(1))).rejects.toThrow('bad xref');
    await expect(extractPdfTextInWorker(hanging, new Uint8Array(1), 300)).rejects.toThrow('took too long');
  });
});

describe('mentions, prompt text, and cleanup', () => {
  it('references workspace files in place and refuses anything outside the workspace', async () => {
    const workspace = await temporaryDirectory('workspace');
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'math.js'), 'exports.average = () => 0;\n');
    const mention = await mentionAttachment(workspace, 'src/math.js');
    expect(mention).toMatchObject({ kind: 'text', workspaceRelative: 'src/math.js', path: path.join(workspace, 'src', 'math.js') });
    await expect(mentionAttachment(workspace, '../outside.txt')).rejects.toThrow('outside the workspace');
    await expect(mentionAttachment(workspace, 'src')).rejects.toThrow('not a regular file');
  });

  it('inlines small text for both agents, and extracted PDF text only for Codex', async () => {
    const root = await temporaryDirectory('attach');
    const notes = await storeAttachment(root, { name: 'notes.md', data: strToU8('remember the edge case') });
    const big = await storeAttachment(root, { name: 'log.txt', data: strToU8('x'.repeat(41 * 1024)) });
    const pdf = await storeAttachment(root, { name: 'paper.pdf', data: samplePdf('Abstract') }, { extractPdfText: pdfToText });
    const image = await storeAttachment(root, { name: 'a.png', data: PNG });

    const forClaude = await attachmentText([notes, big, pdf, image], 'claude');
    expect(forClaude).toEqual({ [notes.id]: 'remember the edge case' });
    const forCodex = await attachmentText([notes, big, pdf, image], 'codex');
    expect(Object.keys(forCodex).sort()).toEqual([notes.id, pdf.id].sort());
    expect(forCodex[pdf.id]).toContain('Abstract');
  });

  it('deletes a conversation folder only inside the attachment storage', async () => {
    const root = await temporaryDirectory('attach');
    const folder = path.join(root, 'conversation');
    await storeAttachment(folder, { name: 'a.txt', data: strToU8('a') });
    await expect(removeAttachmentFolder(root, path.dirname(root))).rejects.toThrow('outside the attachment storage');
    await expect(removeAttachmentFolder(root, root)).rejects.toThrow('outside the attachment storage');
    await removeAttachmentFolder(root, folder);
    expect(existsSync(folder)).toBe(false);
  });
});
