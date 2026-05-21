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
    // HTML comments — `preprocessClipboardHtml` removes these
    // upstream via DOMParser, but a string-level pass is cheap
    // belt-and-braces against any path that bypasses the parse
    // step (malformed HTML that DOMParser couldn't handle, etc.).
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:div|span)[^>]*>/gi, '')
    // Collapse the runs of spaces that the <br> → ' ' replacement
    // and the dropped tags can leave behind.
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Pre-process clipboard HTML before handing to Turndown
 * ([RAISE-39](https://risepeople.atlassian.net/browse/RAISE-39)
 * iteration 3). Word / Outlook / Excel put a full HTML document
 * in the clipboard with two specific shapes Turndown's defaults
 * mishandle:
 *
 *   1. **`<head><style>`** — Word writes a megabyte-class CSS
 *      preamble (`@font-face`, `p.MsoNormal`, etc.) into a
 *      `<style>` block in the document head, with the CSS
 *      itself wrapped in HTML comments (CSS-comment delimiters
 *      around the rule body) for legacy IE compatibility.
 *      Turndown's default rule set doesn't strip these — the
 *      raw style content leaks out into the converted markdown
 *      as the literal "Font Definitions / @font-face / etc."
 *      string, which then renders verbatim in the WYSIWYG
 *      editor as the smoke-test screenshot showed.
 *
 *   2. **`<table>` without `<thead>`** — Word emits tables as
 *      `<table><tr><td>...</td></tr>...</table>` with no header
 *      row. The `turndown-plugin-gfm` tables rule only converts
 *      tables that have a heading row (either `<thead>` or all-
 *      `<th>` first row); without one, the table is `keep`'d as
 *      raw `<table>` HTML in the output. Milkdown then parses
 *      that raw HTML as an inline html node and the user sees
 *      the literal `<table>...</table>` text in their document.
 *
 * Strategy: parse the HTML via the renderer's native DOMParser,
 * drop head / style / script / comment nodes, and promote the
 * first row of each thead-less table to a `<thead>` with `<th>`
 * cells so the GFM rule can convert it. Return the body's
 * innerHTML for Turndown to chew on.
 *
 * If parsing fails (extremely malformed HTML) we fall back to
 * the raw input — Turndown handled it fine before, just with
 * the styling-leak bug.
 */
export function preprocessClipboardHtml(html: string): string {
  if (!html) return html;
  // DOMParser is a renderer-side API; clipboardPaste.ts is
  // already renderer-only (DataTransfer is browser-only too)
  // so this is consistent with the file's environment.
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return html;
  }
  const body = doc.body;
  if (!body) return html;

  // Drop head — it's where Word's CSS preamble lives.
  doc.head?.remove();

  // Drop any style / script that snuck into body (rare, but
  // some sources put them inline).
  body.querySelectorAll('style, script').forEach((el) => el.remove());

  // Drop HTML comments anywhere in body. DOMParser exposes
  // these as Comment nodes; we walk and remove them so the
  // CSS-inside-`<!-- -->` pattern (Word's `<style>` content
  // is wrapped in legacy-IE conditional comments) doesn't
  // leak even if a `<style>` block was missed above.
  const commentWalker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  let cur: Node | null = commentWalker.nextNode();
  while (cur) {
    comments.push(cur);
    cur = commentWalker.nextNode();
  }
  comments.forEach((c) => c.parentNode?.removeChild(c));

  // Word represents the document "Title" style as a
  // `<p class="MsoTitle">...</p>` rather than a heading element
  // (HTML has no semantic title separate from `<h1>`). Without
  // this conversion Turndown sees a paragraph and emits the
  // bold-via-CSS title as `**Title**` instead of `# Title` —
  // the smoke-test screenshot showed exactly this. Promote the
  // common Word title / subtitle classes to real heading tags
  // so Turndown's heading rule fires.
  //
  // Word's `MsoHeading1` … `MsoHeading6` *do* already render as
  // `<h1>` … `<h6>` (Word maps them itself), so they don't need
  // promotion here.
  body.querySelectorAll('p').forEach((p) => {
    const cls = p.className.toLowerCase();
    let level: number | undefined;
    if (/\bmso-?title\b/.test(cls)) level = 1;
    else if (/\bmso-?subtitle\b/.test(cls)) level = 2;
    if (level === undefined) return;
    const h = doc.createElement(`h${level}`);
    h.innerHTML = p.innerHTML;
    p.replaceWith(h);
  });

  // Unwrap block-level children inside table cells. Word emits
  // table cells as `<td><p>Some text</p></td>` — sometimes with
  // multiple `<p>` siblings — and Turndown's table-cell rule
  // serialises that as `| <newline><newline>Some text<newline>
  // <newline> |`, which breaks the markdown row format. The
  // smoke-test screenshot showed exactly this: each cell landed
  // on its own line with a stray `|` between them, plus a
  // disconnected `\| --- | --- | --- | --- |` alignment row.
  //
  // Replace each cell's block children with their inline content
  // joined by `<br>`. GFM tables support `<br>` for line breaks
  // within a cell, so multi-paragraph Word cells survive as
  // single rows without losing the visual line breaks.
  //
  // Pattern matches the tags Word actually emits inside cells:
  // `<p>` (most common), `<div>` (nested wrapper), `<h1>`-`<h6>`
  // (rare — heading inside a cell), and `<o:p>` (Word-XML
  // paragraph marker on the Office namespace).
  body.querySelectorAll('th, td').forEach((cell) => {
    let html = cell.innerHTML;
    if (!/<(?:p|div|h[1-6]|o:p)\b/i.test(html)) return;
    // Replace each block close tag with `<br>`, then drop the
    // open tags. Order matters — the close-tag pass injects the
    // separator before we strip the surrounding markup.
    html = html
      .replace(/<\/(?:p|div|h[1-6]|o:p)>/gi, '<br>')
      .replace(/<(?:p|div|h[1-6]|o:p)\b[^>]*>/gi, '');
    // Trim trailing `<br>` runs the close-tag substitution
    // leaves behind on the last block.
    html = html.replace(/(?:<br\s*\/?>\s*)+$/i, '');
    cell.innerHTML = html;
  });

  // For any `<table>` lacking a `<thead>`, promote the first
  // row to a `<thead>` with `<th>` cells so GFM Turndown's
  // tables rule converts it instead of keeping it as raw HTML.
  // Word / Excel / browser-page tables all hit this — none of
  // them produce explicit `<thead>` in clipboard HTML.
  body.querySelectorAll('table').forEach((table) => {
    if (table.tHead) return;
    const firstRow = table.rows[0];
    if (!firstRow) return;
    const thead = doc.createElement('thead');
    const headerRow = doc.createElement('tr');
    Array.from(firstRow.cells).forEach((cell) => {
      const th = doc.createElement('th');
      th.innerHTML = cell.innerHTML;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.insertBefore(thead, table.firstChild);
    firstRow.remove();
  });

  return body.innerHTML;
}

/**
 * Convert HTML to markdown via Turndown + GFM. Trims the result
 * because Turndown sometimes emits trailing newlines that
 * compound into blank lines once inserted into an editor.
 * Pre-processes Word / Outlook / Excel clipboard HTML to strip
 * the `<style>` preamble and to make table headers explicit
 * (see `preprocessClipboardHtml`). Sanitises the output to drop
 * residual HTML that Turndown left in (web pages especially
 * leak `<div>`, `<span>`, `<br>` etc.).
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  const cleaned = preprocessClipboardHtml(html);
  return sanitizeTurndownOutput(getTurndown().turndown(cleaned)).trim();
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

/**
 * RAISE-51 companion to `getMarkdownFromClipboard`. Returns ONLY the
 * clipboard's `text/plain` slot — no Turndown conversion, no markdown
 * heuristic, no Google-Docs cleanup. Drives the Paste and Match Style
 * (Cmd/Ctrl+Shift+V) flow. Returns `null` on an empty / `text/plain`-less
 * clipboard (image-only sources, etc.) — callers treat null as a no-op
 * paste, matching the ticket's "image clipboards short-circuit" spec.
 *
 * Companion shape with `getMarkdownFromClipboard` (DataTransfer in,
 * string-or-null out) so DOM-paste-event paths can use either helper
 * interchangeably. The menu-action / context-menu paste-plain flow
 * doesn't have a DataTransfer (no DOM paste event); it reads the
 * system clipboard via `window.api.clipboard.readText()` directly and
 * skips this helper.
 */
export function getPlainTextFromClipboard(cd: DataTransfer): string | null {
  const text = cd.getData('text/plain');
  return text || null;
}
