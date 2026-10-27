import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** Spawn options that let terminateProcessTree reach every descendant of the child. */
export function processTreeSpawnOptions(): { detached: boolean } {
  // On POSIX a detached child leads its own process group, so one signal reaches the whole group.
  return { detached: !isWindows };
}

/**
 * Terminates a child and its descendants.
 *
 * `child.kill()` alone is not enough: on Windows an npm `.cmd` shim runs inside `cmd.exe`, and killing
 * `cmd.exe` leaves the real agent running and still editing files.
 */
export function terminateProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (isWindows) {
    // Console programs ignore taskkill's graceful mode, so the tree is always force-terminated.
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => child.kill(signal));
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}
