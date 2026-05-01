import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';

/**
 * Render review-style comments greyed-out in the preview pane
 * ([RAISE-31](https://risepeople.atlassian.net/browse/RAISE-31)).
 *
 * Two flavours:
 *
 *   1. **HTML comments** — `<!-- text -->`. Standard markdown but
 *      our markdown-it instance has `html: false`, so they'd
 *      otherwise vanish entirely. A custom inline rule (registered
 *      *before* `html_inline` so it wins the dispatch) detects the
 *      shape, hides the `<!--` / `-->` delimiters, and renders the
 *      inner text in a styled span.
 *
 *   2. **Line comments** — `// text` at the start of a line (after
 *      optional whitespace). Not standard markdown; it's the
 *      Obsidian / iA Writer convention, confirmed in the ticket
 *      comments as well-known to the requesting user. A custom
 *      block rule consumes the line, hides the `//`, and renders
 *      the rest in a styled paragraph.
 *
 * Both forms render with `class="md-comment"` (mirrored in CSS by
 * `.raise-prose .md-comment` for muted-italic styling). The
 * default markdown-it token renderer handles open/close tokens
 * automatically given the tag + attrSet, so we don't need to
 * register custom render functions.
 *
 * Constraint: comments inside code spans / fenced code blocks
 * stay literal. The block rule is naturally protected — markdown-
 * it's `code` and `fence` block rules run earlier and consume
 * those lines before our rule sees them. The inline rule fires
 * during inline parsing of normal text, which doesn't enter code-
 * marked text either.
 */

const HTML_COMMENT_OPEN = '<!--';
const HTML_COMMENT_CLOSE = '-->';
const LESS_THAN = 0x3c; // '<'
const SLASH = 0x2f; // '/'

function inlineHtmlComment(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  // Cheap first-char dispatch — markdown-it iterates the whole
  // ruler chain on every char, so reject quickly when it isn't
  // `<`. Saves the substring comparison on the common case.
  if (src.charCodeAt(start) !== LESS_THAN) return false;
  if (!src.startsWith(HTML_COMMENT_OPEN, start)) return false;
  const end = src.indexOf(HTML_COMMENT_CLOSE, start + HTML_COMMENT_OPEN.length);
  if (end === -1) return false;
  if (silent) return true;
  const open = state.push('comment_inline_open', 'span', 1);
  open.attrSet('class', 'md-comment');
  open.markup = HTML_COMMENT_OPEN;
  // Recursively parse the comment's inner content as inline
  // markdown so links / bold / italic / inline code inside a
  // comment render correctly. `state.md.inline.parse` runs the
  // full inline tokenizer on the substring and pushes the
  // resulting flat token sequence into the array we hand it —
  // we hand it `state.tokens` directly so the parsed children
  // land between our open / close span tokens.
  const innerSrc = src
    .slice(start + HTML_COMMENT_OPEN.length, end)
    .trim();
  state.md.inline.parse(innerSrc, state.md, state.env, state.tokens);
  state.push('comment_inline_close', 'span', -1);
  state.pos = end + HTML_COMMENT_CLOSE.length;
  return true;
}

function blockLineComment(
  state: StateBlock,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  // markdown-it's tShift already accounts for leading whitespace,
  // so `bMarks + tShift` is the first non-blank char on the line.
  const startPos = state.bMarks[startLine]! + state.tShift[startLine]!;
  const lineEnd = state.eMarks[startLine]!;
  // Reject quickly on first-char.
  if (state.src.charCodeAt(startPos) !== SLASH) return false;
  if (state.src.charCodeAt(startPos + 1) !== SLASH) return false;
  if (silent) return true;
  const lineText = state.src.slice(startPos, lineEnd);

  const open = state.push('comment_line_open', 'p', 1);
  open.attrSet('class', 'md-comment');
  open.markup = '//';
  open.map = [startLine, startLine + 1];

  const inline = state.push('inline', '', 0);
  // Skip the `//` prefix and trim — the prefix is hidden in the
  // rendered output (consistent with how blockquote `>` markers
  // don't show in the rendered HTML).
  inline.content = lineText.slice(2).trim();
  inline.children = [];
  inline.map = [startLine, startLine + 1];

  state.push('comment_line_close', 'p', -1);

  state.line = startLine + 1;
  return true;
}

export function markdownItComments(md: MarkdownIt): void {
  // Inline rule before `html_inline` so we claim `<!--` first.
  // Without `before('html_inline', ...)`, markdown-it would let
  // `html_inline` match `<!--` then tokenise it as raw HTML (which
  // our `html: false` setting then escapes into visible text).
  md.inline.ruler.before('html_inline', 'comment_inline', inlineHtmlComment);

  // Block rule before `paragraph` so a `//`-led line is taken as a
  // comment, not folded into a regular paragraph. Code blocks
  // (fence / indented) are matched earlier in the block ruler so
  // `//` inside them never reaches us.
  md.block.ruler.before('paragraph', 'comment_line', blockLineComment, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
}
