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
 *   1. `<!-- text -->`  (HTML-style, inline or block)
 *   2. `// text`        (line-start, after optional whitespace)
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
 * Skipped contexts:
 *
 *   - Code blocks (`code_block`, `code: true` in spec): the doc
 *     traversal short-circuits with `return false`, so we never
 *     descend into them.
 *   - Inline code marks: when we walk a textblock's children we
 *     check each text node for the `code` mark and skip it. This
 *     keeps `` `<!-- not a comment -->` `` literal inside inline
 *     code, and `` `// also not a comment` `` literal too.
 *
 * URL safety: the line-comment regex is anchored `^[ \t]*\/\/`,
 * and we apply it only to a paragraph's *textContent starts with*
 * — never mid-line. So `Visit https://example.com` never matches
 * (the `//` follows `:`, not line-start).
 */

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const LINE_COMMENT_RE = /^[ \t]*\/\/.*/;

const commentDecorationsKey = new PluginKey<DecorationSet>(
  'raiseCommentDecorations',
);

function buildDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    // Don't descend into code blocks. Their `// ...` and
    // `<!-- ... -->` content is literal code, not commentary.
    if (node.type.spec.code) return false;

    // HTML atoms: when source contains `<!-- ... -->`, the
    // commonmark parser turns it into an `html` ProseMirror node
    // (an inline atom) carrying the literal HTML as its `value`
    // attribute. Decorate the atom directly — the textContent
    // walk below skips over atoms (they aren't text children),
    // so they need their own branch.
    if (node.type.name === 'html') {
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

    if (!node.isTextblock) return true;

    const text = node.textContent;

    // Whole-paragraph "line comment": text starts with `//` after
    // optional leading whitespace. Decorate the entire paragraph
    // and don't bother scanning for HTML comments inside it (the
    // user's intent is "this entire line is a comment", inclusive
    // of any literal `<!--` they happened to type).
    if (text.length > 0 && LINE_COMMENT_RE.test(text)) {
      const start = pos + 1; // step past the textblock open token
      const end = pos + 1 + node.content.size;
      decorations.push(
        Decoration.inline(start, end, { class: 'raise-comment' }),
      );
      return false;
    }

    // Inline `<!-- ... -->` patterns in text. Build a flat
    // text buffer of the paragraph's NON-code-marked text plus a
    // parallel position-mapping array, then run the regex on the
    // buffer. This lets the comment span across multiple text
    // children with different marks — e.g. when a user types
    // `<!-- see [link](url) -->` and Milkdown's link input rule
    // wraps the inner `link` in a separate text child — the
    // `<!--` and `-->` are in different children but the
    // comment as a whole is a single contiguous range in the
    // doc, which is what we need to decorate.
    //
    // Code-marked text is excluded from the buffer entirely so
    // `<!--` inside inline code stays literal. The
    // position-mapping ignores code-marked positions, so a
    // match that "spans" a code-marked region wouldn't decorate
    // (the buffer would just have the non-code text concatenated
    // contiguously, and the regex would run on that — but the
    // match positions wouldn't include the code chars). Edge
    // case; very unlikely to misbehave in real content.
    const blockStart = pos + 1;
    let buffer = '';
    const positions: number[] = [];
    let offset = 0;
    node.forEach((child) => {
      if (child.isText && child.text) {
        const codeMarked = child.marks.some(
          (m) => m.type.name === 'code',
        );
        if (!codeMarked) {
          for (let i = 0; i < child.text.length; i++) {
            buffer += child.text[i];
            positions.push(blockStart + offset + i);
          }
        }
      }
      offset += child.nodeSize;
    });

    HTML_COMMENT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HTML_COMMENT_RE.exec(buffer)) !== null) {
      const startInBuffer = match.index;
      const endInBuffer = match.index + match[0].length;
      // `positions[i]` is the doc position of `buffer[i]`. The
      // decoration's `to` argument is exclusive — pass the
      // position immediately *after* the last buffer char.
      if (endInBuffer <= positions.length) {
        const startPos = positions[startInBuffer];
        const lastChar = positions[endInBuffer - 1];
        if (startPos != null && lastChar != null) {
          decorations.push(
            Decoration.inline(startPos, lastChar + 1, {
              class: 'raise-comment',
            }),
          );
        }
      }
    }

    return false;
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Un-escape `\<!--` -> `<!--` in serialized markdown
 * ([RAISE-31](https://risepeople.atlassian.net/browse/RAISE-31) round-trip fix).
 *
 * When the user types `<!--` in WYSIWYG, the doc gains plain
 * text characters. On serialize, remark-stringify treats `<` as
 * unsafe (it's the start of inline HTML / autolinks in markdown
 * spec) and escapes it to `\<` — so the source on disk becomes
 * `\<!-- foo -->` instead of `<!-- foo -->`.
 *
 * That's both ugly to look at in source mode AND defeats
 * round-trip: re-parsing `\<!--` produces a literal `<` text
 * character, not an HTML comment. (Our decoration plugin still
 * catches the `<!-- ... -->` pattern in text and decorates, so
 * the visual is correct — but the source is dirty.)
 *
 * Comments are deliberately HTML-shaped, so the escaping isn't
 * doing useful work here. Strip the leading backslash from any
 * `\<!--` sequence in the post-process pipeline (called from
 * `markdownUpdated`, alongside `emojiToShortcodes` and
 * `stripEmptyParagraphMarkers`).
 *
 * The corresponding `-->` at end of an inline string isn't
 * escaped by remark-stringify (the `>` rule only triggers at
 * line-start for blockquotes), so we don't need a counterpart
 * unescape for the closing fence.
 *
 * Fast-path: skip the work entirely if the input doesn't
 * contain `\<` at all.
 */
export function unescapeCommentDelimiters(markdown: string): string {
  if (!markdown || !markdown.includes('\\<')) return markdown;
  return markdown.replace(/\\<!--/g, '<!--');
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
