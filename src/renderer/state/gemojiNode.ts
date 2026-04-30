import type { MilkdownPlugin } from '@milkdown/ctx';
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
 *    number of edit cycles. Code blocks and inline code spans are
 *    skipped (the substitution operates on text segments only),
 *    mirroring the parse-side mdast type filtering.
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
 * Suppresses two flavours of "user is inside an inline code span":
 *
 *   1. **Closed code span, edited mid-content.** The user has an
 *      existing `` `code` `` and inserts `:warning:` inside. The
 *      `code` mark is applied to the position; we read it from the
 *      resolved position's marks and bail.
 *
 *   2. **Unclosed code span, mid-typing.** The user has typed
 *      `` `code with :warning: `` but not the closing backtick yet.
 *      Milkdown's commonmark applies the `code` mark only after
 *      the closing backtick, so at this moment there's no mark to
 *      inspect. Instead we count unescaped backticks in the
 *      current text block before the cursor; odd count means
 *      there's an open `` ` `` and we bail.
 *
 * Together the two checks cover both shapes — without either, an
 * input rule fired inside a code context would silently corrupt
 * the user's literal `:name:`.
 */
export const gemojiInputRule = $inputRule(
  () =>
    new InputRule(/:([a-zA-Z0-9_+-]+):$/, (state, match, start, end) => {
      const name = match[1];
      if (!name) return null;
      const emoji = nameToEmoji[name];
      if (emoji == null) return null;

      const $start = state.doc.resolve(start);

      // Check (1): closed inline-code span with the `code` mark
      // already applied at the matched position.
      const codeMark = state.schema.marks.code;
      if (codeMark && codeMark.isInSet($start.marks())) return null;

      // Check (2): unclosed code span — count unescaped backticks
      // in the current textblock before the cursor; odd count
      // means an open `` ` `` is pending.
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
// `$remark` and `$inputRule` return tuple-with-extras objects from
// Milkdown's factory helpers — they have a `.plugin: MilkdownPlugin`
// property and Milkdown's `.use()` accepts them, but the structural
// type isn't `MilkdownPlugin` itself. Cast to keep `.use(gemojiPlugins)`
// type-checking. Mirrors how `@milkdown/plugin-cursor` exports its own
// plugin array as `MilkdownPlugin[]`.
export const gemojiPlugins: MilkdownPlugin[] = [
  remarkGemojiPlugin,
  gemojiInputRule,
] as unknown as MilkdownPlugin[];

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
 * Match a code region the serialize-side substitution must skip:
 *
 *   - fenced code block: ``` (or ~~~) at line start, content,
 *     matching closing fence at line start
 *   - inline code: ` … ` or `` … `` (one or two backticks)
 *
 * Anchored with `m` flag so `^` / `$` mean line start / end.
 * Order matters: fenced fences are matched before inline
 * backticks so the latter doesn't slice into a fence body.
 *
 * Pragmatic and not 100% commonmark-correct (doesn't handle
 * indented code blocks, or arbitrary backtick run lengths beyond
 * 1 / 2 / 3+), but covers the realistic shapes well enough that
 * an emoji glyph deliberately placed inside a code block stays
 * verbatim on save.
 */
const CODE_REGION_RE = /^```[\s\S]*?^```$|^~~~[\s\S]*?^~~~$|``[^`\n]+``|`[^`\n]+`/gm;

function substituteEmojiInRange(text: string): string {
  ALL_EMOJI_RE.lastIndex = 0;
  return text.replace(ALL_EMOJI_RE, (match) => {
    const name = emojiToName[match];
    return name != null ? `:${name}:` : match;
  });
}

/**
 * Single-slot memoization. The serialize-side post-process runs in
 * the `markdownUpdated` listener, which fires per keystroke; for
 * any single edit the function gets a unique input, but spurious
 * duplicate notifications (or upstream re-emits) hit the cache.
 *
 * One slot is enough — Milkdown's listener already short-circuits
 * `markdown === prev` before calling us, so the typical sequence
 * is "increasingly different inputs over time" with the most
 * recent input being the hot one to repeat-process.
 */
let lastIn: string | null = null;
let lastOut: string | null = null;

/**
 * Inverse of `remarkGemojiSubstitute`: walk a serialized markdown
 * string and replace every gemoji character with its primary
 * `:name:` shortcode. Used at the WYSIWYG editor's serialize-side
 * boundary so the source on disk preserves the shortcode form.
 *
 * Code-region awareness: emoji characters inside fenced code blocks
 * (``` or ~~~) and inline code (` or ``) are passed through
 * verbatim, mirroring the parse-side asymmetry where mdast `code` /
 * `inlineCode` nodes aren't visited as `text`. The rest of the
 * markdown is split into [text, code, text, code, …] segments by
 * `CODE_REGION_RE` and the substitution runs only on the text
 * segments.
 *
 * Caveat: `gemoji.emojiToName` returns one *primary* name per
 * emoji. If a file used a non-primary alias (`:woman_running:`
 * where the primary is `:running_woman:`), the round-trip will
 * normalise to the primary. For the common case where the alias
 * IS the primary (`:warning:`, `:fire:`, `:tada:`, `:cat:`, …)
 * the source is preserved bit-for-bit.
 *
 * Performance:
 *
 *   - Fast-path: if the input contains no emoji at all (cheap
 *     `.test()` against the alternation regex), return unchanged.
 *   - Memoization: a single-slot cache short-circuits when the
 *     same input is processed twice in a row. The listener
 *     already filters `markdown === prev`, but spurious duplicate
 *     emits or upstream re-emits hit the cache.
 *   - Otherwise: O(N) scan for code regions + O(N) substitution
 *     in the non-code segments. Negligible for typical doc sizes
 *     (sub-millisecond on a few hundred KB).
 */
export function emojiToShortcodes(markdown: string): string {
  if (!markdown) return markdown;
  if (markdown === lastIn && lastOut !== null) return lastOut;
  ALL_EMOJI_RE.lastIndex = 0;
  if (!ALL_EMOJI_RE.test(markdown)) {
    lastIn = markdown;
    lastOut = markdown;
    return markdown;
  }

  let result = '';
  let cursor = 0;
  CODE_REGION_RE.lastIndex = 0;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = CODE_REGION_RE.exec(markdown)) !== null) {
    if (codeMatch.index > cursor) {
      result += substituteEmojiInRange(markdown.slice(cursor, codeMatch.index));
    }
    // Code region — passed through unchanged so emoji glyphs stay
    // verbatim inside code blocks / inline code.
    result += codeMatch[0];
    cursor = codeMatch.index + codeMatch[0].length;
  }
  if (cursor < markdown.length) {
    result += substituteEmojiInRange(markdown.slice(cursor));
  }
  lastIn = markdown;
  lastOut = result;
  return result;
}
