import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * Convert clipboard content into clean markdown text
 * ([RAISE-39](https://risepeople.atlassian.net/browse/RAISE-39)).
 *
 * Two clipboard slots matter on every paste — `text/plain` and
 * `text/html` — and the cleaner one depends on the source app:
 *
 *   - **Google Docs (with "Copy as markdown" enabled)**, **Notion's
 *     Copy → Markdown**, **IntelliJ's markdown plugin**, etc.: put
 *     the rendered markdown directly into `text/plain`. The
 *     accompanying `text/html` is fine but lossier.
 *   - **Word, Excel, browser pages, Slack, etc.**: put rich HTML
 *     in `text/html` and unstyled text in `text/plain`. The
 *     unstyled text has lost all structure (headings demoted to
 *     plain paragraphs, lists demoted to indented text), so the
 *     HTML is the only good source.
 *
 * The decision rule:
 *
 *   1. If `text/plain` matches at least one markdown syntax
 *      pattern → it's already markdown. Apply Google Docs
 *      cleanup (unwrap double-wrapped links, drop a few
 *      cosmetic over-escapes) and return.
 *   2. Else if `text/html` exists → run it through Turndown
 *      with GFM tables / strikethrough / task-lists.
 *   3. Else → return the plain text as-is. Caller's editor will
 *      handle it as a plain paste.
 *
 * Returns `null` for an empty clipboard.
 */

const MARKDOWN_SYNTAX_PATTERNS: readonly RegExp[] = [
  /^#{1,6} /m, // ATX heading
  /\*\*[^*\s][\s\S]*?\*\*/, // bold
  /__[^_\s][\s\S]*?__/, // alt bold
  /\*[^*\s][^*]*\*/, // italic (rough — accepts some false negatives)
  /\[[^\]]+\]\([^)]+\)/, // link
  /^\s*[-*+] /m, // unordered list
  /^\s*\d+[.\\]\.? /m, // ordered list (commonmark `1.` or Google Docs `1\.`)
  /^```/m, // fenced code (backticks)
  /^~~~/m, // fenced code (tildes)
  /^\|.*\|$/m, // table row
  /^>\s/m, // blockquote
];

/**
 * Heuristic: does this string contain at least one markdown
 * syntactic pattern? Conservative — false negatives are fine
 * (we'd then route through HTML / Turndown which still produces
 * usable output), but a false positive (treating non-markdown as
 * markdown) would blow up the paste.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  return MARKDOWN_SYNTAX_PATTERNS.some((re) => re.test(text));
}

/**
 * Clean up known Google Docs "Copy as markdown" quirks. Listed in
 * RAISE-39 description from a real-world sample:
 *
 *   1. **Double-wrapped links**: `[[X](url1)](url2)` is invalid
 *      markdown (links can't nest); reduce to `[X](url2)`. Most
 *      visible failure mode — every email link in the source
 *      mis-renders without this fix.
 *
 *   2. **Cosmetic over-escapes**: Google Docs escapes `.` after
 *      digits in headings (`### 1\. Foo`) and `#` inside table
 *      cells (`| \# |`). Both parse correctly via commonmark
 *      escape rules, but the visible `\.` / `\#` is jarring in
 *      source view, so strip the escape.
 *
 * Applied unconditionally to every "looks like markdown" paste —
 * if the source wasn't Google Docs the patterns simply don't
 * match anything.
 */
export function cleanupGoogleDocsMarkdown(text: string): string {
  if (!text) return text;
  return text
    .replace(/\[\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/g, '[$1]($3)')
    .replace(/^(\s*\d+)\\\./gm, '$1.')
    .replace(/^(#+\s+\d+)\\\./gm, '$1.')
    .replace(/\\#/g, '#');
}

/**
 * Lazy-built Turndown instance — created the first time any HTML
 * paste needs converting and re-used after that. The constructor
 * options match what Milkdown's serializer emits so a paste-then-
 * edit-then-save round-trip doesn't show diff churn from style
 * differences (`*bold*` vs `_bold_`, `*` bullets vs `-`, etc.).
 */
let turndownInstance: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;
  const td = new TurndownService({
    headingStyle: 'atx', // `# Heading` not setext
    codeBlockStyle: 'fenced', // ```lang\n...\n``` not indented
    bulletListMarker: '*',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined', // `[text](url)` not `[text][ref]`
    hr: '---',
  });
  // GFM extensions: tables, strikethrough, task-lists,
  // highlighted code blocks. Without `tables`, Word / Google Docs
  // / browser-page tables would fall back to plain-text dump and
  // lose structure.
  td.use(gfm);
  turndownInstance = td;
  return td;
}

/**
 * Convert HTML to markdown via Turndown + GFM. Trims the result
 * because Turndown sometimes emits trailing newlines that
 * compound into blank lines once inserted into an editor.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return getTurndown().turndown(html).trim();
}

/**
 * Single entry point for "give me clean markdown from this
 * clipboard". Returns null when the clipboard has no usable
 * text content.
 */
export function getMarkdownFromClipboard(cd: DataTransfer): string | null {
  const text = cd.getData('text/plain');
  const html = cd.getData('text/html');

  if (text && looksLikeMarkdown(text)) {
    return cleanupGoogleDocsMarkdown(text);
  }

  if (html) {
    try {
      const converted = htmlToMarkdown(html);
      if (converted) return converted;
    } catch {
      // Turndown failed on weird HTML — fall through.
    }
  }

  return text || null;
}
