/** Entry point of the permission bridge process (`dist/permissionServer.js`); the logic is in `server.ts`. */
import { askBroker, handleMessage } from './server.js';

const pipe = process.env.DUAL_AGENT_PERMISSION_PIPE ?? '';
const token = process.env.DUAL_AGENT_PERMISSION_TOKEN ?? '';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    void handleMessage(message as Parameters<typeof handleMessage>[0], (request) => askBroker(pipe, token, request)).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  }
});
// Claude Code closes standard input when the stage ends.
process.stdin.on('end', () => process.exit(0));
