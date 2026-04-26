import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';
import { registerAllGruvboxThemes } from './monaco-themes';

// Force @monaco-editor/react to use the bundled monaco instead of fetching
// from a CDN (which would fail in a packaged Electron app with no network).
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

// Pre-register all 6 Gruvbox variants (3 contrast × 2 mode). The
// palettes are JS constants in monaco-themes.ts — no CSS read involved —
// so this is safe to do at module load with no race against stylesheet
// parsing. First Editor mount will pick its variant from useThemeState.
registerAllGruvboxThemes();
