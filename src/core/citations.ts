/**
 * The sources a research answer cites, read from its fenced `sources` block, and written as BibTeX or RIS for a
 * reference manager. The block is agent output, so every field is checked and trimmed before use.
 */

export interface Source {
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  doi?: string;
  url?: string;
}

const BLOCK = /```sources[^\S\r\n]*\r?\n([\s\S]*?)```/;
const FIELD_LIMIT = 500;
const SOURCE_LIMIT = 200;
const DOI = /^10\.\d{4,9}\/\S+$/;

const field = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim().slice(0, FIELD_LIMIT) : '');

/** The cited works in the answer's `sources` block; an absent or malformed block gives none. */
export function parseSources(text: string): Source[] {
  const body = BLOCK.exec(text)?.[1];
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const sources: Source[] = [];
  for (const entry of parsed.slice(0, SOURCE_LIMIT)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const title = field(item.title);
    if (!title) continue;
    const authors = (Array.isArray(item.authors) ? item.authors : typeof item.authors === 'string' ? item.authors.split(/;|\band\b/) : []).map(field).filter(Boolean).slice(0, 50);
    const year = /\d{4}/.exec(field(item.year))?.[0];
    const venue = field(item.venue);
    const doi = field(item.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    const url = field(item.url);
    sources.push({
      title,
      authors,
      ...(year ? { year } : {}),
      ...(venue ? { venue } : {}),
      ...(DOI.test(doi) ? { doi } : {}),
      ...(/^https?:\/\//i.test(url) ? { url } : {}),
    });
  }
  return sources;
}

/** The answer without its machine-readable `sources` block, which the chat shows as a card instead. */
export function stripSourcesBlock(text: string): string {
  return text.replace(BLOCK, '').trimEnd();
}

const bibEscape = (value: string): string => value.replace(/[\\{}]/g, '').replace(/([%&$#_])/g, '\\$1');

function citationKey(source: Source, used: Set<string>): string {
  const family = (source.authors[0] ?? 'anon').split(/[ ,]+/).filter(Boolean).at(source.authors[0]?.includes(',') ? 0 : -1) ?? 'anon';
  const word = source.title.split(/\s+/).find((part) => part.length > 3) ?? 'work';
  const base = `${family}${source.year ?? ''}${word}`.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'source';
  let key = base;
  for (let suffix = 2; used.has(key); suffix += 1) key = `${base}${suffix}`;
  used.add(key);
  return key;
}

export function toBibtex(sources: readonly Source[]): string {
  const used = new Set<string>();
  return sources
    .map((source) => {
      const fields: [string, string | undefined][] = [
        ['title', source.title],
        ['author', source.authors.join(' and ') || undefined],
        ['year', source.year],
        [source.venue ? 'journal' : 'howpublished', source.venue ?? source.url],
        ['doi', source.doi],
        ['url', source.url],
      ];
      const lines = fields.filter(([, value]) => value).map(([name, value]) => `  ${name} = {${bibEscape(value ?? '')}}`);
      return `@${source.venue ? 'article' : 'misc'}{${citationKey(source, used)},\n${lines.join(',\n')}\n}`;
    })
    .join('\n\n')
    .concat(sources.length ? '\n' : '');
}

export function toRis(sources: readonly Source[]): string {
  return sources
    .map((source) =>
      [
        `TY  - ${source.venue ? 'JOUR' : 'GEN'}`,
        `TI  - ${source.title}`,
        ...source.authors.map((author) => `AU  - ${author}`),
        ...(source.year ? [`PY  - ${source.year}`] : []),
        ...(source.venue ? [`JO  - ${source.venue}`] : []),
        ...(source.doi ? [`DO  - ${source.doi}`] : []),
        ...(source.url ? [`UR  - ${source.url}`] : []),
        'ER  - ',
      ].join('\r\n'),
    )
    .join('\r\n\r\n')
    .concat(sources.length ? '\r\n' : '');
}
