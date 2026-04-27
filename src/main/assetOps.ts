import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * RAISE-11: Image drag-and-drop and paste.
 *
 * Drag-and-drop and paste both land here as a single "save image
 * relative to the markdown file" operation. The renderer hands us
 * either:
 *   - a source path on disk (drag-drop — File.path resolves to a real
 *     file the user dragged in from Finder / Explorer), in which case
 *     we copy
 *   - or raw bytes + MIME type (paste — clipboard images are blobs in
 *     memory with no path), in which case we write
 *
 * In either case, the file lands in `<dirname(markdownPath)>/assets/`,
 * with collision-safe naming, and we return the markdown-relative path
 * so the renderer can insert `![alt](assets/<name>)` at the cursor.
 */

/** File extensions we're willing to copy via drag-drop. */
const SUPPORTED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
]);

/** Clipboard MIME types we map to file extensions on paste. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export interface SavedAsset {
  /** Markdown-relative path for insertion, e.g. `assets/screenshot.png`. */
  relPath: string;
  /** Absolute path on disk — used by the "View full size" action. */
  absPath: string;
}

function isSupportedExtension(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Sanitize a filename for the assets folder + markdown link path:
 *   - Collapse any whitespace (including U+00A0 no-break space and
 *     U+202F narrow no-break space — macOS Sonoma+ uses U+202F as
 *     the AM/PM separator in screenshot filenames) to a single `-`.
 *   - Strip characters that need escaping in markdown link paths
 *     (parentheses, brackets, angle brackets) so we don't have to
 *     wrap the path in `<>` or URL-encode.
 *   - Collapse runs of `-` into one and trim leading/trailing dashes.
 *
 * Original case + the dot-separated extension are preserved so
 * `Screenshot 2026-04-23 at 10.12.48 AM.png` becomes
 * `Screenshot-2026-04-23-at-10.12.48-AM.png`.
 */
function sanitizeFilename(name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const cleaned = stem
    // JS `\s` matches every Unicode whitespace category, including
    // U+00A0 (no-break space) and U+202F (narrow no-break space —
    // macOS Sonoma+ uses this as the AM/PM separator in screenshot
    // filenames, which would otherwise sneak into our markdown).
    .replace(/\s+/g, '-')
    // Markdown link / URL-unfriendly punctuation.
    .replace(/[\\/<>()[\]"'`]/g, '')
    // Squeeze runs of dashes.
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // If the user dropped a file named "   .png", we'd end up with an
  // empty stem — fall back to "image" so the result is still a valid
  // filename.
  return (cleaned || 'image') + ext;
}

/**
 * Find an unused filename in `parentDir` by appending `-1`, `-2`, ...
 * before the extension. `screenshot.png` collides → `screenshot-1.png`,
 * `screenshot-2.png`, etc. The trim cap keeps the loop bounded if
 * something's badly wrong; the user will see an error long before we
 * actually iterate 9999 times.
 */
async function ensureUniqueName(
  parentDir: string,
  baseName: string,
): Promise<string> {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let candidate = baseName;
  for (let counter = 1; counter < 10_000; counter += 1) {
    try {
      await fs.access(path.join(parentDir, candidate));
      candidate = `${stem}-${counter}${ext}`;
    } catch {
      return candidate;
    }
  }
  throw new Error(
    `Could not find a free filename for "${baseName}" after 10,000 tries`,
  );
}

/** Format `Date` as `YYYY-MM-DD-HHmmss` for paste-image filenames. */
function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const MM = pad(date.getMinutes());
  const SS = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}-${HH}${MM}${SS}`;
}

/**
 * Copy a dragged image file into `<markdown's dir>/assets/`. Throws if
 * the source extension isn't on the supported list — keeps us from
 * silently copying random binary files when a user drags something
 * weird onto the editor.
 */
export async function saveDroppedImage(
  markdownPath: string,
  sourcePath: string,
): Promise<SavedAsset> {
  const sourceName = path.basename(sourcePath);
  if (!isSupportedExtension(sourceName)) {
    throw new Error(
      `Unsupported image format: ${path.extname(sourceName) || '(none)'}`,
    );
  }
  const assetsDir = path.join(path.dirname(markdownPath), 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  // Sanitize before collision-checking — `Screenshot 2026-04-23 at
  // 10.12.48 AM.png` becomes `Screenshot-2026-04-23-at-10.12.48-AM.png`,
  // and only THEN does ensureUniqueName append `-1`, `-2`, ... if there
  // happens to be a collision with the cleaned name.
  const targetName = await ensureUniqueName(assetsDir, sanitizeFilename(sourceName));
  const absPath = path.join(assetsDir, targetName);
  await fs.copyFile(sourcePath, absPath);
  return { relPath: `assets/${targetName}`, absPath };
}

/**
 * Write a clipboard image (bytes + MIME type) into the assets folder
 * with the canonical `pasted-image-{timestamp}.{ext}` name. Multiple
 * pastes inside the same second go through `ensureUniqueName` to avoid
 * silent overwrite.
 */
export async function savePastedImage(
  markdownPath: string,
  bytes: ArrayBuffer | Uint8Array,
  mimeType: string,
): Promise<SavedAsset> {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error(`Unsupported clipboard image type: ${mimeType}`);
  }
  const assetsDir = path.join(path.dirname(markdownPath), 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  const initial = `pasted-image-${formatTimestamp(new Date())}${ext}`;
  const targetName = await ensureUniqueName(assetsDir, initial);
  const absPath = path.join(assetsDir, targetName);
  // Buffer.from accepts ArrayBuffer directly; Uint8Array works via its
  // underlying buffer. IPC structured-clones ArrayBuffer faithfully.
  const buffer =
    bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(bytes);
  await fs.writeFile(absPath, buffer);
  return { relPath: `assets/${targetName}`, absPath };
}
