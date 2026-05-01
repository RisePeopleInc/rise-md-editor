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

/**
 * Patterns that *strongly* indicate a `text/plain` clipboard slot is
 * already-prepared markdown (vs. unstyled text from Word / Outlook /
 * etc.). Tightened ([RAISE-39](https://risepeople.atlassian.net/browse/RAISE-39))
 * after smoke-test feedback that Word paste was losing tables — Word's
 * plain-text bullets (`* item`) and ordered lists (`1. item`) and
 * Outlook's reply quote markers (`> text`) all look superficially like
 * markdown but are actually structure-stripped dumps where the rich
 * version (text/html) carries the real formatting.
 *
 * To distinguish "I copied real markdown" from "I copied rich content
 * that happens to have bullets in plain text", require a marker that
 * wouldn't naturally appear in a Word/Outlook/etc. plain-text dump:
 *
 *   - ATX heading (`# `, `## `, ...) — Word doesn't prefix headings
 *     with `#` in plain-text export.
 *   - Fenced code (` ``` ` / `~~~`) — strong unambiguous marker.
 *   - Inline link (`[text](url)`) / image (`![alt](url)`) — explicit
 *     markdown syntax; plain-text export shows just the link text.
 *   - Bold delimiters (`**`, `__`) — plain-text export drops the
 *     bold styling entirely.
 *   - Backslash escapes (`\.`, `\#`) — Google Docs's "Copy as
 *     markdown" signature; nothing else emits these.
 *   - GFM table row (`| a | b |` with at least 3 pipes) — Word
 *     plain-text uses tabs, not pipes, for tables.
 *
 * Deliberately omitted (used to be in this list, removed because
 * they false-positive on rich-content plain-text dumps):
 *
 *   - Bullet lists (`^\s*[-*+] `) — Word/Outlook plain bullets match.
 *   - Plain ordered lists (`^\s*\d+\. `) — Word/Outlook match.
 *   - Italic (`*text*`) — too loose, overlaps with bullet plain-text.
 *   - Blockquote (`^> `) — Outlook reply quote markers match.
 *
 * The trade-off: a paste that's *only* unstyled bullet markdown
 * (no headings / links / bold / etc.) routes through the HTML
 * branch instead, which still produces correct output via Turndown
 * because the source app's HTML side carries the bullet structure.
 */
const STRONG_MARKDOWN_PATTERNS: readonly RegExp[] = [
  /^#{1,6} \S/m, // ATX heading with content
  /^```/m, // fenced code (backticks)
  /^~~~/m, // fenced code (tildes)
  /\[[^\]]+\]\([^)]+\)/, // inline link
  /!\[[^\]]*\]\([^)]+\)/, // inline image
  /\*\*[^*\s][\s\S]{0,200}?\*\*/, // bold (paired, length-bounded)
  /__[^_\s][\s\S]{0,200}?__/, // alt bold (paired, length-bounded)
  /\\[.#]/, // backslash-dot or backslash-hash (Google Docs sig)
  /^\|[^|\n]*\|[^|\n]*\|/m, // GFM table row (3+ pipes on one line)
];

/**
 * Heuristic: does this string contain at least one *strong* markdown
 * marker (one that Word / Outlook / etc. wouldn't put in plain-text
 * export)? Conservative — false negatives are fine (we'd then route
 * through HTML / Turndown which still produces usable output), but a
 * false positive (treating a Word plain-text dump as markdown) would
 * lose all the rich structure (tables, bold, etc.) carried by the
 * accompanying text/html slot.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  return STRONG_MARKDOWN_PATTERNS.some((re) => re.test(text));
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
 *      *every* digit in heading text (`### 1\. Foo`,
 *      `### Item 1\. Foo`, `## A 1\. B 2\. C`) and `#` inside
 *      table cells (`| \# |`). Both parse correctly via commonmark
 *      escape rules, but the visible `\.` / `\#` is jarring in
 *      source view, so strip the escape. The smoke-test feedback
 *      on iteration 1 caught the mid-heading-digits case (the
 *      original narrow regex only matched digits *immediately*
 *      after `#+`) — the fix scans the whole heading line.
 *
 *   3. **Ordered-list-start escapes**: `1\. Foo` at line start
 *      (start of a list item). Strip so the rendered source is
 *      `1. Foo`.
 *
 * Applied unconditionally to every "looks like markdown" paste —
 * if the source wasn't Google Docs the patterns simply don't
 * match anything.
 */
export function cleanupGoogleDocsMarkdown(text: string): string {
  if (!text) return text;
  return (
    text
      .replace(/\[\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/g, '[$1]($3)')
      // Strip `\.` after any digit on heading lines (broader than
      // RAISE-39 iteration 1's `^(#+\s+\d+)\\.` which missed
      // `### Item 1\. Foo`).
      .replace(/^(#+\s+.*)$/gm, (line) =>
        line.replace(/(\d)\\\./g, '$1.'),
      )
      // Ordered list start: `1\. Foo` or `  1\. Foo` → `1. Foo`.
      .replace(/^(\s*\d+)\\\./gm, '$1.')
      // Table cell `\#` → `#`. Applies anywhere; outside tables
      // there's no functional difference.
      .replace(/\\#/g, '#')
  );
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
 * Strip residual HTML that Turndown couldn't / didn't convert.
 * Web pages especially throw off `<div>` wrappers, `<span style>`
 * spans, `<br>` inside table cells, etc. — Turndown's defaults
 * leave these in the output as inline HTML, and Milkdown's
 * commonmark parser then renders them as literal text in WYSIWYG
 * (the html schema is an inline atom that displays its raw
 * value), which is what RAISE-39 smoke testing was hitting.
 *
 * Strip categories:
 *   - `<style>...</style>` / `<script>...</script>` — drop
 *     entirely, content is non-prose noise
 *   - `<br>` / `<br />` — replace with a single space (typical
 *     source: GFM table cells where line breaks aren't supported,
 *     so Turndown emits `<br>` to preserve the visual break)
 *   - `<div>` / `<span>` opening/closing tags — drop the tags but
 *     keep the content (Turndown leaves these on unknown
 *     elements; the wrapped text is what we want)
 */
function sanitizeTurndownOutput(md: string): string {
  return md
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:div|span)[^>]*>/gi, '')
    // Collapse the runs of spaces that the <br> → ' ' replacement
    // and the dropped tags can leave behind.
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Convert HTML to markdown via Turndown + GFM. Trims the result
 * because Turndown sometimes emits trailing newlines that
 * compound into blank lines once inserted into an editor.
 * Sanitises the output to drop residual HTML that Turndown left
 * in (web pages especially leak `<div>`, `<span>`, `<br>` etc.).
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return sanitizeTurndownOutput(getTurndown().turndown(html)).trim();
}

/**
 * Defensive serialize-side post-process: undo the `\.` escape
 * that mdast-util-to-markdown sometimes inserts after digits
 * inside heading text. Cleanup at paste time *should* strip
 * the Google-Docs version of this escape, but smoke-test
 * feedback shows `\.` still landing in source on the WYSIWYG
 * round-trip — so we belt-and-braces it here too.
 *
 * Scans every heading line (`#+ ` prefix) and strips `\.` after
 * any digit on that line. Heading text never needs the escape
 * (list-marker parsing only matters at paragraph start, not
 * inside a heading), so this is unconditionally safe.
 *
 * Outside heading lines, `\.` could be the user's deliberate
 * literal-period escape, so we don't touch those.
 */
export function unescapeHeadingNumberDot(markdown: string): string {
  if (!markdown || !markdown.includes('\\.')) return markdown;
  return markdown.replace(/^(#+\s+.*)$/gm, (line) =>
    line.replace(/(\d)\\\./g, '$1.'),
  );
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
