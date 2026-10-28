/**
 * How an Agent-mode permission request is shown to the user: what the agent wants to do in plain words, the
 * exact command or edit, and a warning for what deserves a second look. Pure, so it is unit-tested.
 */
import path from 'node:path';

export interface PermissionView {
  id: string;
  /** The tool as Claude names it, such as Bash or Edit. */
  tool: string;
  /** What the agent wants to do, such as "run a command" or "edit src/app.ts". */
  summary: string;
  /** The exact command, the edit, or the input, trimmed. */
  detail: string;
  warnings: string[];
}

const DETAIL_LIMIT = 4_000;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
}

function trim(value: string): string {
  return value.length <= DETAIL_LIMIT ? value : `${value.slice(0, DETAIL_LIMIT)}\n… (${value.length - DETAIL_LIMIT} more characters)`;
}

function lines(value: string, prefix: string, limit = 12): string {
  const all = value.split(/\r?\n/);
  const shown = all.slice(0, limit).map((line) => `${prefix}${line}`);
  if (all.length > limit) shown.push(`${prefix}… (${all.length - limit} more lines)`);
  return shown.join('\n');
}

/** A path relative to the folder, or the absolute path with a warning when it is outside the folder. */
function place(file: string, folder: string, warnings: string[]): string {
  if (!file) return 'a file';
  const absolute = path.resolve(folder, file);
  const relative = path.relative(folder, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    warnings.push('This is outside the folder, so Undo cannot put it back.');
    return absolute;
  }
  return relative.split(path.sep).join('/');
}

const DELETES = /\b(?:rm\s+-[a-z]*[rf]|rmdir|del\s|erase\s|Remove-Item|rd\s+\/s|format\s|mkfs|git\s+(?:clean|reset\s+--hard|push\s+(?:-f|--force)))/i;
const ELEVATES = /\b(?:sudo|runas|Start-Process\b[^\n]*-Verb\s+RunAs|doas)\b/i;
const PIPES_TO_SHELL = /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sh|bash|zsh|iex|Invoke-Expression|python|node)\b/i;
const OUTSIDE_EFFECTS = /\b(?:npm\s+(?:i|install)\s+(?:-g|--global)|pip\s+install|winget\s+install|choco\s+install|brew\s+install|apt(?:-get)?\s+install|setx|reg\s+add)\b/i;

export function describePermission(id: string, tool: string, input: Record<string, unknown>, folder: string): PermissionView {
  const warnings: string[] = [];
  let summary: string;
  let detail: string;
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = text(input.command);
      summary = input.description ? `run a command: ${text(input.description)}` : 'run a command';
      detail = command;
      if (DELETES.test(command)) warnings.push('This deletes or overwrites files or history.');
      if (ELEVATES.test(command)) warnings.push('This asks for administrator rights.');
      if (PIPES_TO_SHELL.test(command)) warnings.push('This runs a script downloaded from the internet.');
      if (OUTSIDE_EFFECTS.test(command)) warnings.push('This changes your system outside the folder, which Undo cannot reverse.');
      break;
    }
    case 'Write': {
      const file = place(text(input.file_path), folder, warnings);
      summary = `create or overwrite ${file}`;
      detail = lines(text(input.content), '+ ');
      break;
    }
    case 'Edit':
    case 'MultiEdit': {
      const file = place(text(input.file_path), folder, warnings);
      summary = `edit ${file}`;
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
      detail = edits.map((edit) => `${lines(text(edit.old_string), '- ', 8)}\n${lines(text(edit.new_string), '+ ', 8)}`).join('\n\n');
      break;
    }
    case 'NotebookEdit':
      summary = `edit the notebook ${place(text(input.notebook_path), folder, warnings)}`;
      detail = text(input.new_source);
      break;
    case 'WebFetch':
      summary = `fetch ${text(input.url)}`;
      detail = text(input.prompt);
      break;
    case 'WebSearch':
      summary = `search the web for "${text(input.query)}"`;
      detail = '';
      break;
    default:
      summary = `use ${tool}`;
      detail = text(input);
  }
  return { id, tool, summary, detail: trim(detail), warnings };
}
