import { $inputRule, $nodeSchema, $remark } from '@milkdown/utils';
import { InputRule } from '@milkdown/prose/inputrules';
import { TextSelection } from '@milkdown/prose/state';
import type { Node as MdastNode, Parent as MdastParent, Text as MdastText } from 'mdast';
import { nameToEmoji } from 'gemoji';
import { SKIP, visit } from 'unist-util-visit';

/**
 * GitHub-style emoji shortcodes for the WYSIWYG editor ([RAISE-34](https://risepeople.atlassian.net/browse/RAISE-34)).
 *
 * Wires four pieces together:
 *
 * 1. A custom `gemoji` mdast node type, produced by a remark plugin
 *    that walks text nodes and splits valid `:name:` shortcodes out
 *    into their own typed nodes.
 *
 * 2. A Milkdown `$nodeSchema('gemoji', ...)` that round-trips between
 *    the mdast `gemoji` type and a ProseMirror inline atom node with
 *    a `name` attribute.
 *
 * 3. A ProseMirror input rule that fires when the user types the
 *    closing `:` of a valid shortcode mid-document, replacing the
 *    typed text with a gemoji node.
 *
 * 4. (Implicit) the schema's `toDOM` renders the actual emoji
 *    character; no custom NodeView needed because the leaf has no
 *    interactive children.
 *
 * Round-trip preservation: source `:warning:` parses to a `gemoji`
 * mdast node `{name: 'warning'}` → ProseMirror gemoji node carrying
 * the same name → on serialise, `toMarkdown` emits an mdast text
 * node with literal value `:warning:` (which remark-stringify
 * outputs verbatim, no custom stringify handler needed). The
 * shortcode form is preserved bit-for-bit through any number of
 * edit cycles.
 *
 * Why preview's `markdown-it-emoji` and our remark plugin coexist:
 * the preview pane runs an entirely separate markdown-it pipeline
 * ([RAISE-30](https://risepeople.atlassian.net/browse/RAISE-30) `SplitView.tsx`); this module only affects the
 * Milkdown / WYSIWYG path. Both surfaces use the same underlying
 * `gemoji` package's `nameToEmoji` table so the rendered set is
 * consistent.
 */

// All 1913 gemoji names match this character class. Using a tight
// pattern keeps the matcher cheap and avoids false-positives from
// stray colons (e.g. URL `https://...`, time `12:34`, etc.).
const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g;

/**
 * mdast extension carrying the gemoji name. Lives between
 * remark-parse and Milkdown's parser. This shape is compatible with
 * remark-stringify's "ignore unknown" behaviour because we never
 * actually emit it on the stringify side — `toMarkdown.runner`
 * below produces a standard text node instead.
 */
interface GemojiMdastNode extends MdastNode {
  type: 'gemoji';
  name: string;
}

/**
 * Remark plugin: walk the mdast tree, split text nodes that contain
 * valid `:name:` shortcodes into a sequence of [text, gemoji, text, …]
 * children. Code blocks (`code`) and inline code (`inlineCode`) are
 * separate mdast types and aren't visited as `text` — so shortcodes
 * inside them are correctly left alone.
 */
function remarkGemojiSplit(): (tree: MdastNode) => void {
  return (tree) => {
    visit(tree, 'text', (textNode, index, parent) => {
      if (parent == null || index == null) return;
      const text = (textNode as MdastText).value;
      if (!text.includes(':')) return;

      const matches: { start: number; end: number; name: string }[] = [];
      // Reset lastIndex per call — we use the global flag for full-text
      // scanning but the regex object is module-level.
      SHORTCODE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SHORTCODE_RE.exec(text)) !== null) {
        const name = m[1];
        // Only treat as a shortcode if the name resolves to a known
        // gemoji. `:not-an-emoji:` falls through unchanged.
        if (name && nameToEmoji[name] != null) {
          matches.push({ start: m.index, end: m.index + m[0].length, name });
        }
      }
      if (matches.length === 0) return;

      const replacement: MdastNode[] = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.start > cursor) {
          replacement.push({
            type: 'text',
            value: text.slice(cursor, match.start),
          } as MdastText);
        }
        replacement.push({
          type: 'gemoji',
          name: match.name,
        } as GemojiMdastNode);
        cursor = match.end;
      }
      if (cursor < text.length) {
        replacement.push({
          type: 'text',
          value: text.slice(cursor),
        } as MdastText);
      }

      (parent as MdastParent).children.splice(
        index,
        1,
        ...(replacement as MdastParent['children']),
      );
      // Tell `visit` to skip past the replacements (they don't contain
      // further text nodes that need re-scanning).
      return [SKIP, index + replacement.length];
    });
  };
}

export const remarkGemojiPlugin = $remark('remarkGemoji', () => remarkGemojiSplit);

export const gemojiSchema = $nodeSchema('gemoji', () => ({
  inline: true,
  group: 'inline',
  // Mirror the image schema in @milkdown/preset-commonmark — image is
  // also an inline atom and renders cleanly without caret-positioning
  // bugs. The combination matters: `selectable: true` lets the node
  // act as a single unit for cursor purposes, `defining: true` +
  // `isolating: true` tell ProseMirror this is a self-contained
  // inline node with its own boundaries.
  selectable: true,
  atom: true,
  defining: true,
  isolating: true,
  marks: '',
  attrs: {
    name: { default: '', validate: 'string' },
  },
  parseDOM: [
    {
      // Higher than the default 50 priority so this rule wins over
      // image's `img[src]` — both match our rendered DOM, but the
      // `data-gemoji` attribute is the discriminator.
      tag: 'img[data-gemoji]',
      priority: 51,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const name = dom.getAttribute('data-gemoji') ?? '';
        if (!name || nameToEmoji[name] == null) return false;
        return { name };
      },
    },
    {
      // Legacy: earlier rounds of the implementation rendered the
      // gemoji as a `<span>`. Keep this rule for paste-recovery from
      // any pre-img copy, but the live render now goes through the
      // `<img>` path above.
      tag: 'span[data-gemoji]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const name = dom.getAttribute('data-gemoji') ?? '';
        if (!name || nameToEmoji[name] == null) return false;
        return { name };
      },
    },
  ],
  toDOM: (node) => {
    const name = (node.attrs as { name?: string }).name ?? '';
    const emoji = nameToEmoji[name] ?? `:${name}:`;
    // Render as an `<img>` containing an inline-SVG data URL of the
    // emoji glyph. Why <img>:
    //
    // Three rounds of <span>-based fixes (text child, ::before
    // pseudo-element, contenteditable="false", trailing-break CSS
    // suppression) all failed to fix the visual caret-jump after
    // input-rule insertion. The categorical difference between
    // <span> and <img> is that <img> is a *replaced element*: the
    // layout engine and Chromium's contentEditable engine both
    // treat it as an opaque box with intrinsic dimensions and hard
    // boundary positions. ProseMirror's image schema (the only
    // other inline atom shipping in this app) uses <img> and is
    // confirmed to work without caret bugs.
    //
    // We can't use a "real" image of the emoji (would need bundled
    // assets or a CDN). Inline SVG with the emoji as a <text>
    // element keeps the rendering self-contained: the system's
    // color-emoji font (Apple Color Emoji on macOS, Segoe UI Emoji
    // on Windows, Noto Color Emoji on Linux) renders the glyph
    // inside the SVG, producing the same color-emoji output as
    // plain text.
    //
    // Round-trip preservation (toMarkdown emits `:name:`) is
    // unaffected — only the in-DOM rendering changes.
    const safe = emoji
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
      `<text x="8" y="8" font-size="14" text-anchor="middle" ` +
      `dominant-baseline="central" ` +
      `font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">` +
      `${safe}</text></svg>`;
    return [
      'img',
      {
        src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
        // `alt` doubles as the screen-reader announcement and the
        // text shown if the data URL ever fails to render.
        alt: emoji,
        'data-gemoji': name,
        'aria-label': `:${name}:`,
      },
    ];
  },
  parseMarkdown: {
    match: ({ type }) => type === 'gemoji',
    runner: (state, node, type) => {
      const name = (node as unknown as { name?: string }).name ?? '';
      state.addNode(type, { name });
    },
  },
  toMarkdown: {
    // Emit a plain mdast text node with the `:name:` shortcode. The
    // built-in remark-stringify text handler outputs it verbatim, so
    // we don't need to register a custom stringify handler for
    // `gemoji` mdast nodes (which would otherwise be needed because
    // remark-stringify doesn't know that type).
    match: (node) => node.type.name === 'gemoji',
    runner: (state, node) => {
      const name = (node.attrs as { name?: string }).name ?? '';
      state.addNode('text', undefined, `:${name}:`);
    },
  },
}));

/**
 * Input rule fires when the user finishes typing the closing `:` of
 * a valid shortcode. The regex is anchored to `$` so it only matches
 * at the cursor's current end-of-typing position; ProseMirror's
 * input-rule infrastructure scopes that to a single text-block.
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
 * haven't closed yet, so we're mid-typing-code-span and should bail.
 *
 * Note on Cmd+Z: ProseMirror's input-rule history doesn't currently
 * group the rule's transformation as a separate undo step from the
 * triggering keystroke, so undo deletes the trailing `:` rather than
 * reverting the conversion. Working as designed in
 * prosemirror-inputrules; matches the behaviour of every other
 * input rule in Milkdown (e.g. `_italic_` → italic mark + Cmd+Z).
 */
export const gemojiInputRule = $inputRule((ctx) =>
  new InputRule(/:([a-zA-Z0-9_+-]+):$/, (state, match, start, end) => {
    const name = match[1];
    if (!name || nameToEmoji[name] == null) return null;

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

    const node = gemojiSchema.type(ctx).create({ name });
    const tr = state.tr.replaceWith(start, end, node);
    // Place the caret immediately after the inserted atom. By
    // default `replaceWith` lets ProseMirror infer the post-insertion
    // selection, which can land on a NodeSelection over the new
    // atom rather than a text caret beside it — small thing, but
    // explicit positioning eliminates a class of "weird state after
    // input rule fires" surprises.
    return tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize));
  }),
);

/**
 * Bundle the three plugins so consumers can `.use(gemojiPlugins)` in
 * one shot. Order matters within the array — schema before input
 * rule (input rule references the schema's NodeType via `gemojiSchema.type(ctx)`).
 */
export const gemojiPlugins = [remarkGemojiPlugin, gemojiSchema, gemojiInputRule];
