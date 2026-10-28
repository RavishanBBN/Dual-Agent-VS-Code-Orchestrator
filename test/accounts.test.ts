import { describe, expect, it } from 'vitest';

import { parseClaudeStatus, parseCodexStatus, parseGeminiSettings, SIGN_IN_METHODS, SIGN_OUT, terminalLaunch } from '../src/adapters/accounts.js';
import { newConversation } from '../src/core/conversation.js';
import type { RunRecord } from '../src/core/types.js';
import { parseWebviewMessage } from '../src/ui/chat/protocol.js';
import { transcript } from '../src/ui/chat/transcript.js';

describe('signing in to the CLIs', () => {
  it('reads Claude Code\'s status, naming the plan and account only when signed in', () => {
    // The shape `claude auth status --json` prints, from Claude Code 2.1.312.
    const signedIn = parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'ada@example.com', subscriptionType: 'team' }));
    expect(signedIn).toMatchObject({ provider: 'claude', signedIn: true, method: 'Claude subscription (team)', account: 'ada@example.com' });
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: false }))).toMatchObject({ signedIn: false, detail: 'Not signed in.' });
    expect(parseClaudeStatus('not json').signedIn).toBeUndefined();
  });

  it('reads Codex\'s one-line status', () => {
    expect(parseCodexStatus('Logged in using ChatGPT\n', 0)).toMatchObject({ signedIn: true, method: 'ChatGPT' });
    expect(parseCodexStatus('Logged in using an API key - sk-proj-***ABCD', 0)).toMatchObject({ signedIn: true, method: 'API key' });
    expect(parseCodexStatus('Not logged in', 1)).toMatchObject({ signedIn: false });
    expect(parseCodexStatus('', 1).signedIn).toBe(false);
  });

  it('reads how Gemini CLI signs in from its settings, never its credentials', () => {
    expect(parseGeminiSettings(JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }), {})).toMatchObject({ signedIn: true, method: 'Google account' });
    expect(parseGeminiSettings(undefined, {}).signedIn).toBe(false);
    expect(parseGeminiSettings(undefined, { GEMINI_API_KEY: 'x' })).toMatchObject({ signedIn: true, method: 'API key' });
  });

  it('signs in with each CLI\'s own commands, and passes an API key only on standard input', () => {
    expect(SIGN_IN_METHODS.claude.map((method) => method.args.join(' '))).toEqual(['auth login --claudeai', 'auth login --console', 'auth login --sso']);
    expect(SIGN_IN_METHODS.codex.map((method) => method.args.join(' '))).toEqual(['login', 'login --device-auth', 'login --with-api-key']);
    expect(SIGN_IN_METHODS.codex.find((method) => method.readsKey)?.args).not.toContain('--api-key');
    expect(SIGN_OUT).toEqual({ claude: ['auth', 'logout'], codex: ['logout'], gemini: undefined });
  });

  it('starts a terminal sign-in without a shell, or through the absolute COMSPEC for a Windows batch shim', () => {
    if (process.platform === 'win32') {
      expect(terminalLaunch('C:\\npm\\claude.cmd', ['auth', 'login'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({
        shellPath: 'C:\\Windows\\System32\\cmd.exe',
        shellArgs: ['/d', '/c', 'C:\\npm\\claude.cmd', 'auth', 'login'],
      });
      expect(() => terminalLaunch('C:\\npm\\claude.cmd', [], { ComSpec: 'cmd.exe' })).toThrow('absolute');
    }
    expect(terminalLaunch('/usr/local/bin/codex', ['login'])).toEqual({ shellPath: '/usr/local/bin/codex', shellArgs: ['login'] });
  });

  it('accepts the chat\'s sign-in, limit refresh, and conflict messages, and nothing else', () => {
    expect(parseWebviewMessage({ type: 'signIn', provider: 'codex' })).toEqual({ type: 'signIn', provider: 'codex' });
    expect(parseWebviewMessage({ type: 'signIn', provider: 'bash' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'refreshLimits' })).toEqual({ type: 'refreshLimits' });
    expect(parseWebviewMessage({ type: 'resolveConflict', turnId: 't-1', action: 'discard' })).toEqual({ type: 'resolveConflict', turnId: 't-1', action: 'discard' });
    expect(parseWebviewMessage({ type: 'resolveConflict', turnId: 't-1', action: 'rm' })).toBeUndefined();
  });

  it('offers to sign in to the agent whose CLI said it is not signed in', () => {
    const now = new Date().toISOString();
    const empty = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    const run: RunRecord = {
      schemaVersion: 1,
      id: 'r1',
      kind: 'chat',
      objective: 'Why?',
      workspacePath: process.cwd(),
      status: 'failed',
      allowWrites: false,
      createdAt: now,
      updatedAt: now,
      error: 'Not logged in · Please run /login',
      usage: { claude: empty, codex: empty },
      stages: [
        { id: 'claude-answer', title: 'Claude answers', agent: 'claude', assignedAgent: 'codex', permission: 'read-only', purpose: '', instructions: '', status: 'failed', error: 'Not logged in' },
      ],
    };
    const conversation = { ...newConversation(process.cwd()), turns: [{ id: 't1', createdAt: now, mode: 'chat' as const, message: 'Why?', attachments: [], runId: 'r1' }] };
    const [view] = transcript({ conversation, runs: new Map([['r1', run]]), live: new Map(), changes: new Map(), thumbnail: () => undefined });
    expect(view?.signIn).toBe('codex');
  });
});
