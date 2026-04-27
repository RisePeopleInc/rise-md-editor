/**
 * RAISE-11: resolve a markdown-relative image src to a URL Chromium
 * will actually fetch.
 *
 * The Milkdown editor and the markdown-it preview both render
 * `<img src="assets/foo.png">` literally. In dev the renderer is
 * served from http://localhost:port; in production it's served from
 * file:// inside the asar. Either origin's relative-URL resolution
 * has nothing to do with the user's markdown file, so the image
 * comes up as a broken icon.
 *
 * Translation to a custom protocol (`raise-asset://`) registered in
 * the main process happens at render time only — the stored markdown
 * keeps the relative path, which is what users want when they share
 * notes or sync them with Cowork.
 */

/**
 * Resolve `src` against `markdownPath`'s directory, returning a
 * `raise-asset://` URL pointing at the absolute filesystem location.
 * Pass-through for src values that are already absolute URLs (any
 * scheme:// prefix), since http/https/data/file/raise-asset URLs
 * don't need rewriting.
 */
export function resolveAssetUrl(
  markdownPath: string | null,
  src: string,
): string {
  if (!src) return src;
  // Anything with a scheme prefix is already absolute — http://, https://,
  // file://, data:, and raise-asset:// itself.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  // Without a markdown path we can't resolve; fall through with the
  // original src (will render as broken, but that's fewer surprises
  // than silently dropping the image).
  if (!markdownPath) return src;

  // Find the last path separator (covers both POSIX `/` and Windows
  // `\`) and slice off the dir portion of the markdown path.
  const lastSep = Math.max(
    markdownPath.lastIndexOf('/'),
    markdownPath.lastIndexOf('\\'),
  );
  const dir = lastSep >= 0 ? markdownPath.slice(0, lastSep) : '';

  // Join + normalise backslashes so the URL stays in canonical form.
  let absolute = `${dir}/${src}`.replace(/\\/g, '/');

  // URL paths need a leading `/` after the scheme. POSIX paths
  // already start with one (`/Users/...`); Windows drive-letter
  // paths (`C:/Users/...`) don't, and need one prepended so the
  // URL is `raise-asset:///C:/Users/...` (the protocol handler in
  // main strips that extra slash before treating it as a fs path).
  if (!absolute.startsWith('/')) absolute = `/${absolute}`;

  // encodeURI handles spaces, unicode, etc. without touching the
  // already-safe characters.
  return `raise-asset://${encodeURI(absolute)}`;
}
