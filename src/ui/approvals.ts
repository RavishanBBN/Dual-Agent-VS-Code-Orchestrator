import * as vscode from 'vscode';

import type { ApprovalDecision, RunRecord, StageRecord } from '../core/types.js';
import { NOTES_LIMIT } from './presentation.js';

const APPROVE = 'Approve';
const APPROVE_WITH_GUIDANCE = 'Approve with Guidance…';
const REVIEW = 'Review Plan';
const REJECT = 'Reject';

interface Pending {
  runId: string;
  settle: (decision: ApprovalDecision) => void;
}

/**
 * Holds the orchestrator's request for plan approval until the user decides through the notification,
 * the status bar, the Runs view, or the command palette. Cancelling the run rejects it.
 */
export class ApprovalCoordinator implements vscode.Disposable {
  private pending: Pending | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changed.event;

  public constructor(
    private readonly openPlan: (runId: string) => Promise<void>,
    /** False while the chat shows the request, so the decision is not asked for twice. */
    private readonly shouldNotify: () => boolean = () => true,
  ) {}

  public get pendingRunId(): string | undefined {
    return this.pending?.runId;
  }

  public request(run: RunRecord, _stage: StageRecord, signal: AbortSignal): Promise<ApprovalDecision> {
    this.pending?.settle({ approved: false });
    return new Promise((resolve) => {
      const onAbort = (): void => pending.settle({ approved: false });
      const pending: Pending = {
        runId: run.id,
        settle: (decision) => {
          if (this.pending !== pending) return;
          this.pending = undefined;
          signal.removeEventListener('abort', onAbort);
          this.changed.fire();
          resolve(decision);
        },
      };
      this.pending = pending;
      signal.addEventListener('abort', onAbort, { once: true });
      this.changed.fire();
      if (this.shouldNotify()) void this.notify(pending);
    });
  }

  private async notify(pending: Pending): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'Dual Agent: the plan and its review are ready. Approve it before Claude edits any files?',
      APPROVE,
      APPROVE_WITH_GUIDANCE,
      REVIEW,
      REJECT,
    );
    // Dismissing the notification leaves the decision open in the status bar and the Runs view.
    if (choice && this.pending === pending) await this.handle(pending, choice);
  }

  private async handle(pending: Pending, choice: string): Promise<void> {
    switch (choice) {
      case APPROVE:
        pending.settle({ approved: true });
        break;
      case APPROVE_WITH_GUIDANCE: {
        const notes = await vscode.window.showInputBox({
          title: 'Guidance for the implementation',
          prompt: 'Added to every later prompt of this run as your instruction, for example a review point to reject.',
          ignoreFocusOut: true,
          validateInput: (value) => (value.length > NOTES_LIMIT ? `Keep guidance under ${NOTES_LIMIT} characters.` : undefined),
        });
        if (notes === undefined) return;
        pending.settle({ approved: true, ...(notes.trim() ? { notes: notes.trim() } : {}) });
        break;
      }
      case REVIEW:
        await this.openPlan(pending.runId);
        if (this.pending === pending) void this.notify(pending);
        break;
      case REJECT:
        pending.settle({ approved: false });
        break;
    }
  }

  /** Lets the user decide from the status bar or command palette. */
  public async decide(): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      void vscode.window.showInformationMessage('No plan is waiting for approval.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${APPROVE}`, choice: APPROVE, description: 'Claude starts implementing' },
        { label: `$(comment) ${APPROVE_WITH_GUIDANCE}`, choice: APPROVE_WITH_GUIDANCE, description: 'Add an instruction for the rest of the run' },
        { label: `$(book) ${REVIEW}`, choice: REVIEW, description: "Open Claude's plan and Codex's review" },
        { label: `$(close) ${REJECT}`, choice: REJECT, description: 'Cancel the run without editing files' },
      ],
      { title: 'Dual Agent: plan approval', placeHolder: 'The plan is ready. What next?' },
    );
    if (picked && this.pending === pending) await this.handle(pending, picked.choice);
  }

  public approve(notes?: string): void {
    const guidance = notes?.trim().slice(0, NOTES_LIMIT);
    this.pending?.settle({ approved: true, ...(guidance ? { notes: guidance } : {}) });
  }

  public reject(): void {
    this.pending?.settle({ approved: false });
  }

  public dispose(): void {
    this.pending?.settle({ approved: false });
    this.changed.dispose();
  }
}

/** Shows the active run's progress, and asks for attention while a plan waits for approval. */
export class RunStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('dualAgent.status', vscode.StatusBarAlignment.Left, 50);

  public constructor() {
    this.item.name = 'Dual Agent';
  }

  public show(text: string, tooltip: string, attention: boolean): void {
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.command = attention ? 'dualAgent.approvePlan' : 'workbench.view.extension.dualAgent';
    this.item.backgroundColor = attention ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  public hide(): void {
    this.item.hide();
  }

  public dispose(): void {
    this.item.dispose();
  }
}
