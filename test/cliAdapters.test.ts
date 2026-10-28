import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  claudeArguments,
  commandRules,
  ClaudeCliAdapter,
  codexArguments,
  CodexCliAdapter,
  type AdapterConfiguration,
} from '../src/adapters/cliAdapters.js';
import { AgentExecutionError } from '../src/core/errors.js';
import type { AgentRunRequest, PermissionMode } from '../src/core/types.js';
import { removeTemporaryDirectories, temporaryDirectory, writeFakeCli } from './helpers.js';

afterEach(removeTemporaryDirectories);

const base: AdapterConfiguration = { command: 'unused', timeoutMs: 15_000, billingMode: 'subscription' };

/** A fake CLI that records its arguments, stdin, and environment names, then prints `lines`. */
function fakeCli(lines: unknown[], exitCode = 0): string {
  return `const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(__dirname, 'call.json'), JSON.stringify({ args: process.argv.slice(2), input, env: Object.keys(process.env) }));
  for (const line of ${JSON.stringify(lines)}) console.log(JSON.stringify(line));
  process.exitCode = ${exitCode};
});`;
}

function request(cwd: string, permission: PermissionMode = 'read-only'): AgentRunRequest {
  return { prompt: 'stage prompt', cwd, permission, signal: new AbortController().signal, onEvent: () => undefined };
}

/** The CLI lives in bin/, outside the workspace: an executable inside the workspace is refused. */
async function layout(prefix: string): Promise<{ bin: string; workspace: string }> {
  const root = await temporaryDirectory(prefix);
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  await mkdir(bin);
  await mkdir(workspace);
  return { bin, workspace };
}

async function recordedCall(directory: string): Promise<{ args: string[]; input: string; env: string[] }> {
  return JSON.parse(await readFile(path.join(directory, 'call.json'), 'utf8')) as { args: string[]; input: string; env: string[] };
}

async function rejection(promise: Promise<unknown>): Promise<AgentExecutionError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AgentExecutionError);
  return error as AgentExecutionError;
}

const claudeSuccess = [
  { type: 'system', session_id: 'ses_1' },
  { type: 'assistant', session_id: 'ses_1', message: { content: [{ type: 'text', text: 'draft' }] } },
  { type: 'result', session_id: 'ses_1', subtype: 'success', result: 'final answer', usage: { input_tokens: 5, output_tokens: 2 } },
];

describe('provider arguments', () => {
  // Regression: plan mode alone let Claude run shell commands and write a plan file during read-only stages.
  it('limits Claude review stages to reading tools, without repository settings, MCP servers, or tool grants', () => {
    const args = claudeArguments({ ...base, claudeAllowedTools: ['Bash(npm test:*)'] }, 'read-only');
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', 'user', '--strict-mcp-config']));
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args).not.toContain('--allowedTools');
  });

  it('gives Claude write stages editing tools, and commands only through configured rules', () => {
    const plain = claudeArguments(base, 'workspace-write');
    expect(plain[plain.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(plain[plain.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write,NotebookEdit');
    expect(plain).not.toContain('--allowedTools');

    const args = claudeArguments({ ...base, claudeAllowedTools: ['Bash(npm test:*)', 'Edit'], model: 'opus' }, 'workspace-write');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write,NotebookEdit,Bash');
    expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 3)).toEqual(['--allowedTools', 'Bash(npm test:*)', 'Edit']);
    expect(args.slice(-2)).toEqual(['--model', 'opus']);
  });

  it('passes a run\'s model, effort, and attachment folders to Claude, dropping invalid values', () => {
    const args = claudeArguments({ ...base, model: 'sonnet', effort: 'low' }, 'read-only', undefined, {
      options: { model: 'opus', effort: 'max' },
      readableDirectories: ['/storage/attachments/conversation'],
    });
    expect(args).toContain('--include-partial-messages');
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', '/storage/attachments/conversation']);
    expect(args.slice(-4)).toEqual(['--model', 'opus', '--effort', 'max']);

    // Stored runs are revalidated: a flag-like model or a Codex-only effort never reaches Claude.
    const unsafe = claudeArguments({ ...base, model: 'sonnet' }, 'read-only', undefined, { options: { model: '--dangerous', effort: 'ultra' } });
    expect(unsafe).not.toContain('--dangerous');
    expect(unsafe).not.toContain('--effort');
    expect(unsafe.slice(-2)).toEqual(['--model', 'sonnet']);
  });

  it('gives Codex images, a model, and a reasoning effort, keeping the stdin marker out of --image', () => {
    const args = codexArguments(base, 'read-only', { images: ['/a/one.png', '/a/two.jpg'], options: { model: 'gpt-6-sol', effort: 'ultra' } });
    expect(args).toEqual([
      'exec',
      '--json',
      '--image',
      '/a/one.png',
      '--image',
      '/a/two.jpg',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--model',
      'gpt-6-sol',
      '--config',
      'model_reasoning_effort=ultra',
      '-',
    ]);
    expect(codexArguments({ ...base, effort: 'not-a-level' }, 'read-only')).not.toContain('--config');
  });

  it('adds web tools only when allowed, and exact rules only for simple verification commands', () => {
    const plain = claudeArguments(base, 'read-only');
    expect(plain[plain.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    const web = claudeArguments(base, 'read-only', undefined, { web: true });
    expect(web[web.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,WebSearch,WebFetch');
    expect(web.slice(web.indexOf('--allowedTools'), web.indexOf('--allowedTools') + 3)).toEqual(['--allowedTools', 'WebSearch', 'WebFetch']);

    const edit = claudeArguments(base, 'workspace-write', undefined, { allowedCommands: [['node', '--test'], ['npm', 'run', 'lint']] });
    expect(edit[edit.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write,NotebookEdit,Bash');
    expect(edit).toEqual(expect.arrayContaining(['Bash(node --test:*)', 'Bash(npm run lint:*)']));
    // Read-only stages never get commands, and anything needing quoting is left out rather than widened.
    expect(claudeArguments(base, 'read-only', undefined, { allowedCommands: [['node', '--test']] })).not.toContain('Bash(node --test:*)');
    expect(commandRules([['node', '-e', 'require("fs")'], ['echo', 'a b'], ['npm', 'test;rm']])).toEqual([]);
    expect(commandRules([['npx', 'vitest', 'run', '--reporter=dot']])).toEqual(['Bash(npx vitest run --reporter=dot:*)']);
  });

  it('turns on Codex web search with its top-level flag', () => {
    expect(codexArguments(base, 'read-only', { web: true }).slice(0, 3)).toEqual(['--search', 'exec', '--json']);
    expect(codexArguments(base, 'read-only')[0]).toBe('exec');
  });

  it('maps Codex permissions to its sandbox modes', () => {
    expect(codexArguments(base, 'read-only')).toEqual(['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-']);
    expect(codexArguments({ ...base, model: 'gpt-5' }, 'workspace-write')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-5',
      '-',
    ]);
  });
});

describe('CLI adapters with fake providers', () => {
  it('runs Claude with the prompt on stdin and an allowlisted environment', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('claude');
    const command = await writeFakeCli(bin, 'fakeclaude', fakeCli(claudeSuccess));
    process.env.DUAL_AGENT_TEST_SECRET = 'must-not-leak';
    try {
      const adapter = new ClaudeCliAdapter({ ...base, command, claudeAllowedTools: ['Bash(npm test:*)', 'Edit'] });
      const result = await adapter.run(request(workspace, 'workspace-write'));
      expect(result).toMatchObject({ text: 'final answer', providerSessionId: 'ses_1', usage: { inputTokens: 5 } });
    } finally {
      delete process.env.DUAL_AGENT_TEST_SECRET;
    }
    const call = await recordedCall(bin);
    expect(call.input).toBe('stage prompt');
    // The rule survives Windows cmd.exe escaping intact.
    expect(call.args).toEqual(expect.arrayContaining(['--allowedTools', 'Bash(npm test:*)', 'Edit', '--setting-sources', 'user']));
    expect(call.env).not.toContain('DUAL_AGENT_TEST_SECRET');
  });

  it('classifies a failure from the provider error, not from repository text in tool output', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('claude');
    const lines = [
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'new AbortController(); timeoutMs; file not found' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 429 rate limit exceeded', usage: { input_tokens: 7 } },
    ];
    const command = await writeFakeCli(bin, 'fakeclaude', fakeCli(lines, 1));
    const error = await rejection(new ClaudeCliAdapter({ ...base, command }).run(request(workspace)));
    expect(error.kind).toBe('quota');
    expect(error.message).toContain('429');
    expect(error.message).not.toContain('AbortController');
    expect(error.usage?.inputTokens).toBe(7);
  });

  it('fails the stage when Claude reports an error result, even with a clean exit', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('claude');
    const lines = [{ type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 3 } }];
    const command = await writeFakeCli(bin, 'fakeclaude', fakeCli(lines));
    const error = await rejection(new ClaudeCliAdapter({ ...base, command }).run(request(workspace)));
    expect(error.kind).toBe('unknown');
    expect(error.message).toContain('error_max_turns');
  });

  it('runs Codex and reports its quota failures for fallback', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('codex');
    const success = [
      { type: 'thread.started', thread_id: 'thr_1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'review complete' } },
      { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 4 } },
    ];
    const command = await writeFakeCli(bin, 'fakecodex', fakeCli(success));
    const result = await new CodexCliAdapter({ ...base, command }).run(request(workspace));
    expect(result).toMatchObject({ text: 'review complete', providerSessionId: 'thr_1' });
    expect((await recordedCall(bin)).args).toEqual(['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-']);

    const failing = await writeFakeCli(bin, 'failingcodex', fakeCli([{ type: 'turn.failed', error: { message: "You've hit your usage limit." } }], 1));
    const error = await rejection(new CodexCliAdapter({ ...base, command: failing }).run(request(workspace)));
    expect(error.kind).toBe('quota');
  });

  it('never runs a same-named executable planted in the workspace', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('planted');
    const marker = path.join(workspace, 'planted-ran.txt');
    await writeFakeCli(workspace, 'dualagentfake', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('planted 6.6.6');`);
    await writeFakeCli(bin, 'dualagentfake', `${fakeCli(claudeSuccess)}\nif (process.argv.includes('--version')) console.log('real 1.0');`);

    const originalPath = process.env.PATH;
    process.env.PATH = [workspace, bin, originalPath ?? ''].join(path.delimiter);
    try {
      const adapter = new ClaudeCliAdapter({ ...base, command: 'dualagentfake' });
      expect((await adapter.run(request(workspace))).text).toBe('final answer');
      const health = await adapter.doctor(undefined, workspace);
      expect(health).toMatchObject({ available: true, version: 'real 1.0' });
      expect(health.detail).toContain(bin);
    } finally {
      process.env.PATH = originalPath;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('continues a Claude session with the shorter prompt when asked to resume', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('claude');
    const command = await writeFakeCli(bin, 'fakeclaude', fakeCli(claudeSuccess));
    const result = await new ClaudeCliAdapter({ ...base, command }).run({
      ...request(workspace, 'workspace-write'),
      resume: { sessionId: 'ses_1', prompt: 'short prompt' },
    });
    expect(result.resumedSession).toBe(true);
    const call = await recordedCall(bin);
    expect(call.input).toBe('short prompt');
    expect(call.args.slice(call.args.indexOf('--resume'), call.args.indexOf('--resume') + 2)).toEqual(['--resume', 'ses_1']);
  });

  it('starts a new session with the full prompt when the session to resume is gone', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('claude');
    // Claude Code 2.1 reports an unknown session like this, before any model call.
    const script = `if (process.argv.includes('--resume')) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: ses_old'] }));
  console.error('No conversation found with session ID: ses_old');
  process.exitCode = 1;
} else {
${fakeCli(claudeSuccess)}
}`;
    const command = await writeFakeCli(bin, 'fakeclaude', script);
    const events: string[] = [];
    const result = await new ClaudeCliAdapter({ ...base, command }).run({
      ...request(workspace),
      onEvent: (event) => events.push(event.message),
      resume: { sessionId: 'ses_old', prompt: 'short prompt' },
    });
    expect(result.text).toBe('final answer');
    expect(result.resumedSession).toBeUndefined();
    const call = await recordedCall(bin);
    expect(call.input).toBe('stage prompt');
    expect(call.args).not.toContain('--resume');
    expect(events.some((message) => message.includes('could not be resumed'))).toBe(true);
  });

  it('does not retry other failures of a resumed session, and never passes a session ID that looks like a flag', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('claude');
    const lines = [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 429 rate limit' }];
    const command = await writeFakeCli(bin, 'fakeclaude', fakeCli(lines, 1));
    const adapter = new ClaudeCliAdapter({ ...base, command });
    const error = await rejection(adapter.run({ ...request(workspace), resume: { sessionId: 'ses_1', prompt: 'short' } }));
    expect(error.kind).toBe('quota');

    await rejection(adapter.run({ ...request(workspace), resume: { sessionId: '--dangerously-skip-permissions', prompt: 'short' } }));
    expect((await recordedCall(bin)).args).not.toContain('--dangerously-skip-permissions');
  });

  it('ignores resume requests for Codex, whose resume flags are not verified', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('codex');
    const success = [
      { type: 'item.completed', item: { type: 'agent_message', text: 'review complete' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const command = await writeFakeCli(bin, 'fakecodex', fakeCli(success));
    await new CodexCliAdapter({ ...base, command }).run({ ...request(workspace), resume: { sessionId: 'thr_1', prompt: 'short' } });
    const call = await recordedCall(bin);
    expect(call.input).toBe('stage prompt');
    expect(call.args).toEqual(['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-']);
  });

  it('refuses an executable inside any untrusted directory, such as the primary workspace of a worktree run', { timeout: 20_000 }, async () => {
    const { bin, workspace } = await layout('untrusted');
    const command = await writeFakeCli(bin, 'fakeclaude', fakeCli(claudeSuccess));
    const error = await rejection(
      new ClaudeCliAdapter({ ...base, command }).run({ ...request(workspace), untrustedDirectories: [path.dirname(bin)] }),
    );
    expect(error.message).toContain('inside the workspace');
  });

  it('warns when a repository carries Codex project configuration', async () => {
    const workspace = await temporaryDirectory('preflight');
    expect(await new CodexCliAdapter(base).preflightWarnings(workspace)).toEqual([]);
    await mkdir(path.join(workspace, '.codex'));
    expect((await new CodexCliAdapter(base).preflightWarnings(workspace))[0]).toContain('.codex');
    expect(await new ClaudeCliAdapter(base).preflightWarnings(workspace)).toEqual([]);
  });
});
