/**
 * A word-level difference between two answers, for the view that compares Claude's first answer with its
 * revision. Pure, so it is unit-tested and can run in the webview.
 */

export interface DiffSegment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Longer texts are compared line by line, which stays fast. */
const WORD_LIMIT = 2_000;

function tokens(text: string, byLine: boolean): string[] {
  return byLine ? text.split(/(?<=\n)/) : text.split(/(\s+)/).filter((token) => token.length > 0);
}

export function diffText(before: string, after: string): DiffSegment[] {
  const byLine = before.length + after.length > WORD_LIMIT * 12;
  const a = tokens(before, byLine);
  const b = tokens(after, byLine);
  // Longest common subsequence over tokens, filled from the end so the walk below goes forward.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }
  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], text: string): void => {
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i] ?? '');
      i += 1;
      j += 1;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      push('removed', a[i] ?? '');
      i += 1;
    } else {
      push('added', b[j] ?? '');
      j += 1;
    }
  }
  while (i < a.length) push('removed', a[i++] ?? '');
  while (j < b.length) push('added', b[j++] ?? '');
  return segments;
}
