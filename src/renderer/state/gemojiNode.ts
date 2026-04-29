import { $inputRule, $remark } from '@milkdown/utils';
import { InputRule } from '@milkdown/prose/inputrules';
import type { Node as MdastNode, Text as MdastText } from 'mdast';
import { emojiToName, nameToEmoji } from 'gemoji';
import { visit } from 'unist-util-visit';

/**
 * GitHub-style emoji shortcodes for the WYSIWYG editor ([RAISE-34](https://risepeople.atlassian.net/browse/RAISE-34)).
 *
 * Design: shortcodes (`:cat:`) are the canonical *source* form on
 * disk; emoji characters (`🐱`) are the *display* form inside the
 * WYSIWYG editor. The substitution happens at the editor's I/O
 * boundary so that:
 *
 *   - source files use shortcodes (compatible with markdown from
 *     other editors that emit them — Obsidian, Bear, IntelliJ, etc.)
 *   - inside the editor model the emoji is a plain Unicode character
 *     in a text node — no custom schema, no inline atom, no NodeView,
 *     no contentEditable special-casing, so the caret behaves like
 *     it does for any other character
 *
 * Three substitution sites, two directions:
 *
 * 1. **Parse-side** (`remarkGemojiSubstitute`): walks mdast `text`
 *    nodes when a markdown source is loaded and replaces every
 *    `:name:` whose name resolves to a known gemoji with the emoji
 *    character. Code blocks (`code`) and inline code (`inlineCode`)
 *    are separate mdast types and aren't visited as `text`, so
 *    shortcodes inside them are left alone.
 *
 * 2. **Type-side** (`gemojiInputRule`): the ProseMirror input rule
 *    fires when the user types the closing `:` of a valid shortcode
 *    in WYSIWYG and replaces the typed text with the emoji
 *    character.
 *
 * 3. **Serialize-side** (`emojiToShortcodes`): a string-level
 *    post-process called from the WYSIWYG editor's `markdownUpdated`
 *    listener that walks the serialized markdown and replaces every
 *    emoji character that has a primary name in `gemoji.emojiToName`
 *    with `:name:`. This is the inverse of `remarkGemojiSubstitute`,
 *    so a `:warning:` shortcode round-trips bit-for-bit through any
 *    number of edit cycles.
 *
 * Earlier rounds of this feature tried to preserve the shortcode
 * form via a custom mdast `gemoji` node + a ProseMirror inline atom
 * schema. That approach repeatedly hit Chromium contentEditable
 * caret-rendering bugs that no combination of toDOM shape, NodeView,
 * `contenteditable="false"`, CSS pseudo-element rendering, or
 * trailing-break suppression could fix. The breakthrough was
 * realising emoji are just Unicode characters — pushing the
 * substitution out to the I/O boundary keeps the model dead-simple
 * (plain text) while still preserving the source on disk.
 *
 * The preview pane (markdown-it-emoji from RAISE-30) does the same
 * `:name:` → emoji substitution on its own pipeline, so both
 * surfaces render the emoji identically and now have identical DOM
 * shape (plain text runs in both).
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

/**
 * Build a regex that matches any emoji character in the gemoji
 * table. Sorted longest-first so multi-codepoint emoji (e.g. ⚠️ =
 * U+26A0 + U+FE0F) match before any single-codepoint variant of
 * the same glyph. Module-scoped so the regex is built once at
 * import time, not per `emojiToShortcodes` call.
 */
const EMOJI_KEYS = Object.keys(emojiToName)
  .slice()
  .sort((a, b) => b.length - a.length);
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const ALL_EMOJI_RE = new RegExp(
  EMOJI_KEYS.map((emoji) => emoji.replace(REGEX_META, '\\$&')).join('|'),
  'g',
);

/**
 * Inverse of `remarkGemojiSubstitute`: walk a serialized markdown
 * string and replace every gemoji character with its primary
 * `:name:` shortcode. Used at the WYSIWYG editor's serialize-side
 * boundary so the source on disk preserves the shortcode form.
 *
 * Caveat: `gemoji.emojiToName` returns one *primary* name per
 * emoji. If a file used a non-primary alias (`:woman_running:`
 * where the primary is `:running_woman:`), the round-trip will
 * normalise to the primary. For the common case where the alias
 * IS the primary (`:warning:`, `:fire:`, `:tada:`, `:cat:`, …)
 * the source is preserved bit-for-bit.
 *
 * Caveat 2: this operates on the raw markdown string, not on a
 * parsed mdast tree, so an emoji character that lives inside a
 * fenced code block will also be converted to its shortcode form.
 * The realistic scenario for that — a code block containing a
 * literal emoji rather than text — is rare enough that we accept
 * the trade-off; doing it AST-aware would require splitting the
 * substitution back into a remark stringify-only plugin, which
 * Milkdown's shared parse/stringify remark instance makes
 * non-trivial.
 *
 * Fast-path: if the input string doesn't match `ALL_EMOJI_RE` at
 * all, return it unchanged. The regex test is much cheaper than
 * `String.prototype.replace` over the whole document for files
 * that don't contain emoji.
 */
export function emojiToShortcodes(markdown: string): string {
  if (!markdown) return markdown;
  ALL_EMOJI_RE.lastIndex = 0;
  if (!ALL_EMOJI_RE.test(markdown)) return markdown;
  ALL_EMOJI_RE.lastIndex = 0;
  return markdown.replace(ALL_EMOJI_RE, (match) => {
    const name = emojiToName[match];
    return name != null ? `:${name}:` : match;
  });
}
