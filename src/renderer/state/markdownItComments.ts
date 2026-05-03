import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';

/**
 * Render review-style comments greyed-out in the preview pane
 * ([RAISE-31](https://risepeople.atlassian.net/browse/RAISE-31),
 * multi-line + typographer fixes:
 * [RAISE-48](https://risepeople.atlassian.net/browse/RAISE-48)).
 *
 * Three flavours:
 *
 *   1. **Inline HTML comments** — `<!-- text -->` on a single line,
 *      possibly mid-paragraph. Standard markdown but our markdown-it
 *      instance has `html: false`, so they'd otherwise be escaped to
 *      visible `&lt;!-- … --&gt;` text. An inline rule (registered
 *      *before* `html_inline` so it wins the dispatch) detects the
 *      shape, hides the delimiters, and renders the inner text in a
 *      styled span.
 *
 *   2. **Block HTML comments** — `<!--` opening a line, with `-->`
 *      anywhere later (same line, next line, many lines down). The
 *      inline rule from (1) only matches within a single paragraph,
 *      so a comment that spans a blank-line break would have its
 *      `<!--` rendered as escaped paragraph text and the inner
 *      headings / lists / etc. parsed as normal markdown — RAISE-48
 *      sub-bug A. A *block* rule (registered before `paragraph` and
 *      `html_block`) recognises the multi-line shape, recursively
 *      parses the inner src as block markdown, and wraps the result
 *      in a styled `<div class="md-comment">` so every line renders
 *      muted but headings / lists / links inside still format
 *      correctly.
 *
 *   3. **Line comments** — `// text` at the start of a line (after
 *      optional whitespace). Not standard markdown; it's the
 *      Obsidian / iA Writer convention, confirmed in the ticket
 *      comments as well-known to the requesting user. A custom
 *      block rule consumes the line, hides the `//`, and renders
 *      the rest in a styled paragraph.
 *
 * All three render with `class="md-comment"` (mirrored in CSS by
 * `.raise-prose .md-comment` for muted-italic styling). The
 * default markdown-it token renderer handles open/close tokens
 * automatically given the tag + attrSet, so we don't need to
 * register custom render functions.
 *
 * **Typographer suppression** (RAISE-48 sub-bug B): markdown-it's
 * `replacements` rule (gated on `typographer: true` in our config)
 * turns runs of `--` into en-dashes. That mangles literal `--`
 * inside comment bodies (`<!-- foo -- bar -->` → `foo – bar`) AND,
 * historically, the `<!--` open delimiter when it leaked through
 * as raw text on multi-line comments. Inner parses for both the
 * inline and block comment rules temporarily disable typographer
 * so the comment body stays byte-faithful. (The outer document
 * still gets the typographer pass as configured.)
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
  // RAISE-48 sub-bug B: render the inner src to HTML in an isolated
  // pass with `typographer` off, then emit it via a custom token.
  // Using `state.md.inline.parse(...)` and pushing the resulting
  // tokens onto `state.tokens` doesn't work — the outer pass's
  // `replacements` core rule still runs over those tokens later
  // and re-applies typographer (mangling `--` → en-dash, undoing
  // the suppression). Rendering to HTML inside the rule keeps the
  // sub-parse fully isolated. Same trick as `blockHtmlComment`.
  const wasTypographer = state.md.options.typographer;
  state.md.options.typographer = false;
  let innerHtml: string;
  try {
    innerHtml = state.md.renderInline(innerSrc, state.env);
  } finally {
    state.md.options.typographer = wasTypographer;
  }
  const inner = state.push('comment_inline_html', '', 0);
  inner.content = innerHtml;
  state.push('comment_inline_close', 'span', -1);
  state.pos = end + HTML_COMMENT_CLOSE.length;
  return true;
}

/**
 * Block rule for `<!-- ... -->` comments that span one or more
 * lines (RAISE-48 sub-bug A).
 *
 * Match shape: a line whose first non-blank chars are `<!--`. The
 * closing `-->` may appear:
 *
 *   - On the same line (degenerate "block" comment that's just a
 *     single-line comment occupying its own paragraph),
 *   - On the next line (typical short multi-line comment),
 *   - Many lines later, possibly with blank lines and arbitrary
 *     markdown content (headings, lists, links, fenced code) in
 *     between.
 *
 * The inner content (between `<!--` and `-->`, trimmed) is rendered
 * recursively to HTML via `state.md.render(innerSrc, env)` with
 * `typographer` temporarily disabled, so literal `--` inside the
 * comment body survives. The resulting HTML is emitted via a custom
 * `comment_block_html` token (whose renderer just prints
 * `token.content`), wrapped in a `comment_block_open` /
 * `comment_block_close` div pair styled `class="md-comment"`.
 *
 * Why `render` rather than `parse` + push tokens onto the outer
 * stream: pushing pre-tokenised inline tokens onto `state.tokens`
 * makes the outer parse pass re-run its core rules over them — the
 * inline tokenizer re-walks `inline.content` and APPENDS new
 * children (doubling rendered text), and the `replacements` core
 * rule re-applies typographer (re-mangling `--` → en-dash, undoing
 * our suppression). Rendering to HTML inside the rule keeps the
 * sub-parse fully isolated from the outer pipeline.
 *
 * Returns false (so paragraph / html_block can claim the input) if:
 *   - the line doesn't start with `<!--`, OR
 *   - no `-->` is found before EOF.
 *
 * The unclosed-comment fall-through is intentional. A user mid-
 * typing `<!--` would otherwise see the editor swallow the rest of
 * the document into a styled comment block until they finished
 * typing the closing `-->` somewhere — a nasty live-preview UX.
 * Letting markdown-it's default rules render unclosed comments as
 * escaped text gives a stable preview as the user types.
 */
function blockHtmlComment(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const startPos = state.bMarks[startLine]! + state.tShift[startLine]!;
  const lineLast = state.eMarks[startLine]!;
  if (state.src.charCodeAt(startPos) !== LESS_THAN) return false;
  if (!state.src.startsWith(HTML_COMMENT_OPEN, startPos)) return false;

  // Same-line comments (`<!-- text -->` on a single line, even if
  // it's its own paragraph) are deliberately *not* claimed by this
  // rule. They get folded into a paragraph by the default rules and
  // then the inline `comment_inline` rule picks them up — preserving
  // RAISE-31 iteration-3's `<p><span class="md-comment">…</span></p>`
  // shape and avoiding a churn in the DOM that would otherwise change
  // the styled wrapper from `<span>` to `<div>` for the most common
  // single-line case.
  const sameLineEnd = state.src.indexOf(
    HTML_COMMENT_CLOSE,
    startPos + HTML_COMMENT_OPEN.length,
  );
  if (sameLineEnd !== -1 && sameLineEnd < lineLast) return false;

  // Search forward (from the line *after* the opener) for the
  // closing `-->`. Multi-line comments are this rule's whole point.
  let endLineIdx = -1;
  let endCharPos = -1;
  for (let cur = startLine + 1; cur < endLine; cur++) {
    const lineStart = state.bMarks[cur]!;
    const lineEnd = state.eMarks[cur]!;
    const closeAt = state.src.indexOf(HTML_COMMENT_CLOSE, lineStart);
    if (closeAt !== -1 && closeAt < lineEnd) {
      endLineIdx = cur;
      endCharPos = closeAt;
      break;
    }
  }
  if (endLineIdx === -1) return false;
  if (silent) return true;

  const innerSrc = state.src
    .slice(startPos + HTML_COMMENT_OPEN.length, endCharPos)
    .trim();

  // Recursive block render. `state.md.render` runs the full parse
  // + render pipeline on the inner src in an isolated state, so
  // tokens don't leak back into the outer pass and pick up a
  // re-tokenisation (which doubles rendered text) or a re-run of
  // typographer (which un-suppresses our `--` preservation). The
  // returned HTML is dropped verbatim into a custom token that
  // the plugin's renderer rule echoes as raw HTML.
  const wasTypographer = state.md.options.typographer;
  state.md.options.typographer = false;
  let innerHtml: string;
  try {
    innerHtml = state.md.render(innerSrc, state.env);
  } finally {
    state.md.options.typographer = wasTypographer;
  }

  const open = state.push('comment_block_open', 'div', 1);
  open.attrSet('class', 'md-comment');
  open.markup = HTML_COMMENT_OPEN;
  open.map = [startLine, endLineIdx + 1];

  const innerToken = state.push('comment_block_html', '', 0);
  innerToken.content = innerHtml;
  // `block: true` keeps markdown-it's renderer from wrapping us in
  // a paragraph or attempting inline-shaped processing.
  innerToken.block = true;

  const close = state.push('comment_block_close', 'div', -1);
  close.markup = HTML_COMMENT_CLOSE;

  state.line = endLineIdx + 1;
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

  // Block rule for multi-line `<!-- ... -->` (RAISE-48). Registered
  // before `html_block` so it claims the multi-line comment shape
  // before markdown-it's default rules treat it as raw HTML and
  // (with `html: false`) escape it to text. Also before `paragraph`
  // so the `<!--` line isn't folded into a paragraph that then runs
  // through inline parsing — typographer would mangle the `--`.
  md.block.ruler.before('html_block', 'comment_block', blockHtmlComment, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  // Block rule before `paragraph` so a `//`-led line is taken as a
  // comment, not folded into a regular paragraph. Code blocks
  // (fence / indented) are matched earlier in the block ruler so
  // `//` inside them never reaches us.
  md.block.ruler.before('paragraph', 'comment_line', blockLineComment, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  // Renderer rules for the custom comment tokens: emit content
  // verbatim. The content is HTML produced by an isolated
  // `state.md.render(innerSrc)` / `state.md.renderInline(innerSrc)`
  // sub-parse, so it's already escape-safe (markdown-it's normal
  // escaping ran during the inner parse).
  md.renderer.rules['comment_block_html'] = (tokens, idx) =>
    tokens[idx]!.content;
  md.renderer.rules['comment_inline_html'] = (tokens, idx) =>
    tokens[idx]!.content;
}
