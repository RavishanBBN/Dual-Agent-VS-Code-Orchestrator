import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { AgentExecutionError } from './errors.js';

export interface ExecutableLookup {
  /** Environment whose PATH (and PATHEXT on Windows) is searched. Defaults to the extension host's. */
  environment?: NodeJS.ProcessEnv;
  /** Directories that must never supply the executable, such as the workspace being automated. */
  untrustedDirectories?: readonly string[];
}

const isWindows = process.platform === 'win32';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Reads an environment variable, ignoring case on Windows as the OS does. */
export function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!isWindows) return environment[name];
  const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : environment[key];
}

/** True for paths that do not depend on the current directory or drive. */
export function isFullyQualified(value: string): boolean {
  // path.win32.isAbsolute accepts "\dir", which is relative to the current drive.
  return isWindows ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value) : path.isAbsolute(value);
}

function canonical(target: string): string {
  let resolved = path.resolve(target);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // Keep the lexical path for locations that do not exist.
  }
  return isWindows ? resolved.toLowerCase() : resolved;
}

export function isInsideDirectory(target: string, directory: string): boolean {
  const relative = path.relative(canonical(directory), canonical(target));
  return relative === '' || !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (!isWindows) accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (!isWindows) return [command];
  const extensions = (environmentValue(environment, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.startsWith('.'));
  const own = path.extname(command).toLowerCase();
  // An extensionless name such as npm's POSIX "codex" script is not runnable on Windows.
  const literal = own && extensions.some((extension) => extension.toLowerCase() === own) ? [command] : [];
  return [...literal, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

/**
 * Resolves a configured command to an absolute executable path.
 *
 * Windows command lookup normally searches the current directory before PATH, and agents run with the
 * workspace as their current directory. A repository (or an agent that can write files) could therefore
 * plant `codex.cmd` or `git.exe` and have it run outside any sandbox. This lookup never consults the
 * current directory, skips relative PATH entries, and refuses executables inside untrusted directories.
 */
export function resolveExecutable(command: string, lookup: ExecutableLookup = {}): string {
  const environment = lookup.environment ?? process.env;
  const untrusted = lookup.untrustedDirectories ?? [];
  const trusted = (candidate: string): boolean => untrusted.every((directory) => !isInsideDirectory(candidate, directory));
  const name = command.trim();

  if (!name) throw new AgentExecutionError('No executable is configured.', 'invalid');

  if (isFullyQualified(name)) {
    for (const candidate of candidateNames(name, environment)) {
      if (!isExecutableFile(candidate)) continue;
      if (!trusted(candidate)) {
        throw new AgentExecutionError(
          `Refusing to run ${candidate} because it is inside the workspace being automated.`,
          'invalid',
        );
      }
      return candidate;
    }
    throw new AgentExecutionError(`Executable not found: ${name}`, 'unavailable');
  }

  if (/[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) {
    throw new AgentExecutionError(
      `Relative executable path "${name}" is not allowed; configure a command name on PATH or an absolute path.`,
      'invalid',
    );
  }

  for (const rawEntry of (environmentValue(environment, 'PATH') ?? '').split(path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1');
    // Relative entries such as "." resolve against the spawn directory, which is the workspace.
    if (!entry || !isFullyQualified(entry) || !trusted(entry)) continue;
    for (const candidateName of candidateNames(name, environment)) {
      const candidate = path.join(entry, candidateName);
      if (isExecutableFile(candidate) && trusted(candidate)) return candidate;
    }
  }
  throw new AgentExecutionError(`${name} was not found on PATH. Install it or configure an absolute path.`, 'unavailable');
}
