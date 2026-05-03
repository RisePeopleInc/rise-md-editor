import type { MilkdownPlugin } from '@milkdown/ctx';
import { $remark } from '@milkdown/utils';

/**
 * Surgically remove the `mdast-util-gfm-autolink-literal` toMarkdown
 * extension after `remark-gfm` has already registered it
 * ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * The bundled `remark-gfm` plugin (used by `@milkdown/preset-gfm`)
 * registers FIVE GFM extensions with micromark / from-markdown /
 * to-markdown. We want to keep four of them and just drop one
 * specific behaviour:
 *
 *   - **Parse side** (micromark + from-markdown) — KEEP all five.
 *     Real URLs (`https://example.com`) and emails
 *     (`user@example.com`) need the autolink-literal extension's
 *     parse logic to become `link` mdast nodes, which then become
 *     clickable link marks in WYSIWYG via Milkdown's `linkSchema`.
 *
 *   - **Serialize side** (to-markdown) — DROP the autolink-literal
 *     extension specifically. Its `gfmAutolinkLiteralToMarkdown`
 *     factory adds `unsafe` rules that escape `:` (after `[ps]`,
 *     before `\/`), `@` (between word chars), and `.` (after
 *     `[Ww]`) in any *plain-text* occurrence. After our
 *     `remarkUnautolinkPlugin` reverts a filename-shaped autolink
 *     (`file.md`) back to text — and any time a URL-shaped string
 *     lives as plain text in the doc rather than inside a link
 *     mark — those `unsafe` rules would corrupt the saved source
 *     to `https\://example.com` / `user\@example.com` / `www\.x.y`.
 *     The escape prevents the next parse from re-autolinking,
 *     which defeats the purpose of having parse-side autolink-
 *     literal in the first place.
 *
 * Two design alternatives were tried before this approach:
 *
 *   1. **Replace `remark-gfm` wholesale** — write a custom plugin
 *      that registers four GFM extensions (footnote, strikethrough,
 *      table, task-list-item) and skips autolink-literal entirely.
 *      Side effect: real URLs no longer autolinked in WYSIWYG.
 *      Failed AC requirement.
 *   2. **Replace `remark-gfm` with parse-side autolink-literal but
 *      no serialize-side**. Achieves the same effect as this
 *      filter approach but requires reaching deep into Milkdown's
 *      preset-gfm bundle and re-assembling the ProseMirror plugin
 *      chain by hand — broke the link-mark toolbar / right-click
 *      command wiring in user testing.
 *
 * This filter approach is structurally lighter: it pairs with a
 * normal `.use(gfm)` (so all of preset-gfm's ProseMirror plumbing
 * stays in the chain unchanged) and just splices out one entry
 * from `data.toMarkdownExtensions` after registration. Identified
 * by fingerprint: the autolink-literal extension's `unsafe` array
 * has the distinctive rule `{ character: ':', before: '[ps]',
 * after: '\\/' }` that no other GFM extension carries.
 *
 * Registered AFTER `gfm` in the editor's `.use()` chain so the
 * gfm preset's `remarkGFMPlugin` populates the data pile before
 * we filter it.
 */

/**
 * Identify `gfmAutolinkLiteralToMarkdown`'s output by its unique
 * `unsafe` rules. The extension contributes exactly three entries:
 *
 *   - `@` between word chars (email autolink trigger)
 *   - `.` after `[Ww]` (`www.` autolink trigger)
 *   - `:` after `[ps]`, before `\/` (`http:` / `https:` autolink trigger)
 *
 * The third rule's combination of character, before, and after is
 * unique — no other GFM extension carries an `unsafe` rule with a
 * `:` character and a `[ps]` before-pattern. Match on that single
 * rule rather than the whole array shape so the fingerprint stays
 * narrow and resilient to future micro-changes in the extension.
 *
 * Typed `unknown` because mdast-util-to-markdown's `Options` type
 * (which is what `data.toMarkdownExtensions` actually contains) is
 * deeply nested and overlapping but not structurally identical to
 * the simple `{ unsafe?: { character, before, after }[] }` shape we
 * care about for fingerprinting. Casting to a narrow record at
 * the call site keeps the rest of the pipeline's typing clean.
 */
function isAutolinkLiteralToMarkdown(ext: unknown): boolean {
  if (typeof ext !== 'object' || ext === null) return false;
  const unsafe = (ext as { unsafe?: unknown }).unsafe;
  if (!Array.isArray(unsafe)) return false;
  return unsafe.some((rule: unknown) => {
    if (typeof rule !== 'object' || rule === null) return false;
    const r = rule as { character?: unknown; before?: unknown; after?: unknown };
    return r.character === ':' && r.before === '[ps]' && r.after === '\\/';
  });
}

function remarkStripAutolinkLiteralToMarkdown(this: {
  data(): { toMarkdownExtensions?: unknown[] };
}): undefined {
  const data = this.data();
  const tme = data.toMarkdownExtensions;
  if (!Array.isArray(tme)) return;
  // `mdast-util-gfm`'s `gfmToMarkdown()` factory wraps the five
  // sub-extensions (autolink-literal, footnote, strikethrough,
  // table, task-list-item) inside an outer `{ extensions: [...] }`
  // object — so `tme[i]` is one outer wrapper rather than five
  // peer entries. We have to recurse into each wrapper's nested
  // `.extensions` array, filter out the autolink-literal entry by
  // fingerprint, and leave the wrapper otherwise intact. Single
  // pass over the data array; in-place splice mutates the array
  // the wrapper holds (the wrapper's `.extensions` reference is
  // exposed to mdast-util-to-markdown's flatten-extensions step,
  // so mutation is observable downstream).
  //
  // Splice in place rather than re-assigning, in case the unified
  // processor or another plugin holds a reference to the original
  // array. `unified.data()` returns the live data object — mutating
  // its array preserves identity.
  for (const ext of tme) {
    if (typeof ext !== 'object' || ext === null) continue;
    const nested = (ext as { extensions?: unknown }).extensions;
    if (Array.isArray(nested)) {
      // Wrapper case (mdast-util-gfm): walk inner extensions.
      for (let j = nested.length - 1; j >= 0; j--) {
        if (isAutolinkLiteralToMarkdown(nested[j])) {
          nested.splice(j, 1);
        }
      }
    }
  }
  // Also handle the unwrapped case in case some other code path
  // pushes the autolink-literal extension as a peer entry (e.g.
  // a unit test or an alternative gfm composition).
  for (let i = tme.length - 1; i >= 0; i--) {
    if (isAutolinkLiteralToMarkdown(tme[i])) {
      tme.splice(i, 1);
    }
  }
}

export const remarkGfmNoAutolinkPlugin: MilkdownPlugin = $remark(
  'remarkGfmStripAutolinkLiteralSerialize',
  () => remarkStripAutolinkLiteralToMarkdown,
).plugin;
