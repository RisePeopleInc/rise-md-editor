import type { MilkdownPlugin } from '@milkdown/ctx';
import { $remark } from '@milkdown/utils';
import { combineExtensions } from 'micromark-util-combine-extensions';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
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
 * `remark-gfm` substitute that drops the autolink-literal extension
 * ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * Why we can't just patch on top: the bundled `remark-gfm` plugin
 * (used by `@milkdown/preset-gfm`) registers FIVE GFM extensions
 * with micromark / mdast-util-from-markdown / mdast-util-to-markdown:
 *
 *   1. autolink-literal — converts bare `<host>.<TLD>` text to link
 *      nodes (PARSE side), and adds `unsafe` rules that ESCAPE
 *      autolink-trigger characters in plain text on serialize. The
 *      escapes are aggressive — `https://x` text becomes `https\://x`
 *      in the saved source so the next parse sees an explicit
 *      backslash-escaped colon and won't re-detect as an autolink.
 *      That's the bug: explicit-scheme URLs the user typed in
 *      WYSIWYG round-trip with the colon escaped, and an email
 *      address gets the `@` escaped. Both look broken on disk.
 *   2. footnote — `[^foo]` and `[^foo]: …`.
 *   3. strikethrough — `~~text~~`.
 *   4. table — GFM pipe tables.
 *   5. task-list-item — `* [ ]` / `* [x]`.
 *
 * Removing autolink-literal fixes the round-trip damage but means
 * we have to rebuild the rest of the GFM bundle without it. This
 * plugin pulls in extensions 2-5 individually and registers them
 * exactly the way `remark-gfm` does — same micromark / from-markdown
 * / to-markdown shape, just without the autolink-literal entry.
 *
 * The complementary `remarkUnautolinkPlugin` handles the *parse-side*
 * leg of RAISE-47: even with this no-autolink remark plugin in
 * place, an existing doc on disk that already contains the bug-
 * corrupted form `[file.md](http://file.md)` would parse as a link
 * node. The unautolink plugin reverts those to plain text on load.
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

  // Micromark side: combine the four GFM grammar extensions into
  // a single `combineExtensions` call (same shape as
  // `micromark-extension-gfm`'s `gfm()` factory, sans
  // `gfmAutolinkLiteral()`).
  micromarkExtensions.push(
    combineExtensions([
      gfmFootnote(),
      gfmStrikethrough(settings),
      gfmTable(),
      gfmTaskListItem(),
    ]),
  );

  // mdast-util-from-markdown side: an array of token-handler
  // extensions that walk micromark events into mdast nodes.
  // `mdast-util-gfm`'s `gfmFromMarkdown()` factory returns the same
  // shape with the autolink-literal entry included; we mirror it
  // verbatim minus that one entry.
  fromMarkdownExtensions.push([
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ]);

  // mdast-util-to-markdown side: each extension contributes
  // handlers for its node types and (sometimes) `unsafe` escape
  // rules. Dropping the autolink-literal extension here is what
  // makes the round-trip non-destructive — its `unsafe` entries
  // for `:`, `@`, `.` (the autolink-trigger characters) no longer
  // run, so plain-text `https://example.com` and `user@example.com`
  // serialize verbatim instead of as `https\://…` and `user\@…`.
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
