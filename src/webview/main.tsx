import { render, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { AgentId, WorkflowKind } from '../core/types.js';
import type {
  ActivityView,
  AgentChoices,
  AttachmentView,
  ChatState,
  ComposerView,
  ConsentView,
  HostMessage,
  StageView,
  TurnView,
  WebviewMessage,
} from '../ui/chat/protocol.js';
import { isFileLink, renderMarkdown } from './markdown.js';
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

const MODES: { id: WorkflowKind; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Claude answers and Codex checks the answer. Nothing is edited.' },
  { id: 'edit', label: 'Edit', hint: 'Claude edits an isolated copy, Codex reviews the change, and you apply it.' },
  { id: 'brainstorming', label: 'Brainstorm', hint: 'Five rounds of proposal and challenge, read-only.' },
  { id: 'implementation', label: 'Implement', hint: 'Plan, review, your approval, edit, review, fix, and a final check.' },
];
const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
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
};

const ACTIVITY_ICONS: Record<ActivityView['kind'], string> = {
  read: ICONS.file,
  search: 'M6.5 2a4.5 4.5 0 0 1 3.6 7.2l3.6 3.6-.7.7-3.6-3.6A4.5 4.5 0 1 1 6.5 2zm0 1a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  edit: 'M11.3 1.7 14.3 4.7 5 14H2v-3zm0 1.4L3 11.4V13h1.6L12.9 4.7z',
  command: 'M2 3h12v10H2zm1 1v8h10V4zm1 1.3L6.7 8 4 10.7l-.7-.7 2-2-2-2zM7 10h4v1H7z',
  web: 'M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1c-.8 0-1.7 1.6-2 4h4c-.3-2.4-1.2-4-2-4zM2.1 7h2.8c.1-1.5.4-2.9.9-3.9A6 6 0 0 0 2.1 7zm9 0h2.8a6 6 0 0 0-3.7-3.9c.5 1 .8 2.4.9 3.9zM2.1 9a6 6 0 0 0 3.7 3.9c-.5-1-.8-2.4-.9-3.9zm3.9 0c.3 2.4 1.2 4 2 4s1.7-1.6 2-4zm5.1 0c-.1 1.5-.4 2.9-.9 3.9A6 6 0 0 0 13.9 9z',
  reasoning: 'M8 1a5 5 0 0 1 3 9v2H5v-2a5 5 0 0 1 3-9zm-2 12h4v1H6z',
  tool: ICONS.sliders,
};

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
  const html = useMemo(() => renderMarkdown(text), [text]);
  // renderMarkdown escapes all HTML from the text; links and code buttons are handled by the click delegate.
  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
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
  if (changes.state !== 'active') return <div class="note">Changes {changes.state === 'applied' ? 'applied to your workspace' : 'discarded'}.</div>;
  const runId = changes.runId;
  return (
    <div class="card">
      <strong>{changes.files.length ? `${changes.files.length} file${changes.files.length === 1 ? '' : 's'} changed in an isolated copy` : 'No files changed'}</strong>
      <p class="muted">Your workspace is untouched until you apply. Later edit messages in this conversation keep working on the same copy.</p>
      {changes.files.length ? (
        <ul class="files">
          {changes.files.map((file) => (
            <li key={file.path}>
              <button type="button" class="link-button" onClick={() => send({ type: 'openChange', runId, path: file.path, status: file.status })}>
                <span class={`status-letter s-${file.status}`}>{file.status}</span> {file.path}
              </button>
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
              Apply…
            </button>
          </>
        ) : null}
        <button type="button" class="danger" onClick={() => send({ type: 'discardChanges', runId })}>
          Discard…
        </button>
      </div>
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

function Turn({ turn, consent }: { turn: TurnView; consent?: ConsentView }) {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const mode = MODES.find((item) => item.id === turn.mode);
  const final = [...turn.stages].reverse().find((stage) => stage.primary && stage.status === 'completed' && stage.agent === 'claude');
  const time = new Date(turn.createdAt);
  return (
    <article class="turn">
      <div class="turn-time">{Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      <div class="user-message">
        {mode && mode.id !== 'chat' ? <span class="mode-tag">{mode.label}</span> : null}
        <div class="user-text">{turn.message}</div>
        <Attachments items={turn.attachments} />
      </div>
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
      <Changes turn={turn} />
      {turn.error && !turn.stages.some((stage) => stage.error) ? <div class="note bad">{turn.error}</div> : null}
      <footer class="turn-footer">
        {turn.outcome ? <Pill tone={turn.outcome.tone}>{turn.outcome.text}</Pill> : null}
        {turn.usage ? <span class="muted">{turn.usage}</span> : null}
        <span class="spacer" />
        {final ? (
          <button type="button" class="link-button" onClick={() => send({ type: 'copy', text: final.text })}>
            Copy answer
          </button>
        ) : null}
        {turn.canResume && turn.runId ? (
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

function Welcome({ folder }: { folder?: string }) {
  return (
    <div class="welcome">
      <h2>Claude and Codex, working together</h2>
      <p>
        Ask anything about {folder ? <strong>{folder}</strong> : 'this folder'}. Claude answers, and Codex independently checks the answer before you rely on it; if
        Codex finds a problem, Claude corrects it.
      </p>
      <ul>
        {MODES.map((mode) => (
          <li key={mode.id}>
            <strong>{mode.label}</strong>: {mode.hint}
          </li>
        ))}
      </ul>
      <p class="muted">Attach images, PDFs, ZIP archives, Office files, notebooks, or code with the paperclip, by pasting, or by dropping files here. Type @ to mention a file in the workspace.</p>
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

function Composer({ state, mentions }: { state: ChatState; mentions: { query: string; items: { path: string; description: string }[] } | undefined }) {
  const saved = (vscode.getState() as { draft?: string } | undefined)?.draft ?? '';
  const [draft, setDraft] = useState(saved);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mention, setMention] = useState<Mention | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const { composer } = state;
  const disabled = Boolean(state.blocked);

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
    };
    window.addEventListener('message', focus);
    return () => window.removeEventListener('message', focus);
  }, []);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || state.running || disabled) return;
    send({ type: 'send', text, mode: composer.mode });
    setDraft('');
    setMention(undefined);
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
      {settingsOpen ? <AgentSettings composer={composer} close={() => setSettingsOpen(false)} /> : null}
      <Attachments items={composer.pending} removable />
      <textarea
        ref={input}
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder={disabled ? state.blocked : 'Ask Claude and Codex…  @ to mention a file, Shift+Enter for a new line'}
        onInput={(event) => {
          const element = event.currentTarget;
          setDraft(element.value);
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
        <label class="pill-select" title={mode?.hint}>
          <select value={composer.mode} onChange={(event) => send({ type: 'setMode', mode: event.currentTarget.value as WorkflowKind })}>
            {MODES.map((item) => (
              <option key={item.id} value={item.id} title={item.hint}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {AGENTS.map((agent) => {
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
        {state.running ? (
          <button type="button" class="send stop" title="Stop" onClick={() => send({ type: 'stop' })}>
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
  return (
    <div class="history">
      {state.conversations.length ? null : <div class="muted">No conversations yet.</div>}
      {state.conversations.map((conversation) => (
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
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const data = event.data;
      if (data?.type === 'state') setState(data.state);
      else if (data?.type === 'mentions') setMentions({ query: data.query, items: data.items });
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
    const copy = target?.closest('[data-copy]');
    if (copy) {
      const code = copy.closest('.code-block')?.querySelector('code')?.textContent ?? '';
      send({ type: 'copy', text: code });
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
        <button type="button" class={`icon-button${historyOpen ? ' active' : ''}`} title="Conversation history" onClick={() => setHistoryOpen(!historyOpen)}>
          <Icon path={ICONS.history} />
        </button>
        <button type="button" class="icon-button" title="New conversation" disabled={state.running} onClick={() => send({ type: 'newConversation' })}>
          <Icon path={ICONS.plus} />
        </button>
      </header>
      {historyOpen ? <History state={state} close={() => setHistoryOpen(false)} /> : null}
      <div
        class="transcript"
        ref={scroller}
        onClick={onClick}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {state.blocked ? <div class="note warn">{state.blocked}</div> : null}
        {state.turns.length ? state.turns.map((turn) => <Turn key={turn.id} turn={turn} {...(state.consent ? { consent: state.consent } : {})} />) : <Welcome {...(state.folder ? { folder: state.folder } : {})} />}
      </div>
      {state.notice ? (
        <div class={`notice ${state.notice.tone}`}>
          <span>{state.notice.text}</span>
          <button type="button" class="icon-button small" title="Dismiss" onClick={() => send({ type: 'dismissNotice' })}>
            <Icon path={ICONS.close} />
          </button>
        </div>
      ) : null}
      <Composer state={state} mentions={mentions} />
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
