import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunRecord, RunStore } from './types.js';

interface StoreDocument {
  schemaVersion: 1;
  runs: RunRecord[];
}

export class FileRunStore implements RunStore {
  private readonly filePath: string;

  public constructor(
    directory: string,
    private readonly maxRuns: number,
  ) {
    this.filePath = path.join(directory, 'runs.json');
  }

  public async list(): Promise<RunRecord[]> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const document = JSON.parse(content) as StoreDocument;
      return document.schemaVersion === 1 && Array.isArray(document.runs) ? document.runs : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
  }

  public async latest(): Promise<RunRecord | undefined> {
    return (await this.list())[0];
  }

  public async save(run: RunRecord): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const existing = (await this.list()).filter((item) => item.id !== run.id);
    const document: StoreDocument = { schemaVersion: 1, runs: [run, ...existing].slice(0, this.maxRuns) };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, this.filePath);
    } catch {
      await rm(this.filePath, { force: true });
      await rename(temporary, this.filePath);
    }
  }
}
