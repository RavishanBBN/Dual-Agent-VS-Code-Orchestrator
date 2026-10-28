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

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = (token?.info ?? '').trim().split(/\s+/)[0] ?? '';
  const code = markdown.utils.escapeHtml(token?.content ?? '');
  return `<div class="code-block"><div class="code-header"><span>${markdown.utils.escapeHtml(language)}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code>${code}</code></pre></div>`;
};

/** The verdict block is machine-readable; the chat shows it as a badge instead. */
const VERDICT_BLOCK = /```verdict[^\S\r\n]*\r?\n[\s\S]*?```/g;

export function renderMarkdown(text: string): string {
  return markdown.render(text.replace(VERDICT_BLOCK, '').trim());
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
