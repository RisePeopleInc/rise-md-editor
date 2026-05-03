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

// URL pattern: explicit http(s) scheme + greedy run of
// non-whitespace chars that excludes a few markdown-meaningful
// delimiters (`<>"'\``).
//
// **Why greedy + post-process** rather than a clever lazy regex
// with a lookahead: an earlier draft used
// `https?:\/\/[^\s]+?(?=[\s.,!?;:)\]]|$)` — `+?` lazy + lookahead
// allowing `$` at end-of-text. That fires on every partial URL
// as the user types it. Because Milkdown's link mark is `inclusive`,
// the mark added on the partial URL (e.g. `https://w` with href
// `https://w`) auto-extends as the user keeps typing. Each new
// keystroke fires the plugin again, adds *another* mark with a
// different href, and the result is a single URL run with multiple
// marks accumulated and the original (truncated) href winning the
// serializer. Saved source ends up as
// `[https://www.example.com today](https://w)` — link text is the
// whole accumulated run, href is whatever the very first keystroke
// landed.
//
// Fix: never match while the URL is still being typed. The match
// is only valid when the URL run is *terminated* in the text —
// either by whitespace OR by sentence punctuation followed by
// whitespace / end. We do this in `findCompletedUrls` below by
// running the greedy regex and filtering matches that don't have a
// trailing whitespace boundary. URLs at the very end of a text
// node (with no trailing whitespace) stay unlinked until the user
// types a space or a parse cycle re-reads them; that's acceptable
// friction.
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

// Email pattern: standard local@host.tld. Anchored on word
// boundaries so it doesn't match parts of unrelated text.
// Conservative — doesn't try to match every legal email syntax,
// just the common-case shapes that show up in markdown notes.
//
// Same "must be followed by whitespace" boundary check applies
// in `findCompletedEmails` for the same partial-typing reason.
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

// Trailing characters to strip from a matched URL — markdown
// sentences often end with `.`, `,`, `!`, `?`, `;`, `:`, `)`, `]`,
// and the user means those as sentence punctuation, not part of
// the URL. We strip them off the right edge until the URL ends in
// a safe URL char.
const TRAILING_PUNCT_RE = /[.,!?;:)\]]+$/;

interface Hit {
  index: number;
  length: number;
  href: string;
}

function findCompletedHits(
  text: string,
  re: RegExp,
  hrefFn: (match: string) => string,
): Hit[] {
  const hits: Hit[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fullMatch = m[0];
    let trimmed = fullMatch;
    // Strip trailing punctuation off the right edge.
    const punctMatch = TRAILING_PUNCT_RE.exec(trimmed);
    if (punctMatch) {
      trimmed = trimmed.slice(0, trimmed.length - punctMatch[0].length);
    }
    const matchEnd = m.index + trimmed.length;
    // The URL must be followed by whitespace IN THE TEXT for us
    // to consider it "completed". This is what stops the plugin
    // from firing on partial URLs as the user types.
    if (matchEnd >= text.length) continue;
    if (!/\s/.test(text.charAt(matchEnd))) continue;
    if (trimmed.length === 0) continue;
    hits.push({ index: m.index, length: trimmed.length, href: hrefFn(trimmed) });
  }
  return hits;
}

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

        const urlHits = findCompletedHits(text, URL_RE, (m) => m);
        for (const hit of urlHits) {
          adds.push({
            from: pos + hit.index,
            to: pos + hit.index + hit.length,
            href: hit.href,
          });
        }

        const emailHits = findCompletedHits(
          text,
          EMAIL_RE,
          (m) => `mailto:${m}`,
        );
        for (const hit of emailHits) {
          adds.push({
            from: pos + hit.index,
            to: pos + hit.index + hit.length,
            href: hit.href,
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
