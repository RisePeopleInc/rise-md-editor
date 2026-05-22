# Architecture

This document orients a developer joining Rise MD Editor. It covers the process model, source layout, IPC surface, state management, and the major subsystems that show up across the codebase. The README has a quick overview; this doc goes deeper.

## Process model

Electron splits the app into three processes. Code in each lives in a different directory and runs against a different runtime.

```
┌────────────────────────────────────────────────────────────────┐
│ main process (Node)                                            │
│   src/main/                                                    │
│   - Owns: filesystem, dialogs, native menus, windows,          │
│     auto-update, app lifecycle                                 │
│   - Has full Node + Electron APIs                              │
│   - Single instance per app run                                │
└────────────────────────────────────────────────────────────────┘
              ▲                                  │
              │ ipcRenderer.invoke / on          │ webContents.send
              │ (replies via Promise)            │
              │                                  ▼
┌────────────────────────────────────────────────────────────────┐
│ preload script (sandboxed Node, contextIsolated)               │
│   src/preload/index.ts                                         │
│   - Exposes a typed `window.api` to the renderer               │
│   - The ONLY thing the renderer can call across the boundary   │
└────────────────────────────────────────────────────────────────┘
                              ▲
                              │ window.api.*
                              │
┌────────────────────────────────────────────────────────────────┐
│ renderer process (Chromium + React)                            │
│   src/renderer/                                                │
│   - No Node, no fs, no shell                                   │
│   - Talks to main exclusively through the preload bridge       │
│   - One per BrowserWindow                                      │
└────────────────────────────────────────────────────────────────┘
```

**Security posture**: the renderer is sandboxed and `contextIsolation: true`. There is no `nodeIntegration`. Anything privileged — opening a file dialog, reading from disk, writing to electron-store — must go through an explicit IPC channel exposed by the preload. This is why `window.prompt()` doesn't work in the file-tree sidebar (sandboxed renderers don't get it) and why we built inline name-editing (RAISE-8).

## Source tree

```
src/
├── main/                  Electron main process (Node)
│   ├── index.ts           Window + IPC + app-lifecycle wiring (~1100 lines)
│   ├── menu.ts            Native menu definition
│   ├── contextMenu.ts     Context menu (right-click) for editor / file tree
│   ├── fileOperations.ts  Open/save dialogs + fs reads
│   ├── folderOps.ts       File-tree reading + create/rename/trash
│   ├── folderWatcher.ts   chokidar watcher
│   ├── assetOps.ts        Image save pipeline (RAISE-11)
│   ├── exportPdf.ts       Markdown → PDF via Electron's hidden BrowserWindow
│   ├── autoUpdater.ts     electron-updater wiring (RAISE-12)
│   ├── themeStore.ts      App + editor theme persistence (electron-store)
│   ├── recentFilesStore.ts
│   ├── lastFolderStore.ts
│   └── templates.ts       Bundled CLAUDE.md / SKILL.md scaffolds (?raw)
├── preload/
│   └── index.ts           contextBridge — typed `window.api` surface (~450 lines)
├── renderer/              Electron renderer (React 19 + Vite 6)
│   ├── App.tsx
│   ├── main.tsx           React mount point + monaco-setup + font imports
│   ├── monaco-setup.ts    Monaco web-worker wiring
│   ├── monaco-themes.ts   Gruvbox light/dark × hard/medium/soft (6 variants)
│   ├── components/
│   │   ├── editors/
│   │   │   ├── EditorContainer.tsx   Mode dispatcher: Source / WYSIWYG / Split
│   │   │   ├── SourceEditor.tsx      Monaco
│   │   │   ├── WysiwygEditor.tsx     Milkdown / ProseMirror
│   │   │   ├── SplitView.tsx         Source on left, preview on right
│   │   │   ├── ModeSwitcher.tsx
│   │   │   └── Toolbar.tsx
│   │   ├── sidebar/
│   │   │   ├── Sidebar.tsx           Visibility + resize affordance
│   │   │   └── FileTree.tsx          Recursive tree, inline rename, drag
│   │   ├── TabBar.tsx                Drag-to-reorder, dirty dots, middle-click close
│   │   ├── WelcomeScreen.tsx         Splash when no file/folder is open
│   │   ├── WorkspaceBanner.tsx       Workspace-level "Create CLAUDE.md" prompt
│   │   ├── TemplateHintBanner.tsx    "Created from template" hint
│   │   ├── UpdateBanner.tsx          Auto-update banner (RAISE-12)
│   │   ├── ExportPdfModal.tsx
│   │   └── StatusBar.tsx
│   ├── state/             React hooks — see "State management" below
│   ├── styles/
│   │   ├── index.css      Tailwind entry
│   │   ├── themes.css     Rise design tokens (--rise-*)
│   │   ├── milkdown.css   WYSIWYG prose styling (.rise-md-prose)
│   │   ├── print.css      PDF export styling
│   │   └── font-tokens.css
│   └── shims/             Vite alias targets (e.g. mdast-util-gfm patch)
└── resources/             Assets bundled into the asar
```

## IPC surface

`src/preload/index.ts` is the single source of truth for what the renderer can do. The pattern: every privileged operation gets a typed function on `window.api`, which marshals the call through `ipcRenderer.invoke` (or `.on`/`.send` for fire-and-forget). Main registers handlers via `ipcMain.handle` / `ipcMain.on` in `src/main/index.ts`.

Conventions:

- **Channel names** group by namespace and verb: `files:open`, `files:save`, `folder:get-tree`, `folder:trash`, `assets:save-image`, `theme:get`, `recent:add`, `update:install`. The colon-separated form makes the IPC log readable at a glance.
- **`invoke` for request/reply** (returns a Promise). Most handlers are `invoke`.
- **`on`/`send` for events** that don't have a meaningful reply, like `recent:add` (renderer telling main to remember a file path) or `dialog:show-error` (display, no return).
- **One direction**: main → renderer events (menu actions, file-tree changes, update status) flow through `webContents.send` and the renderer subscribes via `window.api.onMenuAction(callback)` / `window.api.onUpdateStatus(callback)` etc. Each `onX` returns an unsubscribe function so the React hooks can clean up.
- **The `MenuActionType` union** in `src/preload/index.ts` is the canonical list of menu-driven actions. Adding a new menu item means: (1) add the type to the union, (2) wire the menu entry in `src/main/menu.ts`, (3) handle it in `App.tsx`'s menu-action effect. Type-safe at all three points.

## State management

No Redux, no Zustand. Each piece of app-level state lives in a `useX` hook under `src/renderer/state/`, and `App.tsx` composes them:

| Hook              | What it owns                                                                    |
| ----------------- | ------------------------------------------------------------------------------- |
| `useFileState`    | Open tabs, dirty tracking, save coordination, mode per tab, last-cursor per tab |
| `useSidebarState` | Open folder, file tree, sidebar width, sidebar visibility                       |
| `useThemeState`   | Hybrid theme controller — app theme (Rise) + editor theme (Gruvbox) + contrast  |
| `useUpdateState`  | Auto-update banner state machine                                                |

The hooks coordinate through props passed into the editor / sidebar components — no global store. A single tab's state is reduced to props and event handlers; complexity stays at the hook boundary.

Persistence: hooks that need to survive restart (theme, recent files, last folder, sidebar width) call into main via IPC. Main owns electron-store; the renderer never touches it directly. This keeps the persistence layer testable in isolation and avoids `electron-store`'s module-import-time gotcha leaking into the renderer.

There are also a number of stateless modules in `src/renderer/state/` that are misnamed — they're really pure transformations / parsing helpers (`markdown.ts`, `markdownItComments.ts`, `autolinkOnType.ts`, `filenameExtensions.ts`, `clipboardPaste.ts`, `imageInsert.ts`, `stripBrowserAutolink.ts`, `remarkUnautolink.ts`). Despite the directory name they aren't hooks. A future refactor could move them to `src/renderer/lib/` or similar.

## Editor architecture

Two distinct editor implementations, deliberately decoupled.

### Source — Monaco

Used for: source-mode editing, the source pane of split-mode, and find/replace.

- Loaded once per renderer process via `monaco-setup.ts`.
- Six theme variants (Gruvbox light/dark × hard/medium/soft contrast) defined in `monaco-themes.ts`.
- Cursor and scroll position are preserved per-tab across mode switches — `useFileState` snapshots them when leaving source mode and restores when returning.
- Monaco's web-worker model means JSON / TypeScript / CSS language services run off-thread. No language service for Markdown (Monaco doesn't ship one); we just get syntax highlighting.

### WYSIWYG — Milkdown / ProseMirror

Used for: wysiwyg-mode editing.

- Milkdown 7 with `commonmark` + `gfm` presets, plus listener / history / clipboard / cursor / tooltip / slash plugins.
- ProseMirror underneath — the document is a tree, not a string. Round-trip to markdown via remark/turndown is lossy at the edges; we patch some serializers (see `src/renderer/shims/mdastUtilGfmNoAutolinkSerialize.ts`).
- YAML frontmatter is split out and rendered as a separate styled monospace textarea above the editor (Milkdown doesn't model YAML cleanly).
- Several appendTransaction plugins enforce invariants: `autolinkOnType` (RAISE-47 type-time autolink discrimination), `emptyParagraphMarker`, `trailingParagraph`, `commentDecorations` (RAISE-48 multi-line HTML comment rendering).

### Split

Source on the left, live preview on the right. Preview is a markdown-it render, not a Milkdown render — different pipeline, intentionally. Scroll-sync is approximate: line-to-block mapping, not exact pixel sync.

### Why two implementations?

Markdown is a text format; ProseMirror models a tree. Round-tripping every edit through markdown serialization would be lossy and slow, especially in large files. Keeping a dedicated source mode means power users can drop into a `vim`-style flow when they need to, and edge cases (HTML comments, custom directives, raw markdown they want byte-perfect) have a path that doesn't go through the WYSIWYG translation layer. The cost is dual maintenance — every feature decision has to consider how it behaves in both modes.

## Theme system

Two independent theme controllers that share a system-preference subscription:

- **App theme** — Rise design system. Source Serif Pro Bold + Open Sans, brand B450 deep-blue, P450 interaction purple. Three modes: light / dark / system. Drives the chrome (tabs, sidebar, menus, toolbars), the WYSIWYG canvas, and the welcome / banner / preview surfaces. Tokens defined in `src/renderer/styles/themes.css` as `--rise-*` CSS custom properties.
- **Editor theme** — Gruvbox. Three modes (light / dark / system) × three contrast levels (hard / medium / soft) = nine resolved themes. Controls only the Monaco source pane.

The boot script in `src/renderer/index.html` reads the persisted app-theme from `localStorage` and sets `data-theme` on `<html>` _before_ React mounts, so users on dark mode never see a flash of light surfaces. The hook (`useThemeState`) re-syncs from main's electron-store on mount and writes back on every change.

System-preference subscription uses `window.matchMedia('(prefers-color-scheme: dark)')`. When the app or editor theme is set to "system", the resolved value updates live without user interaction.

## File and folder lifecycle

```
File open path:
  user → File menu / Cmd+O → main shows dialog → reads bytes →
  IPC reply with { path, content } → renderer creates tab →
  fileState.openTab → editor mounts with content

Folder open path:
  user → File menu / drop folder → main shows dialog →
  IPC reply with { path, tree } → renderer mounts sidebar →
  chokidar watcher starts in main → tree changes stream back to renderer
  via 'folder:tree-changed' events

Save path:
  user → Cmd+S → renderer collects current content from active editor →
  IPC files:save → main writes bytes → reply with new mtime →
  fileState clears dirty flag

External-edit detection (RAISE-56, race fix in RAISE-59):
  chokidar fires → main coalesces (debounce 50ms per path) →
  webContents.send('folder:file-changed') → renderer's onFileChanged
  handler in App.tsx:
    - Clean tab (isTabDirty === false): defer 250ms to let any
      in-flight Milkdown emit (200ms debounce) reach fileState,
      then re-check via fileRef. If still clean, silently re-fetch
      from disk and refreshTabFromDisk. No prompt. Canonical
      "Claude edits a file while user has it open" path.
    - Dirty tab (or became dirty during the 250ms re-check window):
      prompt "this file changed on disk — reload?" so unsaved local
      edits aren't blown away.
  The 250ms deferral closes the RAISE-59 race where a user keystroke
  within ~200ms of an external write could be lost — without it,
  isTabDirty reads stale React state and silently overwrites the
  in-flight emit. Cost: ~250ms of perceptible latency on the silent
  path (Claude-edits-while-user-reads), well below human-perceptible
  for that workflow.
  Only fires in Project Mode (folder open); single-file mode has
  no watcher today.
```

The `useFileState` hook is the coordinator — it owns the tab list and dirty flags and is the only thing that calls `files:save`. Editors emit content via `onChange` callbacks; the hook decides when to debounce / persist / mark clean.

## Image and asset handling

Custom URI scheme `rise-md-asset://` (registered in `src/main/index.ts`'s `whenReady`) resolves relative image paths to absolute filesystem paths at render time only. The stored markdown stays as `![alt](assets/screenshot.png)` regardless of where the file is on disk; the renderer DOM gets `src="rise-md-asset:///abs/path/to/notes/assets/screenshot.png"` after resolution.

Security: the protocol handler enforces an "allowed roots" gate — only paths under currently-open files / folders are reachable. Arbitrary `rise-md-asset://` URLs that target files outside the open workspace return a 403. This prevents a hostile markdown file from exfiltrating arbitrary disk contents via `<img src>` tags.

Image insert (drag/paste) flow in `src/main/assetOps.ts`:

1. Renderer captures the dragged / pasted blob.
2. `assets:save-image` IPC → main writes to `<dirname(markdownPath)>/assets/<sanitized-filename>` (creating the directory if it doesn't exist).
3. Main returns the saved path.
4. Renderer inserts a markdown image reference at the cursor.

Filename sanitization handles the macOS U+202F narrow-no-break-space that `Screenshot 2026-04-27 at 12.34.56 PM.png` ships with.

## Auto-update

`src/main/autoUpdater.ts` wraps `electron-updater`. Skipped in `npm run dev`; active in production builds.

Flow on launch:

1. `electron-updater` polls the GitHub Releases feed (`publish` config in `electron-builder.yml`).
2. If a newer version exists, it downloads in the background (signed + notarized installer for macOS, signature-checked .exe for Windows).
3. Once downloaded, main sends `update:status` → `'downloaded'` to the renderer.
4. `useUpdateState` shows the `UpdateBanner` with **Restart** + **Later**.
5. **Restart** triggers `autoUpdater.quitAndInstall()`. **Later** dismisses the banner; the update is on disk and applies on next normal app exit.

Statuses (`checking`, `available`, `downloading`, `downloaded`, `not-available`, `error`, `idle`) are exposed on the IPC channel for debugging but only `downloading` and `downloaded` render UI.

## Build pipeline

```
src/                 ─[electron-vite]─→  out/
                                          ├── main/index.js
                                          ├── preload/index.js
                                          └── renderer/<assets + index.html>

out/ + electron-builder.yml ─[electron-builder]─→  dist/
                                                    ├── *.dmg / *.zip / *.exe
                                                    ├── *.blockmap
                                                    └── latest-{platform}.yml
```

- **electron-vite** handles three Vite builds in one — main, preload, renderer — with shared TypeScript config and aliasing.
- **electron-builder** wraps `out/` into platform installers, signs (macOS — Apple Developer ID + notarytool), and emits the auto-update YAML feeds.
- **GitHub Actions** drives two workflows. `.github/workflows/release.yml` runs on `v*` tag push: matrix-builds macOS + Windows, calls electron-builder with `--publish never`, and a third job aggregates artifacts into a draft Release. Operational details: [`docs/release-process.md`](release-process.md). `.github/workflows/ci.yml` runs on every push to a non-main branch and every PR to main: a single ubuntu job that runs `typecheck`, `lint`, `build`, and `test`. Same four checks the author was meant to run locally before pushing.

Vite alias of note: `mdast-util-gfm` is shimmed via `src/renderer/shims/mdastUtilGfmNoAutolinkSerialize.ts` to suppress a remark serializer that was introducing autolinks where we don't want them. This lives in `electron.vite.config.ts`'s renderer section.

## Testing

[vitest](https://vitest.dev/) (the test runner Vite ships) handles the unit-test suite ([RAISE-14](https://risepeople.atlassian.net/browse/RAISE-14)). Vitest re-uses electron-vite's TypeScript + ESM setup so no extra transpilation config is needed — `vitest.config.ts` is a thin glob-narrowing wrapper.

- **Discovery glob**: `src/**/__tests__/**/*.test.{ts,tsx}`. Tests live in `__tests__` folders next to the source they cover (e.g. `src/renderer/state/__tests__/filenameExtensions.test.ts`).
- **Environment**: `node` by default. The first wave of tests covers pure-logic surfaces (input → output functions) that don't need a DOM. Per-file `// @vitest-environment jsdom` overrides if a future test needs DOM globals; React component rendering is out of scope for now (handled by the manual test plan in PR descriptions).
- **One-shot mode**: `npm test` runs `vitest run` — exits with the correct code on completion. CI uses this. For interactive watch mode locally, run `npx vitest` (no `run`).
- **CI integration**: the `ci.yml` workflow runs `npm test` alongside typecheck / lint / build. A failing test fails the PR check.

What stays OUT of scope until separate tickets land: React component rendering (would need `@testing-library/react` + jsdom), Electron main-process integration tests (would need spectron-style harness), end-to-end UI tests. Fixture-coverage tickets (RAISE-35, 40, 41, 50) will add tests for specific pure-logic surfaces on top of this foundation.

## Cross-cutting subsystems worth knowing about

- **Filename / TLD list policy** — `src/renderer/state/filenameExtensions.ts` curates the set of strings that autolink (real domains) vs. don't (file extensions). See README "Filename / TLD list policy" for the editorial guidelines.
- **PDF export** — `src/main/exportPdf.ts` opens a hidden BrowserWindow with `print.css` applied, renders the markdown via markdown-it, calls `webContents.printToPDF()`. Print-specific styling lives in `src/renderer/styles/print.css`.
- **Bundled templates** — `src/main/templates.ts` imports `CLAUDE.md` / `SKILL.md` scaffolds via Vite's `?raw` import. Strings are inlined into the main bundle at build time, so `File → New CLAUDE.md` doesn't need to read from disk at runtime.
- **CSS class naming** — components use `.rise-md-*` class names for app-specific scopes (e.g. `.rise-md-prose` for the WYSIWYG content). The `--rise-*` CSS variables are Rise design-system tokens (kept verbatim from the design system, not app-specific).

## Conventions worth keeping

- **Comments explain intent**, not syntax. Especially around React effect deps, IPC channel contracts, and Electron security boundaries.
- **TypeScript strict mode** is non-negotiable — `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noImplicitReturns`. Don't relax these in `tsconfig.*.json`.
- **One canonical source for IPC types** — `src/preload/index.ts` exports the union types (`MenuActionType`, `OpenedFile`, etc.) and both main and renderer import from there.
- **Branch + PR per Jira ticket** — see README "Contributing → Branch naming". The `pr-review` skill expects this convention to find the ticket from the branch name.
