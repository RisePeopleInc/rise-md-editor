import type { MilkdownPlugin } from '@milkdown/ctx';
import { $remark } from '@milkdown/utils';
import type { Link, PhrasingContent, Root, Text } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

/**
 * Strip GFM autolink-literal nodes from filename-shaped text
 * ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * The bug: Milkdown's `@milkdown/preset-gfm` ships `remark-gfm`,
 * which includes the `mdast-util-gfm-autolink-literal` extension.
 * That extension converts bare `<host>.<TLD>` text into mdast
 * `link` nodes, with the URL synthesised as `http://<text>`. So
 * a markdown source of `See file.md for details` parses into:
 *
 *     link { url: 'http://file.md', children: [text 'file.md'] }
 *
 * In the WYSIWYG editor that renders as a clickable link to the
 * non-existent host `file.md`. Worse, on save the serializer
 * writes the link form back to disk: the source on disk becomes
 * `[file.md](http://file.md)` instead of the original plain
 * `file.md` (or the user's intended `\`file.md\`` inline-code
 * reference). Round-trip damage — once it's serialised the link
 * form becomes the new source-of-truth.
 *
 * The fix: a remark plugin (running *after* `remark-gfm` in the
 * pipeline, which is automatic given the registration order in
 * `WysiwygEditor.tsx`) walks the mdast tree, identifies link
 * nodes that look like autolink-literal output, and replaces
 * each with a plain text node of the same visible content.
 *
 * **Detection** — a link is treated as autolink-literal output
 * iff all of:
 *
 *   1. Single text child (no nested formatting).
 *   2. The link's `url` is the visible text prefixed by `http://`
 *      or `https://`. That's the exact shape
 *      `mdast-util-gfm-autolink-literal` produces — it always
 *      synthesises a scheme prefix in front of the matched text.
 *      Critically, we *do not* revert when `url === text` because
 *      that would also clobber an explicit `[file.md](file.md)`
 *      link the user typed by hand (rare, but a real edit). The
 *      synthesised-scheme shape is the unambiguous fingerprint.
 *   3. The visible text doesn't itself start with `http://`,
 *      `https://`, or `mailto:`. That keeps explicit-scheme URLs
 *      typed by the user (`https://example.com`) intact, since
 *      those are *intentional* autolinks. (Belt-and-suspenders —
 *      condition 2 already excludes them, since `url ===
 *      'http://https://example.com'` would be needed to match.)
 *   4. The URL doesn't start with `mailto:`. Email autolinks
 *      (`user@example.com` → `mailto:user@example.com`) are
 *      explicitly preserved per the AC.
 *
 * **What stays linked** —
 *
 *   - `[click](url)` — explicit markdown link (text differs from
 *     URL, so condition 2 fails).
 *   - `<https://example.com>` — CommonMark autolink (the URL has
 *     an explicit scheme that the text matches one-to-one, but
 *     condition 3 keeps schemed URLs).
 *   - `https://example.com` — bare URL with explicit scheme
 *     (same shape as the angle-bracket form after parse).
 *   - `user@example.com` — email autolink (condition 4 keeps it).
 *
 * **What gets reverted** —
 *
 *   - `file.md`, `notes.md`, `example.app` — filename-shaped text
 *     with file-extension TLDs.
 *   - `example.com`, `www.example.com` — bare hostnames without
 *     scheme. Users who want these clickable can write
 *     `<https://example.com>` or `[example.com](https://example.com)`.
 *
 * **Why a remark plugin rather than a ProseMirror transaction
 * filter** — the corruption happens at the *parse* boundary, not
 * during typing. A typed `file.md` stays as plain text in the
 * editor (no input rule promotes it to a link). The damage is
 * exclusively on file load, where the markdown source goes
 * through remark-gfm and emerges with autolink-literal link
 * nodes. Fixing it at the mdast layer prevents the link from
 * ever reaching ProseMirror, so neither the rendering pipeline
 * nor the serialiser sees a link to mangle.
 */

const SCHEME_RE = /^(?:https?:\/\/|mailto:)/i;

function looksLikeBareAutolink(node: Link): boolean {
  if (node.children.length !== 1) return false;
  const child = node.children[0];
  if (!child || child.type !== 'text') return false;
  const text = (child as Text).value;
  const url = node.url;
  if (!text || !url) return false;
  // Email autolinks land here too (children = [text 'user@host']),
  // but the URL has the `mailto:` scheme — those stay linked.
  if (url.startsWith('mailto:')) return false;
  // Visible text already has a scheme? Intentional URL, keep it.
  if (SCHEME_RE.test(text)) return false;
  // Autolink-literal shape: url is the visible text with an
  // http(s):// prefix added. We deliberately don't match the
  // `url === text` case because that would also catch an explicit
  // `[file.md](file.md)` link that the user typed.
  return url === `http://${text}` || url === `https://${text}`;
}

function remarkUnautolink(): (tree: Root) => void {
  return (tree) => {
    visit(tree, 'link', (node, index, parent) => {
      // visit's signature: parent / index are nullable for the root
      // node; for any visited child of a parent (which is the case
      // for every link, since link can't be a top-level mdast root),
      // both are populated. Guard defensively anyway.
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

// `$remark` returns a tuple-with-extras `[options, plugin]` — BOTH
// halves need to be registered. The options half is created via
// `$ctx(...)`; if it's not added to `.use()` the slice never gets
// `ctx.inject`-ed, and the plugin's async handler throws when it
// reads `ctx.get(options.key)`. That promise rejection bubbles up
// through `Promise.all([sysPlugins, usrPlugins])` in the editor's
// `create()`, leaves the editor in `OnCreate` forever, and silently
// breaks the toolbar / context menu / link mark wiring downstream.
//
// Earlier export was `$remark(...).plugin` (just the plugin half),
// which hit exactly this failure mode in user testing — toolbar
// formatting, "Add Link" command, and image insert all no-op'd.
// Mirroring how `state/gemojiNode.ts` exports `remarkGemojiPlugin`:
// surface the full `[options, plugin]` tuple as a `MilkdownPlugin[]`
// so `.use(...)` flattens both halves into the editor's plugin chain.
//
// The `as unknown as MilkdownPlugin[]` cast is the same one the
// gemoji and other `$remark`/`$inputRule` plugins in the codebase
// use — Milkdown's factory return shape is a tuple-with-extras that
// `.use()` accepts at runtime but doesn't structurally satisfy
// `MilkdownPlugin[]` for the typechecker.
const remarkUnautolinkResult = $remark(
  'remarkUnautolink',
  () => remarkUnautolink,
);
export const remarkUnautolinkPlugin: MilkdownPlugin[] = [
  ...remarkUnautolinkResult,
] as unknown as MilkdownPlugin[];
