export type BillingMode = 'subscription' | 'environment';

/**
 * Variables an agent CLI or its tools need to run. Everything else in the extension host's environment
 * (cloud credentials, tokens, SSH agent sockets) stays out of reach of agents and the commands they run.
 */
const BASE_VARIABLES = [
  // Process basics
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  // Windows system and profile locations
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'OS',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'PSMODULEPATH',
  'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  // Network and TLS configuration that corporate setups depend on
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Agent CLI configuration locations
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH',
];

const BASE_PREFIXES = ['LC_', 'XDG_'];

/** Variables that select paid API billing, an alternate endpoint, or cloud-provider routing. */
export const BILLING_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'AZURE_OPENAI_API_KEY',
];

export interface ChildEnvironmentOptions {
  billingMode: BillingMode;
  /** Extra variable names the user allowed in machine settings. */
  passthrough?: readonly string[];
  platform?: NodeJS.Platform;
}

/**
 * Builds the environment for an agent process from an allowlist.
 *
 * In subscription mode billing variables are always removed, even when listed in `passthrough`.
 * Windows variable names are case-insensitive, so matching ignores case there.
 */
export function buildChildEnvironment(source: NodeJS.ProcessEnv, options: ChildEnvironmentOptions): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const normalize = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const allowed = new Set([...BASE_VARIABLES, ...(options.passthrough ?? [])].map(normalize));
  const prefixes = BASE_PREFIXES.map(normalize);
  const billing = new Set(BILLING_VARIABLES.map(normalize));

  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = normalize(name);
    if (billing.has(key)) {
      if (options.billingMode === 'environment') environment[name] = value;
      continue;
    }
    if (allowed.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) environment[name] = value;
  }
  // Stops cmd.exe and other Windows command lookups in agent tools from preferring the workspace directory.
  if (platform === 'win32') environment.NoDefaultCurrentDirectoryInExePath = '1';
  return environment;
}
