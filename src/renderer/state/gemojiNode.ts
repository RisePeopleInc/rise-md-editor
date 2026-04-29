import { $inputRule, $remark } from '@milkdown/utils';
import { InputRule } from '@milkdown/prose/inputrules';
import type { Node as MdastNode, Text as MdastText } from 'mdast';
import { nameToEmoji } from 'gemoji';
import { visit } from 'unist-util-visit';

/**
 * GitHub-style emoji shortcodes for the WYSIWYG editor ([RAISE-34](https://risepeople.atlassian.net/browse/RAISE-34)).
 *
 * Design: a shortcode is just a typing aid for the underlying emoji
 * character. `:cat:` is treated as a more-typeable spelling of `🐱`,
 * and the substitution is one-way — once converted, the source ends
 * up with the emoji character.
 *
 * Two substitution paths, both producing the same result (a plain
 * text node containing the emoji glyph, no custom schema involved):
 *
 * 1. **Parse time**, via a tiny remark plugin (`remarkGemojiSubstitute`):
 *    walks mdast `text` nodes when a markdown source is loaded into
 *    the editor and replaces every `:name:` whose name resolves to a
 *    known gemoji with the emoji character. Code blocks (`code`) and
 *    inline code (`inlineCode`) are separate mdast types and aren't
 *    visited as `text`, so shortcodes inside them are correctly left
 *    alone.
 *
 * 2. **Type time**, via a ProseMirror input rule (`gemojiInputRule`):
 *    fires when the user types the closing `:` of a valid shortcode
 *    in the WYSIWYG editor and replaces the typed text with the
 *    emoji character.
 *
 * Round-trip note: there's no preservation of the `:name:` form. A
 * file containing `:warning:` in source, after any edit + save in
 * WYSIWYG, will have `⚠️` in source. This matches how Slack, GitHub,
 * Discord and most chat systems handle emoji shortcodes — the
 * shortcode is an input convenience, the emoji character is the
 * canonical storage form.
 *
 * Earlier rounds of this feature tried to preserve the shortcode
 * form via a custom mdast `gemoji` node + a ProseMirror inline atom
 * schema. That approach repeatedly hit Chromium contentEditable
 * caret-rendering bugs that no combination of toDOM shape, NodeView,
 * `contenteditable="false"`, CSS pseudo-element rendering, or
 * trailing-break suppression could fix. Dropping the custom node
 * eliminates the whole class of problems by construction: an emoji
 * is just a Unicode character in a text run, same as any other.
 *
 * The preview pane (markdown-it-emoji from RAISE-30) does the same
 * substitution on its own pipeline, so both surfaces render the
 * emoji identically — and now with identical DOM shape (plain text
 * runs in both).
 */

// All 1913 gemoji names match this character class. Using a tight
// pattern keeps the matcher cheap and avoids false-positives from
// stray colons (e.g. URL `https://...`, time `12:34`, etc.).
const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g;

/**
 * Remark plugin: walk the mdast tree, replace `:name:` with the
 * emoji character in `text` nodes. Unknown shortcodes are left as
 * literal text.
 */
function remarkGemojiSubstitute(): (tree: MdastNode) => void {
  return (tree) => {
    visit(tree, 'text', (textNode) => {
      const text = (textNode as MdastText).value;
      if (!text.includes(':')) return;
      // Reset lastIndex per call — the regex is module-level with
      // the global flag, so its `lastIndex` carries between scans.
      SHORTCODE_RE.lastIndex = 0;
      const updated = text.replace(SHORTCODE_RE, (match, name: string) => {
        const emoji = nameToEmoji[name];
        return emoji != null ? emoji : match;
      });
      if (updated !== text) {
        (textNode as MdastText).value = updated;
      }
    });
  };
}

export const remarkGemojiPlugin = $remark('remarkGemoji', () => remarkGemojiSubstitute);

/**
 * Input rule fires when the user finishes typing the closing `:` of
 * a valid shortcode. Anchored to `$` so it only matches at the
 * cursor's current end-of-typing position; ProseMirror's input-rule
 * infrastructure scopes that to a single text-block.
 *
 * Validates against `nameToEmoji` so typing `:foo:` (no such emoji)
 * doesn't get converted — it stays as literal text the user can
 * keep typing into without surprises.
 *
 * Suppresses inside an unclosed inline-code span: typing `` `:warning: ``
 * (without the closing backtick yet) shouldn't convert the emoji,
 * because the user's intent is `` `:warning:` `` (literal inline code).
 * Milkdown's commonmark inline-code mark is only applied AFTER the
 * closing backtick is typed, so when our rule fires there's no mark
 * to inspect — instead we count backticks in the current text block
 * before the cursor; odd count means there's an open `` ` `` we
 * haven't closed yet, so we're mid-typing-code-span and bail.
 */
export const gemojiInputRule = $inputRule(
  () =>
    new InputRule(/:([a-zA-Z0-9_+-]+):$/, (state, match, start, end) => {
      const name = match[1];
      if (!name) return null;
      const emoji = nameToEmoji[name];
      if (emoji == null) return null;

      const $start = state.doc.resolve(start);
      const blockStart = $start.start();
      const textBefore = state.doc.textBetween(blockStart, start);
      let backticks = 0;
      for (let i = 0; i < textBefore.length; i++) {
        // Skip escaped backticks — `\`` is a literal char, not an
        // inline-code delimiter.
        if (textBefore[i] === '`' && textBefore[i - 1] !== '\\') backticks++;
      }
      if (backticks % 2 === 1) return null;

      // Plain text replacement: the matched `:name:` becomes the
      // emoji character. No custom node, no atom, no NodeView. The
      // resulting text run is indistinguishable from a paragraph
      // the user typed the emoji into directly.
      return state.tr.insertText(emoji, start, end);
    }),
);

/**
 * Bundle the two plugins so consumers can `.use(gemojiPlugins)` in
 * one shot.
 */
export const gemojiPlugins = [remarkGemojiPlugin, gemojiInputRule];
