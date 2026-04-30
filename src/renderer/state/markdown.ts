/**
 * Shared markdown helpers used across the editor surfaces
 * (`WysiwygEditor.tsx`, `SplitView.tsx`).
 *
 * Both surfaces need to split a YAML-frontmatter-bearing source into
 * the frontmatter + body parts: WYSIWYG renders the frontmatter in
 * its own dedicated textarea so it doesn't clutter the prose
 * editor; the preview pane needs the same separation so markdown-it
 * doesn't interpret the closing `---` as a Setext H2 underline
 * ([RAISE-32](https://risepeople.atlassian.net/browse/RAISE-32)).
 *
 * Previously this lived as a private helper in `WysiwygEditor.tsx`.
 * Moved here so both call-sites use the exact same regex / BOM
 * stripping / edge-case handling without drift.
 */

/**
 * Match a YAML frontmatter block at the very start of the document.
 *
 * Supports:
 *   - LF and CRLF line endings
 *   - With or without a trailing newline after the closing `---` fence
 *   - Empty frontmatter (`---\n---\n`) as a degenerate but legitimate
 *     case — the inner `(?:([\s\S]*?)\r?\n)?` is optional so the
 *     content + separating newline can be absent. Without that
 *     optional wrapper, `---\n---\n` would not match, and markdown-it
 *     would then render the two fences as two separate `<hr>` tags
 *     (RAISE-32 smoke-test bug).
 *
 * Capture group 1 is the content between the fences. When the match
 * is the "empty frontmatter" form, group 1 is `undefined`; consumers
 * should normalise via `match[1] ?? ''`.
 */
const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;

export interface FrontmatterSplit {
  /**
   * The text inside the `---` fences (without the fences themselves)
   * or `null` if the document doesn't have a frontmatter block.
   */
  frontmatter: string | null;
  /**
   * Everything after the closing `---` fence (or the entire document
   * if there's no frontmatter).
   */
  body: string;
  /**
   * Number of source lines consumed by the frontmatter block. The
   * body's 0-indexed line N corresponds to source line N +
   * `bodyLineOffset`. Used by the preview pane to map markdown-it
   * line indices (which are body-relative when we parse only the
   * body) back to absolute source-line indices for the task-list
   * checkbox click handler. Zero when there's no frontmatter.
   */
  bodyLineOffset: number;
}

/**
 * Split a markdown source string into its frontmatter and body
 * parts. Strips a leading UTF-8 BOM so the regex's `^` anchor
 * matches on files saved by older Windows tools (Notepad, etc.).
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  // BOM stripping has to happen before the regex test — otherwise
  // the BOM character pushes `---` past `^` and we miss the
  // frontmatter on Windows-saved files.
  const stripped = content.replace(/^\uFEFF/, '');
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: null, body: stripped, bodyLineOffset: 0 };
  }
  const consumed = match[0];
  // Count newlines in the consumed prefix to get the line offset
  // for the body. Use a tight char-code loop rather than
  // `split('\n').length - 1` to avoid the intermediate array
  // allocation on every keystroke (the preview pane re-runs this
  // on every content change).
  let bodyLineOffset = 0;
  for (let i = 0; i < consumed.length; i++) {
    if (consumed.charCodeAt(i) === 10 /* \n */) bodyLineOffset++;
  }
  return {
    frontmatter: match[1] ?? '',
    body: stripped.slice(consumed.length),
    bodyLineOffset,
  };
}

/**
 * Inverse of `splitFrontmatter`: glue a frontmatter and body back
 * together. Inserts a single blank line between the closing `---`
 * fence and the body — the typical convention used by tools that
 * write frontmatter (Hugo, Jekyll, Obsidian, etc.).
 */
export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  return `---\n${frontmatter}\n---\n\n${body}`;
}
