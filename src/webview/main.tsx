import { render, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { AgentId, AgentSelection, WorkflowKind } from '../core/types.js';
import type {
  AccountView,
  ActivityView,
  AgentChoices,
  AttachmentView,
  ChatState,
  ComposerView,
  ConflictView,
  ConsentView,
  HostMessage,
  LimitView,
  PermissionView,
  QueuedView,
  QuotaView,
  StageView,
  TurnView,
  UsageByAgent,
  UsageNumbers,
  UsagePeriod,
  WebviewMessage,
} from '../ui/chat/protocol.js';
import { matchSlash, parseSlash, SLASH_COMMANDS, type SlashCommand } from '../ui/chat/slash.js';
import { diffText } from '../ui/chat/textDiff.js';
import { isFileLink, rowsToCsv, trustedMarkdown } from './markdown.js';
import './styles.css';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const send = (message: WebviewMessage): void => vscode.postMessage(message);
const FILE_LIMIT = 25 * 1024 * 1024;
/** Clicks on Stop this soon after sending are the end of a double click on Send. */
const STOP_GUARD_MS = 1_000;

const MODES: { id: WorkflowKind; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Claude answers and Codex checks the answer. Nothing is edited.' },
  { id: 'research', label: 'Research', hint: 'Claude researches on the web with cited sources; Codex opens every source and looks for missing or contrary work.' },
  {
    id: 'agent',
    label: 'Agent',
    hint: 'Like Claude Code in a terminal: Claude runs commands, installs packages, and edits the folder itself, asking you before each command; Codex checks the result.',
  },
  { id: 'edit', label: 'Edit', hint: 'Claude edits an isolated copy, Codex reviews the change, and you apply it.' },
  { id: 'tdd', label: 'Test first', hint: 'Codex writes failing tests for the behavior, Claude makes them pass, and Codex reviews.' },
  { id: 'compare', label: 'Compare', hint: 'Claude and Codex answer independently, then Claude merges the best of both and names where they disagree.' },
  { id: 'brainstorming', label: 'Brainstorm', hint: 'Five rounds of proposal and challenge, read-only.' },
  { id: 'implementation', label: 'Implement', hint: 'Plan, review, your approval, edit, review, fix, and a final check.' },
];
const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];
const AGENT_SELECTIONS: { id: AgentSelection; label: string; hint: string }[] = [
  { id: 'claude-codex', label: 'Claude + Codex', hint: 'Claude leads and Codex checks every answer.' },
  { id: 'codex-claude', label: 'Codex + Claude', hint: 'Codex leads and Claude checks every answer.' },
  { id: 'claude', label: 'Claude only', hint: 'Claude alone, without a second check. Uses only Claude’s limits.' },
  { id: 'codex', label: 'Codex only', hint: 'Codex alone, without a second check. Uses only Codex’s limits.' },
];
/** Ready-made first messages for an empty conversation. */
const STARTERS: { label: string; text: string; mode: WorkflowKind }[] = [
  { label: 'Explain this project', text: 'Explain how this project is organized: its main parts, how they fit together, and where to start reading.', mode: 'chat' },
  { label: 'Find bugs', text: 'Look for likely bugs in this project, with the file and line of each and why it is wrong. Most serious first.', mode: 'chat' },
  { label: 'Set up and run it', text: 'Install what this project needs and run it, or its tests, and tell me what happened.', mode: 'agent' },
  { label: 'Write tests', text: 'Add tests for the least-tested important behavior in this project.', mode: 'tdd' },
  { label: 'Research a topic', text: 'Find recent peer-reviewed work on ', mode: 'research' },
  { label: 'Compare approaches', text: 'What is the best way to ', mode: 'compare' },
];

// ---- Icons (inline, so nothing is fetched) ----

function Icon({ path, spin }: { path: string; spin?: boolean }) {
  return (
    <svg class={`icon${spin ? ' spin' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
const ICONS = {
  arrowUp: 'M8 2.3 13.2 7.5l-.8.8L8.6 4.5V14H7.4V4.5L3.6 8.3l-.8-.8z',
  stop: 'M4 4h8v8H4z',
  attach: 'M10.5 3.5 5 9a1.4 1.4 0 0 0 2 2l5.8-5.8a2.8 2.8 0 0 0-4-4L3 7a4.2 4.2 0 0 0 6 6l4.5-4.5-.7-.7L8.3 12.3a3.2 3.2 0 0 1-4.6-4.6l5.8-5.8a1.8 1.8 0 0 1 2.6 2.6L6.3 10.3a.4.4 0 0 1-.6-.6l5.5-5.5z',
  plus: 'M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5z',
  chart: 'M2 13h12v1H2zm1-5h2v4H3zm4-4h2v8H7zm4-2h2v10h-2z',
  history: 'M8 2a6 6 0 1 1-5.7 7.9l1-.3A5 5 0 1 0 4 5H6v1H2V2h1v2.2A6 6 0 0 1 8 2zm-.5 3h1v3.3l2.3 1.4-.5.8-2.8-1.7z',
  trash: 'M6 2h4v1h3v1H3V3h3zm-2 3h8l-.6 9H4.6zm2 1v7h1V6zm3 0v7h1V6z',
  chevron: 'M6 4l4 4-4 4-.7-.7L8.6 8 5.3 4.7z',
  check: 'M6.3 11.3 3 8l.7-.7 2.6 2.6 6-6 .7.7z',
  warn: 'M8 1.5 15 14H1zm-.5 4v4.5h1V5.5zm0 5.5v1.2h1V11z',
  error: 'M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zM5.4 4.7l-.7.7L7.3 8l-2.6 2.6.7.7L8 8.7l2.6 2.6.7-.7L8.7 8l2.6-2.6-.7-.7L8 7.3z',
  sliders: 'M2 4h7.1a2 2 0 0 1 3.8 0H14v1h-1.1a2 2 0 0 1-3.8 0H2zm9 1.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM2 11h1.1a2 2 0 0 1 3.8 0H14v1H6.9a2 2 0 0 1-3.8 0H2zm3 1.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  spinner: 'M8 1.5a6.5 6.5 0 1 0 6.5 6.5h-1.3A5.2 5.2 0 1 1 8 2.8z',
  close: 'M4.7 4 8 7.3 11.3 4l.7.7L8.7 8l3.3 3.3-.7.7L8 8.7 4.7 12l-.7-.7L7.3 8 4 4.7z',
  file: 'M4 1h5.5L13 4.5V15H4zm1 1v12h7V5H9V2z',
  retry: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5h1A4.5 4.5 0 1 0 8 3.5V6L4.8 3 8 0z',
  pencil: 'M11.3 1.7 14.3 4.7 5 14H2v-3zm0 1.4L3 11.4V13h1.6L12.9 4.7z',
  clock: 'M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm-.5 2h1v3.8l2.6 1.5-.5.9-3.1-1.8z',
  queue: 'M2 3h12v1H2zm0 4h12v1H2zm0 4h7v1H2zm9-1 3 1.5-3 1.5z',
  folder: 'M1.5 3H6l1.5 1.5h7V13h-13zm1 1v8h11V5.5H7.1L5.6 4z',
  note: 'M3 1.5h7.5L13 4v10.5H3zm1 1v11h8V4.5h-2v-2zM5 7h6v1H5zm0 2h6v1H5zm0 2h4v1H5z',
  export: 'M7.5 1.3V10h1V3.2l2.6 2.6.7-.7L8 1.3 4.2 5.1l.7.7L7.5 3.2zM2 9h1v4h10V9h1v5H2z',
  shield: 'M8 1 14 3v4.5c0 3.5-2.6 6.3-6 7.5-3.4-1.2-6-4-6-7.5V3zm0 1.1L3 3.8v3.7c0 2.9 2.1 5.3 5 6.4 2.9-1.1 5-3.5 5-6.4V3.8z',
  scale: 'M7.5 1h1v2h4.5v1h-1.1L14 9a2.5 2.5 0 0 1-5 0l2.1-5H8.5v9H11v1H5v-1h2.5V4H4.9L7 9a2.5 2.5 0 0 1-5 0l2.1-5H3V3h4.5zM4.5 5.3 3.1 8.6h2.8zm7 0-1.4 3.3h2.8z',
  people: 'M5.5 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm5 1a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM1.5 13c0-2.2 1.8-4 4-4s4 1.8 4 4zm8.4-3.9c2.3-.4 4.6 1.2 4.6 3.9h-3.9a5 5 0 0 0-.7-3.9z',
};

const ACTIVITY_ICONS: Record<ActivityView['kind'], string> = {
  read: ICONS.file,
  search: 'M6.5 2a4.5 4.5 0 0 1 3.6 7.2l3.6 3.6-.7.7-3.6-3.6A4.5 4.5 0 1 1 6.5 2zm0 1a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  edit: 'M11.3 1.7 14.3 4.7 5 14H2v-3zm0 1.4L3 11.4V13h1.6L12.9 4.7z',
  command: 'M2 3h12v10H2zm1 1v8h10V4zm1 1.3L6.7 8 4 10.7l-.7-.7 2-2-2-2zM7 10h4v1H7z',
  web: 'M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1c-.8 0-1.7 1.6-2 4h4c-.3-2.4-1.2-4-2-4zM2.1 7h2.8c.1-1.5.4-2.9.9-3.9A6 6 0 0 0 2.1 7zm9 0h2.8a6 6 0 0 0-3.7-3.9c.5 1 .8 2.4.9 3.9zM2.1 9a6 6 0 0 0 3.7 3.9c-.5-1-.8-2.4-.9-3.9zm3.9 0c.3 2.4 1.2 4 2 4s1.7-1.6 2-4zm5.1 0c-.1 1.5-.4 2.9-.9 3.9A6 6 0 0 0 13.9 9z',
  reasoning: 'M8 1a5 5 0 0 1 3 9v2H5v-2a5 5 0 0 1 3-9zm-2 12h4v1H6z',
  todo: 'M2 3h2v2H2zm4 .5h8v1H6zM2 7h2v2H2zm4 .5h8v1H6zM2 11h2v2H2zm4 .5h8v1H6z',
  tool: ICONS.sliders,
};

/** A short two-note chime from WebAudio, so no sound file is loaded. */
function chime(): void {
  try {
    const context = new AudioContext();
    const start = context.currentTime;
    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + index * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.08, start + index * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.12 + 0.3);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + index * 0.12);
      oscillator.stop(start + index * 0.12 + 0.32);
    });
    window.setTimeout(() => void context.close(), 1_000);
  } catch {
    // Sound is a nicety; a host without audio stays silent.
  }
}

// ---- Helpers ----

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? (reader.result.split(',')[1] ?? '') : '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function attachFiles(files: Iterable<File>): Promise<void> {
  for (const file of files) {
    if (file.size > FILE_LIMIT) {
      send({ type: 'attachTooLarge', name: file.name });
      continue;
    }
    send({ type: 'attachData', name: file.name || 'pasted-image.png', data: await readFileBase64(file) });
  }
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => trustedMarkdown(text), [text]);
  // The renderer escapes all HTML from the text; links and code buttons are handled by the click delegate.
  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Script errors and content the CSP blocked go to the extension's output log, where they can be diagnosed.
window.addEventListener('error', (event) => send({ type: 'pageError', message: `${event.message} (${event.filename}:${event.lineno})` }));
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => send({ type: 'pageError', message: `Unhandled rejection: ${String(event.reason)}` }));
document.addEventListener('securitypolicyviolation', (event) =>
  send({ type: 'pageError', message: `Blocked by the content security policy: ${event.violatedDirective} ${event.blockedURI}` }),
);

// ---- Token usage ----

const number = new Intl.NumberFormat();

/** 1234 as "1.2k", 2500000 as "2.5M". */
function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

const total = (usage: UsageNumbers): number => usage.input + usage.output;
const agentsTotal = (usage: UsageByAgent): number => total(usage.claude) + total(usage.codex);

function breakdown(usage: UsageNumbers): string {
  const cached = usage.cached ? ` (${number.format(usage.cached)} cached)` : '';
  const reasoning = usage.reasoning ? ` (${number.format(usage.reasoning)} reasoning)` : '';
  return `Input ${number.format(usage.input)}${cached} · Output ${number.format(usage.output)}${reasoning}`;
}

/** Input, cached, output, and total per agent, with the Claude CLI's cost estimate when it gave one. */
function UsageTable({ usage }: { usage: UsageByAgent }) {
  const cost = usage.claude.costUsd;
  return (
    <div class="usage-table">
      <table>
        <thead>
          <tr>
            <th />
            <th>Input</th>
            <th>Cached</th>
            <th>Output</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {AGENTS.map((agent) => {
            const row = usage[agent.id];
            return (
              <tr key={agent.id} class={`agent-${agent.id}`}>
                <th>
                  <span class="pill-dot" /> {agent.label}
                </th>
                <td>{compact(row.input)}</td>
                <td>{compact(row.cached)}</td>
                <td title={row.reasoning ? `${number.format(row.reasoning)} of it reasoning` : undefined}>{compact(row.output)}</td>
                <td>
                  <strong>{compact(total(row))}</strong>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cost !== undefined && cost > 0 ? <div class="muted small">Claude CLI estimate at API prices: ${cost.toFixed(cost < 1 ? 3 : 2)}</div> : null}
    </div>
  );
}

function UsageLine({ usage }: { usage: UsageByAgent }) {
  const [open, setOpen] = useState(false);
  const parts = AGENTS.filter((agent) => total(usage[agent.id]) > 0).map((agent) => `${agent.label} ${compact(total(usage[agent.id]))}`);
  return (
    <>
      <button type="button" class="link-button quiet usage-line" title="Show token usage" onClick={() => setOpen(!open)}>
        <Icon path={ICONS.chart} /> {parts.join(' · ')} tokens
      </button>
      {open ? <UsageTable usage={usage} /> : null}
    </>
  );
}

/** How much of each account's usage windows is used, as each CLI last reported it. */
function QuotaMeter({ quotas, refreshing }: { quotas: QuotaView[]; refreshing: boolean }) {
  return (
    <section class="quota-meter" aria-label="Subscription limits">
      <div class="usage-period">
        <strong>Subscription limits</strong>
        <span class="muted small">
          {refreshing ? 'asking each agent…' : 'as each CLI last reported'}{' '}
          <button
            type="button"
            class="link-button quiet"
            disabled={refreshing}
            title="Ask Claude and Codex for their current limits with one tiny call each (Claude on Haiku, Codex at low effort), about 7,000 and 13,000 input tokens, mostly the CLIs' own instructions."
            onClick={() => send({ type: 'refreshLimits' })}
          >
            Refresh
          </button>
        </span>
      </div>
      {quotas.length ? null : <div class="muted small quota-empty">No limits reported yet. They appear after the next message, or with Refresh.</div>}
      {quotas.map((quota) => (
        <div class={`quota-row agent-${quota.agent}`} key={`${quota.agent}-${quota.label}`}>
          <span class="quota-label">
            <span class="pill-dot" /> {AGENT_LABELS[quota.agent]} {quota.label}
          </span>
          <span class={`quota-bar${quota.usedPercent >= 90 ? ' high' : quota.usedPercent >= 70 ? ' medium' : ''}`}>
            <span style={{ width: `${Math.round(quota.usedPercent)}%` }} />
          </span>
          <span class="muted small quota-value">
            {Math.round(quota.usedPercent)}%{quota.resets ? ` · resets ${quota.resets}` : ''}
          </span>
        </div>
      ))}
    </section>
  );
}

/** Every use of both CLIs on this machine, from their own logs: terminals, other editors, and Dual Agent. */
function MachineUsage({ machine }: { machine: NonNullable<ChatState['machine']> }) {
  return (
    <section class="machine-usage">
      <div class="usage-period">
        <strong>On this machine</strong>
        <span class="muted small">everywhere, including terminals · updated {machine.updated}</span>
      </div>
      {machine.periods.map((period) => (
        <div key={period.label}>
          <div class="usage-period">
            <span>{period.label}</span>
            <span class="muted small">{compact(agentsTotal(period.usage))} tokens</span>
          </div>
          {agentsTotal(period.usage) ? <UsageTable usage={period.usage} /> : null}
        </div>
      ))}
    </section>
  );
}

function UsagePanel({ periods, quotas, machine, refreshing }: { periods: UsagePeriod[]; quotas: QuotaView[]; machine?: ChatState['machine']; refreshing: boolean }) {
  return (
    <div class="history usage-panel">
      <QuotaMeter quotas={quotas} refreshing={refreshing} />
      {machine ? <MachineUsage machine={machine} /> : null}
      <div class="usage-period">
        <strong>In Dual Agent</strong>
      </div>
      {periods.map((period) => (
        <section key={period.label}>
          <div class="usage-period">
            <strong>{period.label}</strong>
            <span class="muted small">
              {compact(agentsTotal(period.usage))} tokens · {period.runs} message{period.runs === 1 ? '' : 's'} and runs
            </span>
          </div>
          {agentsTotal(period.usage) ? <UsageTable usage={period.usage} /> : null}
        </section>
      ))}
      <p class="muted small">
        Dual Agent's totals are counted from what each CLI reports after every stage, including failed attempts; the machine's totals come from the CLIs' own
        logs. Input includes cached input. The limits update after each message and whenever Codex is used anywhere; an agent close to its limit is skipped
        early, and the other one carries on alone.
      </p>
    </div>
  );
}

function Pill({ tone, children }: { tone: string; children: ComponentChildren }) {
  return <span class={`pill ${tone}`}>{children}</span>;
}

// ---- Transcript ----

function Attachments({ items, removable }: { items: AttachmentView[]; removable?: boolean }) {
  if (!items.length) return null;
  return (
    <div class="attachments">
      {items.map((item) => (
        <span class="chip" key={item.id} title={[`${item.name} · ${item.kind} · ${item.size}`, ...(item.notes ?? [])].join('\n')}>
          {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <Icon path={ICONS.file} />}
          <span class="chip-name">{item.name}</span>
          {item.notes?.length ? <Icon path={ICONS.warn} /> : null}
          {removable ? (
            <button type="button" class="icon-button small" title="Remove" onClick={() => send({ type: 'removeAttachment', id: item.id })}>
              <Icon path={ICONS.close} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** One tool call, as Claude Code shows it: the tool in bold, its subject, and an IN/OUT box that expands. */
function Step({ item }: { item: ActivityView }) {
  const [open, setOpen] = useState(false);
  const hasBox = Boolean(item.input || item.output);
  const state = item.running ? 'running' : item.failed ? 'failed' : 'done';
  return (
    <div class={`step ${state}`}>
      <span class="step-dot" />
      <button type="button" class="step-header" disabled={!hasBox} onClick={() => setOpen(!open)} title={hasBox ? (open ? 'Collapse' : 'Expand') : undefined}>
        <Icon path={ACTIVITY_ICONS[item.kind]} />
        <span class="step-tool">{item.tool}</span>
        <span class="step-title">{item.title}</span>
      </button>
      {hasBox ? (
        <div class={`io${open ? ' open' : ''}`} onClick={() => setOpen(!open)}>
          {item.input ? (
            <div class="io-row">
              <span class="io-label">IN</span>
              <pre>{item.input}</pre>
            </div>
          ) : null}
          {item.output ? (
            <div class="io-row">
              <span class="io-label">OUT</span>
              <pre>{item.output}</pre>
            </div>
          ) : item.running ? (
            <div class="io-row">
              <span class="io-label">OUT</span>
              <pre class="muted">Running…</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Steps({ items }: { items: ActivityView[] }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const hidden = all ? 0 : Math.max(0, items.length - 6);
  return (
    <div class="steps">
      {hidden ? (
        <button type="button" class="link-button quiet" onClick={() => setAll(true)}>
          {hidden} earlier step{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
      {items.slice(hidden).map((item, index) => (
        <Step key={hidden + index} item={item} />
      ))}
    </div>
  );
}

function Verdict({ stage }: { stage: StageView }) {
  if (!stage.verdict) return null;
  const { outcome, findings } = stage.verdict;
  if (outcome === 'pass') return <Pill tone="good">Agrees</Pill>;
  if (outcome === 'missing') return <Pill tone="warn">No verdict</Pill>;
  return <Pill tone="warn">{findings.length} issue{findings.length === 1 ? '' : 's'}</Pill>;
}

function Stage({ stage, runId, expanded, toggle }: { stage: StageView; runId?: string; expanded: boolean; toggle: () => void }) {
  const running = stage.status === 'running';
  const steps = stage.activities.length;
  return (
    <section class={`stage agent-${stage.agent} status-${stage.status}`}>
      <span class="stage-dot">{running ? <Icon path={ICONS.spinner} spin /> : null}</span>
      <button type="button" class="stage-header" onClick={toggle} aria-expanded={expanded}>
        <span class="stage-label">{stage.label}</span>
        <span class="stage-title">{running ? `${stage.title}…` : stage.title}</span>
        <Verdict stage={stage} />
        {!expanded && steps ? <span class="muted small">{steps} step{steps === 1 ? '' : 's'}</span> : null}
        {stage.usage ? (
          <span class="muted small" title={breakdown(stage.usage)}>
            {compact(total(stage.usage))} tokens
          </span>
        ) : null}
        {stage.duration ? <span class="muted small">{stage.duration}</span> : null}
        {stage.status === 'failed' ? <Icon path={ICONS.error} /> : null}
        <span class={`chevron${expanded ? ' open' : ''}`}>
          <Icon path={ICONS.chevron} />
        </span>
      </button>
      {expanded ? (
        <div class="stage-body">
          {stage.fallback ? <div class="note warn">Standing in because the intended agent could not run: {stage.fallback}</div> : null}
          <Steps items={stage.activities} />
          {stage.verdict && stage.verdict.findings.length ? (
            <ul class="findings">
              {stage.verdict.findings.map((finding, index) => (
                <li key={index}>
                  <Pill tone={finding.severity === 'low' ? 'neutral' : 'warn'}>{finding.severity}</Pill> {finding.title}
                  {finding.location ? <span class="muted"> · {finding.location}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {stage.referee ? (
            <div class="referee">
              <div class="referee-title">
                <Icon path={ICONS.scale} /> <strong>{stage.referee.name}</strong> <span class="muted small">independent referee</span>
              </div>
              {stage.referee.error ? <div class="note warn">{stage.referee.error}</div> : <Markdown text={stage.referee.text} />}
            </div>
          ) : null}
          {stage.text ? <Markdown text={stage.text} /> : running ? <div class="working">Working…</div> : stage.status === 'pending' ? <div class="muted">Waiting</div> : null}
          {stage.error ? <div class="note bad">{stage.error}</div> : null}
          {runId && stage.status === 'completed' ? (
            <button type="button" class="link-button quiet" onClick={() => send({ type: 'openStage', runId, index: stage.index })}>
              Open as document
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Approval({ turn }: { turn: TurnView }) {
  const [notes, setNotes] = useState('');
  if (!turn.awaitingApproval || !turn.runId) return null;
  const runId = turn.runId;
  return (
    <div class="card attention">
      <strong>The plan and Codex's review of it are ready.</strong>
      <p>Approve it before Claude edits any files. Guidance you add is given to every later stage as your instruction.</p>
      <textarea rows={2} placeholder="Optional guidance, for example a review point to reject" value={notes} onInput={(event) => setNotes(event.currentTarget.value)} />
      <div class="actions">
        <button type="button" class="primary" onClick={() => send({ type: 'approve', notes })}>
          Approve
        </button>
        <button type="button" onClick={() => send({ type: 'reviewPlan', runId })}>
          Review plan
        </button>
        <button type="button" class="danger" onClick={() => send({ type: 'reject' })}>
          Reject
        </button>
      </div>
    </div>
  );
}

function Changes({ turn }: { turn: TurnView }) {
  const changes = turn.changes;
  if (!changes) return null;
  const direct = changes.direct;
  if (changes.state !== 'active') {
    const done = direct ? (changes.state === 'applied' ? 'kept' : 'undone') : changes.state === 'applied' ? 'applied to your workspace' : 'discarded';
    return <div class="note">Changes {done}.</div>;
  }
  const runId = changes.runId;
  const count = `${changes.files.length} file${changes.files.length === 1 ? '' : 's'}`;
  return (
    <div class="card">
      <strong>{changes.files.length ? (direct ? `${count} changed in your folder` : `${count} changed in an isolated copy`) : 'No files changed'}</strong>
      <p class="muted">
        {direct
          ? 'This folder is not a Git repository, so the agents edited it directly after a snapshot. Keep the changes, or undo them back to the snapshot.'
          : 'Your workspace is untouched until you apply. Later edit messages in this conversation keep working on the same copy.'}{' '}
        To keep only part of a file, open it and undo single changes with the arrows in the diff’s margin.
      </p>
      {changes.files.length ? (
        <ul class="files">
          {changes.files.map((file) => (
            <li key={file.path}>
              <button type="button" class="link-button" onClick={() => send({ type: 'openChange', runId, path: file.path, status: file.status })}>
                <span class={`status-letter s-${file.status}`}>{file.status}</span> {file.path}
              </button>
              <span class="file-actions">
                {direct ? null : (
                  <button type="button" class="link-button quiet" title="Apply only this file to your workspace" onClick={() => send({ type: 'applyFile', runId, path: file.path })}>
                    Apply
                  </button>
                )}
                <button
                  type="button"
                  class="link-button quiet"
                  title={direct ? 'Put only this file back as it was' : 'Drop only this file’s changes from the copy'}
                  onClick={() => send({ type: 'discardFile', runId, path: file.path })}
                >
                  {direct ? 'Undo' : 'Discard'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div class="actions">
        {changes.files.length ? (
          <>
            <button type="button" onClick={() => send({ type: 'reviewChanges', runId })}>
              Review all
            </button>
            <button type="button" class="primary" onClick={() => send({ type: 'applyChanges', runId })}>
              {direct ? 'Keep…' : 'Apply…'}
            </button>
          </>
        ) : null}
        <button type="button" class="danger" onClick={() => send({ type: 'discardChanges', runId })}>
          {direct ? 'Undo all…' : 'Discard…'}
        </button>
      </div>
    </div>
  );
}

/** A message that stopped because both agents are at their usage limits. */
function Paused({ turn }: { turn: TurnView }) {
  const paused = turn.paused;
  if (!paused) return null;
  const runId = paused.runId;
  if (paused.offline) {
    return (
      <div class="card attention paused">
        <strong>
          <Icon path={ICONS.clock} /> Waiting for the network
        </strong>
        <p>
          {paused.continuesAt
            ? 'The connection was lost. This message continues where it stopped as soon as the connection is back, and the queued messages follow.'
            : 'The connection was lost, so this message stopped where it was. Continue it once you are online again.'}
        </p>
        <div class="actions">
          {paused.continuesAt ? (
            <button type="button" onClick={() => send({ type: 'cancelContinuation', runId })}>
              Do not continue
            </button>
          ) : (
            <button type="button" class="primary" onClick={() => send({ type: 'continueAfterLimit', runId })}>
              Continue when online
            </button>
          )}
          <button type="button" onClick={() => send({ type: 'resume', runId })}>
            Continue now
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="card attention paused">
      <strong>
        <Icon path={ICONS.clock} /> Paused at the usage limits
      </strong>
      <p>
        {paused.continuesAt
          ? `This message continues automatically at ${paused.continuesAt}, where it stopped, and the queued messages follow.`
          : `The first limit resets at ${paused.reset}. Continue then, or now if the limits have already reset.`}
      </p>
      <div class="actions">
        {paused.continuesAt ? (
          <button type="button" onClick={() => send({ type: 'cancelContinuation', runId })}>
            Do not continue
          </button>
        ) : (
          <button type="button" class="primary" onClick={() => send({ type: 'continueAfterLimit', runId })}>
            Continue when limits reset
          </button>
        )}
        <button type="button" onClick={() => send({ type: 'resume', runId })}>
          Continue now
        </button>
      </div>
    </div>
  );
}

/** The first answer against the revision the check led to, so the user decides when the agents disagree. */
function Comparison({ turn }: { turn: TurnView }) {
  const [open, setOpen] = useState(false);
  const comparison = turn.comparison;
  const segments = useMemo(() => (open && comparison ? diffText(comparison.original, comparison.revised) : []), [open, comparison]);
  if (!comparison) return null;
  return (
    <div class="card comparison">
      <button type="button" class="link-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon path={ICONS.people} /> {comparison.checker} disagreed, and {comparison.reviser} revised. {open ? 'Hide what changed' : 'See what changed'}
      </button>
      {open ? (
        <>
          <div class="diff" aria-label="Changes from the first answer to the revision">
            {segments.map((segment, index) =>
              segment.kind === 'same' ? (
                <span key={index}>{segment.text}</span>
              ) : segment.kind === 'added' ? (
                <ins key={index}>{segment.text}</ins>
              ) : (
                <del key={index}>{segment.text}</del>
              ),
            )}
          </div>
          <p class="muted small">You decide: the revision is shown as the answer. Prefer the first answer, or ask for one more check of the revision.</p>
          <div class="actions">
            <button type="button" onClick={() => setOpen(false)}>
              Keep the revision
            </button>
            <button type="button" onClick={() => send({ type: 'preferOriginal', turnId: turn.id })}>
              Prefer the first answer
            </button>
            <button type="button" onClick={() => send({ type: 'recheck', turnId: turn.id })}>
              Check again
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** What the run noted, such as a folder edited directly; folded away until asked for. */
function Notes({ warnings }: { warnings?: string[] }) {
  const [open, setOpen] = useState(false);
  if (!warnings?.length) return null;
  return (
    <div class="notes">
      <button type="button" class="link-button quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon path={ICONS.warn} /> {warnings.length} note{warnings.length === 1 ? '' : 's'}
      </button>
      {open ? (
        <ul>
          {warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The works a research answer cites, with links and export for a reference manager. */
function Sources({ turn }: { turn: TurnView }) {
  const [open, setOpen] = useState(false);
  const sources = turn.sources;
  if (!sources?.length) return null;
  return (
    <div class="card sources">
      <div class="sources-header">
        <button type="button" class="link-button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {sources.length} source{sources.length === 1 ? '' : 's'} cited
        </button>
        <span class="spacer" />
        <button type="button" class="link-button quiet" title="Save as BibTeX, for Zotero, Mendeley, or LaTeX" onClick={() => send({ type: 'exportSources', turnId: turn.id, format: 'bibtex' })}>
          BibTeX
        </button>
        <button type="button" class="link-button quiet" title="Save as RIS, for EndNote, Zotero, or Mendeley" onClick={() => send({ type: 'exportSources', turnId: turn.id, format: 'ris' })}>
          RIS
        </button>
      </div>
      {open ? (
        <ol class="source-list">
          {sources.map((source, index) => {
            const link = source.doi ? `https://doi.org/${source.doi}` : source.url;
            return (
              <li key={index}>
                {link ? (
                  <a href="#" data-href={link} title={link}>
                    {source.title}
                  </a>
                ) : (
                  source.title
                )}
                <span class="muted">
                  {source.authors.length ? ` · ${source.authors.slice(0, 3).join(', ')}${source.authors.length > 3 ? ' et al.' : ''}` : ''}
                  {source.year ? ` · ${source.year}` : ''}
                  {source.venue ? ` · ${source.venue}` : ''}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

/** An Agent-mode command or edit waiting for the user, as Claude Code asks in a terminal. */
function Permission({ permission }: { permission: PermissionView }) {
  return (
    <div class="card attention permission" role="alertdialog" aria-label="Permission request">
      <strong>
        <Icon path={ICONS.shield} /> Claude wants to {permission.summary}
      </strong>
      <pre class="permission-detail">{permission.detail}</pre>
      {permission.warnings.length ? (
        <ul class="permission-warnings">
          {permission.warnings.map((warning, index) => (
            <li key={index}>
              <Icon path={ICONS.warn} /> {warning}
            </li>
          ))}
        </ul>
      ) : null}
      <div class="actions">
        <button type="button" class="primary" onClick={() => send({ type: 'permission', id: permission.id, decision: 'once' })}>
          Allow
        </button>
        <button type="button" title={`Allow ${permission.tool} without asking again until this message finishes`} onClick={() => send({ type: 'permission', id: permission.id, decision: 'run' })}>
          Allow {permission.tool} for this message
        </button>
        <button type="button" class="danger" onClick={() => send({ type: 'permission', id: permission.id, decision: 'deny' })}>
          Deny
        </button>
      </div>
    </div>
  );
}

const AGENT_LABELS: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };

/** The agents the next message uses that are signed out, each with a way to sign in. */
function SignInBanner({ accounts, agents }: { accounts: AccountView[]; agents: AgentSelection }) {
  const missing = accounts.filter((account) => account.signedIn === false && account.provider !== 'gemini' && agents.includes(account.provider));
  if (!missing.length) return null;
  return (
    <div class="limit-banner sign-in-banner" role="status">
      <Icon path={ICONS.warn} />
      <span>
        {missing.map((account) => account.name).join(' and ')} {missing.length === 1 ? 'is' : 'are'} not signed in, so {missing.length === 1 ? 'it' : 'they'} cannot work.
      </span>
      {missing.map((account) => (
        <button type="button" class="link-button" key={account.provider} onClick={() => send({ type: 'signIn', provider: account.provider })}>
          Sign in to {account.name}
        </button>
      ))}
    </div>
  );
}

/** Which agents are at their usage limits, and what that means for the next message. */
function LimitBanner({ limits }: { limits: LimitView[] }) {
  const [first, second] = limits;
  if (!first) return null;
  const until = (limit: LimitView): string => `${limit.estimated ? 'tried again at' : 'until'} ${limit.until}`;
  const other = first.agent === 'claude' ? 'Codex' : 'Claude';
  return (
    <div class="limit-banner" role="status">
      <Icon path={ICONS.clock} />
      <span>
        {second
          ? `Claude and Codex are both at their usage limits (${AGENT_LABELS[first.agent]} ${until(first)}, ${AGENT_LABELS[second.agent]} ${until(second)}). New messages wait in the queue.`
          : `${AGENT_LABELS[first.agent]} is at its usage limit, ${until(first)}. ${other} works alone meanwhile; ${AGENT_LABELS[first.agent]} rejoins and catches up after the reset.`}
      </span>
    </div>
  );
}

function Queue({ items }: { items: QueuedView[] }) {
  if (!items.length) return null;
  return (
    <div class="queue" aria-label="Queued messages">
      <div class="queue-title muted small">
        <Icon path={ICONS.queue} /> {items.length} queued
      </div>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <span class="queue-text" title={item.text}>
              {item.conversation ? <span class="muted">{item.conversation}: </span> : null}
              {item.text}
            </span>
            {item.mode !== 'chat' ? <span class="mode-tag">{MODES.find((mode) => mode.id === item.mode)?.label ?? item.mode}</span> : null}
            <button type="button" class="icon-button small" title="Remove from the queue" onClick={() => send({ type: 'unqueue', id: item.id })}>
              <Icon path={ICONS.close} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Consent({ consent }: { consent: ConsentView }) {
  return (
    <div class="card attention">
      <strong>Allow agents to edit files?</strong>
      <ul>
        {consent.details.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      <div class="actions">
        <button type="button" class="primary" onClick={() => send({ type: 'consent', turnId: consent.turnId, decision: 'once' })}>
          Allow
        </button>
        <button type="button" onClick={() => send({ type: 'consent', turnId: consent.turnId, decision: 'conversation' })}>
          Allow for this conversation
        </button>
        <button type="button" class="danger" onClick={() => send({ type: 'consent', turnId: consent.turnId, decision: 'deny' })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Changes the new message's mode cannot continue, and what to do with them before it starts. */
function Conflict({ conflict }: { conflict: ConflictView }) {
  const resolve = (action: 'apply' | 'discard' | 'cancel'): void => send({ type: 'resolveConflict', turnId: conflict.turnId, action });
  return (
    <div class="card attention">
      <strong>Changes from an earlier message are waiting</strong>
      <p>{conflict.text}</p>
      <div class="actions">
        <button type="button" class="primary" onClick={() => resolve('apply')}>
          {conflict.direct ? 'Keep them, then continue' : 'Apply them, then continue'}
        </button>
        <button type="button" onClick={() => resolve('discard')}>
          {conflict.direct ? 'Undo them, then continue' : 'Discard them, then continue'}
        </button>
        <button type="button" class="danger" onClick={() => resolve('cancel')}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Turn({ turn, consent, conflict }: { turn: TurnView; consent?: ConsentView; conflict?: ConflictView }) {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const mode = MODES.find((item) => item.id === turn.mode);
  // The primary stage is the answer, whichever agent gave it.
  const final = [...turn.stages].reverse().find((stage) => stage.primary && stage.status === 'completed' && stage.text);
  const time = new Date(turn.createdAt);
  return (
    <article class="turn">
      <div class="turn-time">{Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      <div class="user-message">
        {mode && mode.id !== 'chat' ? <span class="mode-tag">{mode.label}</span> : null}
        <div class="user-text">{turn.message}</div>
        <Attachments items={turn.attachments} />
      </div>
      {conflict?.turnId === turn.id ? <Conflict conflict={conflict} /> : null}
      {consent?.turnId === turn.id ? <Consent consent={consent} /> : null}
      <div class="timeline">
        {turn.status === 'starting' && consent?.turnId !== turn.id ? (
          <section class="stage status-running">
            <span class="stage-dot">
              <Icon path={ICONS.spinner} spin />
            </span>
            <div class="working">Starting…</div>
          </section>
        ) : null}
        {turn.stages.map((stage) => (
          <Stage
            key={stage.index}
            stage={stage}
            {...(turn.runId ? { runId: turn.runId } : {})}
            expanded={overrides[stage.index] ?? stage.primary}
            toggle={() => setOverrides({ ...overrides, [stage.index]: !(overrides[stage.index] ?? stage.primary) })}
          />
        ))}
      </div>
      <Approval turn={turn} />
      {turn.checks.length ? (
        <ul class="checks">
          {turn.checks.map((check, index) => (
            <li key={index} class={check.passed ? 'good' : 'bad'}>
              <Icon path={check.passed ? ICONS.check : ICONS.error} /> <code>{check.command}</code> {check.summary}
            </li>
          ))}
        </ul>
      ) : null}
      <Comparison turn={turn} />
      <Sources turn={turn} />
      <Changes turn={turn} />
      <Notes {...(turn.warnings ? { warnings: turn.warnings } : {})} />
      <Paused turn={turn} />
      {turn.error && !turn.stages.some((stage) => stage.error) ? <div class="note bad">{turn.error}</div> : null}
      {turn.signIn ? (
        <div class="note warn sign-in-note">
          <span>{AGENT_LABELS[turn.signIn]} is not signed in.</span>
          <button type="button" class="primary" onClick={() => send({ type: 'signIn', provider: turn.signIn ?? 'claude' })}>
            Sign in to {AGENT_LABELS[turn.signIn]}
          </button>
        </div>
      ) : null}
      <footer class="turn-footer">
        {turn.outcome ? <Pill tone={turn.outcome.tone}>{turn.outcome.text}</Pill> : null}
        {turn.usage ? <UsageLine usage={turn.usage} /> : null}
        <span class="spacer" />
        {final ? (
          <button type="button" class="link-button" onClick={() => send({ type: 'copy', text: final.text })}>
            Copy answer
          </button>
        ) : null}
        {turn.canRetry ? (
          <>
            <button type="button" class="link-button" title="Run this message again; later messages and their file changes are undone" onClick={() => send({ type: 'retry', turnId: turn.id })}>
              Retry
            </button>
            <button type="button" class="link-button" title="Change this message and send it again" onClick={() => send({ type: 'editMessage', turnId: turn.id })}>
              Edit
            </button>
          </>
        ) : null}
        {turn.canResume && turn.runId && !turn.paused ? (
          <button type="button" class="link-button" onClick={() => send({ type: 'resume', runId: turn.runId ?? '' })}>
            Resume
          </button>
        ) : null}
        {turn.runId && turn.status !== 'running' && turn.status !== 'awaiting-approval' ? (
          <button type="button" class="link-button" onClick={() => send({ type: 'openReport', runId: turn.runId ?? '' })}>
            Report
          </button>
        ) : null}
      </footer>
    </article>
  );
}

/** Fills the composer from elsewhere on the page, such as a starter prompt. */
const composerEvents = new EventTarget();
function fillDraft(text: string): void {
  composerEvents.dispatchEvent(new CustomEvent('fill', { detail: text }));
}

function Welcome({ folder }: { folder?: string }) {
  return (
    <div class="welcome">
      <h2>Claude and Codex, working together</h2>
      <p>
        Ask anything about {folder ? <strong>{folder}</strong> : 'this folder'}. Claude answers, and Codex independently checks the answer before you rely on it; if
        Codex finds a problem, Claude corrects it.
      </p>
      <div class="starters" aria-label="Starter prompts">
        {STARTERS.map((starter) => (
          <button
            type="button"
            class="starter"
            key={starter.label}
            title={starter.text}
            onClick={() => {
              send({ type: 'setMode', mode: starter.mode });
              fillDraft(starter.text);
            }}
          >
            {starter.label}
          </button>
        ))}
      </div>
      <ul>
        {MODES.map((mode) => (
          <li key={mode.id}>
            <strong>{mode.label}</strong>: {mode.hint}
          </li>
        ))}
      </ul>
      <p class="muted">
        Attach images, PDFs, ZIP archives, Office files, notebooks, code, or a whole folder with the + and folder buttons, by pasting, or by dropping files here. Type @ to
        mention a file and / for commands. Choose who leads, or one agent alone, with the agents menu.
      </p>
    </div>
  );
}

// ---- Composer ----

function AgentSettings({ composer, close }: { composer: ComposerView; close: () => void }) {
  const row = (agent: AgentId, label: string, choices: AgentChoices) => {
    const options = composer.options[agent];
    const model = choices.models.find((item) => item.id === (options.model ?? '')) ?? choices.models[0];
    const efforts = model?.id ? model.efforts : choices.efforts;
    return (
      <div class="settings-row" key={agent}>
        <label>{label}</label>
        <select
          value={options.model ?? ''}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === '__custom') send({ type: 'customModel', agent });
            else send({ type: 'setOptions', agent, model: value, effort: options.effort ?? '' });
          }}
        >
          {choices.models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id ? item.label : 'Default model'}
            </option>
          ))}
          <option value="__custom">Custom model…</option>
        </select>
        <select value={options.effort ?? ''} onChange={(event) => send({ type: 'setOptions', agent, model: options.model ?? '', effort: event.currentTarget.value })}>
          <option value="">Default effort</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </div>
    );
  };
  return (
    <div class="popover" role="dialog" aria-label="Models and effort">
      <div class="popover-header">
        <strong>Models and effort</strong>
        <button type="button" class="icon-button small" title="Close" onClick={close}>
          <Icon path={ICONS.close} />
        </button>
      </div>
      {AGENTS.map((agent) => row(agent.id, agent.label, composer.choices[agent.id]))}
      <p class="muted">Default uses each CLI's own setting. Choices apply to your next messages.</p>
    </div>
  );
}

interface Mention {
  query: string;
  start: number;
  items: { path: string; description: string }[];
  selected: number;
}

type Feature = 'new' | 'export' | 'usage' | 'brief' | 'history' | 'help';

function Composer({
  state,
  mentions,
  onFeature,
}: {
  state: ChatState;
  mentions: { query: string; items: { path: string; description: string }[] } | undefined;
  onFeature: (feature: Feature) => void;
}) {
  const saved = (vscode.getState() as { draft?: string } | undefined)?.draft ?? '';
  const [draft, setDraft] = useState(saved);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mention, setMention] = useState<Mention | undefined>(undefined);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashError, setSlashError] = useState<string | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // Send turns into Stop in the same place, so a double click must not stop the message it just sent.
  const sentAt = useRef(0);
  const { composer } = state;
  const disabled = Boolean(state.blocked);
  const slash: SlashCommand[] = mention ? [] : matchSlash(draft);

  useEffect(() => {
    const fill = (event: Event): void => {
      setDraft((event as CustomEvent<string>).detail);
      input.current?.focus();
    };
    composerEvents.addEventListener('fill', fill);
    return () => composerEvents.removeEventListener('fill', fill);
  }, []);
  useEffect(() => setSlashSelected(0), [slash.length]);

  useEffect(() => vscode.setState({ draft }), [draft]);
  // Only the arrival of new results matters here, so `mention` is deliberately not a dependency.
  useEffect(() => {
    if (mentions && mention && mentions.query === mention.query) setMention({ ...mention, items: mentions.items, selected: 0 });
  }, [mentions]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [draft]);
  useEffect(() => {
    const focus = (event: MessageEvent<HostMessage>): void => {
      if (event.data?.type === 'focus') input.current?.focus();
      if (event.data?.type === 'fillComposer') {
        setDraft(event.data.text);
        input.current?.focus();
      }
    };
    window.addEventListener('message', focus);
    return () => window.removeEventListener('message', focus);
  }, []);

  /** Carries out a slash command; returns false for an ordinary message. */
  const runSlash = (text: string): boolean => {
    const action = parseSlash(text);
    if (!action) return false;
    switch (action.kind) {
      case 'mode':
        send({ type: 'send', text: action.text, mode: action.mode });
        sentAt.current = Date.now();
        break;
      case 'agents':
        send({ type: 'setAgents', agents: action.agents });
        break;
      case 'options': {
        const current = composer.options[action.agent];
        send({ type: 'setOptions', agent: action.agent, model: action.model ?? current.model ?? '', effort: action.effort ?? current.effort ?? '' });
        break;
      }
      case 'web':
        send({ type: 'setWeb', enabled: action.enabled });
        break;
      case 'feature':
        onFeature(action.feature);
        break;
      case 'error':
        setSlashError(action.message);
        return true;
    }
    setSlashError(undefined);
    setDraft('');
    return true;
  };

  const submit = (): void => {
    const text = draft.trim();
    // While a message runs, sending puts the new one in the queue.
    if (!text || disabled) return;
    if (text.startsWith('/') && runSlash(text)) return;
    send({ type: 'send', text, mode: composer.mode });
    sentAt.current = Date.now();
    setDraft('');
    setMention(undefined);
    setSlashError(undefined);
  };

  const completeSlash = (command: SlashCommand): void => {
    // A command that takes a value is completed for typing; one without runs at once.
    if (command.usage.includes(' ')) setDraft(`/${command.name} `);
    else runSlash(`/${command.name}`);
    input.current?.focus();
  };

  const updateMention = (value: string, caret: number): void => {
    const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (!match) {
      setMention(undefined);
      return;
    }
    const query = match[2] ?? '';
    setMention((current) => ({ query, start: caret - query.length - 1, items: current?.query === query ? current.items : [], selected: 0 }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => send({ type: 'searchMentions', query }), 150);
  };

  const choose = (item: { path: string }): void => {
    if (!mention) return;
    const end = mention.start + mention.query.length + 1;
    setDraft(`${draft.slice(0, mention.start)}${draft.slice(end)}`);
    setMention(undefined);
    send({ type: 'addMention', path: item.path });
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (slash.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSlashSelected((slashSelected + step + slash.length) % slash.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const command = slash[slashSelected];
        if (command) completeSlash(command);
        return;
      }
      if (event.key === 'Escape') {
        setDraft('');
        return;
      }
    }
    if (mention?.items.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, selected: (mention.selected + step + mention.items.length) % mention.items.length });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const item = mention.items[mention.selected];
        if (item) choose(item);
        return;
      }
      if (event.key === 'Escape') {
        setMention(undefined);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const mode = MODES.find((item) => item.id === composer.mode) ?? MODES[0];

  return (
    <div
      class="composer"
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = event.dataTransfer?.files;
        if (files?.length) {
          event.preventDefault();
          void attachFiles(Array.from(files));
        }
      }}
    >
      {mention?.items.length ? (
        <ul class="mentions" role="listbox">
          {mention.items.map((item, index) => (
            <li
              key={item.path}
              class={index === mention.selected ? 'selected' : ''}
              onMouseDown={(event) => {
                // Keeps focus in the text box while the suggestion is chosen.
                event.preventDefault();
                choose(item);
              }}
            >
              <Icon path={ICONS.file} /> {item.path.slice(item.path.lastIndexOf('/') + 1)} <span class="muted">{item.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {slash.length ? (
        <ul class="mentions slash" role="listbox" aria-label="Commands">
          {slash.map((command, index) => (
            <li
              key={command.name}
              class={index === slashSelected ? 'selected' : ''}
              onMouseDown={(event) => {
                event.preventDefault();
                completeSlash(command);
              }}
            >
              <code>/{command.name}</code> <span class="muted">{command.hint}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {settingsOpen ? <AgentSettings composer={composer} close={() => setSettingsOpen(false)} /> : null}
      {composer.editing ? (
        <div class="editing">
          <Icon path={ICONS.pencil} />
          <span>
            Editing <q>{composer.editing.preview}</q>. Sending replaces it and the messages after it.
          </span>
          <button
            type="button"
            class="icon-button small"
            title="Stop editing"
            onClick={() => {
              send({ type: 'cancelEdit' });
              setDraft('');
            }}
          >
            <Icon path={ICONS.close} />
          </button>
        </div>
      ) : null}
      {composer.editor || composer.pending.length ? (
        <div class="context-row">
          {composer.editor ? (
            <button
              type="button"
              class={`chip editor-chip${composer.editor.included ? '' : ' off'}`}
              title={
                composer.editor.included
                  ? 'The open file, your selection, and its problems go with the next message. Click to leave them out.'
                  : 'Left out of the next message. Click to include the open file.'
              }
              onClick={() => send({ type: 'setEditorContext', included: !composer.editor?.included })}
            >
              <Icon path={ICONS.file} />
              <span class="chip-name">{composer.editor.label}</span>
            </button>
          ) : null}
          <Attachments items={composer.pending} removable />
        </div>
      ) : null}
      {slashError ? <div class="slash-error">{slashError}</div> : null}
      <textarea
        ref={input}
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder={
          disabled
            ? state.blocked
            : state.running
              ? 'Type the next message; it waits in the queue until this one finishes'
              : composer.agents === 'claude'
                ? 'Ask Claude…  @ to mention a file, / for commands'
                : composer.agents === 'codex'
                  ? 'Ask Codex…  @ to mention a file, / for commands'
                  : 'Ask Claude and Codex…  @ to mention a file, / for commands'
        }
        onInput={(event) => {
          const element = event.currentTarget;
          setDraft(element.value);
          setSlashError(undefined);
          updateMention(element.value, element.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length) {
            event.preventDefault();
            void attachFiles(files);
          }
        }}
      />
      <div class="toolbar">
        <button type="button" class="icon-button" title="Attach files (or paste, or drop them here)" disabled={disabled} onClick={() => send({ type: 'pickFiles' })}>
          <Icon path={ICONS.plus} />
        </button>
        <button type="button" class="icon-button" title="Attach a folder, such as your literature or a data set" disabled={disabled} onClick={() => send({ type: 'pickFolder' })}>
          <Icon path={ICONS.folder} />
        </button>
        <button
          type="button"
          class={`web-toggle${composer.web ? ' on' : ''}`}
          disabled={disabled || composer.mode === 'research'}
          title={
            composer.mode === 'research'
              ? 'Research mode always searches and reads the web.'
              : composer.web
                ? 'Web on: agents may search and read web pages. Search terms and page requests leave your machine.'
                : 'Web off: agents use only the workspace and your attachments. Click to let them search the web.'
          }
          onClick={() => send({ type: 'setWeb', enabled: !composer.web })}
        >
          <Icon path={ACTIVITY_ICONS.web} />
          <span>Web</span>
        </button>
        <label class="pill-select" title={mode?.hint}>
          <select value={composer.mode} onChange={(event) => send({ type: 'setMode', mode: event.currentTarget.value as WorkflowKind })}>
            {MODES.map((item) => (
              <option key={item.id} value={item.id} title={item.hint}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label class="pill-select" title={AGENT_SELECTIONS.find((item) => item.id === composer.agents)?.hint}>
          <select aria-label="Agents" value={composer.agents} onChange={(event) => send({ type: 'setAgents', agents: event.currentTarget.value as AgentSelection })}>
            {AGENT_SELECTIONS.map((item) => (
              <option key={item.id} value={item.id} title={item.hint}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {AGENTS.filter((agent) => composer.agents.includes(agent.id)).map((agent) => {
          const options = composer.options[agent.id];
          const model = composer.choices[agent.id].models.find((item) => item.id && item.id === options.model);
          return (
            <button
              type="button"
              key={agent.id}
              class={`model-pill agent-${agent.id}${settingsOpen ? ' active' : ''}`}
              title={`${agent.label}: choose the model and effort`}
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              <span class="pill-dot" />
              <span class="pill-model">{model?.label ?? options.model ?? agent.label}</span>
              {options.effort ? <span class="pill-effort">{options.effort}</span> : null}
            </button>
          );
        })}
        <span class="spacer" />
        {state.running && draft.trim() ? (
          <button type="button" class="icon-button" title="Queue this message (Enter); it runs when the current one finishes" onClick={submit}>
            <Icon path={ICONS.queue} />
          </button>
        ) : null}
        {state.running ? (
          <button
            type="button"
            class="send stop"
            title="Stop"
            onClick={() => {
              if (Date.now() - sentAt.current > STOP_GUARD_MS) send({ type: 'stop' });
            }}
          >
            <Icon path={ICONS.stop} />
          </button>
        ) : (
          <button type="button" class="send" title="Send (Enter)" disabled={disabled || !draft.trim()} onClick={submit}>
            <Icon path={ICONS.arrowUp} />
          </button>
        )}
      </div>
    </div>
  );
}

// ---- App ----

function History({ state, close }: { state: ChatState; close: () => void }) {
  const [query, setQuery] = useState('');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = state.conversations.filter((conversation) => {
    const haystack = `${conversation.title}\n${conversation.search}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return (
    <div class="history">
      <div class="history-tools">
        <input type="search" placeholder="Search conversations" aria-label="Search conversations" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
        <button type="button" class="icon-button small" title="Export this conversation as Markdown" disabled={!state.turns.length} onClick={() => send({ type: 'exportConversation' })}>
          <Icon path={ICONS.export} />
        </button>
      </div>
      {state.conversations.length ? (shown.length ? null : <div class="muted">No conversation matches.</div>) : <div class="muted">No conversations yet.</div>}
      {shown.map((conversation) => (
        <div class={`history-item${conversation.id === state.conversationId ? ' current' : ''}`} key={conversation.id}>
          <button
            type="button"
            class="history-open"
            onClick={() => {
              send({ type: 'openConversation', id: conversation.id });
              close();
            }}
          >
            <span class="history-title">{conversation.title}</span>
            <span class="muted">
              {conversation.updated} · {conversation.turns} message{conversation.turns === 1 ? '' : 's'}
            </span>
          </button>
          <button type="button" class="icon-button small" title="Delete conversation" onClick={() => send({ type: 'deleteConversation', id: conversation.id })}>
            <Icon path={ICONS.trash} />
          </button>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [state, setState] = useState<ChatState | undefined>(undefined);
  const [mentions, setMentions] = useState<{ query: string; items: { path: string; description: string }[] } | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const panel = (which: 'history' | 'usage' | 'help' | undefined): void => {
    setHistoryOpen(which === 'history');
    setUsageOpen(which === 'usage');
    setHelpOpen(which === 'help');
  };
  const feature = (name: Feature): void => {
    if (name === 'new') send({ type: 'newConversation' });
    else if (name === 'export') send({ type: 'exportConversation' });
    else if (name === 'brief') send({ type: 'editBrief' });
    else panel(name);
  };

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const data = event.data;
      if (data?.type === 'state') setState(data.state);
      else if (data?.type === 'mentions') setMentions({ query: data.query, items: data.items });
      else if (data?.type === 'showUsage') panel('usage');
      else if (data?.type === 'chime') chime();
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [state]);

  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const code = (): string => target?.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    if (target?.closest('[data-copy]')) {
      send({ type: 'copy', text: code() });
      return;
    }
    if (target?.closest('[data-run]')) {
      send({ type: 'runCommand', command: code() });
      return;
    }
    if (target?.closest('[data-paste]')) {
      send({ type: 'pasteCommand', command: code() });
      return;
    }
    const table = target?.closest('[data-csv]')?.closest('.table-block')?.querySelector('table');
    if (table) {
      const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => cell.textContent ?? ''));
      send({ type: 'saveCsv', csv: rowsToCsv(rows) });
      return;
    }
    const link = target?.closest('a[data-href]');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('data-href') ?? '';
      send(isFileLink(href) ? { type: 'openFile', path: href } : { type: 'openLink', href });
    }
  };

  if (!state) return <div class="loading">Loading…</div>;
  return (
    <div class="app">
      <header class="header">
        <div class="header-title">
          <span class="title">{state.title}</span>
          {state.folder ? <span class="muted">{state.folder}</span> : null}
        </div>
        <button
          type="button"
          class={`usage-button${usageOpen ? ' active' : ''}${state.quotas.some((quota) => quota.usedPercent >= 90) ? ' high' : ''}`}
          title={
            state.quotas.length
              ? `Token usage and limits: ${state.quotas.map((quota) => `${AGENT_LABELS[quota.agent]} ${quota.label} ${Math.round(quota.usedPercent)}%`).join(', ')}`
              : 'Token usage'
          }
          onClick={() => panel(usageOpen ? undefined : 'usage')}
        >
          <Icon path={ICONS.chart} />
          <span>{compact(agentsTotal(state.usage[0]?.usage ?? { claude: { input: 0, cached: 0, output: 0, reasoning: 0 }, codex: { input: 0, cached: 0, output: 0, reasoning: 0 } }))}</span>
        </button>
        <button
          type="button"
          class={`icon-button${state.brief ? ' active' : ''}`}
          title={state.brief ? 'Project brief: both agents read it with every message. Click to edit.' : 'Write a project brief that both agents read with every message'}
          onClick={() => send({ type: 'editBrief' })}
        >
          <Icon path={ICONS.note} />
        </button>
        <button type="button" class={`icon-button${historyOpen ? ' active' : ''}`} title="Conversation history" onClick={() => panel(historyOpen ? undefined : 'history')}>
          <Icon path={ICONS.history} />
        </button>
        <button type="button" class="icon-button" title="New conversation" disabled={state.running} onClick={() => send({ type: 'newConversation' })}>
          <Icon path={ICONS.plus} />
        </button>
      </header>
      {historyOpen ? <History state={state} close={() => setHistoryOpen(false)} /> : null}
      {usageOpen ? <UsagePanel periods={state.usage} quotas={state.quotas} refreshing={Boolean(state.refreshingLimits)} {...(state.machine ? { machine: state.machine } : {})} /> : null}
      {helpOpen ? (
        <div class="history help">
          <div class="usage-period">
            <strong>Commands</strong>
            <button type="button" class="icon-button small" title="Close" onClick={() => panel(undefined)}>
              <Icon path={ICONS.close} />
            </button>
          </div>
          <ul>
            {SLASH_COMMANDS.map((command) => (
              <li key={command.name}>
                <code>{command.usage}</code> <span class="muted">{command.hint}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div
        class="transcript"
        role="log"
        aria-label="Conversation"
        aria-busy={state.running}
        ref={scroller}
        onClick={onClick}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {state.blocked ? <div class="note warn">{state.blocked}</div> : null}
        {state.turns.length ? (
          state.turns.map((turn) => <Turn key={turn.id} turn={turn} {...(state.consent ? { consent: state.consent } : {})} {...(state.conflict ? { conflict: state.conflict } : {})} />)
        ) : (
          <Welcome {...(state.folder ? { folder: state.folder } : {})} />
        )}
      </div>
      {state.notice ? (
        <div class={`notice ${state.notice.tone}`}>
          <span>{state.notice.text}</span>
          <button type="button" class="icon-button small" title="Dismiss" onClick={() => send({ type: 'dismissNotice' })}>
            <Icon path={ICONS.close} />
          </button>
        </div>
      ) : null}
      {state.permission ? <Permission permission={state.permission} /> : null}
      <SignInBanner accounts={state.accounts} agents={state.composer.agents} />
      <LimitBanner limits={state.limits} />
      <Queue items={state.queue} />
      <Composer state={state} mentions={mentions} onFeature={feature} />
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
