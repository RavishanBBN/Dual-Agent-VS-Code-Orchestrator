// Launches an installed VS Code with a temporary profile and runs test/smoke/suite.ts in its extension
// host against fake Claude and Codex CLIs. No model is called. Set DUAL_AGENT_VSCODE to the VS Code
// executable (Code.exe, or Electron inside the macOS app bundle) if it is not in the default location.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

function vscodeExecutable() {
  const candidates = [
    process.env.DUAL_AGENT_VSCODE,
    isWindows && path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    isWindows && path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    process.platform === 'darwin' && '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    process.platform === 'linux' && '/usr/share/code/code',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('VS Code was not found; set DUAL_AGENT_VSCODE to its executable.');
  return found;
}

const claude = `let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  if (process.argv.includes('--version')) return console.log('2.1.0 (Fake Claude Code)');
  const stage = (/- ID: (\\S+)/.exec(input) || [])[1] || 'unknown';
  const session = 'smoke-claude-session';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, result: 'Claude output for ' + stage, usage: { input_tokens: 10, output_tokens: 5 } }));
});`;

const codex = `let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  if (process.argv.includes('--version')) return console.log('codex-cli 0.0.0-fake');
  const verdict = '\`\`\`verdict\\n{"verdict": "pass", "findings": []}\\n\`\`\`';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'smoke-codex-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex review.\\n' + verdict } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 4 } }));
});`;

async function fakeCli(directory, name, script) {
  const scriptPath = path.join(directory, `${name}.js`);
  await writeFile(scriptPath, script);
  const launcher = path.join(directory, isWindows ? `${name}.cmd` : name);
  if (isWindows) {
    await writeFile(launcher, `@"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    await chmod(launcher, 0o755);
  }
  return launcher;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dual-agent-smoke-'));
let exitCode = 1;
try {
  await esbuild.build({
    entryPoints: [path.join(repository, 'test', 'smoke', 'suite.ts')],
    bundle: true,
    outfile: path.join(root, 'suite', 'suite.js'),
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
  });
  const bin = path.join(root, 'bin');
  const userData = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  await Promise.all([bin, path.join(userData, 'User'), workspace].map((directory) => mkdir(directory, { recursive: true })));
  // A repository with one commit, so the suite can review an isolated worktree's changes.
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd: workspace, stdio: 'ignore' });
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(workspace, 'README.md'), 'original readme\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'initial');
  const settings = {
    'dualAgent.claude.command': await fakeCli(bin, 'fake-claude', claude),
    'dualAgent.codex.command': await fakeCli(bin, 'fake-codex', codex),
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
  };
  await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));

  // A VS Code session's own variables would make the new process hand off to the running window.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(VSCODE_|ELECTRON_RUN_AS_NODE$)/i.test(name)),
  );
  environment.DUAL_AGENT_SMOKE_USER_DATA = userData;

  const child = spawn(
    vscodeExecutable(),
    [
      workspace,
      `--extensionDevelopmentPath=${repository}`,
      `--extensionTestsPath=${path.join(root, 'suite', 'suite.js')}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(root, 'extensions')}`,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--new-window',
    ],
    { env: environment, stdio: 'inherit' },
  );
  exitCode = await new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
  console.log(exitCode === 0 ? 'Smoke test passed.' : `Smoke test failed with exit code ${exitCode}.`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => undefined);
}
process.exit(exitCode);
