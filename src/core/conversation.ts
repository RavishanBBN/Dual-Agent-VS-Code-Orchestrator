import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { trimMiddle } from './context.js';
import type { AgentId, AgentOptions, AttachmentRef, ReviewVerdict, RunRecord, RunStatus, WorkflowKind } from './types.js';

/** Characters of a final answer kept on the turn, so a conversation outlives the pruning of its runs. */
const ANSWER_LIMIT = 20_000;
/** Characters of each earlier answer given to agents as conversation history. */
const HISTORY_ANSWER_LIMIT = 4_000;
const TITLE_LIMIT = 80;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

export interface ConversationTurn {
  id: string;
  createdAt: string;
  mode: WorkflowKind;
  message: string;
  attachments: AttachmentRef[];
  agentOptions?: Partial<Record<AgentId, AgentOptions>>;
  runId?: string;
  status?: RunStatus;
  /** The final answer, or the edit summary, kept after the run itself may be pruned. */
  answer?: string;
  /** One line on how the agents agreed, such as "Codex agreed" or "revised after Codex's check". */
  outcome?: string;
  /** The last session of each agent in this turn, continued by the next turn. */
  sessions?: Partial<Record<AgentId, string>>;
  error?: string;
}

export interface Conversation {
  schemaVersion: 1;
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

const now = (): string => new Date().toISOString();

export function newConversation(workspacePath: string): Conversation {
  const created = now();
  return { schemaVersion: 1, id: randomUUID(), title: 'New conversation', workspacePath, createdAt: created, updatedAt: created, turns: [] };
}

export function titleFor(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line || 'New conversation';
}

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Conversation>;
  return candidate.schemaVersion === 1 && typeof candidate.id === 'string' && ID_PATTERN.test(candidate.id) && Array.isArray(candidate.turns);
}

/** The stage whose text the user should read as the run's answer: the last completed Claude stage. */
export function finalStage(run: RunRecord): RunRecord['stages'][number] | undefined {
  return [...run.stages].reverse().find((stage) => stage.status === 'completed' && stage.assignedAgent === 'claude' && stage.result?.text);
}

/** "1 high issue" or "3 issues (1 high, 2 low)", for the outcome line. */
export function issueSummary(verdict: ReviewVerdict): string {
  if (verdict.outcome === 'missing') return 'no clear verdict';
  const count = verdict.findings.length;
  if (!count) return 'a problem';
  const bySeverity = new Map<string, number>();
  for (const finding of verdict.findings) bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  if (bySeverity.size === 1) return `${count} ${verdict.findings[0]?.severity ?? ''} issue${count === 1 ? '' : 's'}`;
  return `${count} issues (${[...bySeverity].map(([severity, n]) => `${n} ${severity}`).join(', ')})`;
}

/** How the two agents ended up on this run, for the transcript and for the turn record. */
export function describeOutcome(run: RunRecord): string {
  if (run.status === 'failed') return `Failed: ${run.error ?? 'no reason recorded'}`;
  if (run.status === 'cancelled') return 'Stopped';
  const reviews = run.stages.filter((stage) => stage.review && stage.status === 'completed' && stage.verdict);
  const last = reviews.at(-1);
  if (!last?.verdict) return run.status === 'completed' ? 'Completed' : run.status;
  const revised = run.stages.some((stage) => stage.id === 'claude-revise' && stage.status === 'completed');
  const first = reviews[0]?.verdict ?? last.verdict;
  if (revised) return `Claude revised the answer after Codex found ${issueSummary(first)}`;
  if (run.status === 'completed-with-findings') return `Codex still reports ${issueSummary(last.verdict)}`;
  if (last.verdict.outcome === 'pass') return reviews.length > 1 && first.outcome !== 'pass' ? `Codex agreed after Claude fixed ${issueSummary(first)}` : 'Codex agreed';
  return `Codex found ${issueSummary(last.verdict)}`;
}

/** Records a finished run on its turn: the answer, the outcome, and the sessions the next turn continues. */
export function recordRun(turn: ConversationTurn, run: RunRecord): void {
  turn.runId = run.id;
  turn.status = run.status;
  const final = finalStage(run);
  if (final?.result?.text) turn.answer = trimMiddle(final.result.text, ANSWER_LIMIT);
  turn.outcome = describeOutcome(run);
  if (run.error) turn.error = run.error;
  const sessions: Partial<Record<AgentId, string>> = {};
  for (const stage of run.stages) {
    const id = stage.result?.providerSessionId;
    if (stage.status === 'completed' && id) sessions[stage.assignedAgent] = id;
  }
  if (Object.keys(sessions).length) turn.sessions = sessions;
}

/** The sessions the next turn continues: the most recent session of each agent in earlier turns. */
export function continuedSessions(conversation: Conversation): Partial<Record<AgentId, string>> {
  const sessions: Partial<Record<AgentId, string>> = {};
  for (const turn of conversation.turns) Object.assign(sessions, turn.sessions ?? {});
  return sessions;
}

/**
 * Earlier turns as plain text for agents that do not continue a session: oldest first, each answer trimmed,
 * and the oldest turns dropped first when the history is longer than `budget`.
 */
export function conversationHistory(conversation: Conversation, budget: number): string {
  const entries: string[] = [];
  let used = 0;
  for (const turn of [...conversation.turns].reverse()) {
    if (!turn.answer && !turn.error) continue;
    const files = turn.attachments.length ? `\nAttached: ${turn.attachments.map((item) => item.name).join(', ')}` : '';
    const answer = turn.answer ? trimMiddle(turn.answer, HISTORY_ANSWER_LIMIT) : `(no answer: ${turn.error ?? 'stopped'})`;
    const entry = `### User (${turn.mode})\n${trimMiddle(turn.message, HISTORY_ANSWER_LIMIT)}${files}\n\n### Answer${turn.outcome ? ` (${turn.outcome})` : ''}\n${answer}`;
    if (used + entry.length > budget) break;
    entries.unshift(entry);
    used += entry.length;
  }
  return entries.join('\n\n');
}

/** Stores each conversation in its own file, so a save rewrites only that conversation. */
export class FileConversationStore {
  private readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(storagePath: string) {
    this.directory = path.join(storagePath, 'conversations');
  }

  private file(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error('Invalid conversation ID.');
    return path.join(this.directory, `${id}.json`);
  }

  /** Conversations, most recently updated first. Unreadable files are set aside rather than deleted. */
  public async list(): Promise<Conversation[]> {
    await this.queue;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const conversations: Conversation[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const file = path.join(this.directory, name);
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
        if (isConversation(parsed) && `${parsed.id}.json` === name) conversations.push(parsed);
        else throw new Error('not a conversation');
      } catch {
        await rename(file, `${file}.unreadable-${Date.now()}`).catch(() => undefined);
      }
    }
    return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async get(id: string): Promise<Conversation | undefined> {
    return (await this.list()).find((conversation) => conversation.id === id);
  }

  public save(conversation: Conversation): Promise<void> {
    const saved = this.queue.then(async () => {
      conversation.updatedAt = now();
      await mkdir(this.directory, { recursive: true });
      const target = this.file(conversation.id);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(conversation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target).catch(async () => {
        // Windows can briefly lock the target; writing in place keeps the conversation saved.
        await writeFile(target, `${JSON.stringify(conversation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rm(temporary, { force: true });
      });
    });
    this.queue = saved.catch(() => undefined);
    return saved;
  }

  public delete(id: string): Promise<void> {
    const deleted = this.queue.then(() => rm(this.file(id), { force: true }));
    this.queue = deleted.catch(() => undefined);
    return deleted;
  }

  /** Deletes the oldest conversations beyond `max`, except those `keep` protects; returns what was deleted. */
  public async prune(max: number, keep: (conversation: Conversation) => boolean): Promise<Conversation[]> {
    const conversations = await this.list();
    const removed = conversations.slice(max).filter((conversation) => !keep(conversation));
    for (const conversation of removed) await this.delete(conversation.id);
    return removed;
  }
}
