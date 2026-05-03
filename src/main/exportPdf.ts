import { app, BrowserWindow, dialog, shell, type PrintToPDFOptions } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Export-to-PDF main-process module
 * ([RAISE-42](https://risepeople.atlassian.net/browse/RAISE-42)).
 *
 * The renderer builds the print-ready HTML (markdown-it preview output
 * wrapped in a print-shell with the Rise design-system CSS + the
 * print-specific overrides) and hands it to us via IPC. We:
 *
 *   1. Create a hidden, off-screen `BrowserWindow`.
 *   2. Load the HTML as a `data:text/html` URL.
 *   3. Wait for `did-finish-load`.
 *   4. Call `webContents.printToPDF()` with the layout options the
 *      user chose in the modal.
 *   5. Show the save dialog, write the PDF, optionally open it.
 *   6. Always destroy the off-screen window — even on error — so
 *      we don't leak GPU processes between exports.
 *
 * The render-in-renderer approach (vs render-in-main) means the PDF
 * uses the exact same markdown-it instance + plugins (RAISE-29 task
 * lists, RAISE-30 emoji, RAISE-31 comments, etc.) that the user sees
 * in the split-preview pane. No separate parser to maintain.
 */

/**
 * Standard ISO + ANSI page sizes accepted by Chromium's
 * `printToPDF`. Custom sizes are passed through as
 * `{ width, height }` (in microns to the API; see usage below).
 */
export type PageSizeName = 'Letter' | 'Legal' | 'Tabloid' | 'A3' | 'A4' | 'A5';

export interface CustomPageSize {
  /** Width in inches. */
  width: number;
  /** Height in inches. */
  height: number;
}

export interface ExportPdfOptions {
  /** Complete HTML document including doctype, head, and body. */
  html: string;
  /** Suggested file name (without extension) for the save dialog. */
  defaultBaseName: string;
  /** Directory the save dialog should default to. */
  defaultDir: string | null;
  /** Page size — built-in name or a custom width/height in inches. */
  pageSize: PageSizeName | CustomPageSize;
  /** Portrait or landscape orientation. */
  landscape: boolean;
  /** Per-side margins in inches. */
  margins: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  /** Render scale (0.5 – 2.0). */
  scale: number;
  /** Header / footer template options. `null` disables both. */
  headerFooter: {
    showHeader: boolean;
    showFooter: boolean;
    /** Header / footer text (per slot). Placeholders supported:
     *  `{title}`, `{date}`, `{page}`, `{pages}` (substituted by
     *  Chromium's display-header-footer span class system), plus
     *  `{author}` and `{email}` (substituted by our own pass below
     *  using the values supplied alongside this object). */
    headerLeft: string;
    headerCenter: string;
    headerRight: string;
    footerLeft: string;
    footerCenter: string;
    footerRight: string;
    /** Author / email used for the `{author}` and `{email}`
     *  placeholders. Empty strings disable substitution but are
     *  passed through verbatim if the user wrote `{author}` in
     *  the slot (renders as empty). */
    author: string;
    email: string;
  } | null;
  /** Open the PDF in the OS default reader after export. */
  openAfter: boolean;
}

export type ExportPdfResult =
  | { status: 'saved'; path: string }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

/**
 * Convert our inch-denominated margins into the inch values
 * Chromium's `printToPDF` expects (the API uses inches for both
 * page size and margin fields).
 */
function inchesMargins(opts: ExportPdfOptions['margins']): PrintToPDFOptions['margins'] {
  return {
    top: opts.top,
    bottom: opts.bottom,
    left: opts.left,
    right: opts.right,
  };
}

/**
 * Build the Chromium `pageSize` argument from the user's choice.
 * Built-in names pass through; custom sizes go in as
 * `{ width, height }` in inches.
 */
function pageSizeArg(
  size: ExportPdfOptions['pageSize'],
): PrintToPDFOptions['pageSize'] {
  if (typeof size === 'string') return size;
  return { width: size.width, height: size.height };
}

/**
 * Build the Chromium header / footer template HTML from the user's
 * left / center / right text. Chromium's `displayHeaderFooter`
 * mode supports a tiny set of CSS classes for substitution:
 *
 *   - `.title`        → document title (we set via the print HTML)
 *   - `.url`          → page URL (we don't use)
 *   - `.pageNumber`   → current page number
 *   - `.totalPages`   → total page count
 *   - `.date`         → ISO date string
 *
 * Our user-visible placeholders (`{title}`, `{date}`, `{page}`,
 * `{pages}`) map to these spans. The user's placeholder text is
 * embedded in a 3-cell flex layout so left / center / right align
 * predictably.
 *
 * Header / footer fonts are pinned to small (8pt) and grey (#666)
 * because Chromium otherwise inherits the body font (whatever's
 * in the print-shell), which produces oversized headers on a
 * 20mm margin.
 */
function buildSlotTemplate(
  left: string,
  center: string,
  right: string,
  author: string,
  email: string,
): string {
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  // `{author}` / `{email}` are our own placeholders — substituted
  // *before* escape so the user-supplied values are HTML-safe in
  // the final output. Chromium's built-in placeholders
  // (`{title}`, `{date}`, `{page}`, `{pages}`) become `<span>`
  // markers it fills in at print time, so they're safe to
  // substitute *after* escape.
  const substituteUserValues = (s: string): string =>
    s
      .replace(/\{author\}/g, author)
      .replace(/\{email\}/g, email);
  const substituteSpans = (s: string): string =>
    escape(substituteUserValues(s))
      .replace(/\{title\}/g, '<span class="title"></span>')
      .replace(/\{date\}/g, '<span class="date"></span>')
      .replace(/\{page\}/g, '<span class="pageNumber"></span>')
      .replace(/\{pages\}/g, '<span class="totalPages"></span>');
  // Inline styles — Chromium's header/footer renderer doesn't
  // include the page's own stylesheet, so the templates have to
  // carry every style they need.
  //
  // Smoke-test feedback round 2: the previous `-apple-system`
  // stack didn't render consistently in the header/footer
  // context (Chromium's print-template runs in a separate
  // browsing context where some `-apple-system` resolutions
  // miss). Switched to a universal-OS sans-serif stack —
  // `Helvetica Neue` (macOS / iOS), `Arial` (Windows / Linux
  // ubiquitous), then `sans-serif` generic — which renders
  // predictably across platforms without any `-apple-system`
  // weirdness.
  const baseStyle =
    'font-size:8pt; color:#666; width:100%; padding:0 0.5cm; ' +
    "font-family:'Helvetica Neue', Arial, sans-serif;";
  const cellStyle = 'flex:1; min-width:0;';
  return `
<div style="display:flex; ${baseStyle}">
  <div style="${cellStyle} text-align:left">${substituteSpans(left)}</div>
  <div style="${cellStyle} text-align:center">${substituteSpans(center)}</div>
  <div style="${cellStyle} text-align:right">${substituteSpans(right)}</div>
</div>`;
}

/**
 * Run a single export: build off-screen window, render HTML,
 * print to PDF buffer, save, optionally open.
 */
export async function exportToPdf(
  parent: BrowserWindow,
  opts: ExportPdfOptions,
): Promise<ExportPdfResult> {
  // Save dialog FIRST — if the user cancels, we don't waste a
  // BrowserWindow + render cycle. Default to `<defaultDir>/<basename>.pdf`,
  // falling back to whatever Electron picks (typically Downloads)
  // when there's no associated file dir.
  const suggestedPath = opts.defaultDir
    ? path.join(opts.defaultDir, `${opts.defaultBaseName}.pdf`)
    : `${opts.defaultBaseName}.pdf`;
  const saveResult = await dialog.showSaveDialog(parent, {
    title: 'Export to PDF',
    defaultPath: suggestedPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { status: 'canceled' };
  }
  const outputPath = saveResult.filePath;

  // Off-screen render window. `show: false` keeps the window from
  // ever being visible; the rest of the options minimise memory
  // and security surface (no preload, no dev tools, no node).
  const renderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: false, // offscreen=true breaks printToPDF on some platforms
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // No preload — the print-shell HTML is self-contained.
    },
  });

  let tempHtmlPath: string | null = null;
  try {
    // Write the HTML to a temp file in the OS temp dir and load
    // via `file://`. Smoke-test feedback rounds 2 + 3 + 4 chased
    // a font-loading bug where the off-screen window's
    // `data:text/html` origin (null origin) had inconsistent
    // behaviour around @font-face data URIs and cross-origin
    // CSS imports. Loading from a real `file://` URL gives the
    // window a normal local origin where every modern font-
    // loading mechanism (data URIs in @font-face, relative
    // paths, etc.) just works.
    //
    // Temp file is created in the app's userData dir (which is
    // always writeable) so the print window can also resolve
    // any same-directory relative references the HTML might
    // contain in the future. Cleaned up in the finally block.
    const tempDir = path.join(app.getPath('userData'), 'pdf-export-tmp');
    await fs.mkdir(tempDir, { recursive: true });
    tempHtmlPath = path.join(
      tempDir,
      `print-${randomUUID()}.html`,
    );
    await fs.writeFile(tempHtmlPath, opts.html, 'utf-8');
    await renderWindow.loadURL(pathToFileURL(tempHtmlPath).toString());
    // Wait for fonts to finish loading. With `file://` origin
    // and inlined data-URI fonts in the print HTML's <style>,
    // `document.fonts.ready` resolves once the CSS parses and
    // the data URIs are decoded — typically <100ms but capped
    // at 5s in case of unexpected delays.
    await renderWindow.webContents.executeJavaScript(
      `Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]).then(() => 'ok')`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const printOpts: PrintToPDFOptions = {
      pageSize: pageSizeArg(opts.pageSize),
      landscape: opts.landscape,
      margins: inchesMargins(opts.margins),
      scale: opts.scale,
      printBackground: true,
      // Heading-derived bookmark / outline pane in the resulting
      // PDF. Chromium produces the outline from the document's
      // semantic <h1>...<h6> tree when this option is set.
      generateDocumentOutline: true,
      // Tagged PDF improves accessibility (screen reader support)
      // and is required for some compliance regimes — cheap to
      // enable here so we get it for free.
      generateTaggedPDF: true,
      displayHeaderFooter: opts.headerFooter !== null,
    };
    if (opts.headerFooter) {
      const hf = opts.headerFooter;
      printOpts.headerTemplate = hf.showHeader
        ? buildSlotTemplate(
            hf.headerLeft,
            hf.headerCenter,
            hf.headerRight,
            hf.author,
            hf.email,
          )
        : '<div></div>';
      printOpts.footerTemplate = hf.showFooter
        ? buildSlotTemplate(
            hf.footerLeft,
            hf.footerCenter,
            hf.footerRight,
            hf.author,
            hf.email,
          )
        : '<div></div>';
    }

    const pdfBuffer = await renderWindow.webContents.printToPDF(printOpts);
    await fs.writeFile(outputPath, pdfBuffer);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Always destroy — `close()` would fire close handlers that
    // could prompt; `destroy()` is the unconditional teardown.
    if (!renderWindow.isDestroyed()) renderWindow.destroy();
    // Clean up the temp HTML file. Errors here are non-fatal —
    // userData/pdf-export-tmp gets stale entries on rare crashes
    // but they're tiny (<200KB each) and can be swept on a
    // future export pass if needed.
    if (tempHtmlPath) {
      try {
        await fs.unlink(tempHtmlPath);
      } catch {
        // ignore — see comment above
      }
    }
  }

  if (opts.openAfter) {
    // shell.openPath returns a string — empty on success, error
    // message on failure. We don't surface the error: the file
    // saved fine; only the open-after-export courtesy failed.
    void shell.openPath(outputPath);
  }

  return { status: 'saved', path: outputPath };
}
