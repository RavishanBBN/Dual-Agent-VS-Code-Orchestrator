/**
 * Slash commands typed in the composer: switching mode for one message, choosing the agents, models, effort,
 * or web access, and opening chat features. Pure, so it is unit-tested and runs in the webview.
 */
import type { AgentId, AgentSelection, WorkflowKind } from '../../core/types.js';

export interface SlashCommand {
  name: string;
  usage: string;
  hint: string;
}

export type SlashAction =
  | { kind: 'mode'; mode: WorkflowKind; text: string }
  | { kind: 'agents'; agents: AgentSelection }
  | { kind: 'options'; agent: AgentId; model?: string; effort?: string }
  | { kind: 'web'; enabled: boolean }
  | { kind: 'feature'; feature: 'new' | 'export' | 'usage' | 'brief' | 'history' | 'help' }
  | { kind: 'error'; message: string };

const MODES: Record<string, WorkflowKind> = {
  chat: 'chat',
  ask: 'chat',
  research: 'research',
  edit: 'edit',
  agent: 'agent',
  run: 'agent',
  compare: 'compare',
  both: 'compare',
  test: 'tdd',
  tdd: 'tdd',
  brainstorm: 'brainstorming',
  implement: 'implementation',
  plan: 'implementation',
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'chat', usage: '/chat <message>', hint: 'Claude answers, Codex checks the answer' },
  { name: 'research', usage: '/research <question>', hint: 'Cited web research, every source verified' },
  { name: 'agent', usage: '/agent <task>', hint: 'Run commands, install, and edit, asking you first' },
  { name: 'edit', usage: '/edit <change>', hint: 'Edit an isolated copy, reviewed by Codex' },
  { name: 'test', usage: '/test <behavior>', hint: 'Codex writes failing tests, Claude makes them pass' },
  { name: 'compare', usage: '/compare <question>', hint: 'Both answer independently, then merge' },
  { name: 'brainstorm', usage: '/brainstorm <topic>', hint: 'Five rounds of proposal and challenge' },
  { name: 'implement', usage: '/implement <objective>', hint: 'Plan, approval, implementation, and review' },
  { name: 'agents', usage: '/agents claude+codex | codex+claude | claude | codex', hint: 'Who leads, or one agent alone' },
  { name: 'model', usage: '/model <claude|codex> <name|default>', hint: 'Choose a model' },
  { name: 'effort', usage: '/effort <claude|codex> <level|default>', hint: 'Choose reasoning effort' },
  { name: 'web', usage: '/web on|off', hint: 'Let agents search and read the web' },
  { name: 'new', usage: '/new', hint: 'Start a new conversation' },
  { name: 'history', usage: '/history', hint: 'Open earlier conversations' },
  { name: 'export', usage: '/export', hint: 'Save this conversation as Markdown' },
  { name: 'usage', usage: '/usage', hint: 'Show token usage and limits' },
  { name: 'brief', usage: '/brief', hint: 'Edit the project brief both agents read' },
  { name: 'help', usage: '/help', hint: 'List these commands' },
];

const AGENT_SELECTIONS: Record<string, AgentSelection> = {
  'claude+codex': 'claude-codex',
  'claude-codex': 'claude-codex',
  both: 'claude-codex',
  'codex+claude': 'codex-claude',
  'codex-claude': 'codex-claude',
  claude: 'claude',
  codex: 'codex',
};

/** The commands whose names start with what follows the slash, for the composer's menu. */
export function matchSlash(input: string): SlashCommand[] {
  const typed = /^\/(\S*)$/.exec(input.trimStart())?.[1]?.toLowerCase();
  if (typed === undefined) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(typed));
}

/** What a message starting with a slash asks for, or undefined when it is an ordinary message. */
export function parseSlash(input: string): SlashAction | undefined {
  const match = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return undefined;
  const name = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').trim();
  const words = rest.split(/\s+/).filter(Boolean);
  const mode = MODES[name];
  if (mode) return rest ? { kind: 'mode', mode, text: rest } : { kind: 'error', message: `Type your message after /${name}.` };
  switch (name) {
    case 'agents': {
      const agents = AGENT_SELECTIONS[(words[0] ?? '').toLowerCase()];
      return agents ? { kind: 'agents', agents } : { kind: 'error', message: 'Use /agents claude+codex, codex+claude, claude, or codex.' };
    }
    case 'model':
    case 'effort': {
      const agent = (words[0] ?? '').toLowerCase();
      const value = words[1];
      if ((agent !== 'claude' && agent !== 'codex') || !value) return { kind: 'error', message: `Use /${name} claude <value> or /${name} codex <value>.` };
      const chosen = value.toLowerCase() === 'default' ? '' : value;
      return name === 'model' ? { kind: 'options', agent, model: chosen } : { kind: 'options', agent, effort: chosen };
    }
    case 'web': {
      const value = (words[0] ?? '').toLowerCase();
      return value === 'on' || value === 'off' ? { kind: 'web', enabled: value === 'on' } : { kind: 'error', message: 'Use /web on or /web off.' };
    }
    case 'new':
    case 'export':
    case 'usage':
    case 'brief':
    case 'history':
    case 'help':
      return { kind: 'feature', feature: name };
    default:
      return { kind: 'error', message: `Unknown command /${name}. Type / to see the commands.` };
  }
}
