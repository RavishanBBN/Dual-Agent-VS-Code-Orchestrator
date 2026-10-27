import * as vscode from 'vscode';

import type { AgentHealth, OrchestratorEvent, RunRecord, WorkflowKind } from '../core/types.js';

export interface DashboardController {
  start(kind: WorkflowKind, objective: string, allowWrites: boolean): Promise<RunRecord>;
  cancel(): boolean;
  doctor(): Promise<AgentHealth[]>;
  latest(): Promise<RunRecord | undefined>;
  exportLatest(): Promise<void>;
}

type DashboardMessage =
  | { type: 'ready' }
  | { type: 'start'; kind: WorkflowKind; objective: string; allowWrites: boolean }
  | { type: 'cancel' }
  | { type: 'doctor' }
  | { type: 'export' };

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export class DashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'dualAgent.dashboard';
  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: DashboardController,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: DashboardMessage) => void this.handleMessage(message));
  }

  public publish(event: OrchestratorEvent): void {
    void this.view?.webview.postMessage({ type: event.type, run: event.run, agentEvent: event.agentEvent });
  }

  private async handleMessage(message: DashboardMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready': {
          const latest = await this.controller.latest();
          await this.view?.webview.postMessage({ type: 'initial-state', latest });
          break;
        }
        case 'start':
          await this.controller.start(message.kind, message.objective, message.allowWrites);
          break;
        case 'cancel':
          this.controller.cancel();
          break;
        case 'doctor': {
          const health = await this.controller.doctor();
          await this.view?.webview.postMessage({ type: 'health', health });
          break;
        }
        case 'export':
          await this.controller.exportLatest();
          break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.view?.webview.postMessage({ type: 'ui-error', detail });
      void vscode.window.showErrorMessage(`Dual Agent: ${detail}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const token = nonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.css')).toString();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.js')).toString();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${token}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Dual Agent Orchestrator</title>
</head>
<body>
  <header>
    <div>
      <h1>Dual Agent</h1>
      <p>Claude-led. Codex-reviewed. Reciprocally verified.</p>
    </div>
    <button id="doctor" class="icon-button" title="Check CLI setup" aria-label="Check CLI setup">Check</button>
  </header>

  <section class="health" aria-label="Agent health">
    <div id="claudeHealth" class="health-card"><span class="dot unknown"></span><strong>Claude</strong><small>Not checked</small></div>
    <div id="codexHealth" class="health-card"><span class="dot unknown"></span><strong>Codex</strong><small>Not checked</small></div>
  </section>

  <main>
    <label for="kind">Workflow</label>
    <select id="kind">
      <option value="implementation">Implementation - 7 reciprocal stages</option>
      <option value="brainstorming">Brainstorming - 5 reciprocal stages</option>
    </select>

    <label for="objective">Objective</label>
    <textarea id="objective" rows="7" placeholder="Describe the outcome, constraints, and acceptance criteria..."></textarea>

    <label id="writeConsent" class="consent">
      <input id="allowWrites" type="checkbox">
      <span>Allow agents to modify files inside this workspace for implementation stages.</span>
    </label>

    <div class="actions">
      <button id="start" class="primary">Start workflow</button>
      <button id="cancel" disabled>Cancel</button>
      <button id="export">Export report</button>
    </div>
  </main>

  <section class="run-summary">
    <div class="summary-heading"><h2>Latest run</h2><span id="runStatus" class="badge">none</span></div>
    <div id="usage" class="usage"></div>
    <ol id="stages" class="stages"><li class="empty">No workflow has run in this workspace.</li></ol>
  </section>

  <section class="activity-section">
    <div class="summary-heading"><h2>Activity</h2><button id="clearActivity" class="link-button">Clear</button></div>
    <div id="activity" class="activity" role="log" aria-live="polite"></div>
  </section>

  <div id="error" class="error" role="alert" hidden></div>
  <script nonce="${token}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
