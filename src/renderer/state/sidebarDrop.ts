/**
 * Shared helpers for sidebar-originated drag-and-drop.
 *
 * Three drop targets matter:
 *
 *   1. **Sidebar → Sidebar** (RAISE-13). A row dragged onto another
 *      row triggers a file-system move (or copy with Opt / Ctrl).
 *      Handled inside `FileTree.tsx`.
 *
 *   2. **Sidebar → WYSIWYG editor**. An image dragged onto the
 *      editor inserts as a markdown image (`![alt](relative)`) at
 *      the drop point. Handled in `WysiwygEditor.tsx`.
 *
 *   3. **Sidebar → Source / Split editor**. An image dragged onto
 *      Monaco inserts the relative path as plain text at the drop
 *      point. Handled in `SourceEditor.tsx`.
 *
 * The marker MIME type plus the source path on the DataTransfer is
 * the only signal available pre-drop (DataTransfer.getData is
 * restricted to `text/plain` mid-drag on some platforms — see
 * the long comment in `FileTree.tsx` for the gory details).
 * Helpers here keep the three sites in sync.
 */

/**
 * Custom MIME-ish type set on the DataTransfer by `FileTree.tsx`'s
 * dragstart handler. Drop targets check `dataTransfer.types`
 * (which IS exposed during dragover, unlike `getData`) to know
 * whether this is one of our own drags vs. a foreign drag from
 * Finder / browser / etc.
 */
export const RAISE_TREE_DND_TYPE = 'application/x-rise-tree-move';

/**
 * Image file extensions we recognise for sidebar-drop insertion.
 * Mirrors the set Milkdown / markdown-it already render via the
 * `rise-md-asset://` protocol. Case-insensitive match — the path
 * extension is lowercased before lookup.
 */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.avif',
]);

/**
 * True when the given path's extension is one of the recognised
 * image types. Used by the editor drop handlers to decide whether
 * to insert as a markdown image / path or to no-op (non-image
 * sidebar drops are out of scope for the current feature; future
 * tickets could extend this to attach as a generic link).
 */
export function isImagePath(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
}

/**
 * Read the source path from a sidebar drag's DataTransfer. Returns
 * the empty string if this isn't one of our drags. Checks both
 * `RAISE_TREE_DND_TYPE` (canonical) and `text/plain` (the fallback
 * we set alongside it in `FileTree.tsx` so external drop targets
 * like a terminal or text field get something sensible).
 */
export function getTreeDragSourcePath(dt: DataTransfer): string {
  if (!dt.types.includes(RAISE_TREE_DND_TYPE)) return '';
  return dt.getData(RAISE_TREE_DND_TYPE) || dt.getData('text/plain') || '';
}

/**
 * Extract the parent-directory portion of an absolute path without
 * relying on the Node `path` module (which isn't available in the
 * sandboxed renderer). Splits on the last forward or backslash,
 * whichever appears later — handles both POSIX and Windows paths
 * since path strings can arrive from main on either platform.
 */
function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
}

/**
 * Compute a relative path from `fromDir` to `toPath`, returning
 * forward-slash-separated output regardless of the input
 * separators. Markdown image refs use forward slashes by
 * convention (matches the rise-md-asset:// resolver in
 * `state/assetUrl.ts` and what the user types in source), and
 * Chromium's URL parsing handles forward slashes uniformly on
 * Windows too.
 *
 * Algorithm: split both paths on the dominant separator, find the
 * common prefix length, emit one `..` per remaining `fromDir`
 * segment, then the unique `toPath` segments.
 *
 *   /a/b/c            →  /a/x/y.png       =>  ../../x/y.png
 *   /a/b              →  /a/b/c/d.png     =>  c/d.png
 *   /a/b/c.md (file)  →  /a/b/c/d.png     =>  use `fromDir`, not the file
 *
 * Caller passes `fromDir`, NOT the document's file path — file
 * paths would shift the relative resolution by one level. The
 * doc's directory is `dirnameOf(docPath)`.
 */
export function relativePath(fromDir: string, toPath: string): string {
  // Detect separator dominance. Windows paths typically have
  // backslashes throughout; POSIX uses forward. If a path mixes
  // both (rare — happens when normalisation hasn't been applied),
  // pick the more common one.
  const sep = countChar(fromDir, '\\') + countChar(toPath, '\\') >
    countChar(fromDir, '/') + countChar(toPath, '/')
    ? '\\'
    : '/';
  const fromParts = fromDir.split(sep).filter(Boolean);
  const toParts = toPath.split(sep).filter(Boolean);
  // Find common prefix length, case-insensitively on Windows
  // since `C:\Foo` and `c:\foo` refer to the same place.
  const ignoreCase = sep === '\\';
  let i = 0;
  while (i < fromParts.length && i < toParts.length) {
    const a = ignoreCase ? fromParts[i]!.toLowerCase() : fromParts[i]!;
    const b = ignoreCase ? toParts[i]!.toLowerCase() : toParts[i]!;
    if (a !== b) break;
    i++;
  }
  const ups: string[] = [];
  for (let j = i; j < fromParts.length; j++) ups.push('..');
  const tail = toParts.slice(i);
  const result = [...ups, ...tail].join('/');
  return result || '.';
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * Compute the relative path the editor should insert for a
 * sidebar-dropped file. Resolves `toPath` relative to the document's
 * directory if `docPath` is known; otherwise falls back to the
 * absolute path with forward slashes (untitled documents have no
 * directory to resolve against, but inserting the absolute path
 * still produces something that opens — the user can fix it after
 * saving the doc).
 */
export function computeInsertedPath(toPath: string, docPath: string | null): string {
  if (!docPath) {
    // Untitled doc — emit an absolute path with forward slashes
    // so it parses correctly as a URL on every platform.
    return toPath.replace(/\\/g, '/');
  }
  return relativePath(dirnameOf(docPath), toPath);
}
