/**
 * Renders the Marketplace icon and README screenshots from the real chat bundle in headless Chrome or Edge:
 * the built `dist/webview` script and styles, VS Code's Dark Modern and Light Modern theme colors, and sample
 * conversations about a made-up project. Run `npm run build` first. Set CHROME_PATH to choose the browser.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'media', 'screenshots');

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (!browser) throw new Error('No Chrome or Edge found; set CHROME_PATH.');
if (!existsSync(path.join(root, 'dist', 'webview', 'chat.js'))) throw new Error('Run npm run build first.');

const FONTS = {
  '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
};

const THEMES = {
  dark: {
    '--vscode-editor-background': '#1f1f1f',
    '--vscode-sideBar-background': '#181818',
    '--vscode-foreground': '#cccccc',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-focusBorder': '#0078d4',
    '--vscode-button-background': '#0078d4',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#026ec1',
    '--vscode-button-border': '#ffffff12',
    '--vscode-button-secondaryBackground': '#313131',
    '--vscode-button-secondaryForeground': '#cccccc',
    '--vscode-button-secondaryHoverBackground': '#3c3c3c',
    '--vscode-badge-background': '#616161',
    '--vscode-badge-foreground': '#f8f8f8',
    '--vscode-dropdown-background': '#313131',
    '--vscode-dropdown-border': '#3c3c3c',
    '--vscode-dropdown-foreground': '#cccccc',
    '--vscode-input-background': '#313131',
    '--vscode-input-border': '#3c3c3c',
    '--vscode-input-foreground': '#cccccc',
    '--vscode-input-placeholderForeground': '#989898',
    '--vscode-editorWidget-background': '#202020',
    '--vscode-editorWidget-border': '#454545',
    '--vscode-widget-border': '#313131',
    '--vscode-widget-shadow': '#0000005c',
    '--vscode-list-activeSelectionBackground': '#04395e',
    '--vscode-list-activeSelectionForeground': '#ffffff',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-panel-border': '#2b2b2b',
    '--vscode-textCodeBlock-background': '#2b2b2b',
    '--vscode-textLink-foreground': '#4daafc',
    '--vscode-toolbar-hoverBackground': '#5a5d5e50',
    '--vscode-charts-blue': '#3794ff',
    '--vscode-charts-orange': '#d18616',
    '--vscode-editorWarning-foreground': '#cca700',
    '--vscode-errorForeground': '#f85149',
    '--vscode-testing-iconPassed': '#73c991',
  },
  light: {
    '--vscode-editor-background': '#ffffff',
    '--vscode-sideBar-background': '#f8f8f8',
    '--vscode-foreground': '#3b3b3b',
    '--vscode-descriptionForeground': '#616161',
    '--vscode-focusBorder': '#005fb8',
    '--vscode-button-background': '#005fb8',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#0258a8',
    '--vscode-button-border': '#0000001a',
    '--vscode-button-secondaryBackground': '#e5e5e5',
    '--vscode-button-secondaryForeground': '#3b3b3b',
    '--vscode-button-secondaryHoverBackground': '#cccccc',
    '--vscode-badge-background': '#cccccc',
    '--vscode-badge-foreground': '#3b3b3b',
    '--vscode-dropdown-background': '#ffffff',
    '--vscode-dropdown-border': '#cecece',
    '--vscode-dropdown-foreground': '#3b3b3b',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-border': '#cecece',
    '--vscode-input-foreground': '#3b3b3b',
    '--vscode-input-placeholderForeground': '#767676',
    '--vscode-editorWidget-background': '#f8f8f8',
    '--vscode-editorWidget-border': '#c8c8c8',
    '--vscode-widget-border': '#e5e5e5',
    '--vscode-widget-shadow': '#00000029',
    '--vscode-list-activeSelectionBackground': '#e8e8e8',
    '--vscode-list-activeSelectionForeground': '#000000',
    '--vscode-list-hoverBackground': '#f2f2f2',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-textCodeBlock-background': '#f0f0f0',
    '--vscode-textLink-foreground': '#005fb8',
    '--vscode-toolbar-hoverBackground': '#b8b8b850',
    '--vscode-charts-blue': '#1a85ff',
    '--vscode-charts-orange': '#d18616',
    '--vscode-editorWarning-foreground': '#bf8803',
    '--vscode-errorForeground': '#f85149',
    '--vscode-testing-iconPassed': '#388a34',
  },
};

const usage = (input, cached, output, reasoning = 0) => ({ input, cached, output, reasoning });
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const composer = (mode, web = false, extra = {}) => ({
  mode,
  web,
  agents: 'claude-codex',
  options: { claude: { model: 'opus', effort: 'high' }, codex: { effort: 'high' } },
  pending: [],
  ...extra,
  choices: {
    claude: {
      models: [{ id: '', label: 'Default', efforts: CLAUDE_EFFORTS }, ...['opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id, efforts: CLAUDE_EFFORTS }))],
      efforts: CLAUDE_EFFORTS,
    },
    codex: { models: [{ id: '', label: 'Default', efforts: ['low', 'medium', 'high'] }], efforts: ['low', 'medium', 'high'] },
  },
});

const step = (kind, tool, title, input, output) => ({ kind, tool, title, ...(input ? { input } : {}), ...(output ? { output } : {}) });

const chatTurn = {
  id: 't1',
  mode: 'chat',
  message: 'Why does retry() in src/http/client.ts sometimes give up one attempt early?',
  attachments: [],
  createdAt: '2026-10-28T09:41:00.000Z',
  status: 'completed',
  runId: 'r1',
  stages: [
    {
      index: 0,
      id: 'claude-answer',
      title: 'Claude answers',
      agent: 'claude',
      label: 'Claude · opus',
      status: 'completed',
      primary: true,
      duration: '41s',
      usage: usage(18_240, 15_100, 1_310),
      activities: [
        step('search', 'Grep', 'retry\\(', 'retry\\( in src', 'src/http/client.ts:44\nsrc/http/client.ts:61\ntest/client.test.ts:18'),
        step('read', 'Read', 'src/http/client.ts', 'src/http/client.ts (lines 30-80)'),
        step('read', 'Read', 'test/client.test.ts'),
      ],
      text: [
        'The loop counts the first request as attempt `0`, but stops at `maxAttempts - 1`, so the last retry never runs ([src/http/client.ts:52](src/http/client.ts:52)):',
        '',
        '```ts',
        'for (let attempt = 0; attempt < maxAttempts - 1; attempt++) {',
        '```',
        '',
        'Use `attempt < maxAttempts`. The tests only cover `maxAttempts: 1`, where both bounds behave the same, which is why this went unnoticed. A test where a request fails twice and succeeds on the third of three attempts would catch it.',
      ].join('\n'),
    },
    {
      index: 1,
      id: 'codex-check',
      title: 'Codex checks the answer',
      agent: 'codex',
      label: 'Codex',
      status: 'completed',
      primary: false,
      duration: '27s',
      usage: usage(9_860, 4_200, 640, 380),
      activities: [
        step('command', 'Shell', 'rg -n "maxAttempts" src test'),
        step('read', 'Read', 'src/http/client.ts'),
        step('read', 'Read', 'test/client.test.ts'),
      ],
      verdict: { outcome: 'pass', summary: 'The off-by-one and the missing test are both confirmed.', findings: [] },
      text: 'Confirmed: with `maxAttempts: 3` the loop runs twice. The suggested bound and test are correct.',
    },
  ],
  outcome: { text: 'Codex agreed', tone: 'good' },
  checks: [],
  awaitingApproval: false,
  usage: { claude: usage(18_240, 15_100, 1_310), codex: usage(9_860, 4_200, 640, 380) },
  canResume: false,
};

const editTurn = {
  id: 't2',
  mode: 'edit',
  message: 'Fix the bound and add the missing test.',
  attachments: [],
  createdAt: '2026-10-28T09:44:00.000Z',
  status: 'completed',
  runId: 'r2',
  stages: [
    {
      index: 0,
      id: 'claude-edit',
      title: 'Claude edits',
      agent: 'claude',
      label: 'Claude · opus',
      status: 'completed',
      primary: true,
      duration: '1m 12s',
      usage: usage(31_400, 27_900, 2_050),
      activities: [
        step('edit', 'Edit', 'src/http/client.ts', '- for (let attempt = 0; attempt < maxAttempts - 1; attempt++) {\n+ for (let attempt = 0; attempt < maxAttempts; attempt++) {'),
        step('edit', 'Edit', 'test/client.test.ts', '+ it(\'retries until the last attempt\', async () => {'),
        step('command', 'Bash', 'npm test', 'npm test', 'Test Files  6 passed (6)\n     Tests  43 passed (43)'),
      ],
      text: 'Changed the loop bound to `attempt < maxAttempts` and added a test where the request fails twice and succeeds on the third attempt. All 43 tests pass.',
    },
    {
      index: 1,
      id: 'codex-change-review',
      title: 'Codex reviews the change',
      agent: 'codex',
      label: 'Codex',
      status: 'completed',
      primary: false,
      duration: '34s',
      usage: usage(12_700, 6_100, 720, 410),
      activities: [step('command', 'Shell', 'git diff'), step('command', 'Shell', 'npm test'), step('read', 'Read', 'test/client.test.ts')],
      verdict: { outcome: 'pass', summary: 'Correct and covered.', findings: [] },
      text: 'The change is minimal and the new test fails without it.',
    },
  ],
  outcome: { text: 'Codex approved the change', tone: 'good' },
  checks: [{ command: 'npm test', passed: true, summary: 'passed in 4.2s' }],
  changes: { runId: 'r2', files: [{ path: 'src/http/client.ts', status: 'M' }, { path: 'test/client.test.ts', status: 'M' }], state: 'active', direct: false },
  awaitingApproval: false,
  usage: { claude: usage(31_400, 27_900, 2_050), codex: usage(12_700, 6_100, 720, 410) },
  canResume: false,
};

const periods = [
  { label: 'This conversation', runs: 2, usage: { claude: usage(49_640, 43_000, 3_360), codex: usage(22_560, 10_300, 1_360, 790) } },
  { label: 'Today', runs: 7, usage: { claude: usage(212_900, 181_400, 14_200), codex: usage(96_300, 40_800, 6_100, 3_400) } },
  { label: 'Last 7 days', runs: 31, usage: { claude: usage(1_284_000, 1_102_000, 81_500), codex: usage(512_000, 219_000, 33_800, 18_900) } },
  { label: 'All time', runs: 64, usage: { claude: usage(2_731_000, 2_310_000, 166_000), codex: usage(1_096_000, 468_000, 70_400, 39_100) } },
];

const quotas = [
  { agent: 'claude', label: '5-hour', usedPercent: 46, resets: '3:00 PM' },
  { agent: 'claude', label: 'weekly', usedPercent: 31, resets: 'Mon 9:00 AM' },
  { agent: 'codex', label: '5-hour', usedPercent: 72, resets: '1:40 PM' },
  { agent: 'codex', label: 'weekly', usedPercent: 22, resets: 'Sun 6:15 PM' },
];

const state = (turns, mode, extra = {}, composerExtra = {}) => ({
  folder: 'acme-http',
  conversationId: 'c1',
  title: 'Retry gives up one attempt early',
  conversations: [],
  turns: turns.map((turn) => ({ canRetry: true, ...turn })),
  running: false,
  composer: composer(mode, false, composerExtra),
  usage: periods,
  queue: [],
  limits: [],
  quotas,
  brief: true,
  accounts: [
    { provider: 'claude', name: 'Claude', signedIn: true, detail: 'Signed in with Claude subscription (max).' },
    { provider: 'codex', name: 'Codex', signedIn: true, detail: 'Signed in with ChatGPT.' },
  ],
  ...extra,
});

// Agent mode: Claude installs what the project needs and asks before the command, as Claude Code does in a terminal.
const agentTurn = {
  id: 't4',
  mode: 'agent',
  message: 'Check whether Gemini CLI is installed, and install it if not.',
  attachments: [],
  createdAt: '2026-10-28T10:05:00.000Z',
  status: 'running',
  runId: 'r4',
  canRetry: false,
  stages: [
    {
      index: 0,
      id: 'claude-agent',
      title: 'Claude works in the folder',
      agent: 'claude',
      label: 'Claude · opus',
      status: 'running',
      primary: true,
      activities: [
        step('todo', 'TodoWrite', '1 of 3 done', '✓ Check for Gemini CLI\n◻ Install it with npm\n◻ Confirm the version'),
        { ...step('command', 'Bash', 'gemini --version', 'gemini --version', "'gemini' is not recognized as an internal or external command"), failed: true },
        step('command', 'Bash', 'npm --version', 'npm --version', '10.9.2'),
      ],
      text: 'Gemini CLI is not installed, and npm 10 is available, so I will install it globally with npm.',
    },
    { index: 1, id: 'codex-agent-check', title: 'Codex checks the result', agent: 'codex', label: 'Codex', status: 'pending', primary: false, activities: [] },
  ],
  checks: [],
  awaitingApproval: false,
  canResume: false,
};

const permission = {
  id: 'p1',
  tool: 'Bash',
  summary: 'run a command: Install Gemini CLI globally',
  detail: 'npm install -g @google/gemini-cli',
  warnings: ['This changes your system outside the folder, which Undo cannot reverse.'],
};

// Claude is at its usage limit: Codex answers alone and checks the answer, and the next message waits its turn.
const soloTurn = {
  ...chatTurn,
  id: 't3',
  message: 'Does the same bug affect the upload client?',
  createdAt: '2026-10-28T09:52:00.000Z',
  status: 'running',
  runId: 'r3',
  canRetry: false,
  outcome: undefined,
  usage: undefined,
  stages: [
    {
      ...chatTurn.stages[0],
      agent: 'codex',
      label: 'Codex (standing in)',
      title: 'Codex answers',
      duration: '33s',
      fallback: 'Claude is at its usage limit until 3:00 PM.',
      activities: [step('command', 'Shell', 'rg -n "maxAttempts" src/upload'), step('read', 'Read', 'src/upload/client.ts')],
      text: 'Yes. `src/upload/client.ts` copies the same loop at line 88, with the same `maxAttempts - 1` bound, so uploads also stop one attempt early.',
    },
    { ...chatTurn.stages[1], status: 'running', primary: true, verdict: undefined, duration: undefined, usage: undefined, text: '', activities: [step('read', 'Read', 'src/upload/client.ts')] },
  ],
};

const scenes = [
  { name: 'chat-dark', theme: 'dark', state: state([chatTurn], 'chat'), width: 520, height: 920 },
  { name: 'edit-light', theme: 'light', state: state([editTurn], 'edit'), width: 520, height: 920 },
  {
    name: 'usage-dark',
    theme: 'dark',
    state: state([chatTurn, editTurn], 'edit', {
      machine: {
        updated: '10:12 AM',
        periods: [
          { label: 'Today', runs: 1, usage: { claude: usage(4_812_000, 4_390_000, 61_300), codex: usage(1_204_000, 702_000, 18_900, 9_200) } },
          { label: 'Last 7 days', runs: 6, usage: { claude: usage(31_640_000, 28_900_000, 402_000), codex: usage(8_310_000, 4_870_000, 121_000, 64_000) } },
        ],
      },
    }),
    showUsage: true,
    width: 520,
    height: 1240,
  },
  {
    name: 'agent-dark',
    theme: 'dark',
    state: state([agentTurn], 'agent', { running: true, permission }, { editor: { label: 'package.json', included: true } }),
    width: 520,
    height: 900,
  },
  {
    name: 'solo-dark',
    theme: 'dark',
    state: state([soloTurn], 'chat', {
      running: true,
      limits: [{ agent: 'claude', until: '3:00 PM', estimated: false }],
      queue: [{ id: 'q1', text: 'Then fix both and add a shared helper.', mode: 'edit' }],
    }),
    width: 520,
    height: 900,
  },
];

const css = (variables) =>
  Object.entries(variables)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');

function page(scene) {
  const asset = (name) => pathToFileURL(path.join(root, 'dist', 'webview', name)).href;
  const messages = [{ type: 'state', state: scene.state }, ...(scene.showUsage ? [{ type: 'showUsage' }] : [])];
  return `<!doctype html><html><head><meta charset="utf-8">
<style>:root { ${css(FONTS)} ${css(THEMES[scene.theme])} }</style>
<link rel="stylesheet" href="${asset('chat.css')}">
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script>
</head><body class="vscode-${scene.theme}"><div id="root"></div>
<script src="${asset('chat.js')}"></script>
<script>
const messages = ${JSON.stringify(messages)};
messages.forEach((message, index) => setTimeout(() => window.postMessage(message, '*'), 50 * (index + 1)));
</script></body></html>`;
}

function capture(html, file, width, height, scale) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dual-agent-shot-'));
  try {
    const source = path.join(directory, 'page.html');
    writeFileSync(source, html);
    const result = spawnSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--allow-file-access-from-files',
        `--user-data-dir=${path.join(directory, 'profile')}`,
        `--force-device-scale-factor=${scale}`,
        '--default-background-color=00000000',
        `--window-size=${width},${height}`,
        '--virtual-time-budget=3000',
        `--screenshot=${file}`,
        pathToFileURL(source).href,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (!existsSync(file)) throw new Error(`Screenshot failed: ${result.stderr || result.error}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

mkdirSync(out, { recursive: true });
for (const scene of scenes) {
  const file = path.join(out, `${scene.name}.png`);
  capture(page(scene), file, scene.width, scene.height, 2);
  console.log(`wrote ${path.relative(root, file)}`);
}

// The Marketplace icon: the activity-bar mark in color on a rounded tile.
const mark = readFileSync(path.join(root, 'media', 'icon-marketplace.svg'), 'utf8');
const icon = path.join(root, 'media', 'icon.png');
capture(`<!doctype html><html><body style="margin:0;background:transparent">${mark}</body></html>`, icon, 256, 256, 1);
console.log(`wrote ${path.relative(root, icon)}`);
