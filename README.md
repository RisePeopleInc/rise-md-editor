# rAIse

A markdown editor for Rise People — designed for editing the `CLAUDE.md` and `SKILL.md` files that drive our AI workflows.

## Features

- **Three editing modes**: WYSIWYG (Milkdown), Source (Monaco), and Split — switch with `Cmd/Ctrl+1/2/3` or `Cmd/Ctrl+\`.
- **Project Mode**: open a folder in the sidebar, navigate the file tree, watch for external changes via chokidar.
- **Templates**: scaffold `CLAUDE.md` and `SKILL.md` from bundled templates with `Cmd/Ctrl+Shift+C`.
- **Image drag-and-drop and paste**: dropped or pasted images land in `assets/` next to the markdown file with the reference inserted at the drop point.
- **Hybrid theming**: Rise design system for the WYSIWYG / chrome zone, Gruvbox for the source editor — independent contrast and theme toggles.
- **Tab management**: dirty-tab tracking, save-all / per-tab review on close, drag-to-reorder, same-basename disambiguation.
- **Auto-update** via GitHub Releases (production builds only; non-modal restart prompt).

## Development

### Prerequisites

- **Node 20 or 22** (see `engines.node` in `package.json`). NVM users:
  ```sh
  nvm use 22
  ```
- **macOS / Windows / Linux** — the dev experience targets all three. Builds are platform-scoped (see below).

### Setup

```sh
git clone https://github.com/RisePeopleInc/raise-editor.git
cd raise-editor
npm install
```

### Run

```sh
npm run dev
```

Opens the Electron app with hot module reload for the renderer (Vite) and a watch + restart loop for the main process. Source maps are enabled.

### Lint, type-check, build

```sh
npm run lint        # ESLint flat config
npm run typecheck   # tsc --noEmit
npm run build       # electron-vite build (no installer)
npm run format      # Prettier write
```

All three (lint / typecheck / build) should pass before opening a PR. The build step writes to `out/`; it's the same output the dev server consumes.

## Production builds

Each platform target wraps `electron-vite build` and then runs `electron-builder` with the matching flag. Output lands in `dist/`.

```sh
npm run build:mac     # → dist/rAIse-{version}-universal.dmg + .zip
npm run build:win     # → dist/rAIse-{version}-Setup.exe + .zip
npm run build:linux   # → dist/rAIse-{version}.AppImage + .deb
npm run build:all     # all three (only useful on a CI host with the toolchains)
```

### macOS code signing

Out of the box `npm run build:mac` produces an **unsigned** `.dmg` — fine for internal dogfooding, **not** acceptable for distribution outside the company (Gatekeeper will quarantine it on download). To enable signing + notarization:

1. **Acquire a `Developer ID Application` certificate** from the Apple Developer portal.
2. **Export it as `.p12`** with a password you control.
3. **Set environment variables on the build host**:
   - `CSC_LINK` — base64 of the `.p12`, or an absolute path to it
   - `CSC_KEY_PASSWORD` — the export password
   - `APPLE_ID` — Apple ID email of the cert owner (for notarization)
   - `APPLE_APP_SPECIFIC_PASSWORD` — generated at https://appleid.apple.com
   - `APPLE_TEAM_ID` — 10-char team identifier
4. **Update `electron-builder.yml`**: change `mac.identity` from `null` to the certificate's Common Name (e.g. `"Developer ID Application: Rise People (ABCDE12345)"`) and flip `mac.notarize` to `true`.

See https://www.electron.build/code-signing for the full reference.

### Windows code signing

Same shape — set `CSC_LINK` / `CSC_KEY_PASSWORD` with a code-signing cert (`.pfx`). SmartScreen Defender quarantines unsigned installers on first download for new users.

### App icon

`build/icon.png` is the placeholder — Gruvbox blue rounded square with "rAIse" in white serif. The design source is `build/icon.svg`. To regenerate the PNG from the SVG:

```sh
npx --yes @resvg/resvg-js-cli build/icon.svg build/icon.png -w 1024
```

Any tool that produces 1024×1024 PNG works. Electron-builder generates the platform-specific `.icns` / `.ico` from the PNG at build time — no manual export needed.

The real Rise mark replaces the placeholder under [RAISE-15](https://risepeople.atlassian.net/browse/RAISE-15) — drop the new artwork into `build/icon.png` (and optionally `icon.icns` / `icon.ico` for hand-tuned low-res variants). No path changes required.

## Auto-update

`electron-updater` runs in production builds (skipped in `npm run dev`). On launch it checks `RisePeopleInc/raise-editor`'s GitHub Releases for a newer version. If one's found:

1. The new version downloads in the background.
2. A non-modal banner appears in the editor: *"rAIse `{x.y.z}` is ready. Restart to update."*
3. **Restart** quits the app, installs, and relaunches. **Later** dismisses the banner; the update is on disk and applies on the next normal app exit.

To cut a new release:

```sh
# Bump the version in package.json (semver), commit, push.
# Then on a release-capable host (with code-signing creds + the OS):
npm run build:mac && npm run build:win && npm run build:linux
# Upload the dist/ artifacts to a new GitHub Release. The
# latest-{platform}.yml files alongside each installer must be
# included — they're what the updater reads.
```

CI automation for cuts is a follow-up.

## Architecture

```
src/
├── main/          Electron main process (Node)
│   ├── index.ts        Window + IPC + menu wiring
│   ├── menu.ts         Native menu definition
│   ├── fileOperations  Open/save dialogs + fs reads
│   ├── folderOps       File-tree reading + create/rename/trash
│   ├── folderWatcher   chokidar watcher
│   ├── assetOps        Image save pipeline (RAISE-11)
│   ├── autoUpdater     electron-updater wiring (RAISE-12)
│   ├── themeStore      App + editor theme persistence
│   ├── templates       Bundled CLAUDE.md / SKILL.md scaffolds
│   └── …
├── preload/       contextBridge — typed IPC surface for the renderer
├── renderer/      Electron renderer (React + Vite)
│   ├── App.tsx
│   ├── components/
│   │   ├── editors/    EditorContainer + Source/Wysiwyg/SplitView
│   │   ├── sidebar/    Sidebar + FileTree
│   │   ├── TabBar.tsx
│   │   └── …
│   ├── state/          React hooks for app-level state
│   │   ├── fileState   Tabs + dirty tracking + save coordination
│   │   ├── sidebarState  Folder + tree + visibility
│   │   ├── themeState  Hybrid theme controller
│   │   ├── updateState Auto-update banner state
│   │   └── …
│   ├── styles/         Tailwind + Rise tokens (themes.css) + prose
│   └── monaco-themes   Gruvbox variants (3 contrast × 2 mode)
└── resources/     Bundled assets (templates/, fonts/, icons/)
build/             Build resources (icon.png, icon.svg, entitlements.mac.plist)
```

Key design decisions, with the tickets that drove them:

- **Two editor zones, decoupled**: the WYSIWYG / chrome runs the Rise design system; the Monaco editor runs Gruvbox with its own theme + contrast preference. Independent toggles. ([RAISE-10](https://risepeople.atlassian.net/browse/RAISE-10))
- **Custom `raise-asset://` protocol** for inline image rendering — the stored markdown stays as relative paths, only the rendered DOM gets a resolved URL. Allowed-roots gate prevents arbitrary fs reads. ([RAISE-11](https://risepeople.atlassian.net/browse/RAISE-11))
- **Inline name editing** in the file tree (rename / new file / new folder) instead of `window.prompt` — sandboxed renderers don't support `prompt`. ([RAISE-8](https://risepeople.atlassian.net/browse/RAISE-8))
- **Bundled templates** via Vite's `?raw` import — strings inlined into the main bundle, no fs reads at runtime. ([RAISE-9](https://risepeople.atlassian.net/browse/RAISE-9))

## Contributing

### Branch naming

Branches start with the Jira ticket key:

```
RAISE-12-packaging-and-distribution
RAISE-9-cowork-templates
```

The PR title also leads with the ticket key. The PR-review skill cross-references the Jira ACs against the diff and posts a structured review with severity-tagged inline comments.

### Coding standards

- **TypeScript strict mode**. `strict: true` plus `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noImplicitReturns`. Don't disable.
- **ESLint flat config** (`eslint.config.mjs`). React hooks rules + `typescript-eslint`. Run `npm run lint` before committing.
- **Prettier** for formatting (`npm run format`).
- **Comments explain intent** — what the code is doing for the reader who already understands the syntax. Especially valuable around React effect deps, IPC contracts, and Electron security boundaries.

### Tests

[RAISE-14](https://risepeople.atlassian.net/browse/RAISE-14) sets up the test framework (vitest). Until then, manually verify the test plan in each PR's description before merge.

### Adding a feature

1. Pick (or create) a Jira ticket with clear acceptance criteria.
2. Branch from `main` with the ticket key prefix.
3. Implement, then `npm run lint && npm run typecheck && npm run build`.
4. Open a PR. The PR-review skill (`/pr-review`) runs against it and posts a structured review.
5. Address warnings + actionable suggestions; file follow-ups for anything punted.
6. Squash-merge. Transition the Jira ticket to Done.

## License

Internal — UNLICENSED. See the company handbook for distribution policy.
