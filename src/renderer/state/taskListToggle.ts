/**
 * Shared GFM task-list checkbox toggle logic
 * ([RAISE-29](https://risepeople.atlassian.net/browse/RAISE-29),
 * [RAISE-85](https://risepeople.atlassian.net/browse/RAISE-85)).
 *
 * SplitView's preview pane and ReadView both render task lists as
 * clickable checkboxes and rewrite the source line when one is
 * toggled. The mapping from a clicked checkbox to its source line is
 * built per-render (markdown-it's `list_item_open` token `.map[0]`,
 * offset by the frontmatter line count); flipping the marker on that
 * line is identical across both surfaces, so it lives here as a pure,
 * unit-tested helper rather than being duplicated inline in two
 * components.
 */

// RAISE-29: matches `[ ]` / `[x]` / `[X]` on a known task-list line.
// Applied to a SINGLE source line at a time (the one markdown-it
// identified as a `list_item_open` with the `task-list-item` class),
// so we never risk false-matching a `[ ]` inside a fenced code block
// or ordinary prose.
export const TASK_LINE_MARKER_RE = /\[([ xX])\]/;

/**
 * Flip the GFM task-list checkbox marker on a single source line.
 *
 * `content` is the full document source; `lineIdx` is the 0-indexed
 * absolute source line of the task item (callers add the frontmatter
 * line offset to markdown-it's body-relative `.map[0]` before calling).
 *
 * Returns the rewritten full source. Returns the input unchanged
 * (referentially identical) when the line index is out of range or the
 * target line has no checkbox marker — callers can compare by identity
 * to detect a no-op and skip any write-back.
 */
export function toggleTaskLine(content: string, lineIdx: number): string {
  const lines = content.split('\n');
  const sourceLine = lines[lineIdx];
  if (sourceLine == null) return content;
  const updatedLine = sourceLine.replace(
    TASK_LINE_MARKER_RE,
    (_, marker: string) => `[${marker === ' ' ? 'x' : ' '}]`,
  );
  if (updatedLine === sourceLine) return content;
  lines[lineIdx] = updatedLine;
  return lines.join('\n');
}
