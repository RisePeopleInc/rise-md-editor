import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Mark, Node as ProseNode } from '@milkdown/prose/model';
import { $prose } from '@milkdown/utils';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { looksLikeFilenameExtension } from './filenameExtensions';

/**
 * Strip browser-injected autolink marks from the WYSIWYG model
 * ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * Chromium's contenteditable URL auto-detector wraps URL-shaped
 * text in `<a href="...">` tags as the user types — and often
 * catches only PART of the URL. ProseMirror's `linkSchema.parseDOM`
 * rule (`{ tag: "a[href]" }`) picks up the `<a>` via the
 * MutationObserver path and creates a link MARK on that fragment.
 * Net effect on a typed `https://www.example.com`:
 *
 *     paragraph
 *       text "https://www."        // unmarked
 *       text "example.com"         // link mark href="http://example.com"
 *
 * On serialize, the unmarked half of the URL stays plain (which
 * is what we want, given the build-time shim in
 * `src/renderer/shims/mdastUtilGfmNoAutolinkSerialize.ts`), but
 * the link-marked fragment serialises as `[example.com](http://example.com)`
 * — the source on disk ends up as
 * `https://www.[example.com](http://example.com)`, which then
 * renders as `https://www.<a>example.com</a>` in any viewer. Ugly
 * partial-link.
 *
 * **Detection**: a link mark is treated as browser-injected iff
 * its `href` is the surrounding text run's content prefixed by
 * `http://` or `https://` AND that text doesn't itself start with
 * a scheme. Same fingerprint `state/remarkUnautolink.ts` uses on
 * the parse side, just applied at the ProseMirror layer for
 * typed-not-parsed input.
 *
 * **What this plugin does NOT touch**:
 *   - Marks on paste (handled by Milkdown's clipboard plugin).
 *     Pasted link marks have non-synthesised hrefs that match the
 *     source HTML, so they don't fingerprint as auto-injected.
 *   - User-applied marks via toolbar / right-click "Add Link" /
 *     `[text](url)` markdown syntax. Same reason — href is real
 *     and intentional, not a synthesised scheme prefix.
 *   - Mailto autolinks. The `mailto:` prefix is the explicit
 *     intentional fingerprint; the user (or the parse-side
 *     autolink-literal extension) wanted this as a real link.
 *   - Real explicit-scheme URLs typed by the user (e.g. typed
 *     `https://example.com` where Chromium catches the whole
 *     URL with a matching href). Text has scheme → no fingerprint
 *     match → mark stays. The next parse cycle will recognise
 *     this as an autolink anyway.
 *
 * Runs as an `appendTransaction` so it sees the post-mutation doc
 * state and synthesises a corrective transaction that removes the
 * offending marks before the dispatch cycle ends. Critically
 * does NOT set `addToHistory: false` — Milkdown's listener plugin
 * short-circuits on that meta and would skip the corrective
 * transaction entirely, leaving `markdownUpdated` to fire with the
 * pre-strip state. The cost of NOT setting it is that the strip
 * becomes a separate undo step (Ctrl-Z reverts the strip first,
 * then the typing); the trade is worth it because the alternative
 * is corrupted source on disk.
 */

const SCHEME_RE = /^(?:https?:\/\/|mailto:)/i;
const PLUGIN_KEY = new PluginKey('raise-strip-browser-autolink');

interface MarkRange {
  from: number;
  to: number;
  mark: Mark;
}

/**
 * A link mark fingerprints as a filename-shaped browser-injected
 * autolink iff:
 *
 *   1. The href has a synthesised `http://` or `https://` scheme
 *      that doesn't appear in the visible text run.
 *   2. The href body (after stripping the scheme) refers to a
 *      filename-shaped target — its suffix is a known file
 *      extension (`.md`, `.txt`, etc., per
 *      `filenameExtensions.ts`).
 *
 * Real-TLD-shaped URLs (`www.cbc.ca`, `internet.com`) stay marked.
 * The discriminator vs. the original RAISE-47 strip implementation:
 * we used to remove ANY synthesised-scheme link mark, which
 * over-triggered on Chromium's auto-detection of legitimate URLs.
 * Now we only strip when the URL is filename-shaped — the user
 * said `www.cbc.ca` should stay clickable.
 */
// Exported for unit tests (RAISE-50). Internal to the plugin
// otherwise.
export function isSyntheticAutolinkMark(textRun: string, href: string): boolean {
  if (!href || !textRun) return false;
  if (href.startsWith('mailto:')) return false;
  if (SCHEME_RE.test(textRun)) return false;

  const schemeMatch = /^https?:\/\/(.+)$/.exec(href);
  if (!schemeMatch) return false;
  const hostBody = schemeMatch[1];
  if (!hostBody) return false;

  // Two acceptable shapes for "this is a Chromium-injected
  // synthesised-scheme link" — the strict form (text run is
  // exactly the URL body) and the looser form (text run
  // contains the URL body, in case Chromium scoped the `<a>`
  // wider than just the URL).
  //
  // Either way, only strip if the URL body is filename-shaped
  // (`hostBody` ends with a known file extension). That last
  // gate is what keeps us from over-triggering on a legitimate
  // pasted link like `<a href="http://example.com">click</a>`:
  // hostBody is `example.com`, suffix `com` isn't a file
  // extension, fingerprint exits false, mark survives.
  //
  // **Pathological-paste edge case**: if a pasted `<a href="X">`
  // has X = `http://config.json` (filename-shaped) AND visible
  // text contains `config.json`, we'd strip the mark even though
  // it's "explicit" content from the paste. Acceptable: a real
  // link with `http://config.json` as the destination is
  // semantically broken anyway (`config.json` isn't a host); the
  // common case is that this only fires for browser-injected
  // marks and the few weird-paste cases collapse to "the user
  // gets plain text, which is what they probably wanted".
  const exactMatch = href === `http://${textRun}` || href === `https://${textRun}`;
  const containsMatch = textRun.includes(hostBody);
  if (!exactMatch && !containsMatch) return false;

  return looksLikeFilenameExtension(hostBody);
}

export const stripBrowserAutolinkPlugin: MilkdownPlugin = $prose(() => {
  return new Plugin({
    key: PLUGIN_KEY,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const linkType = newState.schema.marks['link'];
      if (!linkType) return null;
      const offending: MarkRange[] = [];
      newState.doc.descendants((node: ProseNode, pos: number) => {
        if (!node.isText) return;
        for (const mark of node.marks) {
          if (mark.type !== linkType) continue;
          const href = mark.attrs['href'];
          if (typeof href !== 'string') continue;
          if (isSyntheticAutolinkMark(node.text ?? '', href)) {
            offending.push({
              from: pos,
              to: pos + node.nodeSize,
              mark,
            });
          }
        }
      });
      if (offending.length === 0) return null;
      const tr = newState.tr;
      for (const { from, to, mark } of offending) {
        tr.removeMark(from, to, mark);
      }
      // Intentionally NOT setting `tr.setMeta('addToHistory', false)`.
      // Milkdown's listener plugin's `state.apply` short-circuits on
      // that meta, so a strip flagged out-of-history is also flagged
      // out-of-update — the listener keeps `latestTr` pointing at the
      // PRE-strip state, debounces the markdown serialisation off
      // that, and fires `markdownUpdated` with the link mark still
      // present. Result: source on disk has the partial-link wrap
      // even though the editor's actual model state was cleaned.
      // Adding to history is the lesser evil; undo just becomes
      // two-step (revert strip → revert typing).
      return tr;
    },
  });
});
