import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate';

import { isInsideDirectory } from './executables.js';
import { SENSITIVE_NAME } from './gitSnapshot.js';
import type { AgentId, AttachmentKind, AttachmentRef } from './types.js';

export const ATTACHMENT_LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  messageBytes: 100 * 1024 * 1024,
  files: 20,
  archiveEntries: 5_000,
  archiveBytes: 200 * 1024 * 1024,
  archiveEntryBytes: 50 * 1024 * 1024,
  /** Uncompressed size over compressed size above which an entry is treated as a decompression bomb. */
  archiveRatio: 200,
  /** Text written for agents from one PDF or Office file. */
  extractedCharacters: 2_000_000,
  /** Attachment text included in a prompt rather than referenced by path. */
  inlineBytes: 40 * 1024,
  pdfTimeoutMs: 60_000,
} as const;

export class AttachmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** A file to attach: dropped or pasted bytes, or a path the user picked. */
export interface AttachmentSource {
  name: string;
  data?: Uint8Array;
  path?: string;
}

export interface StoreOptions {
  /** Extracts the text of a PDF; usually `extractPdfTextInWorker` bound to the bundled worker script. */
  extractPdfText?: (data: Uint8Array) => Promise<string>;
}

const OFFICE = new Set(['.docx', '.xlsx', '.pptx']);
const IMAGE_TYPES: { type: string; matches: (bytes: Uint8Array) => boolean }[] = [
  { type: 'image/png', matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', matches: (b) => ascii(b, 0, 4) === 'GIF8' },
  { type: 'image/webp', matches: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
];
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** A file name that is safe to create on every platform, keeping the extension where possible. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!clean || clean === '.' || clean === '..') clean = 'attachment';
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > 100) {
    const extension = path.extname(clean).slice(0, 16);
    clean = `${clean.slice(0, 100 - extension.length)}${extension}`;
  }
  return clean;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  try {
    // A multi-byte character cut at the sample's end is not a reason to reject the file.
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < bytes.length ? sample.subarray(0, sample.length - 4) : sample);
    return true;
  } catch {
    return false;
  }
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
}

/** Classifies a file by its content first, and by its extension only where the content is ambiguous. */
export function detectKind(name: string, bytes: Uint8Array): { kind: AttachmentKind; mediaType?: string } {
  const extension = path.extname(name).toLowerCase();
  const image = IMAGE_TYPES.find((candidate) => candidate.matches(bytes));
  if (image) return { kind: 'image', mediaType: image.type };
  if (ascii(bytes, 0, 5) === '%PDF-') return { kind: 'pdf' };
  if (isZip(bytes)) return { kind: OFFICE.has(extension) ? 'document' : 'archive' };
  if (isUtf8Text(bytes)) return { kind: extension === '.ipynb' ? 'notebook' : 'text' };
  throw new AttachmentError(
    `${name} is a binary file the agents cannot read. Attach text, code, images (PNG, JPEG, GIF, WebP), PDFs, ZIP archives, or Word, Excel, and PowerPoint files.`,
  );
}

/** True when the name suggests credentials, so the user is asked before it is sent to the agents. */
export function looksSensitive(name: string): boolean {
  return SENSITIVE_NAME.test(path.basename(name));
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of a WordprocessingML or DrawingML part: paragraphs become lines, tabs and breaks are kept. */
function xmlText(xml: string, paragraph: string): string {
  const text = xml
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<(?:w|a):tab\b[^>]*\/>/g, '\t')
    .replace(/<(?:w|a):br\b[^>]*\/>/g, '\n')
    .replace(new RegExp(`</${paragraph}>`, 'g'), '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXml(text).replace(/\n{3,}/g, '\n\n').trim();
}

interface ZipLimits {
  entries: number;
  totalBytes: number;
  entryBytes: number;
}

/** Unzips only entries that pass `select` and the size limits; everything else is reported, not read. */
function readZip(
  data: Uint8Array,
  select: (name: string) => boolean,
  limits: ZipLimits,
): { files: Record<string, Uint8Array>; skipped: string[] } {
  const skipped: string[] = [];
  let entries = 0;
  let total = 0;
  const filter = (file: UnzipFileInfo): boolean => {
    if (file.name.endsWith('/') || !select(file.name)) return false;
    entries += 1;
    const reason =
      entries > limits.entries
        ? 'too many entries'
        : file.compression !== 0 && file.compression !== 8
          ? `unsupported compression method ${file.compression}`
          : file.originalSize > limits.entryBytes
            ? 'larger than the per-file limit'
            : total + file.originalSize > limits.totalBytes
              ? 'total unpacked size limit reached'
              : file.size > 0 && file.originalSize / file.size > ATTACHMENT_LIMITS.archiveRatio
                ? 'compression ratio suggests a decompression bomb'
                : undefined;
    if (reason) {
      skipped.push(`${file.name} (${reason})`);
      return false;
    }
    total += file.originalSize;
    return true;
  };
  try {
    return { files: unzipSync(data, { filter }), skipped };
  } catch (error) {
    throw new AttachmentError(`The archive could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const OFFICE_LIMITS: ZipLimits = {
  entries: 2_000,
  totalBytes: ATTACHMENT_LIMITS.archiveBytes,
  entryBytes: ATTACHMENT_LIMITS.archiveEntryBytes,
};

function partNumber(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A';
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function spreadsheetText(files: Record<string, Uint8Array>): string {
  const read = (name: string): string => (files[name] ? strFromU8(files[name]) : '');
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    decodeXml([...(match[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1] ?? '').join('')),
  );
  const relationships = new Map(
    [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((match) => [
      match[1] ?? '',
      (match[2] ?? '').replace(/^\/?xl\//, ''),
    ]),
  );
  const sheets = [...read('xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)].map((match) => ({
    name: decodeXml(match[1] ?? ''),
    part: `xl/${relationships.get(match[2] ?? '') ?? ''}`,
  }));
  const sections: string[] = [];
  for (const sheet of sheets) {
    const rows: string[] = [];
    for (const row of read(sheet.part).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1] ?? '';
        const body = cell[2] ?? '';
        const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1] ?? '';
        const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
        const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        const text =
          type === 's'
            ? (shared[Number(value)] ?? '')
            : type === 'inlineStr'
              ? decodeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1] ?? '').join(''))
              : decodeXml(value);
        const index = reference ? columnIndex(reference) : cells.length;
        while (cells.length < index) cells.push('');
        cells[index] = text.replace(/[\t\r\n]+/g, ' ');
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'));
    }
    sections.push(`--- Sheet: ${sheet.name} ---\n${rows.join('\n')}`);
  }
  return sections.join('\n\n');
}

/** Extracts the readable text of a Word, Excel, or PowerPoint file without an Office library. */
export function officeText(name: string, data: Uint8Array): { text: string; skipped: string[] } {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.docx') {
    const { files, skipped } = readZip(data, (entry) => /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(entry), OFFICE_LIMITS);
    const order = (entry: string): number => (entry === 'word/document.xml' ? 0 : 1);
    const text = Object.keys(files)
      .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
      .map((entry) => xmlText(strFromU8(files[entry] ?? new Uint8Array()), 'w:p'))
      .filter(Boolean)
      .join('\n\n');
    return { text, skipped };
  }
  if (extension === '.pptx') {
    const { files, skipped } = readZip(data, (entry) => /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(entry), OFFICE_LIMITS);
    const slides = Object.keys(files)
      .filter((entry) => entry.startsWith('ppt/slides/'))
      .sort((a, b) => partNumber(a) - partNumber(b));
    const text = slides
      .map((entry) => {
        const number = partNumber(entry);
        const notes = files[`ppt/notesSlides/notesSlide${number}.xml`];
        const body = xmlText(strFromU8(files[entry] ?? new Uint8Array()), 'a:p');
        return `--- Slide ${number} ---\n${body}${notes ? `\n\nNotes:\n${xmlText(strFromU8(notes), 'a:p')}` : ''}`;
      })
      .join('\n\n');
    return { text, skipped };
  }
  const { files, skipped } = readZip(
    data,
    (entry) => /^xl\/(?:sharedStrings|workbook)\.xml$|^xl\/_rels\/workbook\.xml\.rels$|^xl\/worksheets\/[^/]+\.xml$/.test(entry),
    OFFICE_LIMITS,
  );
  return { text: spreadsheetText(files), skipped };
}

/** A relative archive path made safe to create under the extraction folder, or undefined to skip it. */
function safeEntryPath(entry: string): string | undefined {
  const normalized = entry.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return undefined;
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (!segments.length || segments.includes('..')) return undefined;
  return segments.map(safeFileName).join('/');
}

/**
 * Unpacks a ZIP archive into `target`. Entries are written as regular files only (never as links), paths
 * that would leave `target` are refused, and size, count, and ratio limits bound the work.
 */
export async function unpackArchive(data: Uint8Array, target: string): Promise<{ listing: string; skipped: string[] }> {
  const { files, skipped } = readZip(data, () => true, {
    entries: ATTACHMENT_LIMITS.archiveEntries,
    totalBytes: ATTACHMENT_LIMITS.archiveBytes,
    entryBytes: ATTACHMENT_LIMITS.archiveEntryBytes,
  });
  await mkdir(target, { recursive: true });
  const written = new Set<string>();
  const listing: string[] = [];
  for (const [entry, content] of Object.entries(files)) {
    const relative = safeEntryPath(entry);
    const destination = relative ? path.join(target, relative) : undefined;
    if (!relative || !destination || !isInsideDirectory(destination, target)) {
      skipped.push(`${entry} (unsafe path)`);
      continue;
    }
    // Two entries can sanitize to the same name; the first one wins.
    if (written.has(relative.toLowerCase())) {
      skipped.push(`${entry} (duplicate name)`);
      continue;
    }
    written.add(relative.toLowerCase());
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx' });
    listing.push(`${relative} (${content.length} bytes)`);
  }
  return { listing: listing.sort().join('\n'), skipped };
}

function limitText(text: string): string {
  return text.length > ATTACHMENT_LIMITS.extractedCharacters
    ? `${text.slice(0, ATTACHMENT_LIMITS.extractedCharacters)}\n[... truncated ...]`
    : text;
}

function skippedNote(skipped: readonly string[]): string[] {
  if (!skipped.length) return [];
  const listed = skipped.slice(0, 10).join('; ');
  return [`${skipped.length} entr${skipped.length === 1 ? 'y was' : 'ies were'} not unpacked: ${listed}${skipped.length > 10 ? '; …' : ''}`];
}

async function readSource(source: AttachmentSource): Promise<Uint8Array> {
  if (source.data) {
    if (source.data.length > ATTACHMENT_LIMITS.fileBytes) throw new AttachmentError(`${source.name} is larger than 25 MB.`);
    return source.data;
  }
  if (!source.path) throw new AttachmentError(`${source.name} has no content.`);
  const info = await stat(source.path);
  if (!info.isFile()) throw new AttachmentError(`${source.name} is not a file.`);
  if (info.size > ATTACHMENT_LIMITS.fileBytes) throw new AttachmentError(`${source.name} is larger than 25 MB.`);
  return new Uint8Array(await readFile(source.path));
}

/**
 * Copies a file into `folder` (the conversation's private attachment folder) and prepares it for both
 * agents: an archive is unpacked, and a PDF or Office file gets a text version for Codex.
 */
export async function storeAttachment(folder: string, source: AttachmentSource, options: StoreOptions = {}): Promise<AttachmentRef> {
  const data = await readSource(source);
  const { kind, mediaType } = detectKind(source.name, data);
  const id = randomBytes(6).toString('hex');
  const name = safeFileName(source.name);
  await mkdir(folder, { recursive: true });
  const stored = path.join(folder, `${id}-${name}`);
  await writeFile(stored, data, { flag: 'wx' });
  const reference: AttachmentRef = { id, name: source.name.split(/[\\/]/).pop() || name, kind, path: stored, size: data.length };
  if (mediaType) reference.mediaType = mediaType;

  const notes: string[] = [];
  if (kind === 'archive') {
    const extractedPath = `${stored}.unpacked`;
    const { listing, skipped } = await unpackArchive(data, extractedPath);
    reference.extractedPath = extractedPath;
    reference.textPath = `${stored}.listing.txt`;
    await writeFile(reference.textPath, listing || '(the archive has no files)');
    notes.push(...skippedNote(skipped));
  } else if (kind === 'document') {
    const { text, skipped } = officeText(source.name, data);
    reference.textPath = `${stored}.txt`;
    await writeFile(reference.textPath, limitText(text) || '(no text found)');
    notes.push(...skippedNote(skipped));
  } else if (kind === 'pdf') {
    if (options.extractPdfText) {
      try {
        const text = await options.extractPdfText(data);
        reference.textPath = `${stored}.txt`;
        await writeFile(reference.textPath, limitText(text) || '(no text found; the PDF may contain only images)');
      } catch (error) {
        notes.push(`Text could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      notes.push('Text extraction is unavailable, so only Claude can read this PDF.');
    }
  }
  if (notes.length) reference.notes = notes;
  return reference;
}

/** References a workspace file the user mentioned with `@`; it is read in place, not copied. */
export async function mentionAttachment(workspacePath: string, relativePath: string): Promise<AttachmentRef> {
  const absolute = path.resolve(workspacePath, relativePath);
  if (!isInsideDirectory(absolute, workspacePath)) throw new AttachmentError(`${relativePath} is outside the workspace.`);
  const info = await lstat(absolute);
  if (!info.isFile()) throw new AttachmentError(`${relativePath} is not a regular file.`);
  const handle = await readFile(absolute);
  const { kind, mediaType } = detectKind(relativePath, new Uint8Array(handle.subarray(0, 64 * 1024)));
  const reference: AttachmentRef = {
    id: randomBytes(6).toString('hex'),
    name: path.basename(relativePath),
    kind,
    path: absolute,
    size: info.size,
    workspaceRelative: relativePath.replace(/\\/g, '/'),
  };
  if (mediaType) reference.mediaType = mediaType;
  return reference;
}

/** Deletes a conversation's attachment folder; `root` is the extension's attachment storage. */
export async function removeAttachmentFolder(root: string, folder: string): Promise<void> {
  if (!isInsideDirectory(folder, root) || path.resolve(folder) === path.resolve(root)) {
    throw new AttachmentError(`Refusing to delete ${folder} because it is outside the attachment storage.`);
  }
  await rm(folder, { recursive: true, force: true });
}

async function readSmall(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (info.size > ATTACHMENT_LIMITS.inlineBytes) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Attachment text worth putting in the prompt itself, by attachment ID. Claude reads PDFs, images, and
 * notebooks with its own tools; Codex gets extracted text, because it cannot open PDFs or Office files.
 */
export async function attachmentText(attachments: readonly AttachmentRef[], agent: AgentId): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const attachment of attachments) {
    if (attachment.workspaceRelative) continue;
    const source =
      attachment.kind === 'text'
        ? attachment.path
        : attachment.kind === 'document' || attachment.kind === 'archive' || (attachment.kind === 'pdf' && agent === 'codex')
          ? attachment.textPath
          : undefined;
    const text = source ? await readSmall(source) : undefined;
    if (text) result[attachment.id] = text;
  }
  return result;
}

/**
 * Extracts a PDF's text in a worker thread, so a malformed or hostile PDF cannot stall the extension host;
 * the worker is terminated when `timeoutMs` passes.
 */
export function extractPdfTextInWorker(workerScript: string, data: Uint8Array, timeoutMs: number = ATTACHMENT_LIMITS.pdfTimeoutMs): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new AttachmentError('reading the PDF took too long'));
    }, timeoutMs);
    const finish = (): void => clearTimeout(timer);
    worker.once('message', (message: unknown) => {
      finish();
      void worker.terminate();
      const value = message as { text?: unknown; error?: unknown };
      if (typeof value.text === 'string') resolve(value.text);
      else reject(new AttachmentError(typeof value.error === 'string' ? value.error : 'the PDF could not be read'));
    });
    worker.once('error', (error) => {
      finish();
      reject(new AttachmentError(error.message));
    });
    worker.once('exit', (code) => {
      finish();
      if (code !== 0) reject(new AttachmentError(`the PDF reader stopped (exit code ${code})`));
    });
  });
}
