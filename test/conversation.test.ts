import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listCodexModels, parseCodexCatalog } from '../src/adapters/models.js';
import {
  continuedSessions,
  conversationHistory,
  describeOutcome,
  FileConversationStore,
  missedTurns,
  newConversation,
  recordRun,
  titleFor,
  type ConversationTurn,
} from '../src/core/conversation.js';
import type { RunRecord, StageRecord } from '../src/core/types.js';
import { removeTemporaryDirectories, temporaryDirectory, writeFakeCli } from './helpers.js';

afterEach(removeTemporaryDirectories);

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 };

function stage(id: string, agent: 'claude' | 'codex', text: string, extra: Partial<StageRecord> = {}): StageRecord {
  return {
    id,
    title: id,
    agent,
    permission: 'read-only',
    purpose: '',
    instructions: '',
    assignedAgent: agent,
    status: 'completed',
    result: { text, usage, rawEventCount: 1, providerSessionId: `${agent}-${id}` },
    ...extra,
  };
}

function chatRun(stages: StageRecord[], status: RunRecord['status'] = 'completed'): RunRecord {
  return {
    schemaVersion: 1,
    id: 'run-1',
    kind: 'chat',
    objective: 'q',
    workspacePath: '/repo',
    status,
    allowWrites: false,
    createdAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:00:00Z',
    stages,
    usage: { claude: usage, codex: usage },
  };
}

const turn = (message: string, extra: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: message,
  createdAt: '2026-10-28T00:00:00Z',
  mode: 'chat',
  message,
  attachments: [],
  ...extra,
});

describe('conversation records', () => {
  it('titles a conversation from its first message', () => {
    expect(titleFor('  How does\n paging   work? ')).toBe('How does paging work?');
    expect(titleFor('x'.repeat(200))).toHaveLength(80);
    expect(titleFor('   ')).toBe('New conversation');
  });

  it("keeps Claude's final answer, how the agents ended up, and the sessions the next turn continues", () => {
    const passed = chatRun([
      stage('claude-answer', 'claude', 'It averages.'),
      stage('codex-check', 'codex', 'ok', { review: true, verdict: { outcome: 'pass', findings: [] } }),
    ]);
    const first = turn('What does it do?');
    recordRun(first, passed);
    expect(first).toMatchObject({ runId: 'run-1', status: 'completed', answer: 'It averages.', outcome: 'Codex agreed' });
    expect(first.sessions).toEqual({ claude: 'claude-claude-answer', codex: 'codex-codex-check' });

    const revised = chatRun([
      stage('claude-answer', 'claude', 'Draft.'),
      stage('codex-check', 'codex', 'no', { review: true, verdict: { outcome: 'fail', findings: [{ severity: 'high', title: 'Wrong' }] } }),
      stage('claude-revise', 'claude', 'Corrected answer.'),
    ]);
    const second = turn('And empty lists?');
    recordRun(second, revised);
    expect(second.answer).toBe('Corrected answer.');
    expect(second.outcome).toBe("Claude revised the answer after Codex found 1 high issue");
    expect(second.sessions?.claude).toBe('claude-claude-revise');

    const conversation = { ...newConversation('/repo'), turns: [first, second] };
    expect(continuedSessions(conversation)).toEqual({ claude: 'claude-claude-revise', codex: 'codex-codex-check' });
  });

  it('describes failed, stopped, and unchecked runs', () => {
    expect(describeOutcome({ ...chatRun([]), status: 'failed', error: 'quota' })).toBe('Failed: quota');
    expect(describeOutcome(chatRun([], 'cancelled'))).toBe('Stopped');
    expect(describeOutcome(chatRun([stage('claude-answer', 'claude', 'x')]))).toBe('Completed');
    const findings = chatRun(
      [stage('claude-edit', 'claude', 'x'), stage('codex-change-review', 'codex', 'y', { review: true, verdict: { outcome: 'fail', findings: [{ severity: 'low', title: 't' }] } })],
      'completed-with-findings',
    );
    expect(describeOutcome(findings)).toBe('Codex still reports 1 low issue');
    const minor = chatRun([
      stage('claude-answer', 'claude', 'x'),
      stage('codex-check', 'codex', 'y', { review: true, verdict: { outcome: 'fail', findings: [{ severity: 'low', title: 'a' }, { severity: 'low', title: 'b' }] } }),
    ]);
    expect(describeOutcome(minor)).toBe('Codex agreed, with 2 minor notes');
  });

  it('gives agents the most recent turns that fit, oldest first', () => {
    const conversation = {
      ...newConversation('/repo'),
      turns: [
        turn('first question', { answer: 'first answer', outcome: 'Codex agreed' }),
        turn('second question', { answer: 'second answer', attachments: [{ id: 'a', name: 'spec.pdf', kind: 'pdf', path: '/p', size: 1 }] }),
        turn('pending question'),
      ],
    };
    const all = conversationHistory(conversation, 10_000);
    expect(all.indexOf('first question')).toBeLessThan(all.indexOf('second question'));
    expect(all).toContain('### Answer (Codex agreed)\nfirst answer');
    expect(all).toContain('Attached: spec.pdf');
    // A turn that has not been answered yet is not history.
    expect(all).not.toContain('pending question');
    const recent = conversationHistory(conversation, 120);
    expect(recent).toContain('second question');
    expect(recent).not.toContain('first question');
  });
});

describe('turns a session missed', () => {
  it('starts new sessions from a retried message on', () => {
    const conversation = {
      ...newConversation('/repo'),
      turns: [turn('a', { sessions: { claude: 'one' } }), turn('b', { freshSessions: true }), turn('c', { sessions: { codex: 'x' } })],
    };
    expect(continuedSessions(conversation)).toEqual({ codex: 'x' });
  });

  it("gives a continued session the turns answered without it, and nothing when it saw them all", () => {
    const conversation = {
      ...newConversation('/repo'),
      turns: [
        turn('first', { sessions: { claude: 'c1' }, answer: 'One' }),
        turn('second', { answer: 'Two, by Codex alone' }),
        turn('third', { sessions: { codex: 'x' }, answer: 'Three' }),
      ],
    };
    const missed = missedTurns(conversation, { claude: 'c1' }, 10_000);
    expect(missed.claude).toContain('Two, by Codex alone');
    expect(missed.claude).toContain('Three');
    expect(missed.claude).not.toContain('One');
    expect(missedTurns({ ...conversation, turns: conversation.turns.slice(0, 1) }, { claude: 'c1' }, 10_000)).toEqual({});
  });

  it("records the answer of the stage in Claude's role when Codex gave it alone", () => {
    const solo = chatRun([stage('claude-answer', 'codex', 'Codex alone'), stage('codex-check', 'codex', 'ok', { review: true })]);
    solo.stages[0] = { ...stage('claude-answer', 'claude', 'Codex alone'), assignedAgent: 'codex' };
    const record = turn('q');
    recordRun(record, solo);
    expect(record.answer).toBe('Codex alone');
  });
});

describe('FileConversationStore', () => {
  it('saves each conversation in its own file and lists them newest first', async () => {
    const store = new FileConversationStore(await temporaryDirectory('conversations'));
    const older = newConversation('/repo');
    const newer = newConversation('/repo');
    await store.save(older);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save({ ...newer, title: 'Paging' });
    expect((await store.list()).map((item) => item.title)).toEqual(['Paging', 'New conversation']);
    expect((await store.get(older.id))?.id).toBe(older.id);
    await store.delete(older.id);
    expect(await store.get(older.id)).toBeUndefined();
  });

  it('sets unreadable files aside and refuses IDs that could escape the folder', async () => {
    const root = await temporaryDirectory('conversations');
    const store = new FileConversationStore(root);
    await store.save(newConversation('/repo'));
    await writeFile(path.join(root, 'conversations', 'broken.json'), '{not json');
    expect(await store.list()).toHaveLength(1);
    expect((await readdir(path.join(root, 'conversations'))).some((name) => name.startsWith('broken.json.unreadable-'))).toBe(true);
    await expect(store.delete('../runs')).rejects.toThrow('Invalid conversation ID');
  });

  it('prunes the oldest conversations except those it is told to keep', async () => {
    const store = new FileConversationStore(await temporaryDirectory('conversations'));
    const conversations = [newConversation('/a'), newConversation('/b'), newConversation('/c')];
    for (const conversation of conversations) {
      await store.save(conversation);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const removed = await store.prune(1, (conversation) => conversation.workspacePath === '/a');
    expect(removed.map((item) => item.workspacePath)).toEqual(['/b']);
    expect((await store.list()).map((item) => item.workspacePath).sort()).toEqual(['/a', '/c']);
  });

  it('deletes every conversation at once', async () => {
    const store = new FileConversationStore(await temporaryDirectory('conversations'));
    await store.save(newConversation('/a'));
    await store.save(newConversation('/b'));
    await store.clear();
    expect(await store.list()).toEqual([]);
    await store.save(newConversation('/c'));
    expect(await store.list()).toHaveLength(1);
  });
});

describe('Codex model catalog', () => {
  const catalog = {
    models: [
      { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, 'high'] },
      { slug: 'internal-review', display_name: 'Internal', visibility: 'hide', supported_reasoning_levels: ['low'] },
      { slug: '--flag-like', visibility: 'list' },
      { slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'BAD LEVEL' }], base_instructions: 'x'.repeat(100_000) },
    ],
  };

  it('keeps listed models with valid names and efforts', () => {
    expect(parseCodexCatalog(JSON.stringify(catalog))).toEqual([
      { id: 'gpt-6-sol', name: 'GPT-6-Sol', efforts: ['low', 'ultra', 'high'], defaultEffort: 'medium' },
      // Without usable levels, the general list is offered.
      { id: 'gpt-6-luna', name: 'gpt-6-luna', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    ]);
    expect(parseCodexCatalog('not json')).toEqual([]);
    expect(parseCodexCatalog('{"models": 3}')).toEqual([]);
  });

  it('reads the catalog from the Codex CLI, even when it is far larger than ordinary output', { timeout: 20_000 }, async () => {
    const bin = await temporaryDirectory('codex-models');
    const script = `if (process.argv.slice(2).join(' ') !== 'debug models') process.exit(2);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(catalog, null, 2))});`;
    const command = await writeFakeCli(bin, 'fakecodex', script);
    const models = await listCodexModels({ command, timeoutMs: 10_000, billingMode: 'subscription' });
    expect(models.map((model) => model.id)).toEqual(['gpt-6-sol', 'gpt-6-luna']);
    const failing = await writeFakeCli(bin, 'brokencodex', 'process.exit(1);');
    expect(await listCodexModels({ command: failing, timeoutMs: 10_000, billingMode: 'subscription' })).toEqual([]);
  });
});
