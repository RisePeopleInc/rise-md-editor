import { remarkCtx, SchemaReady } from '@milkdown/core';
import type { MilkdownPlugin, Ctx } from '@milkdown/ctx';

/**
 * Surgically remove the `mdast-util-gfm-autolink-literal`
 * toMarkdown extension after `remark-gfm` has already registered
 * it, by mutating `remarkCtx`'s processor data once the parser is
 * built ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * **Why we can't use `$remark`**: `$remark`-style plugins all
 * `await ctx.wait(InitReady)` and then push to `remarkPluginsCtx`.
 * Milkdown's editor loader runs all plugins via `Promise.all`,
 * so the order plugins finish their await is racy. If our filter
 * pushes BEFORE gfm's `remarkGFMPlugin`, the unified processor's
 * `reduce` runs our filter first (against an empty data pile),
 * finds nothing to filter, and exits — then gfm runs and adds
 * the autolink-literal extension we wanted to drop. Net effect:
 * the filter does nothing, escapes still corrupt the source.
 *
 * **The fix**: hook into `SchemaReady` instead. By that point
 * (line 137-140 of @milkdown/core), every `$remark` plugin has
 * pushed to `remarkPluginsCtx`, the reduce has run, and the
 * processor in `remarkCtx` has all its extensions installed. We
 * can grab the processor and mutate its `data().toMarkdownExtensions`
 * directly to splice out the autolink-literal entry.
 *
 * The autolink-literal extension is identifiable by its unique
 * `unsafe` rule for `:` after `[ps]`, before `\/` (the
 * `https?:/...` autolink trigger). No other GFM extension carries
 * that combination. Match on it as a fingerprint so the filter is
 * resilient to future micro-changes in the extension shape.
 *
 * `mdast-util-gfm`'s `gfmToMarkdown()` factory wraps all five
 * sub-extensions inside `{ extensions: [...] }`, so the
 * autolink-literal entry is one level nested. Walk into each
 * top-level entry's `.extensions` array, splice the match. Also
 * handle the unwrapped peer-entry case as defensive fallback.
 *
 * **Parse side stays intact** — the autolink-literal *parser*
 * (micromark + mdast-util-from-markdown) is untouched, so bare
 * `https://example.com` and `user@example.com` still produce
 * `link` mdast nodes that Milkdown's link mark schema converts to
 * clickable link marks. Only the *serialiser*'s aggressive escape
 * rules are removed. Plain-text URL-shaped strings (typed in
 * WYSIWYG before they get a link mark) round-trip byte-faithfully
 * to the source file.
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

function stripAutolinkLiteralFromProcessor(processor: unknown): void {
  if (typeof processor !== 'object' || processor === null) return;
  const dataFn = (processor as { data?: unknown }).data;
  if (typeof dataFn !== 'function') return;
  const data = (dataFn as () => unknown).call(processor);
  if (typeof data !== 'object' || data === null) return;
  const tme = (data as { toMarkdownExtensions?: unknown }).toMarkdownExtensions;
  if (!Array.isArray(tme)) return;
  // Walk the wrapper structure produced by `mdast-util-gfm`'s
  // `gfmToMarkdown()` factory: each top-level entry is
  // `{ extensions: [autolinkLiteral, footnote, strikethrough,
  // table, taskListItem] }`. Recurse one level into `.extensions`
  // and splice the autolink-literal entry by fingerprint.
  for (const ext of tme) {
    if (typeof ext !== 'object' || ext === null) continue;
    const nested = (ext as { extensions?: unknown }).extensions;
    if (Array.isArray(nested)) {
      for (let j = nested.length - 1; j >= 0; j--) {
        if (isAutolinkLiteralToMarkdown(nested[j])) {
          nested.splice(j, 1);
        }
      }
    }
  }
  // Defensive fallback for the unwrapped case (e.g. an
  // alternative gfm composition or a unit test that pushes the
  // sub-extensions as peer entries rather than via the wrapper).
  for (let i = tme.length - 1; i >= 0; i--) {
    if (isAutolinkLiteralToMarkdown(tme[i])) {
      tme.splice(i, 1);
    }
  }
}

/**
 * Milkdown plugin: at `SchemaReady`, grab the unified processor
 * from `remarkCtx` and strip the autolink-literal toMarkdown
 * extension from its data pile. Returns a no-op cleanup so the
 * editor's lifecycle is satisfied.
 *
 * Uses the bare-plugin form rather than `$remark` because:
 *
 *   1. We need to run AFTER the `remarkPluginsCtx` reduce has
 *      built the final processor. `$remark` plugins push to
 *      `remarkPluginsCtx` (and thus run during the reduce); we
 *      want to mutate after the reduce completes, which means
 *      operating on the live processor in `remarkCtx`.
 *   2. The bare plugin form lets us pick our own timer
 *      (`SchemaReady`), which is the first timer that fires after
 *      the reduce in line 137-140 of @milkdown/core.
 */
export const remarkGfmNoAutolinkPlugin: MilkdownPlugin = (ctx: Ctx) =>
  async () => {
    await ctx.wait(SchemaReady);
    const processor = ctx.get(remarkCtx);
    stripAutolinkLiteralFromProcessor(processor);
    return () => {
      // No persistent state to tear down — the data array we
      // mutated lives on the processor that the editor itself
      // owns, and the processor is disposed when the editor is.
    };
  };
