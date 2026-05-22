import { BrowserWindow, dialog, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { injectPrintFonts } from './printFonts';

/**
 * Export-to-HTML main-process module
 * ([RAISE-53](https://risepeople.atlassian.net/browse/RAISE-53)).
 *
 * Shares the print pipeline with PDF export: the renderer's
 * `buildPrintHtml` produces a complete, styled HTML document with
 * a `PRINT_FONT_PLACEHOLDER` marker the main process replaces with
 * @font-face declarations (woff2 inlined as data URIs). For HTML
 * export, we additionally transform image references so the output
 * is portable — readable when opened from anywhere on disk, in any
 * browser, without dependence on the original markdown file's
 * directory.
 *
 * Two delivery modes for images:
 *
 *   - **inline**: each `file://` img src is read, base64-encoded,
 *     and replaced with a `data:image/<mime>;base64,...` URI. Output
 *     is a single self-contained `.html` file. Good for email,
 *     Slack attachments, archive — the file Just Works no matter
 *     where it lands.
 *
 *   - **external**: each `file://` img src is copied to an
 *     `assets/` folder alongside the HTML; src is rewritten to
 *     a relative `assets/<name>` path. Everything bundled into a
 *     `.zip`. Good when the user wants to host the HTML or unpack
 *     and edit the markdown-equivalent later.
 *
 * Non-`file://` image srcs (http://, https://, data:, etc.) are
 * left untouched in both modes — they're either already self-
 * contained (data:) or expected to load over the network.
 */

export type ExportHtmlImageMode = 'inline' | 'external';

export interface ExportHtmlOptions {
  /** Pre-rendered HTML from the renderer's `buildPrintHtml`. */
  html: string;
  /** Stem for the saved file — typically the markdown file's basename without `.md`. */
  defaultBaseName: string;
  /** Suggested save directory — typically the markdown file's parent dir. */
  defaultDir: string | null;
  imageMode: ExportHtmlImageMode;
  /**
   * Path of the markdown source. Currently unused for HTML export
   * (the renderer-side `resolveImageForPrint` has already converted
   * relative paths to `file://`), but accepted in the IPC shape for
   * future-proofing — e.g. a hypothetical "relative paths preserved"
   * mode would need it.
   */
  markdownPath: string | null;
  /** Open the saved file in the OS default browser/viewer after writing. */
  openAfter: boolean;
}

export type ExportHtmlResult =
  | { status: 'saved'; path: string }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

// Matches a single <img> tag's src attribute. The HTML markdown-it
// emits is well-formed enough that this isn't fighting a general
// HTML parser — every <img> is rendered by markdown-it's image rule
// with a single src attribute. We capture: (1) the prefix up to and
// including `src="`, (2) the URL, (3) the suffix from the closing
// quote to the tag end. The non-greedy URL match is bounded by `"`,
// so multi-attribute tags like `<img alt="..." src="..." />` match
// correctly regardless of attribute order.
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc=")([^"]+)("[^>]*>)/gi;

/** Map file extension → MIME for the data: URI prefix. */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

/**
 * JSZip timezone workaround. JSZip 3.10.x encodes each entry's
 * modification timestamp using `getUTCHours/UTCDate/UTCFullYear`
 * (see `node_modules/jszip/lib/generate/ZipFileWorker.js`), but
 * the ZIP spec's MS-DOS time field stores **local** time with no
 * timezone marker. The mismatch is silent — extraction tools
 * faithfully read back whatever was stamped and present it as
 * local time, so a zip generated in PT (UTC-7) at 8:31 PM gets
 * its entries stamped with the UTC hour (3:30 AM next day), and
 * Finder's Get Info shows the wrong times after extraction.
 *
 * The standard community workaround is to pre-shift the Date by
 * the local UTC offset so JSZip's `getUTC*` calls return the
 * wall-clock values the user actually expects. Doing this once
 * per export (not per file) keeps every entry in a single zip
 * stamped with the same wall-clock instant, which matches user
 * intuition ("all files in this archive came from one export").
 */
function jszipLocalDate(): Date {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
}

/**
 * Transform every `file://` img src in the HTML using the supplied
 * resolver. Non-file:// srcs are passed through unchanged.
 *
 * The resolver returns either:
 *   - a string with the new src value, OR
 *   - null to signal that the file couldn't be read; the original
 *     src is preserved and an error is logged. (We don't fail the
 *     whole export over one missing image — the user gets a broken
 *     <img> tag, same as if they'd opened the source markdown in any
 *     other viewer.)
 */
async function transformImageSrcs(
  html: string,
  resolve: (absPath: string) => Promise<string | null>,
): Promise<string> {
  const matches: Array<{
    fullMatch: string;
    prefix: string;
    src: string;
    suffix: string;
    index: number;
  }> = [];
  let m: RegExpExecArray | null;
  IMG_SRC_RE.lastIndex = 0;
  while ((m = IMG_SRC_RE.exec(html)) !== null) {
    matches.push({
      fullMatch: m[0]!,
      prefix: m[1]!,
      src: m[2]!,
      suffix: m[3]!,
      index: m.index,
    });
  }

  // Resolve in parallel — most exports have a handful of images,
  // and even with 100+ each read is independent so parallelism
  // dominates. Maintain index ordering for splicing back into the
  // string below.
  const newSrcs = await Promise.all(
    matches.map(async (entry) => {
      if (!entry.src.startsWith('file://')) {
        // Pass through http(s), data:, relative paths, etc. — the
        // browser opening the HTML will resolve them on its own
        // (or render a broken image if it can't).
        return entry.src;
      }
      let absPath: string;
      try {
        absPath = fileURLToPath(entry.src);
      } catch (err) {
        console.warn('[exportHtml] invalid file URL, leaving as-is:', entry.src, err);
        return entry.src;
      }
      const replacement = await resolve(absPath);
      return replacement ?? entry.src;
    }),
  );

  // Splice back in reverse index order so earlier indices stay
  // valid as we mutate later substrings.
  let result = html;
  for (let i = matches.length - 1; i >= 0; i--) {
    const entry = matches[i]!;
    const newSrc = newSrcs[i]!;
    const newTag = `${entry.prefix}${escapeAttr(newSrc)}${entry.suffix}`;
    result =
      result.slice(0, entry.index) + newTag + result.slice(entry.index + entry.fullMatch.length);
  }
  return result;
}

/**
 * Escape `&` and `"` in an attribute value. Data URIs and relative
 * paths don't naturally produce either, but escaping defensively
 * means we never produce malformed HTML even if the source path
 * has weird characters.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Allocate a unique filename for an image being copied into the
 * zip's `assets/` directory. Multiple source images may share a
 * basename (e.g. two different `screenshot.png` files from different
 * directories); deduplicate by appending `-N` before the extension.
 */
function makeAssetNameAllocator(): (absPath: string) => string {
  const used = new Map<string, string>(); // absPath → asset filename
  const allocated = new Set<string>();
  return (absPath: string) => {
    const cached = used.get(absPath);
    if (cached) return cached;
    const base = path.basename(absPath);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let candidate = base;
    let counter = 1;
    while (allocated.has(candidate)) {
      candidate = `${stem}-${counter}${ext}`;
      counter += 1;
    }
    allocated.add(candidate);
    used.set(absPath, candidate);
    return candidate;
  };
}

/**
 * Export the rendered HTML to disk. See module header for the two
 * image-mode flows.
 */
export async function exportToHtml(
  parent: BrowserWindow,
  opts: ExportHtmlOptions,
): Promise<ExportHtmlResult> {
  const isZip = opts.imageMode === 'external';
  const fileExt = isZip ? 'zip' : 'html';
  const suggestedPath = opts.defaultDir
    ? path.join(opts.defaultDir, `${opts.defaultBaseName}.${fileExt}`)
    : `${opts.defaultBaseName}.${fileExt}`;

  const saveResult = await dialog.showSaveDialog(parent, {
    title: isZip ? 'Export to HTML (zipped)' : 'Export to HTML',
    defaultPath: suggestedPath,
    filters: [
      isZip ? { name: 'Zip archive', extensions: ['zip'] } : { name: 'HTML', extensions: ['html'] },
    ],
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { status: 'canceled' };
  }
  const outputPath = saveResult.filePath;

  try {
    // Substitute fonts first — same pipeline as PDF.
    const htmlWithFonts = await injectPrintFonts(opts.html);

    if (opts.imageMode === 'inline') {
      // Walk img srcs, base64-encode file:// targets, rewrite to data: URIs.
      const transformed = await transformImageSrcs(htmlWithFonts, async (absPath) => {
        try {
          const buf = await fs.readFile(absPath);
          const mime = mimeForFile(absPath);
          return `data:${mime};base64,${buf.toString('base64')}`;
        } catch (err) {
          console.warn('[exportHtml] could not inline image, leaving src as-is:', absPath, err);
          return null;
        }
      });
      await fs.writeFile(outputPath, transformed, 'utf-8');
    } else {
      // External mode: copy images into the zip's assets/ folder,
      // rewrite src to relative paths.
      const allocate = makeAssetNameAllocator();
      const zip = new JSZip();
      const filesAdded = new Set<string>(); // assetName values
      // Shared timestamp for every entry in this archive — see
      // `jszipLocalDate` for the timezone-bug workaround. Computing
      // it once means all files share an identical mtime, which
      // matches user expectation that "this whole archive was
      // exported at one moment."
      const entryDate = jszipLocalDate();

      const transformed = await transformImageSrcs(htmlWithFonts, async (absPath) => {
        try {
          const buf = await fs.readFile(absPath);
          const assetName = allocate(absPath);
          if (!filesAdded.has(assetName)) {
            zip.file(`assets/${assetName}`, buf, { date: entryDate });
            filesAdded.add(assetName);
          }
          return `assets/${assetName}`;
        } catch (err) {
          console.warn('[exportHtml] could not bundle image, leaving src as-is:', absPath, err);
          return null;
        }
      });

      const htmlFileName = `${path.basename(outputPath, '.zip')}.html`;
      zip.file(htmlFileName, transformed, { date: entryDate });

      // RAISE-72: JSZip auto-creates directory entries lazily when a
      // file is added with a path prefix (e.g. `assets/foo.png` auto-
      // creates `assets/`). Those auto-created entries get a fresh
      // `new Date()` rather than the `entryDate` we pass to
      // `zip.file()` — which means after the RAISE-53 file-side
      // timezone-shift fix, extracted folders still had wrong (UTC-
      // shifted future) mtimes while the files inside them were
      // correct. Walk the entry map post-add and apply the same
      // shifted entryDate to every directory entry. Catches the
      // current `assets/` folder and any future nested folders
      // (e.g. `assets/icons/`) automatically.
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) {
          entry.date = entryDate;
        }
      }

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }, // balance speed vs size; default is 6
      });
      await fs.writeFile(outputPath, zipBuffer);
    }

    if (opts.openAfter) {
      // shell.openPath returns an error string (empty on success);
      // best-effort — if it fails we don't fail the whole export.
      const openError = await shell.openPath(outputPath);
      if (openError) {
        console.warn('[exportHtml] openPath failed (non-fatal):', openError);
      }
    }

    return { status: 'saved', path: outputPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[exportHtml] export failed:', message);
    return { status: 'error', message };
  }
}
