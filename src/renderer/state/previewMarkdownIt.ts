import MarkdownIt from 'markdown-it';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItTaskLists from 'markdown-it-task-lists';
import { looksLikeFilenameExtension } from './filenameExtensions';
import { markdownItComments } from './markdownItComments';

/**
 * Per-surface differences between the read-only preview pipelines
 * (Split / Read / print). Kept deliberately minimal (RAISE-61): only the
 * two knobs that genuinely differ today live here. Anything else that ever
 * needs to vary can be added when there's a concrete second consumer for it.
 */
export interface PreviewMarkdownItOptions {
  /**
   * Whether GFM task-list checkboxes are interactive. `enabled: true` drops
   * the `disabled` attribute so the `<input>` fires change events —
   * `true` for Split and Read (click-to-toggle, RAISE-29 / RAISE-85),
   * `false` for the print pipeline (static checkboxes in PDF / HTML export).
   */
  taskListsEnabled: boolean;
  /**
   * Rewrites a raw markdown image `src` into a URL the consuming surface can
   * actually load. Split / Read resolve to `rise-md-asset://` (via
   * `resolveAssetUrl`); the print path resolves to `file://` (via
   * `resolveImageForPrint`) because the off-screen print window doesn't see
   * the custom protocol handler. Pass a closure that reads the latest
   * markdown path — e.g. `(src) => resolveAssetUrl(markdownPathRef.current,
   * src)` — so the image rule (registered once) picks up path changes
   * without rebuilding the `MarkdownIt` instance on every keystroke.
   */
  imageSrcResolver: (rawSrc: string) => string;
}

/**
 * Build the shared `markdown-it` instance used by every read-only preview
 * surface — SplitView, ReadView, and the PDF / HTML export — consolidating
 * three copy-pasted instances into one (RAISE-61).
 *
 * Fixed config, identical across all three consumers: `html: false` (escape
 * raw HTML — local notes rarely need it and we'd rather not pass arbitrary
 * tags through), `linkify: true` (autolink explicit-scheme URLs, emails, and
 * bare hostnames), `typographer: true`, and `breaks: false` (a single
 * newline is not a `<br>`, matching CommonMark / Milkdown). Plugin chain:
 * task-lists, emoji (full GitHub set), comment-greying. Plus the RAISE-47
 * filename-shaped autolink suppression and the RAISE-11 image-src rewrite.
 *
 * The two per-surface differences come in through {@link PreviewMarkdownItOptions}.
 */
export function buildPreviewMarkdownIt(options: PreviewMarkdownItOptions): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
  });

  // RAISE-47: keep linkify's default `fuzzyLink: true` so real bare-domain
  // references (`www.cbc.ca`, `internet.com`) autolink as the user expects,
  // but intercept the rendered link tokens and unwrap any whose href points
  // at a filename-shaped suffix (`file.md`, `notes.txt`, `app.config`). The
  // autolink-literal extension can't tell `.md` (Moldova's TLD) apart from
  // `.md` (a markdown file extension); the discrimination happens here,
  // post-tokenisation, against `FILE_EXTENSION_TLDS` via
  // `looksLikeFilenameExtension`.
  const defaultLinkOpen = md.renderer.rules['link_open'];
  const defaultLinkClose = md.renderer.rules['link_close'];
  const wrapLinkRule =
    (defaultRule: typeof defaultLinkOpen) =>
    (
      tokens: Parameters<NonNullable<typeof defaultLinkOpen>>[0],
      idx: Parameters<NonNullable<typeof defaultLinkOpen>>[1],
      ruleOptions: Parameters<NonNullable<typeof defaultLinkOpen>>[2],
      env: Parameters<NonNullable<typeof defaultLinkOpen>>[3],
      self: Parameters<NonNullable<typeof defaultLinkOpen>>[4],
    ) => {
      // The matched-pair `link_close` token's open mate carries the
      // `meta.fileShaped` flag; we set it on the open and read it on the close.
      const token = tokens[idx]!;
      if (token.type === 'link_open') {
        const hrefIdx = token.attrIndex('href');
        if (hrefIdx >= 0) {
          const href = token.attrs?.[hrefIdx]?.[1] ?? '';
          if (looksLikeFilenameExtension(href)) {
            token.meta = { ...(token.meta ?? {}), fileShaped: true };
            return ''; // suppress the <a> open
          }
        }
      }
      if (token.type === 'link_close') {
        // Walk back to the matching `link_open`. Inline tokens carry no
        // explicit pair index, so scan back for the nearest unmatched open;
        // the pair is always balanced within the same `inline` token.
        let depth = 1;
        for (let i = idx - 1; i >= 0; i--) {
          const t = tokens[i]!;
          if (t.type === 'link_close') depth += 1;
          else if (t.type === 'link_open') {
            depth -= 1;
            if (depth === 0) {
              if (t.meta?.['fileShaped']) return ''; // suppress </a>
              break;
            }
          }
        }
      }
      return defaultRule
        ? defaultRule(tokens, idx, ruleOptions, env, self)
        : self.renderToken(tokens, idx, ruleOptions);
    };
  md.renderer.rules['link_open'] = wrapLinkRule(defaultLinkOpen);
  md.renderer.rules['link_close'] = wrapLinkRule(defaultLinkClose);

  // RAISE-29 / RAISE-85: GFM task lists. `enabled` controls whether the
  // checkbox is interactive (drops `disabled`); `label: true` wraps the item
  // text in a <label> for accessibility and a completed-item CSS hook.
  md.use(markdownItTaskLists, { enabled: options.taskListsEnabled, label: true });
  // RAISE-30: GitHub emoji shortcodes (`:warning:` → ⚠️). Full set (~1500
  // codes); respects code spans / fenced blocks; unknown codes pass through.
  md.use(markdownItEmoji);
  // RAISE-31: render review-style comments (`<!-- … -->`, leading `// …`)
  // greyed-out via `class="md-comment"`. Skips code naturally.
  md.use(markdownItComments);

  // RAISE-11: rewrite a relative image `src` at render time to a URL the
  // surface can load. The target form is the caller's concern (passed via
  // `imageSrcResolver`): `rise-md-asset://` for Split / Read, `file://` for
  // print. We mutate the token's `src` before delegating to the default rule.
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, ruleOptions, env, self) => {
    const token = tokens[idx]!;
    const srcIdx = token.attrIndex('src');
    if (srcIdx >= 0) {
      const src = token.attrs?.[srcIdx]?.[1] ?? '';
      token.attrs![srcIdx]![1] = options.imageSrcResolver(src);
    }
    return defaultImage
      ? defaultImage(tokens, idx, ruleOptions, env, self)
      : self.renderToken(tokens, idx, ruleOptions);
  };

  return md;
}
