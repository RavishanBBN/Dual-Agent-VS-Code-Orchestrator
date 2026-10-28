/**
 * Renders agent Markdown for the chat. Raw HTML is escaped (html: false), images are disabled so nothing is
 * fetched, and links never navigate: they carry their target in `data-href` for the extension to check.
 */
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
markdown.disable(['image']);

/**
 * Web and mail links, and paths to files: relative, absolute, with a Windows drive, or with a line number
 * such as `math.js:12`, which would otherwise read as a URL scheme.
 */
const ALLOWED_LINK = /^(?:https?:|mailto:)|^(?![a-z][a-z0-9+.-]*:)|^[a-z]:[\\/]|^[^:\s]+\.[^:\s]+:\d+(?::\d+)?$/i;

markdown.validateLink = (url: string): boolean => ALLOWED_LINK.test(url.trim());

const renderToken = markdown.renderer.renderToken.bind(markdown.renderer);
markdown.renderer.rules.link_open = (tokens, index, options) => {
  const token = tokens[index];
  if (token) {
    const href = token.attrGet('href') ?? '';
    token.attrSet('href', '#');
    token.attrSet('data-href', href);
    token.attrSet('title', href);
  }
  return renderToken(tokens, index, options);
};

/** Code blocks in these languages are commands, which the chat offers to run or paste into a terminal. */
const SHELL_LANGUAGES = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'powershell', 'pwsh', 'ps1', 'ps', 'cmd', 'bat', 'batch']);

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = (token?.info ?? '').trim().split(/\s+/)[0] ?? '';
  const content = token?.content ?? '';
  const code = markdown.utils.escapeHtml(content);
  const shell = SHELL_LANGUAGES.has(language.toLowerCase());
  // Only a single line is offered: it runs without a shell, and pasting it into a terminal runs nothing, while a
  // pasted line break would run every line before it.
  const single = content.trim() !== '' && !content.trim().includes('\n');
  const buttons = [
    shell && single ? '<button type="button" class="copy" data-run title="Run it in the folder after you confirm; its output is attached to your next message">Run</button>' : '',
    shell && single ? '<button type="button" class="copy" data-paste title="Paste it into a terminal without running it">Terminal</button>' : '',
    '<button type="button" class="copy" data-copy>Copy</button>',
  ].join('');
  return `<div class="code-block"><div class="code-header"><span>${markdown.utils.escapeHtml(language)}</span>${buttons}</div><pre><code>${code}</code></pre></div>`;
};

// Tables get a button that saves them as CSV, such as a research-gap matrix or a claim table.
markdown.renderer.rules.table_open = () => '<div class="table-block"><div class="table-header"><button type="button" class="copy" data-csv title="Save this table as a CSV file">CSV</button></div><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

/** The verdict and sources blocks are machine-readable; the chat shows them as a badge and a sources card. */
const VERDICT_BLOCK = /```verdict[^\S\r\n]*\r?\n[\s\S]*?```/g;
const SOURCES_BLOCK = /```sources[^\S\r\n]*\r?\n[\s\S]*?```/g;

/** A table's rows as CSV, quoting cells that need it. */
export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  const cell = (value: string): string => {
    const text = value.replace(/\s+/g, ' ').trim();
    // A leading =, +, -, or @ would run as a formula in a spreadsheet, so it is kept as text; a number stays a number.
    const safe = /^[=+\-@]/.test(text) && !/^[+-]?\d[\d.,]*%?$/.test(text) ? `'${text}` : text;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

export function renderMarkdown(text: string): string {
  return markdown.render(text.replace(VERDICT_BLOCK, '').replace(SOURCES_BLOCK, '').trim());
}

interface TrustedTypePolicy {
  createHTML(input: string): unknown;
}
interface TrustedTypesWindow {
  trustedTypes?: { createPolicy(name: string, rules: { createHTML(input: string): string }): TrustedTypePolicy };
}

/**
 * The page's Content-Security-Policy requires Trusted Types and names only this policy, so the renderer above
 * is the one source of HTML on the page. Without Trusted Types (in tests) the HTML is used as it is.
 */
const policy = (globalThis as TrustedTypesWindow).trustedTypes?.createPolicy('dual-agent-markdown', { createHTML: (input) => input });

/** Rendered agent Markdown in the form the page may assign to innerHTML. */
export function trustedMarkdown(text: string): string {
  const html = renderMarkdown(text);
  return policy ? (policy.createHTML(html) as string) : html;
}

/** Whether a link target is a file path rather than a web or mail address. */
export function isFileLink(href: string): boolean {
  return !/^(?:https?:|mailto:)/i.test(href);
}
