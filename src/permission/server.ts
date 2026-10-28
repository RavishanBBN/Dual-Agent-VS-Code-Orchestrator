/**
 * The MCP server Claude Code starts in Agent mode, named by `--permission-prompt-tool`. For each command or
 * edit Claude does not judge read-only, Claude calls its `approve` tool; the server asks the extension's
 * permission broker over a local pipe, which asks the user, and returns the decision. It runs as its own Node
 * process with no access to VS Code, and refuses whenever it cannot reach the broker.
 */
import net from 'node:net';

export const APPROVE_TOOL = 'approve';
const PROTOCOL_VERSION = '2025-06-18';

export interface BrokerRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface BrokerDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const deny = (message: string): BrokerDecision => ({ behavior: 'deny', message });

/** Asks the broker at `pipe`, proving with `token` that the request comes from the bridge it started. */
export function askBroker(pipe: string, token: string, request: BrokerRequest): Promise<BrokerDecision> {
  return new Promise((resolve) => {
    if (!pipe || !token) {
      resolve(deny('Dual Agent cannot ask for your approval right now, so this was not run.'));
      return;
    }
    let buffer = '';
    let settled = false;
    const finish = (decision: BrokerDecision): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(decision);
    };
    const socket = net.createConnection(pipe, () => socket.write(`${JSON.stringify({ token, ...request })}\n`));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as Partial<BrokerDecision>;
        finish(reply.behavior === 'allow' ? { behavior: 'allow' } : deny(typeof reply.message === 'string' ? reply.message : 'The user declined this.'));
      } catch {
        finish(deny('Dual Agent sent an unreadable decision, so this was not run.'));
      }
    });
    socket.on('error', () => finish(deny('Dual Agent is not reachable to ask for your approval, so this was not run.')));
    socket.on('close', () => finish(deny('Dual Agent closed before you decided, so this was not run.')));
  });
}

const APPROVE_SCHEMA = {
  type: 'object',
  properties: {
    tool_name: { type: 'string' },
    input: { type: 'object' },
    tool_use_id: { type: 'string' },
  },
  required: ['tool_name', 'input'],
};

/**
 * Handles one JSON-RPC message from Claude Code and returns the response to write, or undefined for a
 * notification. `ask` reaches the user; the input is passed through unchanged when they allow it.
 */
export async function handleMessage(message: JsonRpcMessage, ask: (request: BrokerRequest) => Promise<BrokerDecision>): Promise<object | undefined> {
  if (message.id === undefined) return undefined;
  const reply = (result: unknown): object => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'dual-agent-permissions', version: '1.0.0' },
      });
    }
    case 'tools/list':
      return reply({
        tools: [{ name: APPROVE_TOOL, description: 'Asks the Dual Agent user to allow or deny a tool call.', inputSchema: APPROVE_SCHEMA }],
      });
    case 'tools/call': {
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const input = typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
      const toolName = typeof args.tool_name === 'string' ? args.tool_name : 'unknown';
      const decision = message.params?.name === APPROVE_TOOL ? await ask({ toolName, input }) : deny('Unknown tool.');
      // Claude Code reads the decision as JSON text; an allowed call runs with its input unchanged.
      const text = decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.message ?? 'The user declined this.' };
      return reply({ content: [{ type: 'text', text: JSON.stringify(text) }] });
    }
    case 'ping':
      return reply({});
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method ?? ''}` } };
  }
}
