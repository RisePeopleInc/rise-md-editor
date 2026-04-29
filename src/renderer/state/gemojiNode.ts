import { $inputRule, $nodeSchema, $remark } from '@milkdown/utils';
import { InputRule } from '@milkdown/prose/inputrules';
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
  selectable: true,
  atom: true,
  marks: '',
  attrs: {
    name: { default: '', validate: 'string' },
  },
  parseDOM: [
    {
      tag: 'span[data-gemoji]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const name = dom.getAttribute('data-gemoji') ?? '';
        // Reject pasted spans whose `data-gemoji` doesn't resolve —
        // we don't want to manufacture broken nodes from arbitrary HTML.
        if (!name || nameToEmoji[name] == null) return false;
        return { name };
      },
    },
  ],
  toDOM: (node) => {
    const name = (node.attrs as { name?: string }).name ?? '';
    return [
      'span',
      {
        'data-gemoji': name,
        // Surface the shortcode to assistive tech alongside the emoji
        // so screen-readers can announce both forms ("warning emoji").
        'aria-label': `:${name}:`,
      },
      nameToEmoji[name] ?? `:${name}:`,
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
 */
export const gemojiInputRule = $inputRule((ctx) =>
  new InputRule(/:([a-zA-Z0-9_+-]+):$/, (state, match, start, end) => {
    const name = match[1];
    if (!name || nameToEmoji[name] == null) return null;
    return state.tr.replaceWith(
      start,
      end,
      gemojiSchema.type(ctx).create({ name }),
    );
  }),
);

/**
 * Bundle the three plugins so consumers can `.use(gemojiPlugins)` in
 * one shot. Order matters within the array — schema before input
 * rule (input rule references the schema's NodeType via `gemojiSchema.type(ctx)`).
 */
export const gemojiPlugins = [remarkGemojiPlugin, gemojiSchema, gemojiInputRule];
