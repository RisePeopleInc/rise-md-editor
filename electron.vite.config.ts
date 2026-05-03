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
