import type { FindingSeverity, ReviewFinding, ReviewVerdict } from './types.js';

const SEVERITIES: readonly FindingSeverity[] = ['blocker', 'high', 'medium', 'low'];
const MAX_FINDINGS = 50;
const MAX_TEXT = 300;

/** Matches fenced blocks whose info string is `verdict`. */
const VERDICT_BLOCK = /```verdict[^\S\r\n]*\r?\n([\s\S]*?)```/g;
/** A plain final line such as `VERDICT: PASS`, accepted when no block is present. */
const VERDICT_LINE = /^\s*\**verdict\**\s*:\s*\**\s*(pass|fail)\b/gim;

/** The instructions that make a review stage's verdict machine-readable. */
export const VERDICT_INSTRUCTIONS = [
  '### Required verdict',
  'End your response with a fenced code block whose info string is `verdict`, containing only JSON in this form:',
  '```verdict',
  '{"verdict": "fail", "findings": [{"severity": "high", "title": "Short description", "location": "path/to/file.ts:42"}]}',
  '```',
  'Use "pass" only when no blocker or high-severity issue remains. Otherwise use "fail" and list each material finding; severity is one of "blocker", "high", "medium", "low". Write the block once, after your review.',
].join('\n');

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\r\n]+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

function finding(value: unknown): ReviewFinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const title = text(entry.title) ?? text(entry.summary);
  if (!title) return undefined;
  const raw = typeof entry.severity === 'string' ? entry.severity.toLowerCase() : '';
  const severity = SEVERITIES.find((candidate) => candidate === raw) ?? 'medium';
  const location = text(entry.location);
  return { severity, title, ...(location ? { location } : {}) };
}

function fromJson(source: string): ReviewVerdict | undefined {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const object = value as Record<string, unknown>;
  const verdict = typeof object.verdict === 'string' ? object.verdict.toLowerCase() : '';
  if (verdict !== 'pass' && verdict !== 'fail') return undefined;
  const findings = Array.isArray(object.findings)
    ? object.findings.slice(0, MAX_FINDINGS).map(finding).filter((item): item is ReviewFinding => item !== undefined)
    : [];
  return { outcome: verdict, findings };
}

/**
 * Reads the reviewer's verdict from the last `verdict` block, falling back to a final `VERDICT:` line.
 * The last occurrence is used because earlier ones may be quotations of repository content. The verdict
 * decides only whether a fix round runs and how the run is labelled; it never grants permissions.
 */
export function parseVerdict(output: string): ReviewVerdict {
  const blocks = [...output.matchAll(VERDICT_BLOCK)];
  const last = blocks.at(-1)?.[1];
  if (last !== undefined) return fromJson(last.trim()) ?? { outcome: 'missing', findings: [] };
  const line = [...output.matchAll(VERDICT_LINE)].at(-1)?.[1]?.toLowerCase();
  if (line === 'pass' || line === 'fail') return { outcome: line, findings: [] };
  return { outcome: 'missing', findings: [] };
}

/** Counts findings by severity, most severe first, for compact display. */
export function summarizeVerdict(verdict: ReviewVerdict): string {
  if (verdict.outcome === 'missing') return 'no verdict';
  if (!verdict.findings.length) return verdict.outcome;
  const counts = SEVERITIES.map((severity) => [severity, verdict.findings.filter((item) => item.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);
  return `${verdict.outcome}: ${counts.join(', ')}`;
}

/** A failing verdict whose findings are all low severity: notes worth showing, not worth another agent call. */
export function onlyMinorFindings(verdict: ReviewVerdict): boolean {
  return verdict.outcome === 'fail' && verdict.findings.length > 0 && verdict.findings.every((finding) => finding.severity === 'low');
}
