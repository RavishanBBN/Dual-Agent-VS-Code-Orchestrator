/**
 * Splits a command an agent suggested into arguments, so the extension can run it without a shell. Quotes
 * group words; anything that only a shell understands (pipes, redirection, chaining, substitution,
 * variables) is refused rather than run differently than it reads. So is a command that starts a shell or
 * runs code given inline, because quoted text reaches that program unchecked and it would interpret it.
 * Such a command can still be pasted into a terminal, where the user runs it themselves.
 */

export type SplitCommand = { argv: string[] } | { error: string };

/** Shell syntax starting at the current position: operators, substitution, and POSIX or Windows variables. */
const SHELL_ONLY = /^(?:[|&;<>`]|\$\(|\$\{|\$[A-Za-z_]|%[A-Za-z_]+%)/;

/** Programs that interpret their arguments as shell commands, or start another program from them. */
const SHELLS = new Set(['cmd', 'command', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'wsl', 'busybox']);
const LAUNCHERS = new Set([
  'sudo', 'doas', 'runas', 'su', 'env', 'xargs', 'start', 'nohup', 'exec', 'nice', 'timeout', 'time', 'watch', 'setsid', 'stdbuf', 'script',
  'cscript', 'wscript', 'mshta', 'rundll32', 'forfiles', 'wmic', 'schtasks',
]);
/**
 * Interpreters and the options that make them run code written on the command line. A one-letter option also
 * counts inside a cluster (`-pe`, `-Bc`, `-ne`), and a long one with its value attached (`--eval=...`).
 */
const INLINE_CODE: Record<string, readonly string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  python: ['-c'],
  pythonw: ['-c'],
  py: ['-c'],
  pypy: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  osascript: ['-e'],
  // Package runners that run a command string in a shell.
  npx: ['-c', '--call'],
  npm: ['-c', '--call'],
  pnpm: ['-c', '--shell-mode'],
};

/** The program's bare name: no folder, no Windows extension, no version suffix (`python3.12`), lowercase. */
function programName(program: string): string {
  return (program.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.(?:exe|com|cmd|bat)$/, '')
    .replace(/(?<=[a-z])[\d.]+$/, '');
}

function givesOption(argument: string, option: string): boolean {
  if (argument === option || (option.startsWith('--') && argument.startsWith(`${option}=`))) return true;
  // A short option clustered with others, or with its value attached.
  const cluster = /^-([A-Za-z]+)/.exec(argument)?.[1];
  return /^-[A-Za-z]$/.test(option) && cluster !== undefined && cluster.includes(option.charAt(1));
}

function startsInterpreter(argv: readonly string[]): boolean {
  const name = programName(argv[0] ?? '');
  if (SHELLS.has(name) || LAUNCHERS.has(name)) return true;
  const options = INLINE_CODE[name];
  return options !== undefined && argv.slice(1).some((argument) => options.some((option) => givesOption(argument, option)));
}

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
  if (!argv.length) return { error: 'There is no command to run.' };
  if (startsInterpreter(argv)) {
    return { error: 'This command starts a shell or runs code given inline, which the checks here cannot see into. Paste it into a terminal instead.' };
  }
  return { argv };
}
