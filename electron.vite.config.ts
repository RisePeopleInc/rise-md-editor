import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        // RAISE-47: replace `mdast-util-gfm` (which `remark-gfm`
        // imports internally) with a shim that drops the
        // autolink-literal toMarkdown extension. The shim keeps
        // every other GFM serialiser behaviour intact and keeps
        // autolink-literal's PARSER side (so bare URLs and emails
        // still become `link` mdast nodes on read). Dropping just
        // the toMarkdown extension is what stops the unsafe-escape
        // rules from corrupting `https://example.com` into
        // `https\://example.com` on save. See
        // `src/renderer/shims/mdastUtilGfmNoAutolinkSerialize.ts`.
        //
        // **Scope** — this alias applies to ALL renderer-bundle
        // imports of `mdast-util-gfm`. As of writing the only
        // consumer is `remark-gfm`'s internal import; the shim
        // matches its `gfmFromMarkdown` / `gfmToMarkdown` export
        // shape exactly so the alias is transparent to that
        // consumer. If a future renderer dependency adds a direct
        // import of `mdast-util-gfm` that uses a different export
        // (e.g. a named import this shim doesn't re-export, or a
        // breaking-change rename in a major version bump), the
        // build will fail at type-check time. Either:
        //
        //   1. Extend the shim to re-export the missing API, or
        //   2. Pin the shim to a fixed sub-import path
        //      (e.g. alias `mdast-util-gfm/lib/index.js` instead
        //      of the package root) so other consumers fall
        //      through to the real package.
        //
        // The main-process bundle does NOT use this alias, so
        // anything in `src/main/` that imports `mdast-util-gfm`
        // sees the unmodified package.
        'mdast-util-gfm': resolve(
          __dirname,
          'src/renderer/shims/mdastUtilGfmNoAutolinkSerialize.ts',
        ),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
