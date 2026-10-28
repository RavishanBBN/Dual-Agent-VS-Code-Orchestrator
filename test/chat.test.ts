import { describe, expect, it } from 'vitest';

import { newConversation, type ConversationTurn } from '../src/core/conversation.js';
import type { AgentStreamEvent, RunRecord, StageRecord } from '../src/core/types.js';
import { fileReference, linkTarget, parseWebviewMessage } from '../src/ui/chat/protocol.js';
import { applyLiveEvent, transcript, usageOverview, type LiveStage } from '../src/ui/chat/transcript.js';
import { isFileLink, renderMarkdown } from '../src/webview/markdown.js';

describe('chat protocol', () => {
  it('accepts well-formed messages from the webview', () => {
    expect(parseWebviewMessage({ type: 'send', text: 'Why?', mode: 'chat' })).toEqual({ type: 'send', text: 'Why?', mode: 'chat' });
    expect(parseWebviewMessage({ type: 'setOptions', agent: 'codex', model: 'gpt-6-sol', effort: 'high' })).toMatchObject({ agent: 'codex' });
    expect(parseWebviewMessage({ type: 'attachData', name: 'a.png', data: 'iVBORw0KGgo=' })).toMatchObject({ name: 'a.png' });
    expect(parseWebviewMessage({ type: 'openStage', runId: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924', index: 2 })).toMatchObject({ index: 2 });
    expect(parseWebviewMessage({ type: 'consent', turnId: 'abc-123', decision: 'conversation' })).toMatchObject({ decision: 'conversation' });
    expect(parseWebviewMessage({ type: 'send', text: 'Find research gaps in sparse attention.', mode: 'research' })).toMatchObject({ mode: 'research' });
    expect(parseWebviewMessage({ type: 'setWeb', enabled: true })).toEqual({ type: 'setWeb', enabled: true });
    expect(parseWebviewMessage({ type: 'setWeb', enabled: 'yes' })).toBeUndefined();
  });

  it('drops anything malformed, so the webview cannot steer the extension with odd input', () => {
    const rejected: unknown[] = [
      null,
      'send',
      { type: 'unknown' },
      { type: 'send', text: '   ', mode: 'chat' },
      { type: 'send', text: 'x', mode: 'shell' },
      { type: 'send', text: 'x'.repeat(20_001), mode: 'chat' },
      { type: 'attachData', name: 'a.png', data: 'not base64!' },
      { type: 'attachData', name: 'a.png', data: '' },
      { type: 'setOptions', agent: 'gpt', model: 'x', effort: 'high' },
      { type: 'openStage', runId: 'run', index: -1 },
      { type: 'openStage', runId: 'run', index: 1.5 },
      { type: 'openConversation', id: '../runs' },
      { type: 'consent', turnId: 'abc', decision: 'always' },
      { type: 'approve', notes: 'x'.repeat(4_001) },
    ];
    for (const value of rejected) expect(parseWebviewMessage(value)).toBeUndefined();
  });

  it('opens only web and mail links from agent output', () => {
    expect(linkTarget('https://example.com/a?b=1')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1' });
    expect(linkTarget('mailto:team@example.com')?.kind).toBe('external');
    for (const href of ['command:workbench.action.terminal.new', 'file:///C:/Windows/System32', 'javascript:alert(1)', 'vscode://settings', 'not a url']) {
      expect(linkTarget(href)).toBeUndefined();
    }
  });

  it('reads file references with line numbers in the forms agents write them', () => {
    expect(fileReference('src/math.js:12')).toEqual({ path: 'src/math.js', line: 12 });
    expect(fileReference('F:/Works/repo/math.js:3:5')).toEqual({ path: 'F:/Works/repo/math.js', line: 3 });
    expect(fileReference('src/math.js#L7-L9')).toEqual({ path: 'src/math.js', line: 7 });
    expect(fileReference('README.md')).toEqual({ path: 'README.md' });
  });
});

describe('chat Markdown', () => {
  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdown('Hi <img src=x onerror=alert(1)> <script>alert(2)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('turns links into data attributes and refuses dangerous schemes', () => {
    const html = renderMarkdown('[docs](https://example.com) [math](src/math.js:4) [short](math.js:1) [bad](javascript:alert(1)) [cmd](command:evil)');
    expect(html).toContain('href="#" data-href="https://example.com"');
    expect(html).toContain('data-href="src/math.js:4"');
    // A bare "name.ext:line" is a file reference, not a URL scheme.
    expect(html).toContain('data-href="math.js:1"');
    // A refused link stays visible as plain text, but never becomes a link target.
    expect(html).not.toMatch(/(?:data-)?href="javascript:/);
    expect(html).not.toMatch(/(?:data-)?href="command:/);
    expect(html).toContain('[bad](javascript:alert(1))');
    expect(isFileLink('src/math.js:4')).toBe(true);
    expect(isFileLink('https://example.com')).toBe(false);
  });

  it('never loads images, and gives code blocks a copy button with escaped code', () => {
    expect(renderMarkdown('![tracker](https://example.com/pixel.png)')).not.toContain('<img');
    const html = renderMarkdown('```ts\nconst a = "<b>";\n```');
    expect(html).toContain('<button type="button" class="copy" data-copy>Copy</button>');
    expect(html).toContain('const a = &quot;&lt;b&gt;&quot;;');
    expect(html).toContain('<span>ts</span>');
  });

  it('hides the machine-readable verdict, which the chat shows as a badge', () => {
    const html = renderMarkdown('Looks right.\n\n```verdict\n{"verdict":"pass","findings":[]}\n```');
    expect(html).toContain('Looks right.');
    expect(html).not.toContain('verdict');
  });
});

const usage = { inputTokens: 1_200, cachedInputTokens: 300, outputTokens: 500, reasoningOutputTokens: 0 };

function stage(id: string, agent: 'claude' | 'codex', status: StageRecord['status'], text = '', extra: Partial<StageRecord> = {}): StageRecord {
  return {
    id,
    title: id,
    agent,
    permission: 'read-only',
    purpose: '',
    instructions: '',
    assignedAgent: agent,
    status,
    ...(status === 'completed' ? { result: { text, usage, rawEventCount: 1 } } : {}),
    ...extra,
  };
}

function run(id: string, stages: StageRecord[], extra: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    id,
    kind: 'chat',
    objective: 'q',
    workspacePath: '/repo',
    status: 'completed',
    allowWrites: false,
    createdAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:00:00Z',
    stages,
    usage: { claude: usage, codex: { ...usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
    conversationId: 'c1',
    ...extra,
  };
}

const turn = (id: string, runId?: string, extra: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id,
  createdAt: '2026-10-28T00:00:00Z',
  mode: 'chat',
  message: `message ${id}`,
  attachments: [],
  ...(runId ? { runId } : {}),
  ...extra,
});

describe('chat transcript', () => {
  const base = { live: new Map(), changes: new Map(), thumbnail: () => undefined };

  it('shows the running stage with what has streamed so far, and nothing of stages not reached', () => {
    const steps = [
      { kind: 'read' as const, tool: 'Read', title: 'math.js', input: 'math.js', output: 'exports.average = …', id: 'a' },
      { kind: 'command' as const, tool: 'Bash', title: 'Run the tests', input: 'node --test', id: 'b' },
    ];
    const active = run('r1', [stage('claude-answer', 'claude', 'running', '', { activities: steps }), stage('codex-check', 'codex', 'pending', '', { review: true })], {
      status: 'running',
      agentOptions: { claude: { model: 'opus' } },
    });
    const live = new Map([['r1', new Map<string, LiveStage>([['claude-answer', { text: 'Partial answer' }]])]]);
    const conversation = { ...newConversation('/repo'), turns: [turn('t1', 'r1')] };
    const [view] = transcript({ ...base, conversation, runs: new Map([['r1', active]]), live, activeRunId: 'r1' });
    expect(view?.status).toBe('running');
    expect(view?.stages[0]).toMatchObject({ label: 'Claude · opus', text: 'Partial answer', primary: true });
    // The step still waiting for its result is the one in progress.
    expect(view?.stages[0]?.activities).toEqual([
      { kind: 'read', tool: 'Read', title: 'math.js', input: 'math.js', output: 'exports.average = …' },
      { kind: 'command', tool: 'Bash', title: 'Run the tests', input: 'node --test', running: true },
    ]);
    expect(view?.stages[1]).toMatchObject({ status: 'pending', text: '', primary: false });
    expect(view?.outcome).toBeUndefined();
    expect(view?.canResume).toBe(false);
  });

  it("presents Claude's revision as the answer, with Codex's findings, the steps kept, and the outcome", () => {
    const finished = run('r1', [
      stage('claude-answer', 'claude', 'completed', 'Draft', {
        startedAt: '2026-10-28T00:00:00Z',
        completedAt: '2026-10-28T00:01:05Z',
        activities: [{ kind: 'read', tool: 'Read', title: 'a.js', input: 'a.js' }],
      }),
      stage('codex-check', 'codex', 'completed', 'Wrong', { review: true, verdict: { outcome: 'fail', findings: [{ severity: 'high', title: 'Off by one', location: 'a.js:3' }] } }),
      stage('claude-revise', 'claude', 'completed', 'Fixed answer'),
    ]);
    const conversation = { ...newConversation('/repo'), turns: [turn('t1', 'r1')] };
    const [view] = transcript({ ...base, conversation, runs: new Map([['r1', finished]]) });
    expect(view?.stages.map((item) => item.primary)).toEqual([false, false, true]);
    // Steps stay visible after the run, with no step marked as in progress.
    expect(view?.stages[0]).toMatchObject({ duration: '1m 5s', activities: [{ tool: 'Read', title: 'a.js' }] });
    expect(view?.stages[0]?.activities[0]?.running).toBeUndefined();
    expect(view?.stages[1]?.verdict).toEqual({ outcome: 'fail', summary: 'fail: 1 high', findings: [{ severity: 'high', title: 'Off by one', location: 'a.js:3' }] });
    expect(view?.outcome).toEqual({ text: "Claude revised the answer after Codex found 1 high issue", tone: 'warn' });
    expect(view?.usage?.claude).toEqual({ input: 1_200, cached: 300, output: 500, reasoning: 0 });
    expect(view?.stages[0]?.usage).toEqual({ input: 1_200, cached: 300, output: 500, reasoning: 0 });
  });

  it('shows the worktree changes only on the latest edit turn, and keeps answers of pruned runs', () => {
    const worktree = { path: '/wt', workingDirectory: '/wt', repositoryRoot: '/repo', baseCommit: 'b', state: 'active' as const };
    const first = run('r1', [stage('claude-edit', 'claude', 'completed', 'Edited')], { kind: 'edit', worktree, createdAt: '2026-10-28T00:00:00Z' });
    const second = run('r2', [stage('claude-edit', 'claude', 'completed', 'Edited more')], { kind: 'edit', worktree, createdAt: '2026-10-28T00:01:00Z' });
    const conversation = {
      ...newConversation('/repo'),
      turns: [turn('t0', 'gone', { answer: 'Old answer', outcome: 'Codex agreed', status: 'completed' }), turn('t1', 'r1', { mode: 'edit' }), turn('t2', 'r2', { mode: 'edit' })],
    };
    const changes = new Map([['r2', [{ path: 'src/a.js', status: 'modified' as const, symlink: false }]]]);
    const views = transcript({ ...base, conversation, runs: new Map([['r1', first], ['r2', second]]), changes });
    expect(views[0]?.stages).toEqual([expect.objectContaining({ text: 'Old answer', primary: true })]);
    expect(views[0]?.outcome).toEqual({ text: 'Codex agreed', tone: 'neutral' });
    expect(views[1]?.changes).toBeUndefined();
    expect(views[2]?.changes).toEqual({ runId: 'r2', files: [{ path: 'src/a.js', status: 'M' }], state: 'active' });
  });

  it('offers resume for a failed turn and shows its error', () => {
    const failed = run('r1', [stage('claude-answer', 'claude', 'failed', '', { error: 'usage limit' })], { status: 'failed', error: 'usage limit' });
    const conversation = { ...newConversation('/repo'), turns: [turn('t1', 'r1')] };
    const [view] = transcript({ ...base, conversation, runs: new Map([['r1', failed]]) });
    expect(view).toMatchObject({ canResume: true, error: 'usage limit', outcome: { tone: 'bad' } });
    expect(view?.stages[0]?.primary).toBe(true);
  });
});

describe('token usage', () => {
  const tokens = (input: number, output: number, cost?: number) => ({
    inputTokens: input,
    cachedInputTokens: Math.floor(input / 2),
    outputTokens: output,
    reasoningOutputTokens: 0,
    ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
  });
  const none = tokens(0, 0);
  const at = (id: string, createdAt: string, claude: ReturnType<typeof tokens>, codex: ReturnType<typeof tokens>): RunRecord => ({
    ...run(id, []),
    createdAt,
    usage: { claude, codex },
  });
  const day = Date.parse('2026-10-28T00:00:00Z');
  const window = (runs: RunRecord[]) => ({ runs, dayStartMs: day, weekStartMs: day - 6 * 86_400_000 });

  it('totals the conversation, today, the last 7 days, and all runs separately', () => {
    const runs = [
      at('today', '2026-10-28T09:00:00Z', tokens(1_000, 100, 0.05), tokens(800, 50)),
      at('week', '2026-10-24T09:00:00Z', tokens(2_000, 200, 0.1), none),
      at('old', '2026-09-01T09:00:00Z', tokens(4_000, 400), tokens(100, 10)),
    ];
    const conversation = { ...newConversation('/repo'), turns: [turn('t1', 'today'), turn('t2', 'pruned', { usage: { claude: tokens(500, 50), codex: none } })] };
    const [mine, today, week, all] = usageOverview(conversation, window(runs));
    // The conversation counts a pruned run's usage from its turn.
    expect(mine).toMatchObject({ label: 'This conversation', runs: 2, usage: { claude: { input: 1_500, output: 150 }, codex: { input: 800, output: 50 } } });
    expect(today).toMatchObject({ label: 'Today', runs: 1, usage: { claude: { input: 1_000, costUsd: 0.05 } } });
    expect(week).toMatchObject({ label: 'Last 7 days', runs: 2, usage: { claude: { input: 3_000, output: 300 } } });
    expect(week?.usage.claude.costUsd).toBeCloseTo(0.15);
    expect(all).toMatchObject({ label: 'All runs', runs: 3, usage: { claude: { input: 7_000 }, codex: { input: 900, output: 60 } } });
  });

  it('reports nothing for a new conversation and keeps a pruned turn\'s usage on its message', () => {
    const [mine] = usageOverview(undefined, window([]));
    expect(mine).toEqual({ label: 'This conversation', runs: 0, usage: { claude: { input: 0, cached: 0, output: 0, reasoning: 0 }, codex: { input: 0, cached: 0, output: 0, reasoning: 0 } } });
    const conversation = { ...newConversation('/repo'), turns: [turn('t1', 'gone', { answer: 'Old', usage: { claude: tokens(300, 30), codex: none } })] };
    const [view] = transcript({ live: new Map(), changes: new Map(), thumbnail: () => undefined, conversation, runs: new Map() });
    expect(view?.usage?.claude).toEqual({ input: 300, cached: 150, output: 30, reasoning: 0 });
  });
});

describe('live agent activity', () => {
  const claude = (extra: Partial<AgentStreamEvent>): AgentStreamEvent => ({ agent: 'claude', category: 'message', message: '', ...extra });

  it("builds Claude's text from streamed fragments, with a paragraph between messages", () => {
    const live: LiveStage = { text: '' };
    applyLiveEvent(live, claude({ delta: 'Let me ' }));
    applyLiveEvent(live, claude({ delta: 'look.' }));
    applyLiveEvent(live, claude({ message: 'Let me look.' }));
    applyLiveEvent(live, { agent: 'claude', category: 'tool', message: 'a.js', activity: { kind: 'read', tool: 'Read', title: 'a.js' } });
    applyLiveEvent(live, claude({ delta: 'It works.' }));
    expect(live.text).toBe('Let me look.\n\nIt works.');
  });

  it("appends Codex's whole messages", () => {
    const live: LiveStage = { text: '' };
    applyLiveEvent(live, { agent: 'codex', category: 'message', message: 'First finding.' });
    applyLiveEvent(live, { agent: 'codex', category: 'message', message: 'Second finding.' });
    expect(live.text).toBe('First finding.\n\nSecond finding.');
  });
});
