/**
 * Build-time shim for `mdast-util-gfm` that drops the
 * `autolink-literal` toMarkdown extension while keeping every
 * other GFM feature (footnote, strikethrough, table, task-list-item)
 * untouched. Aliased in `electron.vite.config.ts` so any import of
 * `mdast-util-gfm` in the renderer bundle (currently only
 * `remark-gfm`'s internal one) resolves here.
 *
 * **Why we need this shim** — `mdast-util-gfm-autolink-literal`'s
 * `gfmAutolinkLiteralToMarkdown()` factory contributes three
 * `unsafe` rules that escape autolink-trigger characters in any
 * plain-text occurrence:
 *
 *   - `@` between word chars (email autolink trigger)
 *   - `.` after `[Ww]` (`www.` autolink trigger)
 *   - `:` after `[ps]`, before `\/` (`http:` / `https:` autolink trigger)
 *
 * Their stated purpose is to prevent text written *as text* from
 * being mis-parsed as autolinks on the next read. For our use case
 * (a markdown editor where the user owns the source), the escapes
 * are net-negative: typed `https://example.com` saves as
 * `https\://example.com` (with backslashes that the user did not
 * write and would not expect), and the escaping prevents the next
 * parse from re-detecting the URL as an autolink — the source on
 * disk drifts away from any reasonable canonical form.
 *
 * **What we keep** — the *parse-side* autolink-literal extension
 * (`gfmAutolinkLiteralFromMarkdown` + the corresponding micromark
 * grammar) stays active. Bare URLs and emails in the source still
 * become `link` mdast nodes on parse; the WYSIWYG link mark schema
 * picks them up as clickable link marks; the markdown-it preview
 * still renders them as links via its own linkify rule. The shim
 * touches only the serialiser path.
 *
 * **Why a build-time shim and not a runtime patch** — earlier
 * RAISE-47 follow-ups tried multiple runtime patches (wholesale
 * replacing `remark-gfm`, splitting Milkdown's gfm preset,
 * post-filtering `data.toMarkdownExtensions`, hooking SchemaReady)
 * and each hit a different combination of plugin-loader race
 * conditions, broken toolbar wiring, or listener-filter
 * interactions. Replacing the import-graph entry for
 * `mdast-util-gfm` is structurally simpler: there is no race because
 * the alias is resolved at module-load time, no chain to re-assemble
 * because the rest of preset-gfm sees the same shape it always saw,
 * and no listener gymnastics because the unsafe rules simply never
 * exist in the `data.toMarkdownExtensions` pile in the first place.
 *
 * The alias only affects renderer-bundle imports
 * (`electron-vite.config.ts` -> `renderer.resolve.alias`); the main
 * process's `mdast-util-gfm` (currently unused there) is unaffected.
 */

import {
  gfmFootnoteFromMarkdown,
  gfmFootnoteToMarkdown,
} from 'mdast-util-gfm-footnote';
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough';
import {
  gfmAutolinkLiteralFromMarkdown,
} from 'mdast-util-gfm-autolink-literal';
import {
  gfmTableFromMarkdown,
  gfmTableToMarkdown,
} from 'mdast-util-gfm-table';
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownExtension } from 'mdast-util-to-markdown';

interface GfmOptions {
  // Re-exported `singleTilde`-style options that `remark-gfm` may
  // forward; we ignore them for autolink-literal since we're
  // dropping that extension entirely. Other extensions read what
  // they need from this object.
  [key: string]: unknown;
}

/**
 * Same shape and behaviour as `mdast-util-gfm`'s
 * `gfmFromMarkdown()` — five extensions in an array. The
 * autolink-literal extension stays so bare URLs / emails parse
 * into `link` mdast nodes.
 */
export function gfmFromMarkdown(): FromMarkdownExtension[] {
  return [
    gfmAutolinkLiteralFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ];
}

/**
 * Same wrapper shape as `mdast-util-gfm`'s `gfmToMarkdown()` —
 * `{ extensions: [...] }` — but with the autolink-literal entry
 * deliberately *omitted*. That entry's only contribution to the
 * serialiser is its `unsafe` escape rules, and dropping those is
 * the entire point of the shim.
 */
export function gfmToMarkdown(
  options?: GfmOptions | null | undefined,
): ToMarkdownExtension {
  const opts = options ?? {};
  return {
    extensions: [
      gfmFootnoteToMarkdown(opts),
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown(),
      gfmTaskListItemToMarkdown(),
    ],
  };
}
