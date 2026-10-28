/**
 * Splits a command an agent suggested into arguments, so the extension can run it without a shell. Quotes
 * group words; anything that only a shell understands (pipes, redirection, chaining, substitution,
 * variables) is refused rather than run differently than it reads. Such a command can still be pasted into a
 * terminal, where the user runs it themselves.
 */

export type SplitCommand = { argv: string[] } | { error: string };

/** Shell syntax starting at the current position: operators, substitution, and POSIX or Windows variables. */
const SHELL_ONLY = /^(?:[|&;<>`]|\$\(|\$\{|\$[A-Za-z_]|%[A-Za-z_]+%)/;

export function splitCommandLine(input: string): SplitCommand {
  // A leading prompt such as "$ " or "> " is part of how the command was shown, not of the command.
  const line = input.trim().replace(/^(?:\$|>|PS [^>]*>)\s+/, '');
  if (!line) return { error: 'There is no command to run.' };
  if (/[\r\n]/.test(line)) return { error: 'Several lines need a shell. Paste them into a terminal instead.' };
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === '\\' && quote === '"' && (line[index + 1] === '"' || line[index + 1] === '\\')) current += line[++index] ?? '';
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    // Outside quotes, shell syntax would change what runs.
    if (SHELL_ONLY.test(line.slice(index))) return { error: 'This command uses shell syntax such as pipes or variables. Paste it into a terminal instead.' };
    current += character;
    started = true;
  }
  if (quote) return { error: 'A quote is not closed.' };
  if (started) argv.push(current);
  return argv.length ? { argv } : { error: 'There is no command to run.' };
}
