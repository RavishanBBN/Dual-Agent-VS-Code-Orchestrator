import * as vscode from 'vscode';

import { describeCheck } from '../core/context.js';
import { renderRunReport, renderStageDocument } from '../core/report.js';
import type { RunRecord, StageRecord } from '../core/types.js';
import { readBaseFile } from '../core/worktree.js';

/** Read-only documents for run reports, stage outputs, and check logs. */
export const RUN_SCHEME = 'dual-agent-run';
/** A file as it was in a run's base commit, for the left side of a diff. */
export const BASE_SCHEME = 'dual-agent-base';

type RunLookup = (runId: string) => RunRecord | undefined;

function stageName(run: RunRecord, stage: StageRecord): string {
  return `${String(run.stages.indexOf(stage) + 1).padStart(2, '0')}-${stage.id}`;
}

export function reportUri(run: RunRecord): vscode.Uri {
  return vscode.Uri.from({ scheme: RUN_SCHEME, path: `/${run.id}/report.md` });
}

export function stageUri(run: RunRecord, stage: StageRecord): vscode.Uri {
  return vscode.Uri.from({ scheme: RUN_SCHEME, path: `/${run.id}/${stageName(run, stage)}.md` });
}

export function checkUri(run: RunRecord, stage: StageRecord, index: number): vscode.Uri {
  return vscode.Uri.from({ scheme: RUN_SCHEME, path: `/${run.id}/${stageName(run, stage)}-check-${index + 1}.log` });
}

export function baseUri(run: RunRecord, relativePath: string, empty = false): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${run.id}/${relativePath}`, ...(empty ? { query: 'empty' } : {}) });
}

function parse(uri: vscode.Uri): { runId: string; name: string } {
  const [, runId = '', ...rest] = uri.path.split('/');
  return { runId, name: rest.join('/') };
}

export class RunDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.changed.event;

  public constructor(private readonly lookup: RunLookup) {}

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const { runId, name } = parse(uri);
    const run = this.lookup(runId);
    if (!run) return 'This run is no longer in the history.\n';
    if (name === 'report.md') return renderRunReport(run);
    for (const stage of run.stages) {
      const prefix = stageName(run, stage);
      if (name === `${prefix}.md`) return renderStageDocument(run, stage);
      const check = new RegExp(`^${prefix}-check-(\\d+)\\.log$`).exec(name);
      const result = check ? stage.checks?.[Number(check[1]) - 1] : undefined;
      if (result) return `$ ${result.command.join(' ')}\n# ${describeCheck(result)}\n\n${result.output}`;
    }
    return 'This document is no longer available.\n';
  }

  /** Refreshes open documents of a run as it progresses. */
  public refresh(runId: string): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === RUN_SCHEME && parse(document.uri).runId === runId) this.changed.fire(document.uri);
    }
  }

  public dispose(): void {
    this.changed.dispose();
  }
}

export class BaseFileProvider implements vscode.TextDocumentContentProvider {
  public constructor(private readonly lookup: RunLookup) {}

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.query === 'empty') return '';
    const { runId, name } = parse(uri);
    const worktree = this.lookup(runId)?.worktree;
    return worktree ? readBaseFile(worktree, name) : '';
  }
}
