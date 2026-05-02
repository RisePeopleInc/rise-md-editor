import type { Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

/**
 * Render review-style comments greyed-out in the WYSIWYG editor
 * ([RAISE-31](https://risepeople.atlassian.net/browse/RAISE-31)).
 *
 * Two patterns:
 *
 *   1. `<!-- text -->`  HTML-style, inline or block, single- or
 *      multi-line.
 *   2. `// text`        Line-start, after optional whitespace.
 *
 * Implemented via a ProseMirror inline-decoration plugin rather
 * than custom marks or nodes, because:
 *
 *   - Source preservation is automatic. The doc carries the
 *     literal `<!-- text -->` / `// text` characters; the
 *     decoration is purely visual. Save → reopen → re-decorate.
 *
 *   - No round-trip mark/node serialiser pair to maintain.
 *
 *   - No contentEditable atom complexity (the same class of
 *     problem RAISE-34 spent seven attempts wrestling with). The
 *     user can position the caret inside a comment, edit it like
 *     normal text, and the decoration follows.
 *
 * Two decoration paths cover the comment shapes:
 *
 *   **A — `html` atom branch** (parsed source). When markdown
 *   source contains `<!-- ... -->`, the commonmark parser turns
 *   it into Milkdown's `html` ProseMirror node (an inline atom)
 *   carrying the literal HTML as its `value` attribute. We
 *   detect the atom directly and decorate over its node range.
 *   Critical that the descendants walk *enters* textblocks
 *   (returning `true` from the textblock callback), because the
 *   atoms live as children of paragraphs after a paste / save /
 *   reload — without descent the atoms are invisible to the
 *   plugin and pasted comments don't decorate.
 *
 *   **B — Cross-block text buffer scan** (typed input). When
 *   the user types `<!--` directly in WYSIWYG, the chars enter
 *   as plain text; if they hit Enter inside the comment the
 *   text spans multiple paragraphs. We build a doc-level text
 *   buffer with a parallel doc-position-mapping array (skipping
 *   code blocks and inline-code-marked text), run the
 *   `<!--...-->` regex on the buffer, and emit one inline
 *   decoration per textblock the match overlaps.
 *
 * Skipped contexts:
 *
 *   - Code blocks (`code_block`, `code: true` in spec): the doc
 *     traversal short-circuits with `return false`, so we never
 *     descend into them.
 *   - Inline code marks: when we walk a textblock's children we
 *     check each text node for the `spec.code` mark and skip it.
 *     This keeps `` `<!-- not a comment -->` `` literal inside
 *     inline code, and `` `// also not a comment` `` literal too.
 *
 * URL safety: the line-comment regex is anchored `^[ \t]*\/\/`,
 * and we apply it only to a paragraph's *textContent starts with*
 * — never mid-line. So `Visit https://example.com` never matches
 * (the `//` follows `:`, not line-start).
 *
 * ---
 *
 * ## Iteration history
 *
 * Every regex / branch in this file earned its place via a
 * specific smoke-test failure across 4 rounds. Future
 * maintainers touching these patterns can use this map to
 * understand which input shape each branch is defending against
 * without re-running the manual test matrix.
 *
 *   **Iteration 0 (initial)** — the decoration plugin scaffold,
 *   per-textblock scan, html atom branch, line-comment fast-
 *   path, and `unescapeCommentDelimiters` for the leading `\<`.
 *
 *   **Iteration 1 (first smoke test, 5 fixes)**:
 *   1. *Links / formatting inside comments rendered verbatim
 *      in preview* — the markdown-it inline rule was pushing a
 *      raw text token for the inner content. Switched to
 *      `state.md.inline.parse(innerSrc, ..., state.tokens)` so
 *      the inline tokenizer recurses over the contents.
 *   2. *Cross-mark text scan* — when a comment's inner content
 *      gets a link mark on part of it (e.g., the `[link](url)`
 *      portion gets the link mark), the `<!--` and `-->` end
 *      up in *different* text children. Added the per-block
 *      flat-text-buffer + position-map approach so the regex
 *      sees the full pattern across mark boundaries.
 *   3. *html-atom branch* — source `<!-- ... -->` parses to an
 *      `html` ProseMirror inline atom, which the
 *      walk-text-children approach missed entirely.
 *   4. *Round-trip un-escape* — `\<!--` survived to disk;
 *      added the post-process strip.
 *   5. *CSS contrast* — the muted variable alone wasn't dim
 *      enough; added `opacity: 0.65`.
 *
 *   **Iteration 2 (rebase smoke test, 3 fixes)**:
 *   1. *Paste / reload doesn't decorate* — the textblock
 *      callback returned `false` from `descendants`, blocking
 *      descent into paragraph children. Pasted / reloaded
 *      comments parse to `html` atoms living *inside*
 *      paragraphs, never visited. Switched to `return true`.
 *   2. *Multi-line typed comment doesn't decorate* — comment
 *      spans multiple paragraphs after Enter. Replaced the
 *      per-block buffer scan with a doc-level cross-block
 *      scan (collect every block's segment, concatenate with
 *      synthetic `\n`, run regex, emit one decoration per
 *      overlapped block).
 *   3. *Source `//` no styling* — added Monaco line decoration
 *      in `SourceEditor.tsx`.
 *
 *   **Iteration 3 (round 2 smoke test, 3 fixes)**:
 *   1. *Inline code styled as comment* — buffer scan was
 *      checking `m.type.name === 'code'`. Milkdown's inline
 *      code mark is `inlineCode` (camelCase). Switched to
 *      `m.type.spec.code === true` — the conventional flag.
 *   2. *Link-in-comment escapes round-trip* — typed `\[link\]
 *      \(url\)` clutter survived. Expanded
 *      `unescapeCommentDelimiters` to strip inner-comment
 *      escapes, not just the leading `\<`.
 *   3. *Indented `// note` shows as `&#x20; // note`* — added
 *      `unescapeIndentEntities` post-process.
 *
 *   **Iteration 4 (round 3 smoke test, 1 fix)**:
 *   - *`\:` survives round-trip* — `mdast-util-gfm-autolink-
 *     literal` adds `:`, `.`, `@` to the safe-pass unsafe set.
 *     Extended the inner-comment unescape character set to
 *     cover the autolink-literal trio.
 *
 *   **Iteration 5 (review polish)**:
 *   - Documented the cross-block false-positive risk inline.
 *   - Added a negative-lookbehind guard so `\\<!--` (escaped
 *     literal backslash) isn't misclassified as the
 *     comment-delimiter escape.
 *   - Switched Monaco source decoration to
 *     `createDecorationsCollection()` (non-deprecated API).
 *   - Extended html branch to also accept block-level html
 *     nodes (`html_block` if Milkdown ever ships one), with
 *     a comment that today this is theoretical.
 *   - Trimmed redundant `.*` from `LINE_COMMENT_RE` and
 *     redundant `.includes('\\<!--')` early-out check.
 */

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const LINE_COMMENT_RE = /^[ \t]*\/\//;

const commentDecorationsKey = new PluginKey<DecorationSet>(
  'raiseCommentDecorations',
);

/**
 * Per-textblock entry collected during the doc walk so the
 * cross-block scan can run after we know all the segments.
 */
interface BlockSegment {
  /** Absolute doc position of the textblock's first inline char. */
  start: number;
  /** Concatenated non-code-marked text content of the block. */
  text: string;
  /** `positions[i]` is the doc position of `text[i]`. */
  positions: number[];
}

function collectBlockSegment(node: ProseNode, pos: number): BlockSegment {
  const start = pos + 1; // step past textblock open token
  let text = '';
  const positions: number[] = [];
  let offset = 0;
  node.forEach((child) => {
    if (child.isText && child.text) {
      // Skip text wearing a code-flagged mark. Milkdown's inline
      // code mark is registered as `inlineCode` (camelCase, not
      // `code`), so checking by name was a silent miss — the
      // mark's `spec.code` flag is the conventional indicator
      // and catches any code-like mark regardless of name.
      const codeMarked = child.marks.some(
        (m) => m.type.spec.code === true,
      );
      if (!codeMarked) {
        for (let i = 0; i < child.text.length; i++) {
          text += child.text[i];
          positions.push(start + offset + i);
        }
      }
    }
    offset += child.nodeSize;
  });
  return { start, text, positions };
}

function buildDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  const blockSegments: BlockSegment[] = [];

  doc.descendants((node, pos) => {
    // Skip code blocks entirely. Their `// ...` and `<!-- ... -->`
    // content is literal code, not commentary.
    if (node.type.spec.code) return false;

    // `html` branch — parsed source `<!-- ... -->` lands here
    // as an inline atom carrying the literal HTML in `value`.
    // Decorate over the node's range. Atoms have no children so
    // we return false (no descent needed).
    //
    // Today Milkdown's commonmark schema only registers an
    // inline `html` node; if it ever ships a block-level
    // `html_block` (an old proposal that hasn't landed), this
    // branch covers that too — the value-shape check is
    // identical.
    if (node.type.name === 'html' || node.type.name === 'html_block') {
      const value = (node.attrs as { value?: string }).value ?? '';
      if (value.startsWith('<!--') && value.endsWith('-->')) {
        decorations.push(
          Decoration.inline(pos, pos + node.nodeSize, {
            class: 'raise-comment',
          }),
        );
      }
      return false;
    }

    // Textblock branch — collect a per-block segment for the
    // cross-block scan, AND apply the line-comment fast-path
    // here. Critical: return `true` so `descendants` enters the
    // textblock's children — without descent, html atoms living
    // *inside* paragraphs (the post-paste / post-reload shape)
    // never get visited and pasted comments don't decorate.
    if (node.isTextblock) {
      const text = node.textContent;
      if (text.length > 0 && LINE_COMMENT_RE.test(text)) {
        decorations.push(
          Decoration.inline(pos + 1, pos + 1 + node.content.size, {
            class: 'raise-comment',
          }),
        );
        // Don't collect this block for the cross-block scan —
        // a `// note` line being interpreted as part of an
        // unclosed `<!--` from an earlier paragraph would
        // cause weird false-positive multi-block matches.
        return true;
      }
      blockSegments.push(collectBlockSegment(node, pos));
      return true;
    }

    return true; // container — descend
  });

  // Cross-block HTML comment scan. Concatenate every block's text
  // with a `\n` separator (NOT pushed to the position map — the
  // separator is purely a regex aid). Run the regex over the
  // joined buffer; for each match, emit one inline decoration per
  // overlapped block.
  //
  // **False-positive trade-off**: an unbalanced `<!--` in one
  // paragraph and an unrelated `bar -->` in a later paragraph
  // (no relation, no closing pair within either block) will be
  // joined by the synthetic `\n` and matched as one comment,
  // decorating both paragraphs. This is rare in practice (users
  // don't usually leave dangling `<!--` between unrelated
  // paragraphs) and visual-only — the source on disk is
  // whatever the user actually typed, no data corruption. The
  // cost of a precise per-block matcher (which would miss the
  // legitimate multi-paragraph typed comment case) is judged
  // higher than the false-positive cost.
  if (blockSegments.length > 0) {
    let bigBuffer = '';
    // For each block, the index in `bigBuffer` where its text starts.
    const blockOffsets: number[] = [];
    for (const seg of blockSegments) {
      blockOffsets.push(bigBuffer.length);
      bigBuffer += seg.text;
      bigBuffer += '\n'; // synthetic separator
    }

    HTML_COMMENT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HTML_COMMENT_RE.exec(bigBuffer)) !== null) {
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;
      // Emit one inline decoration per block the match overlaps.
      // Within a block, the decoration covers from match-start (or
      // block-start) through match-end (or block-end). The
      // synthetic `\n` between blocks is never decorated because
      // it's not a real doc position.
      for (let i = 0; i < blockSegments.length; i++) {
        const seg = blockSegments[i];
        const segStartInBuffer = blockOffsets[i];
        const segEndInBuffer = segStartInBuffer + seg.text.length;
        // Does the match overlap this block's text range?
        if (matchEnd <= segStartInBuffer) break; // match ends before this block starts
        if (matchStart >= segEndInBuffer) continue; // match starts after this block ends

        const localStart = Math.max(matchStart, segStartInBuffer) - segStartInBuffer;
        const localEnd = Math.min(matchEnd, segEndInBuffer) - segStartInBuffer;
        if (localEnd <= localStart) continue;
        if (localEnd > seg.positions.length) continue;

        const startPos = seg.positions[localStart];
        const lastChar = seg.positions[localEnd - 1];
        if (startPos == null || lastChar == null) continue;
        decorations.push(
          Decoration.inline(startPos, lastChar + 1, {
            class: 'raise-comment',
          }),
        );
      }
    }
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * Un-escape comment delimiters and inner content in serialized
 * markdown
 * ([RAISE-31](https://risepeople.atlassian.net/browse/RAISE-31) round-trip fix).
 *
 * Two related concerns, handled in one pass over the output:
 *
 *   1. **Leading `\<!--`**. When the user types `<!--` in
 *      WYSIWYG, the doc gains plain text characters. On
 *      serialize, mdast-util-to-markdown's `safe` step escapes
 *      `<` (it's in the unsafe set — start of inline HTML /
 *      autolinks). The source on disk becomes `\<!-- foo -->`
 *      instead of `<!-- foo -->`. Strip the leading `\` so the
 *      delimiter is clean.
 *
 *   2. **Inner content escapes**. Within a comment, the same
 *      safe step also escapes `[`, `]`, `(`, `)`, `*`, `_`,
 *      `:`, `.`, `@` etc. — see the character-set comment in
 *      the regex below. HTML comments don't have backslash-
 *      escape semantics (the entire comment value is opaque
 *      to the markdown parser), so the escapes are inert
 *      noise — strip them.
 *
 * Combined into a single regex pass: find every `\<!-- ... -->`
 * or `<!-- ... -->` region and (a) drop a leading backslash
 * unless it itself was escaped, (b) strip backslashes from
 * common markdown-syntax characters inside the comment.
 *
 * Outside a comment context, `\<` is preserved (the user might
 * have typed it deliberately to escape an inline-html opening
 * in prose).
 *
 * **Escape-of-escape edge case**: `\\<!--` (two backslashes
 * then comment) means "literal backslash, then comment open"
 * after the markdown parser unescapes it. We must NOT treat
 * this as `\<!--` (escape of comment open), because doing so
 * would discard the user's literal-backslash intent. The
 * negative-lookbehind in the regex (`(?<!\\)\\<!--`) skips the
 * leading-`\`-strip when the `\` is itself preceded by another
 * `\`.
 */
export function unescapeCommentDelimiters(markdown: string): string {
  // `\<!--` always contains the substring `<!--`, so checking
  // for `<!--` alone is sufficient as the early-out — covers
  // both escaped and unescaped forms.
  if (!markdown || !markdown.includes('<!--')) return markdown;
  return markdown.replace(/(?<!\\)(\\?)<!--[\s\S]*?-->/g, (comment, esc) => {
    // `esc` is either '' (clean `<!--`) or '\\' (escaped `\<!--`,
    // and the negative-lookbehind guarantees that backslash
    // wasn't itself preceded by another `\`). Strip the escape.
    let result = comment;
    if (esc === '\\') result = result.slice(1);
    // Strip backslash-escape from common markdown-syntax chars
    // inside the comment.
    //
    // Character set covers everything mdast-util-to-markdown's
    // safe step + remark-gfm's autolink-literal extension might
    // add a `\` in front of inside a text node:
    //
    //   - `[`, `]`, `(`, `)` — link syntax
    //   - `<`, `>` — inline HTML / autolinks
    //   - `*`, `_` — emphasis / strong
    //   - `!` — image
    //   - `#` — heading prefix
    //   - `` ` `` — code span
    //   - `~` — strikethrough
    //   - `|` — table cell
    //   - `:` — gfm-autolink-literal escapes `:` after `[ps]`
    //     before `/` to break URL re-parsing (`https\://`)
    //   - `.` — gfm-autolink-literal escapes `.` after `[Ww]`
    //     to break `www.example.com` re-parsing
    //   - `@` — gfm-autolink-literal escapes `@` between word
    //     chars to break email re-parsing (`user\@host.com`)
    //
    // Inside an HTML comment all of these are inert content
    // (the markdown parser treats the comment value as opaque),
    // so stripping the `\` is always safe.
    result = result.replace(/\\([[\]()<>*_!#`~|:.@])/g, '$1');
    return result;
  });
}

/**
 * Strip `&#x20;` numeric character entities from serialized
 * markdown ([RAISE-31](https://risepeople.atlassian.net/browse/RAISE-31)
 * indented-line fix).
 *
 * mdast-util-to-markdown encodes a *leading* space at the start
 * of a paragraph as the entity `&#x20;` to prevent the
 * commonmark parser from re-interpreting it as part of an
 * indented-code-block (4+ leading spaces = code). For our
 * intended use case — `  // an indented note` — the encoding
 * is technically correct but visually horrible: the source
 * reads `&#x20; // an indented note` instead of just
 * `  // an indented note`.
 *
 * Strip every `&#x20;` back to a literal space. Trade-off: a
 * user who typed `&#x20;` deliberately as a literal entity
 * (rare) loses it. We strip globally rather than only at
 * line-start because the encoding can also appear mid-line in
 * some Milkdown serialiser paths (trailing-space preservation
 * uses the same entity), and the user-typed-literal case is
 * vanishingly rare in practice. Markdown renderers that
 * encounter literal `&#x20;` decode it to a space anyway, so
 * the visible-result is unchanged either way — only the
 * source-view representation differs.
 */
export function unescapeIndentEntities(markdown: string): string {
  if (!markdown || !markdown.includes('&#x20;')) return markdown;
  return markdown.replace(/&#x20;/g, ' ');
}

/**
 * ProseMirror plugin that maintains a `DecorationSet` of
 * comment-styling decorations, rebuilt on every doc change.
 * Performance: `descendants` is O(N) in the doc node count,
 * runs once per transaction, well below the per-keystroke
 * budget for typical doc sizes.
 */
export const commentDecorationsPlugin = $prose(() => {
  return new Plugin<DecorationSet>({
    key: commentDecorationsKey,
    state: {
      init: (_, { doc }) => buildDecorations(doc),
      apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
    },
    props: {
      decorations(state) {
        return commentDecorationsKey.getState(state);
      },
    },
  });
});
