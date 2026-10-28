import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { ChatController } from './chatController.js';

export const CHAT_VIEW = 'dualAgent.chat';

/**
 * Hosts the chat in the Dual Agent side bar and, on request, in an editor tab. Both load the same bundled
 * script under a strict Content-Security-Policy: nothing is fetched from the network, only the bundle's
 * nonce-tagged script runs, and agent text reaches the page as data, never as HTML from the extension.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {
    controller.setVisibility(() => Boolean(this.view?.visible || this.panel?.visible));
    // Like Claude Code, the tab is named after the conversation.
    controller.onTitle = (title) => {
      if (this.panel) this.panel.title = title;
      if (this.view) this.view.description = title;
    };
  }

  private options(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'), vscode.Uri.file(this.controller.resourceRoot)],
    };
  }

  private connect(webview: vscode.Webview): vscode.Disposable {
    webview.options = this.options();
    webview.html = this.html(webview);
    return this.controller.attach(webview, (file) => webview.asWebviewUri(vscode.Uri.file(file)).toString());
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const connection = this.connect(view.webview);
    view.onDidDispose(() => {
      connection.dispose();
      if (this.view === view) this.view = undefined;
    });
    view.onDidChangeVisibility(() => this.controller.refresh());
  }

  /** Opens the chat as an editor tab beside the current editor, or reveals the one already open. */
  public openInEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('dualAgent.chatPanel', 'Dual Agent', vscode.ViewColumn.Beside, {
      ...this.options(),
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    this.panel = panel;
    const connection = this.connect(panel.webview);
    panel.onDidDispose(() => {
      connection.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
    panel.onDidChangeViewState(() => this.controller.refresh());
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', name)).toString();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      // Only the Markdown renderer's policy may produce HTML, so no other code path can inject markup.
      "require-trusted-types-for 'script'",
      'trusted-types dual-agent-markdown',
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('chat.css')}">
<title>Dual Agent</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('chat.js')}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
