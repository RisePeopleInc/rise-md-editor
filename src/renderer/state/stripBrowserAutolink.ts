import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Mark, Node as ProseNode } from '@milkdown/prose/model';
import { $prose } from '@milkdown/utils';
import type { MilkdownPlugin } from '@milkdown/ctx';

/**
 * Strip browser-injected autolink marks
 * ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * Chromium's contenteditable URL auto-detector wraps URL-shaped
 * text in `<a href="...">` tags as the user types. ProseMirror's
 * `linkSchema.parseDOM` rule (`{ tag: "a[href]" }`) picks up
 * those `<a>` tags via the MutationObserver path and creates a
 * link MARK on the affected text run. Three problems:
 *
 *   1. Chromium's detector often catches only PART of the URL —
 *      a typed `https://www.example.com` ends up with a link mark
 *      only on `example.com`, leaving `https://www.` unmarked.
 *      The split causes the source on save to look corrupted:
 *      `https\://www\.[example.com](http://example.com)`.
 *
 *   2. The mark's href is *synthesised* (Chromium prepends
 *      `http://` to bare-host text). On serialize, that becomes
 *      an explicit `[text](url)` markdown link with mismatched
 *      text and url — even after a clean round-trip the source
 *      stays in the broken form.
 *
 *   3. There's no input rule in Milkdown's commonmark / gfm
 *      presets that would itself add a link mark on typed URLs.
 *      Every link mark on typed (not pasted, not parsed) text is
 *      attributable to the browser's autolink behaviour, not the
 *      user's intent. Stripping these is safe.
 *
 * **Detection**: a link mark is treated as browser-injected iff
 * its `href` is the surrounding text run's content prefixed by
 * `http://` or `https://` AND that text doesn't itself start
 * with a scheme. Same fingerprint `state/remarkUnautolink.ts`
 * uses on the parse side, just applied at the ProseMirror layer
 * for typed-not-parsed input.
 *
 * **What this plugin does NOT touch**:
 *   - Marks on paste (handled by Milkdown's clipboard plugin) —
 *     those reach the model with non-synthesised hrefs that
 *     match the source, so they don't fingerprint as auto-injected.
 *   - User-applied link marks via the toolbar / `[text](url)`
 *     markdown syntax — same reason, href is real and intentional.
 *   - Mailto autolinks — `mailto:` prefix is the explicit
 *     fingerprint that the user (or the parse-side
 *     autolink-literal extension) wanted this as a real link.
 *
 * Runs as an `appendTransaction` so it sees the post-mutation
 * doc state and synthesises a corrective transaction that
 * removes the offending marks before the dispatch cycle ends.
 *
 * **Why we DON'T set `addToHistory: false`** — that meta would
 * normally be the right call (the strip is implicit, not a user
 * edit, shouldn't pollute the undo stack). But Milkdown's
 * listener plugin's `state.apply` short-circuits on
 * `tr.getMeta("addToHistory") === false`, so a strip flagged
 * out-of-history is also flagged out-of-update — the listener
 * keeps `latestTr` pointing at the PRE-strip state, debounces
 * the markdown serialisation off that, and the listener fires
 * `markdownUpdated` with the unmodified link mark still in the
 * doc. Result: source on disk has `[example.com](http://example.com)`
 * even though the editor's actual model state has been cleaned.
 *
 * Leaving the meta unset costs us a separate undo step (the
 * strip becomes its own history entry, so Ctrl-Z first reverts
 * the strip and then the typing). The trade is worth it — the
 * alternative is a corrupted save that propagates to disk.
 */

const SCHEME_RE = /^(?:https?:\/\/|mailto:)/i;
const PLUGIN_KEY = new PluginKey('raise-strip-browser-autolink');

interface MarkRange {
  from: number;
  to: number;
  mark: Mark;
}

function isSyntheticAutolinkMark(textRun: string, href: string): boolean {
  if (!href || !textRun) return false;
  if (href.startsWith('mailto:')) return false;
  if (SCHEME_RE.test(textRun)) return false;
  return href === `http://${textRun}` || href === `https://${textRun}`;
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
      // Intentionally NOT setting `tr.setMeta('addToHistory',
      // false)`. See the doc comment at the top of this file —
      // Milkdown's listener plugin treats `addToHistory: false`
      // as "skip this transaction", so the markdownUpdated
      // listener would see the pre-strip state and serialise the
      // corrupted form to disk. Adding to history is the lesser
      // evil; undo just becomes two-step (revert strip → revert
      // typing).
      return tr;
    },
  });
});
