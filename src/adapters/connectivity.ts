/**
 * Whether the machine can reach the providers, to tell a lost connection from one provider's outage. It only
 * opens a TCP connection and closes it again: no request is sent, and the hosts are the ones the CLIs use.
 */
import net from 'node:net';

export interface Target {
  host: string;
  port: number;
}

/** Anthropic's and OpenAI's API hosts, which Claude Code and Codex connect to. */
const PROVIDERS: readonly Target[] = [
  { host: 'api.anthropic.com', port: 443 },
  { host: 'chatgpt.com', port: 443 },
  { host: 'api.openai.com', port: 443 },
];
const TIMEOUT_MS = 4_000;

function connects(target: Target, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** True as soon as one target accepts a connection; false when none does within the timeout. */
export async function reachable(targets: readonly Target[], timeoutMs = TIMEOUT_MS): Promise<boolean> {
  if (!targets.length) return true;
  return new Promise((resolve) => {
    let pending = targets.length;
    for (const target of targets) {
      void connects(target, timeoutMs).then((ok) => {
        pending -= 1;
        if (ok) resolve(true);
        else if (pending === 0) resolve(false);
      });
    }
  });
}

/**
 * Behind a proxy the providers are reached through it, so the proxy is what must be reachable; a direct
 * connection could fail there even while the CLIs work.
 */
export function probeTargets(environment: NodeJS.ProcessEnv = process.env): Target[] {
  const proxy = environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.ALL_PROXY ?? environment.all_proxy ?? environment.HTTP_PROXY ?? environment.http_proxy;
  if (proxy) {
    try {
      const url = new URL(proxy);
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      if (url.hostname) return [{ host: url.hostname, port }];
    } catch {
      // A proxy setting that is not a URL is the CLIs' concern; the providers are tried directly.
    }
  }
  return [...PROVIDERS];
}

export function isOnline(environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return reachable(probeTargets(environment));
}
