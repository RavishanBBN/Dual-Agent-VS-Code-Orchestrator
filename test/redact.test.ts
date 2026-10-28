import { describe, expect, it } from 'vitest';

import { buildStagePrompt } from '../src/core/context.js';
import { redactSecrets } from '../src/core/redact.js';
import type { GitSnapshot, RunRecord, StageRecord } from '../src/core/types.js';
import { totalUsageByAgent } from '../src/core/usage.js';

// Sample credentials are assembled at run time, so no credential-shaped literal is committed.
const join = (...parts: string[]): string => parts.join('');
const samples = {
  github: join('gh', 'p_', 'A1b2C3d4'.repeat(5)),
  aws: join('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  anthropic: join('sk-', 'ant-', 'api03-', 'x'.repeat(40)),
  openai: join('sk-', 'proj-', 'Ab3'.repeat(16)),
  slack: join('xo', 'xb-', '1234567890-abcdefghij'),
  google: join('AI', 'za', 'B'.repeat(35)),
  stripe: join('sk', '_live_', '9'.repeat(24)),
  npm: join('np', 'm_', 'c'.repeat(36)),
  jwt: join('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcDEF123456ghi'),
  key: join('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow\n-----END ', 'RSA PRIVATE KEY-----'),
};

describe('secret masking', () => {
  it('masks each supported credential format and counts what it masked', () => {
    const text = Object.entries(samples)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n');
    const { text: masked, count } = redactSecrets(text);
    expect(count).toBe(Object.keys(samples).length);
    for (const value of Object.values(samples)) expect(masked).not.toContain(value);
    expect(masked).toContain('github=[redacted GitHub token]');
    expect(masked).toContain('aws=[redacted AWS access key]');
    expect(masked).toContain('anthropic=[redacted Anthropic API key]');
    expect(masked).toContain('openai=[redacted OpenAI API key]');
    expect(masked).toContain('key=[redacted private key]');
  });

  it('leaves ordinary code alone', () => {
    const code = 'const sk = "sk-short"; const akia = "AKIA"; const name = "github_pat"; token = process.env.TOKEN;';
    expect(redactSecrets(code)).toEqual({ text: code, count: 0 });
  });

  it('masks credentials in everything a prompt quotes, unless turned off', () => {
    const stage: StageRecord = {
      id: 'claude-answer',
      title: 'Claude answers',
      agent: 'claude',
      assignedAgent: 'claude',
      permission: 'read-only',
      purpose: '',
      instructions: '',
      status: 'running',
    };
    const run: RunRecord = {
      schemaVersion: 1,
      id: 'r',
      kind: 'chat',
      objective: 'Why does the deploy fail?',
      workspacePath: '/w',
      status: 'running',
      allowWrites: false,
      createdAt: '',
      updatedAt: '',
      stages: [stage],
      usage: totalUsageByAgent(),
      history: `### User (chat)\nearlier\n\n### Answer\nUse ${samples.github}`,
    };
    const snapshot: GitSnapshot = {
      available: true,
      status: ' M .env.example',
      diffStat: '',
      diff: `+AWS_KEY=${samples.aws}`,
      untracked: [],
      warnings: [],
    };
    const masked = buildStagePrompt(run, stage, snapshot, 50_000);
    expect(masked).not.toContain(samples.aws);
    expect(masked).not.toContain(samples.github);
    expect(masked).toContain('[redacted AWS access key]');
    const raw = buildStagePrompt(run, stage, snapshot, 50_000, { redact: false });
    expect(raw).toContain(samples.aws);
  });
});
