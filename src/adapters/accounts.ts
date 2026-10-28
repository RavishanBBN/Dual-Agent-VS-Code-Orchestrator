/**
 * Signing in to Claude Code, Codex, and Gemini CLI, and asking each whether it is signed in. Every step is the
 * CLI's own command, run with the same environment the agents get, so a sign-in lands in the configuration the
 * agents read. Credentials stay with the CLIs: the extension never opens their credential files, and only
 * passes an API key the user types straight to the CLI's standard input.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveExecutable } from '../core/executables.js';
import { buildChildEnvironment, type BillingMode } from './environment.js';
import { runProcess } from './processRunner.js';

export type AccountProvider = 'claude' | 'codex' | 'gemini';

export const PROVIDER_NAMES: Record<AccountProvider, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini CLI' };

export interface AccountStatus {
  provider: AccountProvider;
  /** Undefined when the CLI could not say, for example because it is not installed. */
  signedIn: boolean | undefined;
  /** How it is signed in, such as "Claude subscription (team)", "ChatGPT", or "API key". */
  method?: string;
  /** The account, such as an email address, shown only to the user on this machine. */
  account?: string;
  detail: string;
}

/** One way to sign in: the CLI's arguments, and whether it reads an API key from standard input. */
export interface SignInMethod {
  id: string;
  label: string;
  description: string;
  args: string[];
  /** The key is asked for in a password box and passed on standard input, never stored. */
  readsKey?: boolean;
}

export const SIGN_IN_METHODS: Record<AccountProvider, readonly SignInMethod[]> = {
  claude: [
    { id: 'subscription', label: 'Claude subscription', description: 'Pro, Max, Team, or Enterprise, in the browser', args: ['auth', 'login', '--claudeai'] },
    { id: 'console', label: 'Anthropic Console', description: 'Billed per token through the API', args: ['auth', 'login', '--console'] },
    { id: 'sso', label: 'Single sign-on', description: "Your organization's SSO", args: ['auth', 'login', '--sso'] },
  ],
  codex: [
    { id: 'chatgpt', label: 'ChatGPT account', description: 'Plus, Pro, Business, or Enterprise, in the browser', args: ['login'] },
    { id: 'device', label: 'ChatGPT with a device code', description: 'When this machine cannot open the sign-in page', args: ['login', '--device-auth'] },
    { id: 'api-key', label: 'OpenAI API key', description: 'Billed per token; the key goes straight to Codex', args: ['login', '--with-api-key'], readsKey: true },
  ],
  gemini: [
    {
      id: 'google',
      label: 'Google account',
      description: 'Gemini CLI asks how to sign in when it starts; choose Login with Google, then type /quit',
      args: [],
    },
  ],
};

/** The CLI's command to sign out, where it has one. */
export const SIGN_OUT: Record<AccountProvider, string[] | undefined> = { claude: ['auth', 'logout'], codex: ['logout'], gemini: undefined };

/** Reads `claude auth status --json`. */
export function parseClaudeStatus(stdout: string): AccountStatus {
  try {
    const status = JSON.parse(stdout) as Record<string, unknown>;
    const signedIn = status.loggedIn === true;
    const subscription = typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined;
    const method =
      status.authMethod === 'claude.ai' ? `Claude subscription${subscription ? ` (${subscription})` : ''}` : typeof status.authMethod === 'string' ? status.authMethod : undefined;
    const account = typeof status.email === 'string' ? status.email : undefined;
    return {
      provider: 'claude',
      signedIn,
      ...(method && signedIn ? { method } : {}),
      ...(account && signedIn ? { account } : {}),
      detail: signedIn ? `Signed in${method ? ` with ${method}` : ''}${account ? ` as ${account}` : ''}.` : 'Not signed in.',
    };
  } catch {
    return { provider: 'claude', signedIn: undefined, detail: 'Claude Code did not report its sign-in status.' };
  }
}

/** Reads `codex login status`, which prints a line such as "Logged in using ChatGPT" or "Not logged in". */
export function parseCodexStatus(output: string, exitCode: number): AccountStatus {
  const line = output.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? '';
  const using = /logged in using (.+)$/i.exec(line)?.[1]?.trim();
  if (using) return { provider: 'codex', signedIn: true, method: /api key/i.test(using) ? 'API key' : using, detail: `Signed in with ${using}.` };
  if (/not logged in/i.test(line) || exitCode !== 0) return { provider: 'codex', signedIn: false, detail: 'Not signed in.' };
  return { provider: 'codex', signedIn: undefined, detail: line ? `Codex reported: ${line.slice(0, 200)}` : 'Codex did not report its sign-in status.' };
}

/**
 * Gemini CLI has no status command. Its settings file records which sign-in it uses, and an API key may come
 * from the environment; neither holds a credential, and its credential file is never opened.
 */
export function parseGeminiSettings(settings: string | undefined, environment: NodeJS.ProcessEnv): AccountStatus {
  if (environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY) return { provider: 'gemini', signedIn: true, method: 'API key', detail: 'Uses an API key from the environment.' };
  let type: unknown;
  try {
    const parsed = settings ? (JSON.parse(settings) as { security?: { auth?: { selectedType?: unknown } }; selectedAuthType?: unknown }) : undefined;
    type = parsed?.security?.auth?.selectedType ?? parsed?.selectedAuthType;
  } catch {
    type = undefined;
  }
  if (typeof type !== 'string' || !type) return { provider: 'gemini', signedIn: false, detail: 'Not signed in yet: Gemini CLI asks how to sign in the first time it runs.' };
  const method = type === 'oauth-personal' ? 'Google account' : type === 'gemini-api-key' ? 'API key' : type === 'vertex-ai' ? 'Vertex AI' : type;
  return { provider: 'gemini', signedIn: true, method, detail: `Set up to sign in with ${method}.` };
}

export interface AccountOptions {
  command: string;
  billingMode: BillingMode;
  environmentPassthrough?: readonly string[];
  /** Folders a command must never be resolved from, such as the workspace. */
  untrustedDirectories?: readonly string[];
}

/** The environment the agents run with, so sign-in and status use the same configuration folders. */
export function accountEnvironment(options: AccountOptions): NodeJS.ProcessEnv {
  return buildChildEnvironment(process.env, { billingMode: options.billingMode, passthrough: options.environmentPassthrough ?? [] });
}

export function accountExecutable(options: AccountOptions): string {
  return resolveExecutable(options.command, { environment: accountEnvironment(options), untrustedDirectories: options.untrustedDirectories ?? [] });
}

/** Asks the CLI whether it is signed in. */
export async function accountStatus(provider: AccountProvider, options: AccountOptions, signal?: AbortSignal): Promise<AccountStatus> {
  const environment = accountEnvironment(options);
  let executable: string;
  try {
    executable = accountExecutable(options);
  } catch (error) {
    return { provider, signedIn: undefined, detail: error instanceof Error ? error.message : String(error) };
  }
  if (provider === 'gemini') {
    const home = environment.GEMINI_CLI_HOME || os.homedir();
    const settings = await readFile(path.join(home, '.gemini', 'settings.json'), 'utf8').catch(() => undefined);
    return parseGeminiSettings(settings, environment);
  }
  try {
    const result = await runProcess({
      command: executable,
      args: provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'],
      cwd: os.homedir(),
      timeoutMs: 20_000,
      environment,
      allowNonZeroExit: true,
      ...(signal ? { signal } : {}),
    });
    return provider === 'claude' ? parseClaudeStatus(result.stdout) : parseCodexStatus(`${result.stdout}\n${result.stderr}`, result.exitCode);
  } catch (error) {
    return { provider, signedIn: undefined, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Signs in with an API key the user typed: it goes to the CLI's standard input and is not kept anywhere. */
export async function signInWithKey(provider: AccountProvider, method: SignInMethod, key: string, options: AccountOptions): Promise<void> {
  if (!method.readsKey) throw new Error(`${method.label} does not take a key.`);
  await runProcess({
    command: accountExecutable(options),
    args: method.args,
    cwd: os.homedir(),
    input: `${key.trim()}\n`,
    timeoutMs: 60_000,
    environment: accountEnvironment(options),
  });
}

export async function signOut(provider: AccountProvider, options: AccountOptions): Promise<void> {
  const args = SIGN_OUT[provider];
  if (!args) throw new Error(`${PROVIDER_NAMES[provider]} has no sign-out command; remove its sign-in by running it and typing /auth.`);
  await runProcess({ command: accountExecutable(options), args, cwd: os.homedir(), timeoutMs: 60_000, environment: accountEnvironment(options) });
}

/**
 * How a terminal starts the CLI for an interactive sign-in, without a shell: the executable itself, or on
 * Windows a batch shim through the absolute COMSPEC, the way the agents' processes start.
 */
export function terminalLaunch(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): { shellPath: string; shellArgs: string[] } {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const comspec = environment.ComSpec ?? environment.COMSPEC ?? process.env.ComSpec;
    if (!comspec || !path.isAbsolute(comspec)) throw new Error('COMSPEC must be an absolute path to start a batch shim.');
    return { shellPath: comspec, shellArgs: ['/d', '/c', executable, ...args] };
  }
  return { shellPath: executable, shellArgs: [...args] };
}
