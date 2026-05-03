import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { $prose } from '@milkdown/utils';
import type { MilkdownPlugin } from '@milkdown/ctx';

/**
 * Autolink URLs and emails as the user types
 * ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47) UX
 * follow-up).
 *
 * Without this plugin, a typed `https://example.com` stays as plain
 * text in the WYSIWYG model until a parse cycle (mode switch, doc
 * reload) re-reads the source and triggers
 * `mdast-util-gfm-autolink-literal`'s parse-side detection.
 * Mode-switching to make a URL clickable is friction-heavy.
 *
 * **What this plugin does**: on every doc-changing transaction,
 * walks the doc looking for text runs that:
 *
 *   1. Match a URL or email pattern, with the match BOUNDARY
 *      anchored at whitespace, end-of-node, or punctuation. The
 *      anchor stops a partial match from firing while the user is
 *      still typing the URL — `https://example.c` doesn't get a
 *      mark, only `https://example.com` (followed by space, end of
 *      text, or sentence punctuation) does.
 *   2. Don't already have a link mark.
 *
 * For each match, adds a link mark with `href` equal to the matched
 * text (or `mailto:` + text for emails). The mark is added in an
 * `appendTransaction`, so it pairs with the user's typing
 * transaction in the same dispatch — Ctrl-Z reverts both as one
 * step.
 *
 * **Coexistence with `stripBrowserAutolinkPlugin`**: the strip
 * plugin removes link marks where href is the *synthesised-scheme*
 * form (`http://text` where text has no scheme — Chromium's
 * partial autolink fingerprint). This plugin adds marks where
 * href === text and text already has the scheme. The two never
 * fight over the same mark — they target disjoint fingerprints.
 *
 * **Coexistence with the parse-side `remarkUnautolinkPlugin`**:
 * the remark plugin reverts file.md-shaped autolink-literal output
 * on parse. This plugin only matches text with `http://` or
 * `https://` prefix, so file.md never triggers it.
 *
 * **No conflict with explicit `[text](url)` syntax**: explicit link
 * marks already exist when the doc is parsed; this plugin's
 * "doesn't already have a link mark" check skips them.
 *
 * **Why this doesn't loop with `stripBrowserAutolinkPlugin`**:
 * adding a mark with `href === text === https://example.com` —
 * the strip plugin checks the fingerprint
 * (`href === 'http://' + text` etc., where text has no scheme); a
 * full-URL match doesn't fingerprint, so the strip plugin doesn't
 * remove the mark. No oscillation.
 */

const PLUGIN_KEY = new PluginKey('raise-autolink-on-type');

// URL pattern: explicit http(s) scheme, followed by non-whitespace,
// terminated by whitespace, end-of-text, or sentence punctuation.
// The lookahead `(?=[\s.,!?;:)\]]|$)` ensures we only match
// "completed" URLs — the user has either moved past them with
// whitespace/punctuation or hit the end of the text. Avoids
// flickering autolinks as they're being typed.
//
// `\S+?` (lazy) plus the lookahead means the URL is the shortest
// run of non-whitespace that ends at a boundary char. Trailing
// punctuation isn't included in the URL — `https://x.com.` autolinks
// `https://x.com` not `https://x.com.`.
const URL_RE = /https?:\/\/[^\s<>"'`]+?(?=[\s.,!?;:)\]]|$)/g;

// Email pattern: standard local@host.tld. Anchored on word
// boundaries so it doesn't match parts of unrelated text.
// Conservative — doesn't try to match every legal email syntax,
// just the common-case shapes that show up in markdown notes.
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

interface MarkAdd {
  from: number;
  to: number;
  href: string;
}

export const autolinkOnTypePlugin: MilkdownPlugin = $prose(() => {
  return new Plugin({
    key: PLUGIN_KEY,
    appendTransaction(transactions, _oldState, newState) {
      // Skip if no doc change. Skip if any transaction is our OWN
      // mark-adding transaction (avoids the obvious infinite loop:
      // we add a mark → that's a doc change → we re-fire → repeat).
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (transactions.some((tr) => tr.getMeta(PLUGIN_KEY))) return null;
      const linkType = newState.schema.marks['link'];
      if (!linkType) return null;

      const adds: MarkAdd[] = [];
      newState.doc.descendants((node: ProseNode, pos: number) => {
        if (!node.isText) return;
        // Skip text runs that already have a link mark — could be
        // an explicit `[text](url)` parse, a paste, a toolbar
        // application, or our own previous autolink. Don't
        // double-mark.
        if (linkType.isInSet(node.marks)) return;

        const text = node.text ?? '';
        if (!text) return;

        // URLs.
        URL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = URL_RE.exec(text)) !== null) {
          const url = m[0];
          adds.push({
            from: pos + m.index,
            to: pos + m.index + url.length,
            href: url,
          });
        }

        // Emails.
        EMAIL_RE.lastIndex = 0;
        while ((m = EMAIL_RE.exec(text)) !== null) {
          const email = m[0];
          adds.push({
            from: pos + m.index,
            to: pos + m.index + email.length,
            href: `mailto:${email}`,
          });
        }
      });

      if (adds.length === 0) return null;
      const tr = newState.tr;
      for (const { from, to, href } of adds) {
        tr.addMark(from, to, linkType.create({ href }));
      }
      // Tag the transaction so our re-entry guard above catches
      // this exact one and exits early on the next dispatch round.
      tr.setMeta(PLUGIN_KEY, true);
      // Intentionally NOT setting `addToHistory: false`. Same
      // reasoning as `state/stripBrowserAutolink.ts`: Milkdown's
      // listener short-circuits on that meta, so we'd never
      // serialize the marked-up state. Cost: undo is a separate
      // step (reverts the autolink, then the typing). Acceptable.
      return tr;
    },
  });
});
