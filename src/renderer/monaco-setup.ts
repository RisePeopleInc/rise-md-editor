// Import Monaco's *core editor API* rather than the `monaco-editor` barrel.
// The bare specifier resolves to `editor.main`, which eagerly registers ALL
// ~80 syntax-highlighting language packs (abap, solidity, freemarker2, …) plus
// the rich-feature workers (TypeScript, CSS, HTML) — pure dead weight in a
// markdown editor. `editor.api` exposes the same surface these files use
// (`editor`, `languages`, `Range`, `Position`, `MarkerSeverity`, …) without
// the language registrations, so we opt into exactly what we need below.
// See [RAISE-82](https://risepeople.atlassian.net/browse/RAISE-82).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { loader } from '@monaco-editor/react';
import { registerAllGruvboxThemes } from './monaco-themes';

// -----------------------------------------------------------------------------
// Curated language set ([RAISE-82](https://risepeople.atlassian.net/browse/RAISE-82)).
//
// This is a markdown-native editor; the editor's primary language is
// `markdown` and the only place other languages surface is fenced code
// blocks inside CLAUDE.md / SKILL.md files. Monaco's markdown grammar embeds
// whatever languages are registered, so registering this curated set is
// exactly what lights up fenced-block highlighting for them.
//
// The set below covers ~95% of the fenced code blocks we see in those files
// (shell, json, yaml, the JS/TS family) plus the common dev languages people
// occasionally paste. Anything NOT registered degrades gracefully: the fence
// renders as plain, unhighlighted monospace — no errors, no broken layout.
//
// `shell` is bash/sh; `cpp` registers both `c` and `cpp`. JSON is the one
// rich-feature exception — see the contribution + worker note below.
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';

// JSON is NOT a basic-language: its highlighting comes from the rich
// `language/json` feature, which needs a dedicated worker. JSON is extremely
// common in CLAUDE.md / SKILL.md fenced blocks (tool configs, settings), so
// we keep it. We deliberately do NOT pull in the css/html/typescript rich
// features — the basic-languages above already give those syntax
// highlighting, and the rich features would each drag in another worker.
import 'monaco-editor/esm/vs/language/json/monaco.contribution';

// Force @monaco-editor/react to use the bundled monaco instead of fetching
// from a CDN (which would fail in a packaged Electron app with no network).
// The JSON rich feature spins up its own worker (label 'json'); everything
// else routes to the shared editor worker.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') {
      return new jsonWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

// Pre-register all 6 Gruvbox variants (3 contrast × 2 mode). The
// palettes are JS constants in monaco-themes.ts — no CSS read involved —
// so this is safe to do at module load with no race against stylesheet
// parsing. First Editor mount will pick its variant from useThemeState.
registerAllGruvboxThemes();
