import type { MilkdownPlugin } from '@milkdown/ctx';
import { $remark } from '@milkdown/utils';
import type { Link, PhrasingContent, Root, Text } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';
import { looksLikeFilenameExtension } from './filenameExtensions';

/**
 * Strip filename-shaped autolink-literal nodes from the parsed
 * mdast tree ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * `mdast-util-gfm-autolink-literal`'s parse-side extension
 * (which we keep — see the build-time shim
 * `src/renderer/shims/mdastUtilGfmNoAutolinkSerialize.ts`)
 * converts bare `<host>.<TLD>` text into `link` mdast nodes with
 * `url` synthesised as `http://<text>`. So a markdown source of
 * `See file.md for details` parses into:
 *
 *     paragraph
 *       text "See "
 *       link url="http://file.md"
 *         text "file.md"
 *       text " for details"
 *
 * In WYSIWYG that renders as a clickable but broken link to the
 * non-existent host `file.md`. This plugin walks the mdast tree
 * after `remark-gfm` runs, identifies link nodes that look like
 * autolink-literal output, and replaces them with plain text
 * nodes of the same visible content. Real URLs (text has scheme)
 * and emails (`mailto:` url) are preserved untouched.
 *
 * **Detection** — a link is treated as autolink-literal output iff:
 *
 *   1. Single text child (no nested formatting).
 *   2. The `url` is the visible text prefixed by `http://` or
 *      `https://`. That's the exact shape
 *      `mdast-util-gfm-autolink-literal` produces — it always
 *      synthesises a scheme prefix in front of the matched text.
 *      We deliberately do NOT match the `url === text` case
 *      because that would also clobber an explicit
 *      `[file.md](file.md)` link a user typed by hand.
 *   3. The visible text doesn't itself start with `http://`,
 *      `https://`, or `mailto:` — keeps explicit-scheme URLs
 *      typed by the user (`https://example.com`) intact.
 *   4. The `url` doesn't start with `mailto:` — keeps email
 *     autolinks (`user@example.com` → `mailto:user@example.com`).
 *
 * **Critical: export shape** — `$remark` returns a tuple-with-
 * extras `[options, plugin]`. BOTH halves must be registered with
 * the editor — the `options` half is a `$ctx`-injected slice that
 * the plugin reads on every InitReady. Exporting just `.plugin`
 * (without options) makes the plugin's async handler throw on
 * `ctx.get(options.key)`, the editor's `Promise.all([...])` rejects,
 * and the editor stays in `OnCreate` forever (silently breaking
 * toolbar / commands / link mark wiring downstream — burned us
 * for four follow-ups in the previous attempt at this fix).
 *
 * Mirror `state/gemojiNode.ts`'s pattern: surface the full tuple
 * as a `MilkdownPlugin[]` so `.use()` flattens both halves into
 * the plugin chain.
 */

const SCHEME_RE = /^(?:https?:\/\/|mailto:)/i;

/**
 * A link node fingerprints as a filename-shaped autolink when:
 *
 *   1. It has a single text child (no nested formatting).
 *   2. Its url is the visible text with `http://` or `https://`
 *      synthesised in front (the autolink-literal output shape).
 *   3. The visible text doesn't already start with a scheme
 *      (`https?://` or `mailto:`).
 *   4. The URL doesn't start with `mailto:` (emails stay linked).
 *   5. **The visible text's suffix is in the file-extension list
 *      from `filenameExtensions.ts`.** This is the change vs. the
 *      original RAISE-47 implementation: previously, ANY synthesised-
 *      scheme autolink was reverted, which clobbered legitimate bare-
 *      domain references like `www.cbc.ca` or `internet.com`. Now we
 *      only revert when the suffix matches a known file extension
 *      (`.md`, `.txt`, `.json`, etc.) — real-TLD references stay as
 *      autolinks.
 */
// Exported for unit tests (RAISE-50). Internal to the remark
// plugin otherwise.
export function looksLikeBareAutolink(node: Link): boolean {
  if (node.children.length !== 1) return false;
  const child = node.children[0];
  if (!child || child.type !== 'text') return false;
  const text = (child as Text).value;
  const url = node.url;
  if (!text || !url) return false;
  if (url.startsWith('mailto:')) return false;
  if (SCHEME_RE.test(text)) return false;
  if (url !== `http://${text}` && url !== `https://${text}`) return false;
  return looksLikeFilenameExtension(text);
}

function remarkUnautolink(): (tree: Root) => void {
  return (tree) => {
    visit(tree, 'link', (node, index, parent) => {
      if (parent == null || index == null) return;
      if (!looksLikeBareAutolink(node)) return;
      const child = node.children[0] as Text;
      const replacement: Text = { type: 'text', value: child.value };
      // mdast `Parent.children` is `(BlockContent | DefinitionContent
      // | …)[]` depending on parent type — the typed splice signature
      // varies. Cast through PhrasingContent[] since `link` lives in
      // phrasing contexts; the runtime mutation is shape-correct
      // regardless.
      (parent.children as PhrasingContent[]).splice(index, 1, replacement);
      // Tell visit to re-process at the same index — the splice
      // replaced the node, so continuing past would skip the new
      // text node (harmless here, but `SKIP` is the explicit form).
      return [SKIP, index];
    });
  };
}

const remarkUnautolinkResult = $remark('remarkUnautolink', () => remarkUnautolink);

// `as unknown as MilkdownPlugin[]` matches the cast pattern in
// `state/gemojiNode.ts`. Milkdown's `$remark` factory returns a
// tuple-with-extras that `.use()` accepts at runtime but doesn't
// structurally satisfy `MilkdownPlugin[]` for the typechecker.
export const remarkUnautolinkPlugin: MilkdownPlugin[] = [
  ...remarkUnautolinkResult,
] as unknown as MilkdownPlugin[];
