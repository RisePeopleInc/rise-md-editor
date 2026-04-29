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
 * gemoji shortcode substitution happens. Net effect: two blank lines
 * in WYSIWYG round-trips as a single blank line in source — standard
 * commonmark behaviour, and what every other markdown editor does.
 *
 * Trade-off: a user who legitimately *wants* a literal `<br />` on
 * its own line in source (rare — most markdown renderers either
 * render or strip it depending on `html` config, and the preview
 * pane in this app already strips it via `html: false`) will see it
 * removed on save. The Milkdown-internal use of the marker is
 * indistinguishable from a user-typed one at the string level, so
 * we can't tell them apart without inspecting the mdast tree. The
 * vastly more common case is the auto-generated marker, so the
 * trade-off favours fixing the bug.
 */

// Match a line that is *only* `<br />` (with optional trailing
// whitespace and case-insensitive HTML tag form). This intentionally
// doesn't match `<br />` mid-line — that's almost certainly user
// content (e.g. `text<br />more text` for a hard break inside a
// paragraph) and should pass through.
const STANDALONE_BR_LINE = /^<br ?\/?>\s*$/gim;

/**
 * Strip Milkdown's empty-paragraph round-trip markers from a
 * serialized markdown string. Idempotent and side-effect-free.
 *
 * Fast-path: skip the work entirely if the input doesn't contain
 * the substring `<br` at all (cheap `.includes` before the regex
 * scan).
 */
export function stripEmptyParagraphMarkers(markdown: string): string {
  if (!markdown || !markdown.includes('<br')) return markdown;
  // Replace each standalone `<br />` line with an empty string,
  // then collapse the resulting run of blank lines (paragraph
  // separators around the now-removed marker) back to a single
  // paragraph break. This preserves intentional paragraph
  // structure while eliminating the marker artefact.
  return markdown
    .replace(STANDALONE_BR_LINE, '')
    .replace(/\n{3,}/g, '\n\n');
}
