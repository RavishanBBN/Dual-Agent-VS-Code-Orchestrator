import { describe, expect, it } from 'vitest';

import { DUAL_AGENT_IDENTITY, isSmallTalk } from '../src/core/about.js';
import { describeOutcome } from '../src/core/conversation.js';
import { WorkflowOrchestrator } from '../src/core/orchestrator.js';
import type { AgentAdapter, AgentHealth, AgentRunRequest, AttachmentRef, GitSnapshot, RunRecord, RunStore, StageResult } from '../src/core/types.js';

describe('recognizing greetings and questions about the assistant', () => {
  it('recognizes greetings, thanks, and questions about who we are or what we can do', () => {
    for (const message of [
      'hi',
      'Hi, what are your skills?',
      'hello there!',
      'Who are you?',
      'what can you do',
      'Hey Claude and Codex, what can you help me with?',
      'thanks!',
      'Thank you so much 🙏',
      'Good morning team',
      'help',
      'How does this work?',
      'can you help me?',
    ]) {
      expect(isSmallTalk(message), message).toBe(true);
    }
  });

  it('leaves anything about a task, a file, or code to the full workflow', () => {
    for (const message of [
      'hi, can you fix the failing test in auth.ts?',
      'What does retry() do?',
      'help me write a parser',
      'what can you do about the memory leak?',
      'hello world program in python',
      'thanks, now add tests for it',
      '',
      `hi ${'what can you do '.repeat(10)}`,
    ]) {
      expect(isSmallTalk(message), message).toBe(false);
    }
  });
});

class MemoryStore implements RunStore {
  public runs: RunRecord[] = [];
  public async list(): Promise<RunRecord[]> {
    return structuredClone(this.runs);
  }
  public async latest(): Promise<RunRecord | undefined> {
    return structuredClone(this.runs[0]);
  }
  public async save(run: RunRecord): Promise<void> {
    this.runs = [structuredClone(run), ...this.runs.filter((item) => item.id !== run.id)];
  }
}

class Agent implements AgentAdapter {
  public calls: AgentRunRequest[] = [];
  public constructor(public readonly id: 'claude' | 'codex') {}
  public async doctor(): Promise<AgentHealth> {
    return { agent: this.id, available: true, detail: 'ok' };
  }
  public async run(request: AgentRunRequest): Promise<StageResult> {
    this.calls.push(request);
    const review = /- ID: codex-check/.test(request.prompt);
    return { text: review ? 'Fine.\n```verdict\n{"verdict": "pass", "findings": []}\n```' : 'We are Claude and Codex.', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, rawEventCount: 1 };
  }
}

const snapshot: GitSnapshot = { available: true, status: ' M src/a.ts', diff: '+secret plan', diffStat: '1 file changed', untracked: [], warnings: [] };

function setup() {
  const claude = new Agent('claude');
  const codex = new Agent('codex');
  const orchestrator = new WorkflowOrchestrator({ claude, codex }, new MemoryStore(), { maxContextCharacters: 20_000, fallbackOnQuota: true }, {
    captureSnapshot: async () => snapshot,
    readAttachmentText: async () => ({}),
  });
  return { claude, codex, orchestrator };
}

describe('a quick reply about the assistant', () => {
  it('answers in one Claude call from the product description, without the workspace or a check', async () => {
    const { claude, codex, orchestrator } = setup();
    const run = await orchestrator.start('chat', 'Hi, what are your skills?', process.cwd(), false);
    expect(run.status).toBe('completed');
    expect(run.stages.map((stage) => stage.id)).toEqual(['claude-intro']);
    expect(codex.calls).toHaveLength(0);
    const prompt = claude.calls[0]?.prompt ?? '';
    expect(prompt).toContain('## About Dual Agent');
    expect(prompt).toContain('Research: Claude researches on the web');
    expect(prompt).not.toContain('### Git status');
    expect(prompt).not.toContain('+secret plan');
    expect(describeOutcome(run)).toBe('Quick reply, nothing to check');
  });

  it('keeps the full checked workflow for real questions and for messages with attachments', async () => {
    const { claude, codex, orchestrator } = setup();
    const question = await orchestrator.start('chat', 'What does retry() do?', process.cwd(), false);
    expect(question.stages.map((stage) => stage.id)).toEqual(['claude-answer', 'codex-check']);
    expect(claude.calls[0]?.prompt).toContain(DUAL_AGENT_IDENTITY);
    expect(claude.calls[0]?.prompt).toContain('### Git status');
    expect(codex.calls).toHaveLength(1);

    const attachment = { id: 'a1', name: 'shot.png', kind: 'image', size: 10, path: `${process.cwd()}/shot.png` } as AttachmentRef;
    const withImage = await orchestrator.start('chat', 'hi', process.cwd(), false, { attachments: [attachment] });
    expect(withImage.stages.map((stage) => stage.id)).toEqual(['claude-answer', 'codex-check']);
  });
});
