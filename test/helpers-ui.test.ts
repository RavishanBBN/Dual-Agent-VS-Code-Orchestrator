import { describe, expect, it } from 'vitest';

import { parseSources, stripSourcesBlock, toBibtex, toRis } from '../src/core/citations.js';
import { splitCommandLine } from '../src/core/commandLine.js';
import { matchSlash, parseSlash } from '../src/ui/chat/slash.js';
import { diffText } from '../src/ui/chat/textDiff.js';

const answer = [
  'Caching helps [1].',
  '',
  '```sources',
  JSON.stringify([
    { title: 'Learned Caching for Search', authors: ['Ada Lovelace', 'Alan Turing'], year: 2024, venue: 'SIGIR', doi: 'https://doi.org/10.1145/1234.5678', url: 'https://example.org/paper' },
    { title: 'A Preprint & Its {Braces}', authors: 'Grace Hopper', year: 'circa 2025', url: 'javascript:alert(1)' },
    { authors: ['No Title'] },
  ]),
  '```',
].join('\n');

describe('research citations', () => {
  it('reads the sources block, keeping only well-formed fields', () => {
    expect(parseSources(answer)).toEqual([
      { title: 'Learned Caching for Search', authors: ['Ada Lovelace', 'Alan Turing'], year: '2024', venue: 'SIGIR', doi: '10.1145/1234.5678', url: 'https://example.org/paper' },
      { title: 'A Preprint & Its {Braces}', authors: ['Grace Hopper'], year: '2025' },
    ]);
    expect(stripSourcesBlock(answer)).toBe('Caching helps [1].');
    expect(parseSources('no block')).toEqual([]);
    expect(parseSources('```sources\nnot json\n```')).toEqual([]);
  });

  it('writes BibTeX with unique keys and escaped special characters, and RIS', () => {
    const sources = parseSources(answer);
    const bib = toBibtex(sources);
    expect(bib).toContain('@article{lovelace2024learned,');
    expect(bib).toContain('author = {Ada Lovelace and Alan Turing}');
    expect(bib).toContain('doi = {10.1145/1234.5678}');
    expect(bib).toContain('title = {A Preprint \\& Its Braces}');
    expect(bib).toContain('@misc{hopper2025preprint,');
    const ris = toRis(sources);
    expect(ris).toContain('TY  - JOUR\r\nTI  - Learned Caching for Search\r\nAU  - Ada Lovelace\r\nAU  - Alan Turing\r\nPY  - 2024');
    expect(ris).toContain('DO  - 10.1145/1234.5678');
    expect(ris.match(/ER {2}- /g)).toHaveLength(2);
  });
});

describe('splitting a suggested command', () => {
  it('splits quoted arguments and drops a shown prompt', () => {
    expect(splitCommandLine('$ npm install -g @google/gemini-cli')).toEqual({ argv: ['npm', 'install', '-g', '@google/gemini-cli'] });
    expect(splitCommandLine('git commit -m "fix: the \\"retry\\" bound"')).toEqual({ argv: ['git', 'commit', '-m', 'fix: the "retry" bound'] });
    expect(splitCommandLine("echo 'a | b'")).toEqual({ argv: ['echo', 'a | b'] });
    expect(splitCommandLine('PS C:\\work> gemini --version')).toEqual({ argv: ['gemini', '--version'] });
  });

  it('refuses shell syntax rather than run something different from what it says', () => {
    for (const line of ['ls | wc -l', 'npm test && npm run build', 'echo $HOME', 'cat < a.txt', 'rm -rf $(pwd)', 'echo %PATH%', 'a\nb', '"unclosed', '   ']) {
      expect('error' in splitCommandLine(line), line).toBe(true);
    }
  });

  it('refuses a command that starts a shell, even with its shell syntax in quotes', () => {
    for (const line of [
      'cmd /d /c "echo %PATH%"',
      'cmd.exe /c dir',
      'C:\\Windows\\System32\\cmd.exe /c dir',
      'powershell -Command "Get-ChildItem env:"',
      'pwsh.exe -c "Remove-Item -Recurse ~"',
      'bash -c "ls | wc -l"',
      "sh -c 'rm -rf ~'",
      '/bin/zsh -c "echo $HOME"',
      'wsl ls',
    ]) {
      const result = splitCommandLine(line);
      expect('error' in result ? result.error : `accepted as ${JSON.stringify(result.argv)}`, line).toMatch(/starts a shell|runs code/);
    }
  });

  it('refuses inline code for an interpreter, and programs that start other programs', () => {
    for (const line of [
      'node -e "require(\'fs\').rmSync(\'x\')"',
      'node --eval "process.exit(1)"',
      'node -p "process.env"',
      'python -c "import os"',
      'python3 -c "print(1)"',
      'py -c "print(1)"',
      'perl -e "unlink q(x)"',
      'ruby -e "puts 1"',
      'php -r "echo 1;"',
      'sudo ls',
      'env bash',
      'xargs rm',
      'start notepad',
      'runas /user:admin cmd',
      // Forms a first version of this check missed, each of which runs code.
      'node -pe "1+1"',
      'python -Bc "import os"',
      'perl -ne "print"',
      'python3.12 -c "import os"',
      'node --eval="process.exit()"',
      'npx -c "echo $HOME"',
      'npm exec -c "rm -rf x"',
      'pnpm -c exec "echo hi"',
      'forfiles /c "cmd /c del x"',
    ]) {
      expect('error' in splitCommandLine(line), line).toBe(true);
    }
  });

  it('still runs ordinary programs and scripts from the project', () => {
    expect(splitCommandLine('node scripts/build.mjs')).toEqual({ argv: ['node', 'scripts/build.mjs'] });
    expect(splitCommandLine('python -m pytest -q')).toEqual({ argv: ['python', '-m', 'pytest', '-q'] });
    expect(splitCommandLine('npx vitest run')).toEqual({ argv: ['npx', 'vitest', 'run'] });
    expect(splitCommandLine('git log --format="%h | %s"')).toEqual({ argv: ['git', 'log', '--format=%h | %s'] });
    expect(splitCommandLine('bashful lint')).toEqual({ argv: ['bashful', 'lint'] });
    expect(splitCommandLine('python3 tools/check.py --count 3')).toEqual({ argv: ['python3', 'tools/check.py', '--count', '3'] });
    expect(splitCommandLine('node -r ts-node/register src/main.ts')).toEqual({ argv: ['node', '-r', 'ts-node/register', 'src/main.ts'] });
    expect(splitCommandLine('npm install -g @google/gemini-cli')).toEqual({ argv: ['npm', 'install', '-g', '@google/gemini-cli'] });
    expect(splitCommandLine('node --version')).toEqual({ argv: ['node', '--version'] });
  });
});

describe('slash commands', () => {
  it('switches mode for one message, and sets agents, models, effort, and web', () => {
    expect(parseSlash('/research gaps in retrieval caching')).toEqual({ kind: 'mode', mode: 'research', text: 'gaps in retrieval caching' });
    expect(parseSlash('/agent install gemini cli')).toEqual({ kind: 'mode', mode: 'agent', text: 'install gemini cli' });
    expect(parseSlash('/test the parser rejects empty input')).toMatchObject({ mode: 'tdd' });
    expect(parseSlash('/agents codex+claude')).toEqual({ kind: 'agents', agents: 'codex-claude' });
    expect(parseSlash('/model claude opus')).toEqual({ kind: 'options', agent: 'claude', model: 'opus' });
    expect(parseSlash('/effort codex default')).toEqual({ kind: 'options', agent: 'codex', effort: '' });
    expect(parseSlash('/web on')).toEqual({ kind: 'web', enabled: true });
    expect(parseSlash('/export')).toEqual({ kind: 'feature', feature: 'export' });
    expect(parseSlash('just a message')).toBeUndefined();
    expect(parseSlash('/edit')).toMatchObject({ kind: 'error' });
    expect(parseSlash('/frobnicate')).toMatchObject({ kind: 'error' });
  });

  it('lists matching commands for the menu', () => {
    expect(matchSlash('/re').map((command) => command.name)).toEqual(['research']);
    expect(matchSlash('/').length).toBeGreaterThan(10);
    expect(matchSlash('/research now')).toEqual([]);
  });
});

describe('comparing two answers', () => {
  it('marks words removed from and added to the first answer', () => {
    expect(diffText('The loop stops at maxAttempts - 1.', 'The loop stops at maxAttempts.')).toEqual([
      { kind: 'same', text: 'The loop stops at ' },
      { kind: 'removed', text: 'maxAttempts - 1.' },
      { kind: 'added', text: 'maxAttempts.' },
    ]);
    expect(diffText('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
    expect(diffText('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
  });
});
