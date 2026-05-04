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
 *
 * ## Policy for additions and removals
 *
 * **To add an extension** (text ends in `.X`, autolink should be
 * suppressed): the entry must be unambiguously a file extension
 * — i.e. you would NEVER expect a URL to end in `.X`. If `.X` is
 * also an ICANN-recognised TLD that real domains use, you risk
 * breaking existing user URLs that end with that TLD. Mitigation:
 * add to `KNOWN_TLDS` AS WELL if there's a real-URL collision;
 * the gate logic resolves the conflict via the more-specific
 * autolink-on-type path.
 *
 * **To remove an extension**: only if a user reports a real-domain
 * URL ending in that extension is being false-positive treated as
 * a file. ICANN-retiring a TLD is rare; we'd rather autolink a
 * legacy URL than break the convention.
 *
 * **When in doubt**: leave the extension OUT. The user can wrap
 * the URL in `<>` (CommonMark autolink) or `[](url)` (explicit
 * link) to force a link. Conversely, file references render fine
 * as plain text. Ambiguous extensions (e.g. `.app` — TLD and
 * macOS bundle suffix) lean toward the TLD reading.
 *
 * Maintain alphabetically by section.
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

/**
 * Allowlist of "TLDs we recognise as real domains" — used to gate
 * autolink-on-type for `www.X` and bare-hostname patterns. Without
 * this, the autolink-on-type regex matches natural-language
 * abbreviation patterns like `e.g.something`, `i.e.foobar`,
 * `etc.something` whose suffix isn't a TLD AND isn't in the file-
 * extension blocklist — they fall through to autolink and produce
 * broken `http://e.g.something` links.
 *
 * Composition rationale:
 *
 *   - Generic TLDs that show up in personal / dev / company URLs
 *     across English-speaking markdown notes (com, org, net, edu,
 *     gov, io, dev, app, ai, etc.).
 *   - Two-letter country TLDs for the locales the team and
 *     industry tend to interact with most. Not exhaustive — adding
 *     a country TLD is one line if a real URL fails to autolink.
 *
 * **Policy for additions** — only add a string to this set if:
 *
 *   1. It's a real ICANN-recognised TLD
 *      ([list](https://www.iana.org/domains/root/db)), AND
 *   2. It's NOT also a common file extension or natural-language
 *      abbreviation (e.g. don't add `.txt`, `.app` if it's
 *      ambiguous with a macOS bundle, etc.). When in doubt, prefer
 *      "real domain wins" — but be aware the entry may surface
 *      false positives in user docs.
 *
 * **Policy for removals** — only remove if the entry is generating
 * false positives in user docs. ICANN-retiring a TLD is rare, and
 * we'd rather autolink a legacy URL than break the convention.
 *
 * The list is maintained alphabetically by section. Country TLDs
 * appear after the generic block.
 */
export const KNOWN_TLDS: ReadonlySet<string> = new Set([
  // Generic TLDs (most common in dev / product notes).
  'com',
  'org',
  'net',
  'gov',
  'edu',
  'mil',
  'int',
  'biz',
  'info',
  'name',
  'pro',
  'asia',
  'jobs',
  'travel',
  'mobi',
  'tel',
  // Newer generic TLDs commonly appearing in URLs.
  'io',
  'co',
  'ai',
  'app',
  'dev',
  'gg',
  'tv',
  'me',
  'ly',
  'sh',
  'cc',
  'so',
  'xyz',
  'page',
  'site',
  'shop',
  'store',
  'tech',
  'cloud',
  'online',
  'news',
  'agency',
  'studio',
  'guru',
  // Country TLDs — North America.
  'ca',
  'mx',
  'us',
  // Country TLDs — Europe.
  'uk',
  'ie',
  'fr',
  'de',
  'it',
  'es',
  'pt',
  'nl',
  'be',
  'lu',
  'ch',
  'at',
  'se',
  'no',
  'fi',
  'dk',
  'is',
  'pl',
  'cz',
  'sk',
  'hu',
  'ro',
  'bg',
  'gr',
  'tr',
  'ru',
  'ua',
  'lt',
  'lv',
  'ee',
  'si',
  'hr',
  'rs',
  // Country TLDs — Asia / Pacific.
  'jp',
  'cn',
  'kr',
  'in',
  'au',
  'nz',
  'sg',
  'hk',
  'tw',
  'th',
  'id',
  'my',
  'ph',
  'vn',
  // Country TLDs — Middle East / Africa.
  'il',
  'ae',
  'sa',
  'za',
  // Country TLDs — South America.
  'br',
  'ar',
  'cl',
  'co',
  'pe',
]);

/**
 * Returns true if the given text's "TLD" (suffix after the last
 * `.`) matches a known real-domain TLD per `KNOWN_TLDS`. Strips
 * scheme prefix and path/query/fragment before checking, same as
 * `looksLikeFilenameExtension`.
 *
 * Used to gate autolink-on-type for schemeless URL shapes
 * (`www.X`, `bare.host.tld`) so that natural-language abbreviation
 * patterns (`e.g.something`, `i.e.foo`) don't false-positive into
 * autolinks.
 */
export function looksLikeKnownTld(text: string): boolean {
  const stripped = text
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/, 1)[0];
  if (!stripped) return false;
  const dotIdx = stripped.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const tld = stripped.slice(dotIdx + 1).toLowerCase();
  if (!tld) return false;
  return KNOWN_TLDS.has(tld);
}
