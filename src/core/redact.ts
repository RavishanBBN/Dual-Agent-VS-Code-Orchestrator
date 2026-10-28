/**
 * Masks credentials in text the extension itself puts into prompts or logs: diffs, untracked files,
 * attachments, conversation history, check output, and agent excerpts. Only formats specific enough to
 * have almost no false positives are matched. Agents can still open files themselves; this keeps the
 * extension from pushing secrets to them.
 */

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { name: 'private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'Azure storage key', pattern: /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/g },
  { name: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

export interface Redaction {
  text: string;
  /** How many values were masked. */
  count: number;
}

export function redactSecrets(text: string): Redaction {
  let count = 0;
  let result = text;
  for (const { name, pattern } of PATTERNS) {
    result = result.replace(pattern, () => {
      count += 1;
      return `[redacted ${name}]`;
    });
  }
  return { text: result, count };
}
