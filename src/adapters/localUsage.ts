/**
 * Usage of Claude Code and Codex on this machine, including sessions outside Dual Agent such as a terminal or
 * another editor, read from the logs both CLIs keep: Claude Code's session files under `~/.claude/projects`,
 * and Codex's under `~/.codex/sessions`. Only token counts, times, usage-limit messages, and Codex's
 * rate-limit percentages are read; the conversations in those files are never kept, logged, or sent anywhere.
 * Credential files are never opened. Files are read incrementally, so a rescan reads only what was appended.
 */
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyFailure } from '../core/errors.js';
import { parseLimitReset } from '../core/limits.js';
import type { QuotaReading, TokenUsage } from '../core/types.js';
import { addUsage, localDay } from '../core/usage.js';
import { codexQuota } from './parsers.js';

/** Days of history kept: today and the six before it, plus one so a week is always complete. */
const DAYS = 8;
const DAY_MS = 86_400_000;
/** A log this large is skipped rather than read, so one runaway file cannot stall the scan. */
const FILE_LIMIT = 512 * 1024 * 1024;
const FILES_LIMIT = 5_000;
const CHUNK = 1024 * 1024;
/** A limit message older than this says nothing about now. */
const LIMIT_MESSAGE_MS = 8 * 24 * 60 * 60_000;

const CODEX_MARKER = Buffer.from('"token_count"');
const CLAUDE_USAGE_MARKER = Buffer.from('"usage"');
const CLAUDE_ERROR_MARKER = Buffer.from('"isApiErrorMessage":true');

export interface LocalUsageHomes {
  /** Claude Code's configuration folder, `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claude: string;
  /** Codex's home, `CODEX_HOME` or `~/.codex`. */
  codex: string;
}

export function localUsageHomes(environment: NodeJS.ProcessEnv = process.env): LocalUsageHomes {
  return {
    claude: environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codex: environment.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
}

export interface LocalUsageReport {
  /** Tokens per local day ("2026-10-28"), for the last eight days. */
  claude: Record<string, TokenUsage>;
  codex: Record<string, TokenUsage>;
  /** The newest limits each CLI recorded: Codex's windows, and a Claude limit it reported as reached. */
  quotas: QuotaReading[];
  scannedAt: string;
}

interface FileState {
  /** Bytes read so far. */
  offset: number;
  /** The start of a line not yet complete. */
  rest: Buffer;
  /** Codex: the session's running total, so each event adds only what it used. */
  total?: TokenUsage;
}

const EMPTY: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function subtract(after: TokenUsage, before: TokenUsage | undefined): TokenUsage {
  const base = before ?? EMPTY;
  return {
    inputTokens: Math.max(0, after.inputTokens - base.inputTokens),
    cachedInputTokens: Math.max(0, after.cachedInputTokens - base.cachedInputTokens),
    outputTokens: Math.max(0, after.outputTokens - base.outputTokens),
    reasoningOutputTokens: Math.max(0, after.reasoningOutputTokens - base.reasoningOutputTokens),
  };
}

/** Codex's `total_token_usage`, where input already includes the cached part, as in Dual Agent's own counts. */
export function codexTotal(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: count(usage.cached_input_tokens),
    outputTokens: count(usage.output_tokens),
    reasoningOutputTokens: count(usage.reasoning_output_tokens),
  };
}

/** Claude's per-message usage, combined the way Dual Agent counts it: input includes cache reads and writes. */
export function claudeMessageUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const read = count(usage.cache_read_input_tokens);
  return {
    inputTokens: count(usage.input_tokens) + read + count(usage.cache_creation_input_tokens),
    cachedInputTokens: read,
    outputTokens: count(usage.output_tokens),
    reasoningOutputTokens: 0,
  };
}

/** Every `.jsonl` file under `root`, at most `depth` folders down, changed since `since`. */
async function logFiles(root: string, depth: number, since: number, found: string[] = []): Promise<string[]> {
  if (found.length >= FILES_LIMIT) return found;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (found.length >= FILES_LIMIT) break;
    const full = path.join(root, entry.name);
    // Links are not followed, so the scan stays inside the CLI's own folder.
    if (entry.isDirectory() && depth > 0) await logFiles(full, depth - 1, since, found);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await stat(full).catch(() => undefined);
      if (info && info.mtimeMs >= since && info.size <= FILE_LIMIT) found.push(full);
    }
  }
  return found;
}

/** Codex files its sessions by day, so only the folders of the days that count are listed. */
async function codexFiles(home: string, now: number): Promise<string[]> {
  const files: string[] = [];
  const since = now - DAYS * DAY_MS;
  for (let day = 0; day <= DAYS; day += 1) {
    const date = new Date(now - day * DAY_MS);
    const folder = path.join(home, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    await logFiles(folder, 0, since, files);
  }
  return files;
}

const yieldToHost = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class LocalUsageScanner {
  private readonly files = new Map<string, FileState>();
  private readonly claudeDays = new Map<string, TokenUsage>();
  private readonly codexDays = new Map<string, TokenUsage>();
  /** Claude writes one line per content block, all with the message's usage, so each message counts once. */
  private readonly seen = new Set<string>();
  private codexReading: QuotaReading | undefined;
  private claudeLimit: { at: number; text: string } | undefined;
  private scanning: Promise<LocalUsageReport> | undefined;

  public constructor(
    private readonly homes: LocalUsageHomes = localUsageHomes(),
    private readonly clock: () => number = Date.now,
  ) {}

  /** Reads what the logs gained since the last scan; scans already running are shared. */
  public scan(): Promise<LocalUsageReport> {
    this.scanning ??= this.read().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async read(): Promise<LocalUsageReport> {
    const now = this.clock();
    const since = now - DAYS * DAY_MS;
    const claude = await logFiles(path.join(this.homes.claude, 'projects'), 3, since);
    const codex = await codexFiles(this.homes.codex, now);
    for (const file of claude) {
      await this.readFile(file, (line) => this.claudeLine(line, since));
      await yieldToHost();
    }
    for (const file of codex) {
      await this.readFile(file, (line, state) => this.codexLine(line, state, since));
      await yieldToHost();
    }
    const listed = new Set([...claude, ...codex]);
    for (const file of [...this.files.keys()]) if (!listed.has(file)) this.files.delete(file);
    const oldest = localDay(since);
    for (const days of [this.claudeDays, this.codexDays]) for (const day of [...days.keys()]) if (day < oldest) days.delete(day);
    return this.report(now);
  }

  private report(now: number): LocalUsageReport {
    const quotas: QuotaReading[] = [];
    if (this.codexReading) quotas.push(this.codexReading);
    const limit = this.claudeLimit;
    if (limit) {
      const reset = parseLimitReset(limit.text, new Date(limit.at));
      if (reset && reset.getTime() > now) {
        quotas.push({ agent: 'claude', windows: [], limited: true, resetsAt: reset.toISOString(), observedAt: new Date(limit.at).toISOString() });
      }
    }
    return { claude: Object.fromEntries(this.claudeDays), codex: Object.fromEntries(this.codexDays), quotas, scannedAt: new Date(now).toISOString() };
  }

  /** Reads the part of a log appended since the last scan, line by line, decoding only lines with a marker. */
  private async readFile(file: string, onLine: (line: Buffer, state: FileState) => void): Promise<void> {
    const info = await stat(file).catch(() => undefined);
    if (!info) return;
    let state = this.files.get(file);
    // The logs only grow; a file that shrank was replaced, and is skipped rather than counted twice.
    if (state && info.size < state.offset) return;
    if (!state) {
      state = { offset: 0, rest: Buffer.alloc(0) };
      this.files.set(file, state);
    }
    if (info.size === state.offset) return;
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return;
    try {
      const buffer = Buffer.alloc(CHUNK);
      while (state.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, info.size - state.offset), state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        let data = Buffer.concat([state.rest, buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
          onLine(data.subarray(start, end), state);
          start = end + 1;
        }
        data = data.subarray(start);
        // A line longer than a few chunks holds no usage worth its memory; it is dropped.
        state.rest = data.length > 8 * CHUNK ? Buffer.alloc(0) : Buffer.from(data);
      }
    } finally {
      await handle.close();
    }
  }

  private claudeLine(line: Buffer, since: number): void {
    const usage = line.includes(CLAUDE_USAGE_MARKER);
    const error = line.includes(CLAUDE_ERROR_MARKER);
    if (!usage && !error) return;
    let entry: { type?: unknown; timestamp?: unknown; requestId?: unknown; message?: { id?: unknown; usage?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line.toString('utf8')) as typeof entry;
    } catch {
      return;
    }
    if (entry.type !== 'assistant' || typeof entry.timestamp !== 'string') return;
    const time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time) || time < since) return;
    if (error) {
      const content = Array.isArray(entry.message?.content) ? (entry.message.content as { text?: unknown }[]) : [];
      const text = content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ').slice(0, 500);
      if (classifyFailure(text) === 'quota' && time > this.clock() - LIMIT_MESSAGE_MS && (!this.claudeLimit || time > this.claudeLimit.at)) this.claudeLimit = { at: time, text };
      return;
    }
    const id = typeof entry.message?.id === 'string' ? entry.message.id : undefined;
    const key = id ? `${id}:${typeof entry.requestId === 'string' ? entry.requestId : ''}` : undefined;
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const tokens = claudeMessageUsage(entry.message?.usage);
    if (!tokens) return;
    const day = localDay(time);
    this.claudeDays.set(day, addUsage(this.claudeDays.get(day) ?? EMPTY, tokens));
  }

  private codexLine(line: Buffer, state: FileState, since: number): void {
    if (!line.includes(CODEX_MARKER)) return;
    let entry: { timestamp?: unknown; payload?: { type?: unknown; info?: { total_token_usage?: unknown } | null; rate_limits?: Record<string, unknown> | null } };
    try {
      entry = JSON.parse(line.toString('utf8')) as typeof entry;
    } catch {
      return;
    }
    if (entry.payload?.type !== 'token_count' || typeof entry.timestamp !== 'string') return;
    const time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time)) return;
    const total = codexTotal(entry.payload.info?.total_token_usage);
    if (total) {
      // Codex repeats its running total in several events; only the growth since the last one is new.
      const added = subtract(total, state.total);
      state.total = total;
      if (time >= since && added.inputTokens + added.outputTokens > 0) {
        const day = localDay(time);
        this.codexDays.set(day, addUsage(this.codexDays.get(day) ?? EMPTY, added));
      }
    }
    if (entry.payload.rate_limits && (!this.codexReading || time >= Date.parse(this.codexReading.observedAt))) {
      const reading = codexQuota(entry.payload.rate_limits, new Date(time));
      if (reading) this.codexReading = reading;
    }
  }
}
