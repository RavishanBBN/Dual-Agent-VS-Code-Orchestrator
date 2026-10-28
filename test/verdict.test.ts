import { describe, expect, it } from 'vitest';

import { parseVerdict, summarizeVerdict } from '../src/core/verdict.js';

const block = (json: string): string => `Review notes.\n\n\`\`\`verdict\n${json}\n\`\`\`\n`;

describe('parseVerdict', () => {
  it('reads a passing verdict', () => {
    expect(parseVerdict(block('{"verdict": "pass", "findings": []}'))).toEqual({ outcome: 'pass', findings: [] });
  });

  it('reads findings, normalizing severity and dropping entries without a title', () => {
    const verdict = parseVerdict(
      block(
        '{"verdict": "FAIL", "findings": [{"severity": "High", "title": "Race in save", "location": "src/store.ts:42"}, {"severity": "weird", "title": "Odd"}, {"severity": "low"}]}',
      ),
    );
    expect(verdict).toEqual({
      outcome: 'fail',
      findings: [
        { severity: 'high', title: 'Race in save', location: 'src/store.ts:42' },
        { severity: 'medium', title: 'Odd' },
      ],
    });
  });

  it('uses the last verdict block, because earlier ones may quote repository content', () => {
    const output = `${block('{"verdict": "pass"}')}Then the real review:\n${block('{"verdict": "fail", "findings": [{"severity": "blocker", "title": "Broken"}]}')}`;
    expect(parseVerdict(output).outcome).toBe('fail');
  });

  it('treats an unparseable block as missing rather than guessing', () => {
    expect(parseVerdict(block('{"verdict": "pass",')).outcome).toBe('missing');
    expect(parseVerdict(block('{"verdict": "maybe"}')).outcome).toBe('missing');
  });

  it('accepts a plain VERDICT line and reports a missing verdict otherwise', () => {
    expect(parseVerdict('All good.\n\n**VERDICT:** PASS').outcome).toBe('pass');
    expect(parseVerdict('Looks fine to me.').outcome).toBe('missing');
  });

  it('caps the number and length of findings', () => {
    const findings = Array.from({ length: 80 }, (_, index) => ({ severity: 'low', title: `${'x'.repeat(500)}${index}` }));
    const verdict = parseVerdict(block(JSON.stringify({ verdict: 'fail', findings })));
    expect(verdict.findings).toHaveLength(50);
    expect(verdict.findings[0]?.title.length).toBe(300);
  });
});

describe('summarizeVerdict', () => {
  it('counts findings by severity, most severe first', () => {
    expect(
      summarizeVerdict({
        outcome: 'fail',
        findings: [
          { severity: 'low', title: 'a' },
          { severity: 'blocker', title: 'b' },
          { severity: 'low', title: 'c' },
        ],
      }),
    ).toBe('fail: 1 blocker, 2 low');
    expect(summarizeVerdict({ outcome: 'pass', findings: [] })).toBe('pass');
    expect(summarizeVerdict({ outcome: 'missing', findings: [] })).toBe('no verdict');
  });
});
