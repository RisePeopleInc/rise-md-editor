/**
 * "TLDs" that are really file extensions, used to gate autolink
 * detection so a `file.md` reference in a markdown note doesn't
 * become a clickable link to the non-existent host `file.md`
 * ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47)).
 *
 * The autolink-literal extensions in remark-gfm and markdown-it's
 * linkify both treat any `host.tld` shape as a candidate URL, so
 * `file.md` autolinks because `md` is in linkify's auto-2-char
 * TLD set (Moldova). Real-domain references like `www.cbc.ca` or
 * `internet.com` SHOULD autolink — the user wants their notes to
 * have working links to bare-domain URLs they typed without an
 * explicit scheme.
 *
 * The discriminator we land on: the suffix after the LAST dot.
 * If it's a known file extension, we treat the text as a filename
 * and revert the autolink. If it's not, we leave the autolink in
 * place — `www.cbc.ca` ends in `ca`, which is a real TLD (not in
 * the file-extension list), so it stays linked.
 *
 * **What goes in this list**: extensions a user is reasonably
 * likely to type in a markdown note as a file reference and not
 * want autolinked. Code, config, docs, archives. Common image
 * formats that could be confused with TLDs.
 *
 * **What stays out**: real two-letter TLDs (ca, uk, us, io, ai),
 * three-letter common TLDs (com, org, net, dev, app), and
 * anything that's primarily known as a domain. `.app` is a TLD
 * AND a macOS bundle suffix; we lean toward the TLD reading.
 *
 * The list is conservative — we'd rather miss a file-extension
 * autolink than break a real-URL autolink. Users can extend this
 * list when they encounter common-but-missed extensions.
 */
export const FILE_EXTENSION_TLDS: ReadonlySet<string> = new Set([
  // Markdown / docs
  'md',
  'mdx',
  'markdown',
  'rst',
  'adoc',
  'asciidoc',
  'tex',
  'rtf',

  // Plain text / logs
  'txt',
  'log',

  // Configuration / data
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'conf',
  'config',
  'env',
  'lock',
  'plist',

  // Web / markup
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'sass',
  'less',
  'styl',

  // JavaScript family
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'vue',
  'svelte',

  // Other code
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'scala',
  'clj',
  'cljs',
  'c',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'hxx',
  'cs',
  'fs',
  'vb',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'pl',
  'php',
  'lua',
  'r',
  'swift',
  'm',
  'mm',
  'sql',
  'graphql',
  'gql',

  // Documents
  'pdf',
  'doc',
  'docx',
  'odt',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'csv',
  'tsv',

  // Images (less commonly references in markdown but worth keeping
  // off the autolink path — `.png` etc. is never a URL)
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
  'tiff',
  'heic',

  // Audio / video
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
  'mov',
  'avi',
  'mkv',

  // Archives
  'zip',
  'tar',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar',

  // Binary / build artifacts
  'exe',
  'dll',
  'so',
  'dylib',
  'a',
  'o',
  'obj',
  'bin',
  'class',
  'jar',
  'wasm',
]);

/**
 * Returns true if the given text's "TLD" (suffix after the last
 * `.`) matches a known file extension. Used to gate autolink
 * detection — file-extension-shaped text doesn't autolink, real-
 * TLD-shaped text does.
 *
 * Returns false if there's no `.` at all, or if the suffix is
 * empty, or if the suffix isn't in the file-extension list.
 *
 * Strips a `https?://` prefix before checking, so `http://file.md`
 * is treated the same as `file.md` for this check.
 *
 * Strips trailing path / query / fragment characters
 * (`/`, `?`, `#`) so `http://file.md/path` reads as `file.md` (a
 * filename reference, even with the bogus path tacked on).
 */
export function looksLikeFilenameExtension(text: string): boolean {
  // Strip optional scheme prefix and any path/query/fragment.
  const stripped = text
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/, 1)[0];
  if (!stripped) return false;
  const dotIdx = stripped.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const ext = stripped.slice(dotIdx + 1).toLowerCase();
  if (!ext) return false;
  return FILE_EXTENSION_TLDS.has(ext);
}
