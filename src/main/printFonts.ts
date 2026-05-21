import { promises as fs } from 'node:fs';

/**
 * Shared font helpers for the print-ready HTML pipeline.
 *
 * The renderer's `buildPrintHtml` drops a placeholder marker
 * (`PRINT_FONT_PLACEHOLDER`) in the `<style>` block. Main substitutes
 * the actual @font-face declarations — Open Sans 400 / 600 / 700 and
 * Source Serif Pro 700, woff2 contents inlined as data URIs — just
 * before handing the HTML off to its consumer (off-screen print
 * window for PDF, file write for HTML export).
 *
 * Reading the font files in main vs the renderer is deliberate:
 * the renderer's `file://` origin can't reach
 * `node_modules/@fontsource/...` reliably in production builds. Main
 * has Node's `fs` everywhere, including inside the asar.
 *
 * Originally lived inside `exportPdf.ts`. Moved here once HTML export
 * (RAISE-53) needed the same font-substitution pipeline.
 */

/** Renderer-side sentinel — must match the constant in `src/renderer/state/exportPdfHtml.ts`. */
export const PRINT_FONT_PLACEHOLDER = '<!-- RAISE_PRINT_FONTS -->';

const fontDataUriCache = new Map<string, string>();

async function readBundledFontDataUri(packageRelativePath: string): Promise<string> {
  const cached = fontDataUriCache.get(packageRelativePath);
  if (cached) return cached;
  const absolute = require.resolve(packageRelativePath);
  const buffer = await fs.readFile(absolute);
  const dataUri = `data:font/woff2;base64,${buffer.toString('base64')}`;
  fontDataUriCache.set(packageRelativePath, dataUri);
  return dataUri;
}

/**
 * Build the @font-face declarations for the four Rise brand fonts
 * with the woff2 contents inlined as data URIs. Idempotent + cached;
 * safe to call once per export.
 */
export async function buildPrintFontCss(): Promise<string> {
  const [openSans400, openSans600, openSans700, sourceSerifPro700] = await Promise.all([
    readBundledFontDataUri('@fontsource/open-sans/files/open-sans-latin-400-normal.woff2'),
    readBundledFontDataUri('@fontsource/open-sans/files/open-sans-latin-600-normal.woff2'),
    readBundledFontDataUri('@fontsource/open-sans/files/open-sans-latin-700-normal.woff2'),
    readBundledFontDataUri(
      '@fontsource/source-serif-pro/files/source-serif-pro-latin-700-normal.woff2',
    ),
  ]);
  return `
@font-face {
  font-family: 'Open Sans';
  font-weight: 400;
  font-style: normal;
  font-display: block;
  src: url(${openSans400}) format('woff2');
}
@font-face {
  font-family: 'Open Sans';
  font-weight: 600;
  font-style: normal;
  font-display: block;
  src: url(${openSans600}) format('woff2');
}
@font-face {
  font-family: 'Open Sans';
  font-weight: 700;
  font-style: normal;
  font-display: block;
  src: url(${openSans700}) format('woff2');
}
@font-face {
  font-family: 'Source Serif Pro';
  font-weight: 700;
  font-style: normal;
  font-display: block;
  src: url(${sourceSerifPro700}) format('woff2');
}
`;
}

/**
 * Substitute the font placeholder in the renderer-built HTML with the
 * actual @font-face block. The function form for `replace` is
 * intentional — base64 strings can't contain `$` characters, but the
 * function form is unambiguously safe against `$1` / `$&` interpolation.
 */
export async function injectPrintFonts(html: string): Promise<string> {
  const fontCss = await buildPrintFontCss();
  return html.replace(PRINT_FONT_PLACEHOLDER, () => fontCss);
}
