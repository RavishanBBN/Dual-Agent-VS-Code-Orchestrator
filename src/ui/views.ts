import path from 'node:path';

import * as vscode from 'vscode';

import type { RunRecord } from '../core/types.js';
import type { WorktreeChange } from '../core/worktree.js';
import { checkUri, stageUri } from './documents.js';
import {
  changeDescription,
  changeName,
  checkIcon,
  checkLabel,
  describeCheck,
  runContextValue,
  runDescription,
  runIcon,
  runLabel,
  runTooltip,
  stageDescription,
  stageIcon,
  stageTooltip,
  type IconSpec,
} from './presentation.js';

/** Runs shown in the view; older ones stay in history and in exported reports. */
const VISIBLE_RUNS = 30;
/** Run updates arrive for every stage transition; the tree is redrawn at most this often. */
const REFRESH_DELAY_MS = 150;

export type RunNode =
  | { kind: 'run'; runId: string }
  | { kind: 'stage'; runId: string; stageIndex: number }
  | { kind: 'check'; runId: string; stageIndex: number; checkIndex: number }
  | { kind: 'warnings'; runId: string }
  | { kind: 'warning'; runId: string; index: number }
  | { kind: 'changes'; runId: string }
  | { kind: 'change'; runId: string; change: WorktreeChange };

export function isRunNode(value: unknown): value is RunNode {
  return typeof value === 'object' && value !== null && typeof (value as { runId?: unknown }).runId === 'string';
}

function icon(spec: IconSpec): vscode.ThemeIcon {
  return new vscode.ThemeIcon(spec.id, spec.color ? new vscode.ThemeColor(spec.color) : undefined);
}

function markdown(value: string): vscode.MarkdownString {
  // Untrusted: command links and HTML in agent text are never activated.
  return new vscode.MarkdownString(value);
}

export interface RunsViewSource {
  activeRunId(): string | undefined;
  listChanges(run: RunRecord): Promise<WorktreeChange[]>;
}

export class RunsView implements vscode.TreeDataProvider<RunNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<RunNode | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private runs: RunRecord[] = [];
  private readonly changes = new Map<string, Promise<WorktreeChange[]>>();
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly source: RunsViewSource) {}

  public all(): readonly RunRecord[] {
    return this.runs;
  }

  public get(runId: string): RunRecord | undefined {
    return this.runs.find((run) => run.id === runId);
  }

  public setRuns(runs: readonly RunRecord[]): void {
    this.runs = runs.slice(0, VISIBLE_RUNS);
    this.changes.clear();
    this.refreshSoon();
  }

  /** Records a run update. The active run is kept as the live object, so its documents stay current. */
  public upsert(run: RunRecord): void {
    const index = this.runs.findIndex((item) => item.id === run.id);
    if (index === -1) this.runs = [run, ...this.runs].slice(0, VISIBLE_RUNS);
    else this.runs[index] = run;
    this.changes.delete(run.id);
    this.refreshSoon();
  }

  private refreshSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.changed.fire(undefined);
    }, REFRESH_DELAY_MS);
  }

  private changesOf(run: RunRecord): Promise<WorktreeChange[]> {
    let pending = this.changes.get(run.id);
    if (!pending) {
      pending = this.source.listChanges(run).catch(() => []);
      this.changes.set(run.id, pending);
    }
    return pending;
  }

  public getTreeItem(node: RunNode): vscode.TreeItem {
    const run = this.get(node.runId);
    if (!run) return new vscode.TreeItem('(run removed)');
    const active = this.source.activeRunId() === run.id;

    switch (node.kind) {
      case 'run': {
        const item = new vscode.TreeItem(
          runLabel(run),
          active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `run:${run.id}`;
        item.description = runDescription(run, Date.now(), active);
        item.tooltip = markdown(runTooltip(run));
        item.iconPath = icon(runIcon(run, active));
        item.contextValue = runContextValue(run, active);
        return item;
      }
      case 'stage': {
        const stage = run.stages[node.stageIndex];
        if (!stage) return new vscode.TreeItem('(stage removed)');
        const item = new vscode.TreeItem(
          `${node.stageIndex + 1}. ${stage.title}`,
          stage.checks?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `stage:${run.id}:${stage.id}`;
        item.description = stageDescription(stage);
        item.tooltip = markdown(stageTooltip(stage));
        item.iconPath = icon(stageIcon(stage));
        item.contextValue = 'stage';
        item.command = { command: 'dualAgent.openDocument', title: 'Open Stage Output', arguments: [stageUri(run, stage)] };
        return item;
      }
      case 'check': {
        const stage = run.stages[node.stageIndex];
        const check = stage?.checks?.[node.checkIndex];
        if (!stage || !check) return new vscode.TreeItem('(check removed)');
        const item = new vscode.TreeItem(checkLabel(check));
        item.id = `check:${run.id}:${stage.id}:${node.checkIndex}`;
        item.description = describeCheck(check);
        item.iconPath = icon(checkIcon(check));
        item.contextValue = 'check';
        item.command = { command: 'dualAgent.openDocument', title: 'Open Check Output', arguments: [checkUri(run, stage, node.checkIndex)] };
        return item;
      }
      case 'warnings': {
        const item = new vscode.TreeItem(`Warnings (${run.warnings?.length ?? 0})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `warnings:${run.id}`;
        item.iconPath = icon({ id: 'warning', color: 'list.warningForeground' });
        return item;
      }
      case 'warning': {
        const text = run.warnings?.[node.index] ?? '';
        const item = new vscode.TreeItem(text);
        item.tooltip = text;
        return item;
      }
      case 'changes': {
        const item = new vscode.TreeItem('Changes in the isolated worktree', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `changes:${run.id}`;
        item.description = 'review, then apply or discard';
        item.iconPath = icon({ id: 'diff' });
        item.contextValue = 'changes';
        return item;
      }
      case 'change': {
        const worktree = run.worktree;
        const item = new vscode.TreeItem(changeName(node.change));
        item.id = `change:${run.id}:${node.change.path}`;
        item.description = changeDescription(node.change);
        if (worktree) item.resourceUri = vscode.Uri.file(path.join(worktree.path, node.change.path));
        item.contextValue = 'change';
        item.command = { command: 'dualAgent.openChange', title: 'Open Diff', arguments: [run.id, node.change] };
        return item;
      }
    }
  }

  public async getChildren(node?: RunNode): Promise<RunNode[]> {
    if (!node) return this.runs.map((run) => ({ kind: 'run', runId: run.id }));
    const run = this.get(node.runId);
    if (!run) return [];
    switch (node.kind) {
      case 'run': {
        const children: RunNode[] = [];
        if (run.warnings?.length) children.push({ kind: 'warnings', runId: run.id });
        children.push(...run.stages.map((_, stageIndex): RunNode => ({ kind: 'stage', runId: run.id, stageIndex })));
        // Listing changes stages files in the worktree, so it waits until no agent is working there.
        if (run.worktree?.state === 'active' && this.source.activeRunId() !== run.id) children.push({ kind: 'changes', runId: run.id });
        return children;
      }
      case 'stage':
        return (run.stages[node.stageIndex]?.checks ?? []).map((_, checkIndex) => ({
          kind: 'check',
          runId: run.id,
          stageIndex: node.stageIndex,
          checkIndex,
        }));
      case 'warnings':
        return (run.warnings ?? []).map((_, index) => ({ kind: 'warning', runId: run.id, index }));
      case 'changes':
        return (await this.changesOf(run)).map((change) => ({ kind: 'change', runId: run.id, change }));
      default:
        return [];
    }
  }

  public dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.changed.dispose();
  }
}

export interface ToolRow {
  id: 'claude' | 'codex' | 'git';
  label: string;
  /** pass, warning, or error. */
  state: 'ready' | 'warning' | 'unavailable';
  description: string;
  detail: string;
}

export class AgentsView implements vscode.TreeDataProvider<ToolRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private rows: Promise<ToolRow[]> | undefined;

  public constructor(private readonly check: () => Promise<ToolRow[]>) {}

  /** Runs the checks again and returns the new rows. */
  public refresh(): Promise<ToolRow[]> {
    this.rows = this.check();
    this.changed.fire(undefined);
    return this.rows;
  }

  public getTreeItem(row: ToolRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label);
    item.id = `tool:${row.id}`;
    item.description = row.description;
    item.tooltip = row.detail;
    item.iconPath = icon(
      row.state === 'ready'
        ? { id: 'pass', color: 'testing.iconPassed' }
        : row.state === 'warning'
          ? { id: 'warning', color: 'list.warningForeground' }
          : { id: 'error', color: 'testing.iconFailed' },
    );
    return item;
  }

  public getChildren(row?: ToolRow): Promise<ToolRow[]> {
    if (row) return Promise.resolve([]);
    // The first expansion of the view runs the checks; VS Code shows progress while they run.
    this.rows ??= this.check();
    return this.rows;
  }

  public dispose(): void {
    this.changed.dispose();
  }
}
