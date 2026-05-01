/**
 * Strip Milkdown's empty-paragraph round-trip marker (`<br />`) from
 * serialized markdown ([RAISE-37](https://risepeople.atlassian.net/browse/RAISE-37)).
 *
 * Background — why this marker exists in the first place:
 *
 * CommonMark collapses any run of consecutive blank lines into a single
 * blank line on parse / re-serialise. So a user who hit Enter twice at
 * the end of a paragraph (creating a deliberately-empty paragraph
 * between two real ones) would see their second blank line vanish on
 * round-trip through Milkdown.
 *
 * Milkdown's workaround lives in
 *   `@milkdown/preset-commonmark/src/node/paragraph.ts` (lines 34–52)
 * — `paragraph.toMarkdown` writes a literal `<br />` HTML node into
 * any empty paragraph that isn't the doc's last child. A paired remark
 * plugin (`remarkPreserveEmptyLinePlugin`, registered automatically by
 * the `commonmark` preset) strips those `<br />` HTML mdast nodes back
 * out on parse. So *within Milkdown*, the marker is invisible — it's
 * a round-trip artefact you never see.
 *
 * The problem for us: our `markdownUpdated` listener observes the
 * raw serializer output *before* it could be re-parsed by Milkdown.
 * That raw string is what we hand to the parent's onChange and what
 * eventually hits disk. So the user types two Enters → source on
 * disk gets a literal `<br />` line → the split-preview pane (with
 * `html: false`) renders it as visible text.
 *
 * Fix: drop the `<br />` lines at the same I/O boundary where the
 * gemoji shortcode substitution happens, with the same code-region
 * awareness so a `<br />` line *inside* a fenced code block stays
 * verbatim (otherwise we'd corrupt user code-block content
 * containing literal HTML samples). Net effect: two blank lines in
 * WYSIWYG round-trips as a single blank line in source — standard
 * commonmark behaviour, and what every other markdown editor does.
 *
 * Trade-off: a user who legitimately *wants* a literal `<br />` on
 * its own line in source *outside* a code block (rare — most
 * markdown renderers either render or strip it depending on `html`
 * config, and the preview pane in this app already strips it via
 * `html: false`) will see it removed on save. The Milkdown-internal
 * use of the marker is indistinguishable from a user-typed one at
 * the string level outside code regions, so we can't tell them
 * apart without inspecting the mdast tree. The vastly more common
 * case is the auto-generated marker, so the trade-off favours
 * fixing the bug.
 */

/**
 * The literal Milkdown emits for an empty middle paragraph.
 * `paragraph.toMarkdown` writes exactly `<br />` (lowercase, one
 * space, self-closing) — we match exactly that on a line, with
 * optional trailing whitespace. Two flavours of "lines that are
 * just a marker":
 *
 *   1. **Standalone**: `<br />` on its own line, with optional
 *      leading whitespace. The prototypical RAISE-37 case —
 *      empty paragraph between two real ones.
 *
 *   2. **Empty list item**: `* <br />` / `- [ ] <br />` etc.
 *      RAISE-39 surfaced this when pasting task-list content
 *      ended in an empty trailing item. Milkdown's paragraph
 *      serializer writes the `<br />` for an empty middle
 *      paragraph regardless of whether the paragraph is wrapped
 *      in a list_item, so the marker leaks the same way; we
 *      just need a wider regex to catch it.
 *
 * Anything else (mid-line `<br />`, `<br>` without slash, `<BR>`,
 * `<br />` with attributes) is treated as user content.
 */
const EMPTY_PARAGRAPH_MARKER_LINE =
  /^[ \t]*(?:[-*+] (?:\[[^\]]*\] )?)?<br \/>\s*$/gm;

/**
 * Match a code region the strip must skip:
 *
 *   - fenced code block: ``` (or ~~~) at line start, content,
 *     matching closing fence at line start
 *   - inline code: `…` or ``…`` (one or two backticks)
 *
 * Mirrors `CODE_REGION_RE` in `gemojiNode.ts` so both serialize-
 * side post-processes have the same notion of what counts as code.
 * Pragmatic and not 100% commonmark-correct (no indented-code-block
 * handling, no support for arbitrary backtick-fence lengths beyond
 * 1 / 2 / 3+) — covers the realistic shapes well enough to keep
 * code-block content intact on save.
 */
const CODE_REGION_RE = /^```[\s\S]*?^```$|^~~~[\s\S]*?^~~~$|``[^`\n]+``|`[^`\n]+`/gm;

function stripInTextRegion(text: string): string {
  return text
    .replace(EMPTY_PARAGRAPH_MARKER_LINE, '')
    // Collapse the run of blank lines left behind by the removed
    // marker (paragraph separators on both sides + the now-empty
    // line) back to a single paragraph break.
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Strip Milkdown's empty-paragraph round-trip markers from a
 * serialized markdown string. Idempotent and side-effect-free.
 *
 * Splits the input into [text, code, text, code, …] segments via
 * `CODE_REGION_RE` and runs the strip only on the text segments;
 * code regions pass through verbatim so a `<br />` deliberately
 * placed inside a code fence (e.g. an HTML example) survives.
 *
 * Fast-path: skip the work entirely if the input doesn't contain
 * the substring `<br` at all (cheap `.includes` before the regex
 * scan).
 */
export function stripEmptyParagraphMarkers(markdown: string): string {
  if (!markdown || !markdown.includes('<br')) return markdown;

  let result = '';
  let cursor = 0;
  CODE_REGION_RE.lastIndex = 0;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = CODE_REGION_RE.exec(markdown)) !== null) {
    if (codeMatch.index > cursor) {
      result += stripInTextRegion(markdown.slice(cursor, codeMatch.index));
    }
    // Code region — passed through unchanged.
    result += codeMatch[0];
    cursor = codeMatch.index + codeMatch[0].length;
  }
  if (cursor < markdown.length) {
    result += stripInTextRegion(markdown.slice(cursor));
  }
  return result;
}
