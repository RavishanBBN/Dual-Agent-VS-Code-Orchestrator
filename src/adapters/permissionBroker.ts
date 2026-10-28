/**
 * The extension's side of Agent mode's permission bridge. Claude Code starts `dist/permissionServer.js` from
 * the MCP configuration written here; that process connects to this broker over a private local pipe, proves
 * with a random token that it is the bridge this broker started, and waits while `decide` asks the user.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { BrokerDecision, BrokerRequest } from '../permission/server.js';

export type { BrokerDecision as PermissionDecision, BrokerRequest as PermissionRequest };

/** The MCP server name and its tool, as Claude Code addresses it in `--permission-prompt-tool`. */
export const PERMISSION_SERVER = 'dualagent';
export const PERMISSION_TOOL = `mcp__${PERMISSION_SERVER}__approve`;
/** A request line longer than this is refused; a command or an edit preview is far smaller. */
const REQUEST_LIMIT = 2 * 1024 * 1024;

export interface PermissionBrokerOptions {
  /** Private storage, where the MCP configuration (which holds the token) is written. */
  storagePath: string;
  /** Absolute path of the bundled permission server. */
  serverScript: string;
  /** How to run that script; in the extension host this is VS Code's own runtime in Node mode. */
  runtime?: { command: string; env: Record<string, string> };
  decide: (request: BrokerRequest) => Promise<BrokerDecision>;
}

export class PermissionBroker {
  private server: net.Server | undefined;
  private readonly token = randomBytes(32).toString('hex');
  private readonly pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\dual-agent-permissions-${randomBytes(12).toString('hex')}`
      : path.join(os.tmpdir(), `dual-agent-${randomBytes(8).toString('hex')}.sock`);
  private configFile: string | undefined;

  public constructor(private readonly options: PermissionBrokerOptions) {}

  /** Starts listening and writes the MCP configuration; returns what the Claude adapter passes on. */
  public async start(): Promise<{ configFile: string; tool: string }> {
    const server = net.createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.pipe, () => resolve());
    });
    this.server = server;
    const runtime = this.options.runtime ?? { command: process.execPath, env: {} };
    const configuration = {
      mcpServers: {
        [PERMISSION_SERVER]: {
          type: 'stdio',
          command: runtime.command,
          args: [this.options.serverScript],
          env: { ...runtime.env, DUAL_AGENT_PERMISSION_PIPE: this.pipe, DUAL_AGENT_PERMISSION_TOKEN: this.token },
        },
      },
    };
    await mkdir(this.options.storagePath, { recursive: true });
    const configFile = path.join(this.options.storagePath, 'permission-mcp.json');
    // The file holds the token, so only the user can read it.
    await writeFile(configFile, JSON.stringify(configuration, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.configFile = configFile;
    return { configFile, tool: PERMISSION_TOOL };
  }

  private serve(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > REQUEST_LIMIT) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = '';
      void this.answer(line).then((decision) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
      });
    });
  }

  private async answer(line: string): Promise<BrokerDecision> {
    let request: Partial<BrokerRequest> & { token?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      return { behavior: 'deny', message: 'Malformed request.' };
    }
    if (typeof request.token !== 'string' || !this.tokenMatches(request.token)) return { behavior: 'deny', message: 'Unknown caller.' };
    if (typeof request.toolName !== 'string' || typeof request.input !== 'object' || request.input === null) {
      return { behavior: 'deny', message: 'Malformed request.' };
    }
    try {
      return await this.options.decide({ toolName: request.toolName, input: request.input });
    } catch (error) {
      return { behavior: 'deny', message: `Dual Agent could not ask: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private tokenMatches(token: string): boolean {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  public async dispose(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
    if (this.configFile) await rm(this.configFile, { force: true });
  }
}
