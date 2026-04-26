import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';
import { registerGruvboxThemes } from './monaco-themes';

// Force @monaco-editor/react to use the bundled monaco instead of fetching
// from a CDN (which would fail in a packaged Electron app with no network).
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

// Pre-register the Gruvbox themes so the first <Editor> mount gets the
// real palette instead of the built-in vs/vs-dark. The bootstrap script
// in index.html has already set [data-theme] before this module loads,
// so getComputedStyle inside readPalette returns the right values.
registerGruvboxThemes();
