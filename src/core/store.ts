import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunRecord, RunStore } from './types.js';

interface StoreDocument {
  schemaVersion: 1;
  runs: RunRecord[];
}

const REPLACE_ATTEMPTS = 5;

function parseRuns(content: string): RunRecord[] | undefined {
  try {
    const document = JSON.parse(content) as Partial<StoreDocument> | null;
    if (document?.schemaVersion !== 1 || !Array.isArray(document.runs)) return undefined;
    return document.runs.filter(
      (run): run is RunRecord =>
        typeof run === 'object' && run !== null && typeof run.id === 'string' && Array.isArray(run.stages),
    );
  } catch {
    return undefined;
  }
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Replaces `target` with `source`. On Windows, antivirus and indexers briefly lock files, so the rename is
 * retried. The last resort copies over the target in place, so the history file never stops existing.
 */
async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 1; attempt <= REPLACE_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt === REPLACE_ATTEMPTS) break;
      await delay(50 * attempt);
    }
  }
  await copyFile(source, target);
  await rm(source, { force: true });
}

export class FileRunStore implements RunStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    directory: string,
    private readonly maxRuns: number,
  ) {
    this.filePath = path.join(directory, 'runs.json');
  }

  public async list(): Promise<RunRecord[]> {
    // Waiting for pending saves means a read never sees a file that is still being copied into place.
    await this.queue;
    return this.read();
  }

  private async read(): Promise<RunRecord[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const runs = parseRuns(content);
    if (runs) return runs;
    // An unreadable or newer-format history is set aside, not overwritten, so new runs can still be saved.
    await rename(this.filePath, `${this.filePath}.unreadable-${Date.now()}`).catch(() => undefined);
    return [];
  }

  public async latest(): Promise<RunRecord | undefined> {
    return (await this.list())[0];
  }

  public save(run: RunRecord): Promise<void> {
    // Each save reads, merges, and rewrites the file, so saves must not interleave.
    const saved = this.queue.then(() => this.write(run));
    this.queue = saved.catch(() => undefined);
    return saved;
  }

  /** Deletes the whole history, including copies set aside as unreadable. */
  public clear(): Promise<void> {
    const cleared = this.queue.then(async () => {
      const directory = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const names = await readdir(directory).catch(() => [] as string[]);
      for (const name of names.filter((entry) => entry === base || entry.startsWith(`${base}.`))) {
        await rm(path.join(directory, name), { force: true });
      }
    });
    this.queue = cleared.catch(() => undefined);
    return cleared;
  }

  private async write(run: RunRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const existing = (await this.read()).filter((item) => item.id !== run.id);
    // A run whose worktree changes are still waiting to be applied or discarded is never pruned.
    const runs = [run, ...existing].filter((item, index) => index < this.maxRuns || item.worktree?.state === 'active');
    const document: StoreDocument = { schemaVersion: 1, runs };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await replaceFile(temporary, this.filePath);
  }
}
