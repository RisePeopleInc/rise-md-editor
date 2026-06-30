import { splitFrontmatter } from './markdown';
import { buildPreviewMarkdownIt } from './previewMarkdownIt';

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
 *      relative `assets/foo.png` paths to `rise-md-asset://...`
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
/**
 * Font-family CSS vars (`--font-sans`, `--font-serif`) live in a
 * dedicated tokens file so this off-screen print window can include
 * them as plain `:root` declarations. Inlining themes.css alone
 * doesn't cut it: themes.css declares the fonts inside Tailwind v4's
 * `@theme inline { … }` block, which the browser silently drops
 * when it sees raw (no Tailwind processing in the print window).
 * That dropped block was the smoking gun behind RAISE-42 smoke-test
 * rounds 1-9 where the PDF body kept rendering as Times Roman.
 */
import fontTokensCss from '../styles/font-tokens.css?inline';

/**
 * Sentinel marker the renderer drops into the print HTML; the
 * main process replaces it with the actual @font-face CSS block
 * (woff2 files inlined as data URIs) just before writing the
 * print HTML to a temp file.
 *
 * Smoke-test feedback round 7: previous rounds tried bundling
 * the fonts in the renderer via Vite's `?url` import + fetch().
 * In dev (renderer at `http://localhost:5173`) the relative
 * `/assets/foo.woff2` URL resolved fine. In prod (renderer at
 * `file://...index.html`), `fetch('/assets/foo.woff2')` resolves
 * against the filesystem root, not the renderer's bundle dir,
 * so the fetch fails silently — body fell back to system serif.
 *
 * Solution: main process reads font files via Node's `fs` (works
 * uniformly in dev and asar-packed prod) and substitutes them
 * into the placeholder. Renderer just emits the marker. See
 * `buildPrintFontCss` in `src/main/exportPdf.ts`.
 */
export const PRINT_FONT_PLACEHOLDER = '<!-- RAISE_PRINT_FONTS -->';

/**
 * What's being built — affects which CSS files get inlined.
 *
 * RAISE-53 introduced the split: HTML export gets a leaner bundle
 * that matches the WYSIWYG visual (centered max-width, surface-tone
 * code blocks) instead of the print-tuned overrides (full-width,
 * near-white code blocks, @page rules, page-break-avoid). Both
 * modes share the markdown-it pipeline + the prose CSS + the font
 * substitution; they diverge only in the trailing print/html
 * stylesheet.
 */
export type PrintHtmlOutputMode = 'pdf' | 'html';

interface BuildHtmlOptions {
  /** Document title — used for the print header `{title}` placeholder and the HTML `<title>`. */
  title: string;
  /** The active document's markdown source (whole or a selection). */
  markdownSource: string;
  /** Filesystem path of the active document, if saved. Used to resolve relative image references. */
  markdownPath: string | null;
  /** Strip review-style comments (`<!-- … -->`, `// …`) before rendering. Matches the dominant convention across competitor markdown editors (Obsidian, iA Writer, Typora, Marked 2 all hide comments in exports). Code-region aware — comments inside fenced code blocks survive verbatim. */
  stripComments: boolean;
  /** RAISE-53: which output is being built. Defaults to 'pdf' to preserve the original PDF-export behaviour. */
  outputMode?: PrintHtmlOutputMode;
}

/**
 * RAISE-53: HTML-export-specific CSS. Replaces `print.css` for the
 * 'html' output mode. Two responsibilities:
 *
 *   1. Constrain the body to a centered max-width column (matches
 *      WYSIWYG's `mx-auto max-w-[720px] px-6 py-8` layout, so the
 *      exported HTML feels visually identical to the editor view
 *      the author was working in).
 *
 *   2. Strip print-only quirks the user wouldn't expect in a
 *      browser-viewed HTML page: @page rules, page-break-avoid,
 *      print-toned `pre`/`code` overrides that diverge from the
 *      surface-elevated wash the WYSIWYG editor shows.
 *
 * Kept inline (not a separate CSS file) because it's small, tightly
 * coupled to this output mode, and reduces the bundle's import
 * graph by one entry. If it grows past ~40 lines, promote to its
 * own `.css?inline` import.
 */
const htmlExportCss = `
body.rise-md-prose {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 24px;
  background: var(--rise-app, #ffffff);
}
`;

/**
 * Lightweight CSS minifier — strips `/* … *‍/` comments and collapses
 * whitespace around structural punctuation. Applied only to the
 * HTML-export path (`outputMode === 'html'`); PDF gets the
 * unminified CSS so a future debugging session inspecting the
 * print-window's DevTools still sees readable source.
 *
 * Smoke-test feedback from the RAISE-53 review: the inlined
 * CSS in exported HTML was several hundred lines of comments and
 * documentation, dwarfing the actual rules. The user pointed out
 * the bloat and asked for at-minimum minification.
 *
 * The minifier is deliberately conservative — no name shortening,
 * no rule de-duplication, no dead-code elimination. Those are
 * harder problems (especially with the WYSIWYG-only `.ProseMirror`
 * selectors in `milkdown.css`) and risk introducing regressions
 * for tiny wins. Comment+whitespace stripping alone takes the
 * exported `<style>` block from ~20KB to ~6KB without changing
 * any rendered byte.
 *
 * Safe against the CSS in this project: no `url(…)` references
 * with embedded spaces, no `content: "…"` string literals (both
 * verified at minifier-introduction time). The @font-face `url(…)`
 * declarations come from main-process substitution AFTER renderer
 * minification, so their base64 payloads are untouched.
 */
function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
    .replace(/\s+/g, ' ') // collapse whitespace runs
    .replace(/\s*([{}:;,>])\s*/g, '$1') // tighten around structural punctuation
    .replace(/;}/g, '}') // drop redundant trailing semicolons
    .trim();
}

/**
 * Match a fenced or inline code region the comment strip must
 * skip — so a literal `<!--` or `//` inside a markdown tutorial's
 * code sample stays in the exported PDF.
 *
 * Mirrors the same pattern used in `emptyParagraphMarker.ts` and
 * `gemojiNode.ts`. Pragmatic, not 100% commonmark-correct (no
 * indented-code-block handling, no support for arbitrary backtick-
 * fence lengths beyond 1/2/3+) — covers the realistic shapes well
 * enough that the comment strip preserves user code samples.
 */
const CODE_REGION_RE = /^```[\s\S]*?^```$|^~~~[\s\S]*?^~~~$|``[^`\n]+``|`[^`\n]+`/gm;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const LINE_COMMENT_RE = /^[ \t]*\/\/.*(?:\r?\n)?/gm;

function stripCommentsInPlainText(text: string): string {
  return text.replace(HTML_COMMENT_RE, '').replace(LINE_COMMENT_RE, '');
}

/**
 * Single-tilde strikethrough — Milkdown's GFM input rule accepts
 * both `~text~` and `~~text~~` (matches the pattern
 * `(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/`), so the WYSIWYG editor
 * renders single-tilde input as strikethrough. markdown-it's
 * built-in strikethrough rule, by contrast, hard-rejects runs
 * shorter than two tildes (`if (len < 2) return false`). Without
 * intervention `~text~` renders fine in WYSIWYG but as plain text
 * in preview/split/HTML-export — a confusing inconsistency.
 *
 * Fix: rewrite single-tilde pairs to double tildes before parsing,
 * so markdown-it's existing `~~`-handling renders them. Mirrors
 * Milkdown's boundary conditions:
 *   - opening `~` not preceded by a word char or tilde; not
 *     followed by another tilde or whitespace
 *   - closing `~` not preceded by whitespace or tilde; not
 *     followed by a word char or tilde
 *
 * Same code-region-aware split as `stripComments` so single tildes
 * inside fenced/inline code (e.g. a shell snippet showing
 * `~/foo`) pass through untouched.
 */
const SINGLE_TILDE_RE = /(?<![\w~])~(?!~|\s)([^~\n]+?)(?<!\s|~)~(?!\w|~)/g;

function expandSingleTildeInPlainText(text: string): string {
  return text.replace(SINGLE_TILDE_RE, '~~$1~~');
}

export function expandSingleTildeStrikethrough(markdown: string): string {
  if (!markdown || !markdown.includes('~')) return markdown;
  let result = '';
  let cursor = 0;
  CODE_REGION_RE.lastIndex = 0;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = CODE_REGION_RE.exec(markdown)) !== null) {
    if (codeMatch.index > cursor) {
      result += expandSingleTildeInPlainText(markdown.slice(cursor, codeMatch.index));
    }
    result += codeMatch[0];
    cursor = codeMatch.index + codeMatch[0].length;
  }
  if (cursor < markdown.length) {
    result += expandSingleTildeInPlainText(markdown.slice(cursor));
  }
  return result;
}

/**
 * Strip review-style comments (`<!-- ... -->` HTML and `// ...`
 * line comments) from a markdown source, code-region aware.
 *
 * Splits the input into [text, code, text, code, …] segments via
 * `CODE_REGION_RE` and runs the strip only on the text segments;
 * code regions pass through verbatim. Net effect: comments in
 * prose disappear; comments shown inside a markdown tutorial's
 * code sample (`\`\`\`html\n<!-- example -->\n\`\`\``) survive.
 *
 * Collapses 3+ consecutive newlines back to 2 after the strip,
 * since a comment-only paragraph becomes an empty line that
 * adjacent blank lines collapse to a paragraph break — without
 * the collapse the source would gain runs of blank lines where
 * comments used to be.
 */
function stripComments(markdown: string): string {
  if (!markdown) return markdown;
  if (!markdown.includes('<!--') && !/^[ \t]*\/\//m.test(markdown)) {
    return markdown;
  }
  let result = '';
  let cursor = 0;
  CODE_REGION_RE.lastIndex = 0;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = CODE_REGION_RE.exec(markdown)) !== null) {
    if (codeMatch.index > cursor) {
      result += stripCommentsInPlainText(markdown.slice(cursor, codeMatch.index));
    }
    result += codeMatch[0];
    cursor = codeMatch.index + codeMatch[0].length;
  }
  if (cursor < markdown.length) {
    result += stripCommentsInPlainText(markdown.slice(cursor));
  }
  return result.replace(/\n{3,}/g, '\n\n');
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
function resolveImageForPrint(src: string, markdownPath: string | null): string {
  if (!src) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  if (!markdownPath) return src;

  const lastSep = Math.max(markdownPath.lastIndexOf('/'), markdownPath.lastIndexOf('\\'));
  const dir = lastSep >= 0 ? markdownPath.slice(0, lastSep) : '';

  let absolute = `${dir}/${src}`.replace(/\\/g, '/');
  if (!absolute.startsWith('/')) absolute = `/${absolute}`;
  return `file://${encodeURI(absolute)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the complete print-shell HTML document. The print font
 * @font-face declarations are filled in by the main process
 * (substituting the `PRINT_FONT_PLACEHOLDER` marker) — main has
 * Node `fs` access in both dev and asar-packed prod, where
 * renderer-side `fetch()` of relative paths is unreliable.
 *
 * Force the light theme regardless of the user's current setting
 * — exporting a dark-themed page wastes ink and is the consensus
 * pain point in the competitive set.
 */
export function buildPrintHtml(opts: BuildHtmlOptions): string {
  // RAISE-61: shared preview pipeline. Print uses static (non-interactive)
  // task-list checkboxes and resolves images to `file://` (the off-screen
  // print window doesn't see the `rise-md-asset://` protocol handler).
  const md = buildPreviewMarkdownIt({
    taskListsEnabled: false,
    imageSrcResolver: (src) => resolveImageForPrint(src, opts.markdownPath),
  });

  // Reuse SplitView's frontmatter handling: split YAML off the
  // top, render the body, prepend a styled metadata block.
  const { frontmatter, body } = splitFrontmatter(opts.markdownSource);
  // Strip review-style comments before rendering when the
  // toggle is on (default). Matches Obsidian / iA Writer /
  // Typora / Marked 2 / VSCode-markdown-pdf — every surveyed
  // competitor hides comments in exports by default. Source-
  // level strip (vs CSS-hiding) keeps the resulting PDF byte-
  // clean: no invisible comment text dragged along in the PDF
  // for a recipient to extract.
  const commentStripped = opts.stripComments ? stripComments(body) : body;
  // Single-tilde strikethrough — keep the export visually consistent
  // with the WYSIWYG editor, which renders `~text~` as <del> via
  // Milkdown's GFM input rule.
  const renderSource = expandSingleTildeStrikethrough(commentStripped);
  const bodyHtml = md.render(renderSource);
  let bodyContent = bodyHtml;
  if (frontmatter !== null) {
    const escapedFm = escapeHtml(frontmatter);
    bodyContent =
      `<div class="rise-md-frontmatter-preview"><pre>${escapedFm}</pre></div>` + bodyHtml;
  }

  // RAISE-53: pick the trailing stylesheet based on output mode.
  // PDF gets print.css (page-break rules, near-white code blocks
  // optimised for paper). HTML gets the inline htmlExportCss
  // (centered max-width, no @page rules, code blocks inherit the
  // WYSIWYG-tone styling from proseCss). proseCss + themesCss +
  // fontTokensCss are shared.
  const outputMode = opts.outputMode ?? 'pdf';
  const trailingCss = outputMode === 'html' ? htmlExportCss : printCss;

  // HTML export: minify the inlined stylesheet to keep the output
  // file lean (smoke-test feedback for RAISE-53). PDF stays
  // unminified — the off-screen print window's DevTools is a
  // useful debugging surface when print layouts misbehave.
  const composedCss = `${fontTokensCss}\n${themesCss}\n${proseCss}\n${trailingCss}`;
  const finalCss = outputMode === 'html' ? minifyCss(composedCss) : composedCss;

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
${PRINT_FONT_PLACEHOLDER}
${finalCss}
</style>
</head>
<body class="rise-md-prose">
${bodyContent}
</body>
</html>`;
}
