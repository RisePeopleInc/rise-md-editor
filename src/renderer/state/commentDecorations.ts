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
    // Don't descend into code blocks. Their `// ...` and `<!-- ... -->`
    // content is literal code, not commentary.
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;

    const text = node.textContent;
    if (text.length === 0) return false;

    // Whole-paragraph "line comment": text starts with `//` after
    // optional leading whitespace. Decorate the entire paragraph
    // and don't bother scanning for HTML comments inside it (the
    // user's intent is "this entire line is a comment", inclusive
    // of any literal `<!--` they happened to type).
    if (LINE_COMMENT_RE.test(text)) {
      const start = pos + 1; // step past the textblock open token
      const end = pos + 1 + node.content.size;
      decorations.push(
        Decoration.inline(start, end, { class: 'raise-comment' }),
      );
      return false;
    }

    // Otherwise, scan each text-child for `<!--...-->` patterns.
    // We walk children manually (rather than just regexing
    // `textContent`) so we can skip text nodes that carry the
    // `code` mark — those are inline code spans whose `<!--`
    // should stay literal.
    let offset = 0;
    node.forEach((child) => {
      if (child.isText && child.text) {
        const codeMarked = child.marks.some(
          (m) => m.type.name === 'code',
        );
        if (!codeMarked) {
          HTML_COMMENT_RE.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = HTML_COMMENT_RE.exec(child.text)) !== null) {
            const start = pos + 1 + offset + match.index;
            const end = start + match[0].length;
            decorations.push(
              Decoration.inline(start, end, { class: 'raise-comment' }),
            );
          }
        }
      }
      offset += child.nodeSize;
    });

    return false;
  });

  return DecorationSet.create(doc, decorations);
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
