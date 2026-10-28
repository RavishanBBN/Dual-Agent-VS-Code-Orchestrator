import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface LockEntry {
  version?: string;
  resolved?: string;
}

describe('package-lock.json', () => {
  // A version label that disagrees with its tarball breaks `npm audit signatures`, which looks the label up in
  // the registry. Replacing the extension's version across the lockfile once mislabelled two dependencies.
  it("labels every package with the version of the tarball it resolves to", () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { version: string; packages: Record<string, LockEntry> };
    const mislabelled = Object.entries(lock.packages)
      .filter(([key, entry]) => key && entry.resolved && entry.version)
      .map(([key, entry]) => ({ key, label: entry.version, tarball: /\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(entry.resolved ?? '')?.[1] }))
      .filter((entry) => entry.tarball !== undefined && entry.tarball !== entry.label);
    expect(mislabelled).toEqual([]);
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(lock.version).toBe(manifest.version);
  });
});
