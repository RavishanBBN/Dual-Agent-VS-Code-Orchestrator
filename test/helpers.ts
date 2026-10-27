import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

const directories: string[] = [];

export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `dual-agent-${prefix}-`));
  directories.push(directory);
  return directory;
}

export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

/** The file name a launcher for `name` gets on this platform. */
export function launcherName(name: string): string {
  return isWindows ? `${name}.cmd` : name;
}

/**
 * Writes `<name>.js` and a launcher that runs it with this Node.js binary: a `.cmd` shim on Windows (the
 * same shape npm installs for the real CLIs) and an executable shell script elsewhere.
 */
export async function writeFakeCli(directory: string, name: string, script: string): Promise<string> {
  const scriptPath = path.join(directory, `${name}.js`);
  const launcher = path.join(directory, launcherName(name));
  await writeFile(scriptPath, script, 'utf8');
  if (isWindows) {
    await writeFile(launcher, `@"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
    await chmod(launcher, 0o755);
  }
  return launcher;
}

export const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
