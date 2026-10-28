import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentExecutionError } from '../src/core/errors.js';
import { isInsideDirectory, resolveExecutable } from '../src/core/executables.js';
import { isWindows, launcherName, removeTemporaryDirectories, temporaryDirectory, writeFakeCli } from './helpers.js';

afterEach(removeTemporaryDirectories);

function kindOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExecutionError);
    return (error as AgentExecutionError).kind;
  }
  throw new Error('Expected the lookup to fail.');
}

async function layout(): Promise<{ workspace: string; bin: string; environment: NodeJS.ProcessEnv }> {
  const root = await temporaryDirectory('lookup');
  const workspace = path.join(root, 'workspace');
  const bin = path.join(root, 'bin');
  await mkdir(workspace);
  await mkdir(bin);
  await writeFakeCli(workspace, 'codex', 'console.log("planted")');
  await writeFakeCli(bin, 'codex', 'console.log("real")');
  return { workspace, bin, environment: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' } };
}

describe('resolveExecutable', () => {
  it('never selects an executable from the workspace, even when it is first on PATH', async () => {
    const { workspace, bin, environment } = await layout();
    environment.PATH = [workspace, bin].join(path.delimiter);
    expect(resolveExecutable('codex', { environment, untrustedDirectories: [workspace] })).toBe(path.join(bin, launcherName('codex')));
  });

  it('ignores relative PATH entries such as "."', async () => {
    const { environment } = await layout();
    environment.PATH = ['.', 'bin'].join(path.delimiter);
    expect(kindOf(() => resolveExecutable('codex', { environment }))).toBe('unavailable');
  });

  it('refuses a configured absolute path inside the workspace', async () => {
    const { workspace, environment } = await layout();
    const planted = path.join(workspace, launcherName('codex'));
    expect(kindOf(() => resolveExecutable(planted, { environment, untrustedDirectories: [workspace] }))).toBe('invalid');
  });

  it('accepts a configured absolute path outside the workspace', async () => {
    const { workspace, bin, environment } = await layout();
    const real = path.join(bin, launcherName('codex'));
    expect(resolveExecutable(real, { environment, untrustedDirectories: [workspace] })).toBe(real);
  });

  it('rejects relative paths with a directory component', () => {
    expect(kindOf(() => resolveExecutable(`tools${path.sep}codex`))).toBe('invalid');
  });

  it('reports a missing command as unavailable', () => {
    expect(kindOf(() => resolveExecutable('definitely-not-installed-cli', { environment: { PATH: '' } }))).toBe('unavailable');
  });

  it.runIf(isWindows)('prefers a runnable shim over an extensionless POSIX script and reads Path case-insensitively', async () => {
    const { bin } = await layout();
    await writeFakeCli(bin, 'tool', '');
    await writeFile(path.join(bin, 'tool'), '#!/bin/sh\n');
    expect(resolveExecutable('tool', { environment: { Path: bin, PATHEXT: '.EXE;.CMD' } })).toBe(path.join(bin, 'tool.cmd'));
  });
});

describe('isInsideDirectory', () => {
  it('distinguishes nested paths from siblings that share a prefix', () => {
    const root = path.resolve('/work');
    expect(isInsideDirectory(path.join(root, 'a', 'b'), root)).toBe(true);
    expect(isInsideDirectory(root, root)).toBe(true);
    expect(isInsideDirectory(path.resolve('/workspace/a'), root)).toBe(false);
    expect(isInsideDirectory(path.resolve('/other'), root)).toBe(false);
  });

  // Regression: a Windows short name such as C:\Users\RUNNER~1 was expanded only for paths that existed.
  it('resolves paths that do not exist yet through their existing ancestor', async () => {
    const root = await temporaryDirectory('inside');
    const real = path.join(root, 'real');
    const outside = path.join(root, 'outside');
    await mkdir(real);
    await mkdir(outside);
    // Junctions need no special rights on Windows; elsewhere the type is ignored and a symbolic link is made.
    const linked = path.join(root, 'linked');
    await symlink(real, linked, 'junction');
    await symlink(outside, path.join(real, 'escape'), 'junction');

    expect(isInsideDirectory(path.join(linked, 'new', 'file.txt'), linked)).toBe(true);
    expect(isInsideDirectory(path.join(linked, 'new', 'file.txt'), real)).toBe(true);
    expect(isInsideDirectory(path.join(real, 'escape', 'new-file.txt'), real)).toBe(false);
  });
});
