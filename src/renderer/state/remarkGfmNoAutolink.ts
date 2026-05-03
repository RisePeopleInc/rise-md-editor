import type { MilkdownPlugin } from '@milkdown/ctx';
import { $remark } from '@milkdown/utils';
import { combineExtensions } from 'micromark-util-combine-extensions';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import {
  gfmFootnoteFromMarkdown,
  gfmFootnoteToMarkdown,
} from 'mdast-util-gfm-footnote';
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough';
import {
  gfmTableFromMarkdown,
  gfmTableToMarkdown,
} from 'mdast-util-gfm-table';
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item';

/**
 * Custom `remark-gfm` substitute with asymmetric autolink-literal
 * handling ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * The bundled `remark-gfm` plugin (used by `@milkdown/preset-gfm`)
 * registers FIVE GFM extensions with micromark / from-markdown /
 * to-markdown:
 *
 *   1. autolink-literal — bare `<host>.<TLD>` text → link nodes
 *      (parse side), AND `unsafe` rules that escape autolink-trigger
 *      characters (`:` after `[ps]`, `@` between word chars, `.`
 *      after `[Ww]`) in *plain text* on serialize.
 *   2. footnote — `[^foo]` and `[^foo]: …`.
 *   3. strikethrough — `~~text~~`.
 *   4. table — GFM pipe tables.
 *   5. task-list-item — `* [ ]` / `* [x]`.
 *
 * **The asymmetry**: we register autolink-literal on the PARSE side
 * (micromark + from-markdown) but NOT on the SERIALIZE side
 * (to-markdown). Why:
 *
 *   - **Parse side enabled** — the AC requires real URLs
 *     (`https://example.com`, `http://github.com/foo`) and email
 *     addresses (`user@example.com`) to autolink in WYSIWYG. With
 *     autolink-literal off entirely, those would render as plain
 *     text in Edit mode (the user-visible regression that prompted
 *     this rewrite). With it ON, the parser produces `link` mdast
 *     nodes for bare URLs and emails, and Milkdown's link mark
 *     schema converts them to clickable link marks in ProseMirror.
 *   - **Serialize side disabled** — autolink-literal's
 *     `gfmAutolinkLiteralToMarkdown` adds `unsafe` rules that
 *     aggressively escape `:`, `@`, `.` in any plain-text
 *     occurrence. After my `remarkUnautolinkPlugin` reverts a
 *     filename-shaped link (`file.md`) to plain text, the unsafe
 *     rules would re-mangle the result on save — `file.md` itself
 *     wouldn't trigger the rules (no `[Ww]\.` pattern), but a
 *     standalone plain-text `https://example.com` typed by the user
 *     and not yet promoted to a link mark would. The escape
 *     prevents the next parse from re-autolinking, which is the
 *     opposite of what we want. Skipping the toMarkdown extension
 *     keeps plain text byte-faithful.
 *
 *   The two sides of the same extension are independently
 *   register-able, so we can opt into the parse benefit (autolink
 *   real URLs in WYSIWYG) while opting out of the serialize cost
 *   (escape-spam in saved source).
 *
 * The complementary `remarkUnautolinkPlugin` does the
 * filename-shaped exception: it walks the parsed tree and reverts
 * `link { url: 'http://file.md' }` shape back to plain text on
 * load, so `file.md`-style references stay as text in Edit mode.
 * Real URLs (where the link's text already has a scheme) and
 * emails (where the URL has the `mailto:` prefix) survive the
 * unautolink pass and remain clickable.
 *
 * Replaces `@milkdown/preset-gfm`'s `remarkGFMPlugin` in the editor
 * pipeline. The other parts of the gfm preset (ProseMirror schema
 * for tables / strikethrough / task-list, input rules, paste rules,
 * commands) are kept as-is — see `WysiwygEditor.tsx`.
 */

interface RemarkGfmOptions {
  singleTilde?: boolean;
}

// Mirror remark-gfm's plugin signature: a unified plugin that
// installs micromark / from-markdown / to-markdown extensions onto
// the processor's data pile.
function remarkGfmNoAutolink(this: {
  data(): {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
    toMarkdownExtensions?: unknown[];
  };
}, options?: RemarkGfmOptions): undefined {
  const settings = options ?? {};
  const data = this.data();

  const micromarkExtensions =
    data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions =
    data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions =
    data.toMarkdownExtensions ?? (data.toMarkdownExtensions = []);

  // Micromark (parse-side grammar) — include autolink-literal so
  // bare URLs / emails get tokenised as autolinks. Same shape as
  // `micromark-extension-gfm`'s bundled `gfm()` factory.
  micromarkExtensions.push(
    combineExtensions([
      gfmAutolinkLiteral(),
      gfmFootnote(),
      gfmStrikethrough(settings),
      gfmTable(),
      gfmTaskListItem(),
    ]),
  );

  // mdast-util-from-markdown (parse-side AST builders) — same
  // story: include autolink-literal so the autolink tokens become
  // mdast `link` nodes. The downstream `remarkUnautolinkPlugin`
  // then reverts the filename-shaped link nodes back to text;
  // real URLs and emails stay as link nodes.
  fromMarkdownExtensions.push([
    gfmAutolinkLiteralFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ]);

  // mdast-util-to-markdown (serialize-side handlers) — DROP the
  // autolink-literal toMarkdown extension. That's what makes the
  // round-trip non-destructive: the extension's `unsafe` entries
  // for `:` (after `[ps]`, before `\/`), `@` (between word chars),
  // and `.` (after `[Ww]`) would otherwise escape every URL- or
  // email-shaped run of plain text on save — `https://example.com`
  // becomes `https\://example.com`, `user@example.com` becomes
  // `user\@example.com`, etc. Skipping the extension here keeps
  // plain text byte-faithful, while the parse-side extension above
  // still gives us link marks for real URLs in Edit mode.
  toMarkdownExtensions.push(
    gfmStrikethroughToMarkdown(),
    // `gfmTableToMarkdown` accepts table-specific options
    // (`tableCellPadding`, `tablePipeAlign`, etc.) that don't
    // overlap with our `RemarkGfmOptions` shape (`singleTilde`).
    // Pass undefined to take the defaults — matches what
    // `remark-gfm`'s own bundle does for users that don't pass
    // table-specific options.
    gfmTableToMarkdown(),
    gfmTaskListItemToMarkdown(),
    gfmFootnoteToMarkdown(),
  );
}

export const remarkGfmNoAutolinkPlugin: MilkdownPlugin = $remark(
  'remarkGfmNoAutolink',
  () => remarkGfmNoAutolink,
).plugin;
