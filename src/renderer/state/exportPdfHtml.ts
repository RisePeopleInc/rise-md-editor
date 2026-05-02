import MarkdownIt from 'markdown-it';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItTaskLists from 'markdown-it-task-lists';
import { splitFrontmatter } from './markdown';
import { markdownItComments } from './markdownItComments';

/**
 * Build the print-ready HTML for PDF export
 * ([RAISE-42](https://risepeople.atlassian.net/browse/RAISE-42)).
 *
 * Mirrors the `SplitView` markdown-it pipeline so the PDF looks
 * exactly like the split-preview pane:
 *
 *   - GFM task lists rendered as checkboxes (RAISE-29)
 *   - Emoji shortcodes rendered as Unicode chars (RAISE-30)
 *   - Review-style comments rendered muted-italic (RAISE-31)
 *   - YAML frontmatter rendered as a metadata block above the body
 *     (RAISE-32)
 *   - Linkified bare URLs, typographer quotes, etc.
 *
 * Two deliberate divergences from the live preview:
 *
 *   1. **Image src resolution** — the live preview rewrites
 *      relative `assets/foo.png` paths to `raise-asset://...`
 *      URLs that the main process serves from disk. The off-
 *      screen print BrowserWindow doesn't have access to that
 *      protocol, so we instead inline images as `data:` URIs
 *      (when an absolute filesystem path can be derived) or
 *      pass through `file://` for absolute paths. Done in
 *      `resolveImageForPrint` below.
 *
 *   2. **No task-list interactivity** — print HTML doesn't need
 *      click-to-toggle handlers, so checkboxes render as
 *      `disabled`-style static glyphs (the GFM plugin does this
 *      automatically when `enabled: false`).
 *
 * The output is a complete HTML document (doctype, head, body,
 * inline styles) — no external resources except embedded fonts.
 * That keeps the off-screen render hermetic: no async network
 * fetches, no dependence on the renderer process surviving the
 * print, no protocol-handler coupling.
 */

/**
 * Inline `print.css` content. Pulled in via `?inline` so Vite
 * embeds the CSS source as a string rather than as a separate
 * file we'd have to fetch.
 */
import printCss from '../styles/print.css?inline';
import proseCss from '../styles/milkdown.css?inline';
import themesCss from '../styles/themes.css?inline';

interface BuildHtmlOptions {
  /** Document title — used for the print header `{title}` placeholder and the HTML `<title>`. */
  title: string;
  /** The active document's markdown source (whole or a selection). */
  markdownSource: string;
  /** Filesystem path of the active document, if saved. Used to resolve relative image references. */
  markdownPath: string | null;
}

/**
 * Resolve a markdown-image src to something the off-screen print
 * window can fetch. Three cases:
 *
 *   1. **Absolute URL** (`http://...`, `https://...`, `data:...`,
 *      `file://...`) — pass through. Network fetches will work
 *      from the off-screen window with `webSecurity: true` as
 *      long as the URL is reachable.
 *   2. **Relative path with a known doc dir** — resolve against
 *      the doc dir and rewrite to `file:///...` so Chromium
 *      reads from disk directly.
 *   3. **Relative path with no doc dir** (untitled document with
 *      pasted images) — pass through and accept that the image
 *      will render as broken in the PDF. Untitled docs typically
 *      don't have local image references anyway.
 */
function resolveImageForPrint(
  src: string,
  markdownPath: string | null,
): string {
  if (!src) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  if (!markdownPath) return src;

  const lastSep = Math.max(
    markdownPath.lastIndexOf('/'),
    markdownPath.lastIndexOf('\\'),
  );
  const dir = lastSep >= 0 ? markdownPath.slice(0, lastSep) : '';

  let absolute = `${dir}/${src}`.replace(/\\/g, '/');
  if (!absolute.startsWith('/')) absolute = `/${absolute}`;
  return `file://${encodeURI(absolute)}`;
}

function buildMarkdownIt(markdownPath: string | null): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
  });
  // Match SplitView's plugin set — keeps the PDF visually identical
  // to what the user sees in the split-preview pane.
  md.use(markdownItTaskLists, { enabled: false, label: true });
  md.use(markdownItEmoji);
  md.use(markdownItComments);

  // Image-src rewrite for print. Same pattern as SplitView, but
  // resolves to `file://` rather than `raise-asset://` because
  // the off-screen print window doesn't see the custom protocol
  // handler registered on the main BrowserWindow.
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const srcIdx = token.attrIndex('src');
    if (srcIdx >= 0) {
      const src = token.attrs?.[srcIdx]?.[1] ?? '';
      const resolved = resolveImageForPrint(src, markdownPath);
      token.attrs![srcIdx]![1] = resolved;
    }
    return defaultImage
      ? defaultImage(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
  return md;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the complete print-shell HTML document. The off-screen
 * BrowserWindow loads this via `data:text/html`; nothing further
 * is fetched once the document parses.
 */
export function buildPrintHtml(opts: BuildHtmlOptions): string {
  const md = buildMarkdownIt(opts.markdownPath);

  // Reuse SplitView's frontmatter handling: split YAML off the
  // top, render the body, prepend a styled metadata block.
  const { frontmatter, body } = splitFrontmatter(opts.markdownSource);
  const bodyHtml = md.render(body);
  let bodyContent = bodyHtml;
  if (frontmatter !== null) {
    const escapedFm = escapeHtml(frontmatter);
    bodyContent =
      `<div class="raise-frontmatter-preview"><pre>${escapedFm}</pre></div>` +
      bodyHtml;
  }

  // Force the light theme regardless of the user's current setting
  // — exporting a dark-themed page wastes ink and is the consensus
  // pain point in the competitive set.
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
${themesCss}
${proseCss}
${printCss}
</style>
</head>
<body class="raise-prose">
${bodyContent}
</body>
</html>`;
}
