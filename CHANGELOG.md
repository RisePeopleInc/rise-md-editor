# Changelog

All notable changes to Rise MD Editor are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Automated release pipeline via GitHub Actions** ([RAISE-45](https://risepeople.atlassian.net/browse/RAISE-45)). Pushing a `v*` tag now triggers a parallel macOS + Windows build on GitHub-hosted runners that assembles the artifacts into a draft GitHub Release. macOS builds are code-signed and notarized (Apple Developer ID + notarytool); Windows builds are unsigned for now while Azure Artifact Signing is being provisioned (SmartScreen warns on first download for a brief reputation-build window). A `workflow_dispatch` entry point with a `skip_signing` input lets contributors dry-run the build path without burning notary minutes. Operational details — secrets, troubleshooting, signing roadmap — live in `docs/release-process.md`.

### Fixed

- **Crash on macOS launch via Finder double-click** ([RAISE-54](https://risepeople.atlassian.net/browse/RAISE-54)). Right-click → Open With → Rise MD Editor (or double-clicking a `.md` file when the app isn't already running) no longer triggers an "Uncaught Exception: Cannot create BrowserWindow before app is ready" dialog. Root cause: the macOS `open-file` event handler funneled through `dispatchMenuAction`, which called `createWindow()` synchronously — and on macOS, `open-file` can fire before `app.whenReady()` completes. The dispatch now gates window creation on `app.isReady()` and relies on the existing `whenReady` + renderer-ready queue-drain path to surface the pending action once the window is up.
- **Spurious "Save changes?" prompt when closing an unmodified file** ([RAISE-55](https://risepeople.atlassian.net/browse/RAISE-55)). Closing a file you only opened (no edits) no longer prompts to save discardable changes. Root cause: Milkdown's first `markdownUpdated` event after loading a file is the parse-and-reserialize of the on-disk source, which differs byte-for-byte (list-marker normalization, escape handling) even when semantically identical. The renderer's WYSIWYG listener now skips the first emit, so opening a file leaves the tab clean until the user types.

### Changed

- **Renamed app to Rise MD Editor** ([RAISE-43](https://risepeople.atlassian.net/browse/RAISE-43)). The display name in the dock / start menu / About dialog / window title now reads "Rise MD Editor" (was "rAIse"). The `appId`, `productName`, npm-package `name`, and GitHub repo are all renamed to match. The `RAISE-` Jira ticket prefix and the `--rise-*` Rise design-system CSS variables stay unchanged. No user-data migration is shipped — the app is pre-release and there are no installed users with state to preserve.

## [0.1.2] — 2026-04-27

Follow-up to v0.1.1 — finishes the macOS install UX by enabling notarization. No feature changes.

### Changed

- **macOS builds are now notarized** by Apple's notary service in addition to being code-signed. ([RAISE-24](https://risepeople.atlassian.net/browse/RAISE-24))
  - First launch on a clean Mac now shows _"macOS verified that this app is free of malware"_ with an **Open** button, instead of v0.1.1's misleading _"could not verify ... may harm your Mac"_ dialog with only Move-to-Trash. (Signing alone wasn't enough on macOS Catalina+ — Gatekeeper specifically checks for a stapled notarization ticket.)
  - The DMG container is now signed too. v0.1.1 shipped with an unsigned DMG containing a signed `.app`; both layers are signed in v0.1.2.
  - Build hosts now need `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` env vars to produce a notarized build. Without them, builds still succeed but skip notarization (useful for local smoke tests).

### Notes

- Existing v0.1.1 installs will see the auto-update banner within ~5 seconds of next launch and can install v0.1.2 from there. The publisher identity is unchanged so Squirrel auto-update accepts the upgrade.

## [0.1.1] — 2026-04-27

Tiny follow-up to v0.1.0 — code signing for macOS only, no feature changes.

### Changed

- **macOS builds are now code-signed** with the Rise People Inc Developer ID Application certificate. ([RAISE-23](https://risepeople.atlassian.net/browse/RAISE-23))
  - On first launch users still see Gatekeeper's "verified developer" dialog (one-time _"Open Anyway"_ via System Settings → Privacy & Security) because the build isn't notarized yet — but the dialog now says _"Apple verified Rise People Inc"_ instead of _"could not verify rAIse"_. Notarization is tracked as a follow-up.
  - `electron-builder.yml`'s `mac.identity` is now hardcoded; build hosts without the cert in their Keychain need `CSC_IDENTITY_AUTO_DISCOVERY=false` in the environment to skip signing for unsigned smoke builds.

### Notes

- Existing v0.1.0 installs will see the auto-update banner within ~5 seconds of next launch and can install v0.1.1 from there.
- Windows + Linux artifacts unchanged — still need to be built on their respective hosts and uploaded to the same release.

## [0.1.0] — 2026-04-27

Initial dogfood-ready release. Eleven build stories (RAISE-2 through RAISE-12) shipped as a single 0.1.0 baseline.

### Added

- **App scaffolding** — Electron 33 + React 19 + TypeScript strict, electron-vite bundling, Tailwind CSS 4 with the `@theme inline` token mapping, ESLint flat config, Prettier. ([RAISE-2](https://risepeople.atlassian.net/browse/RAISE-2))
- **Source editor** — Monaco with Markdown highlighting, find / replace via menu IPC, font zoom, cursor + scroll preservation across mode swaps. ([RAISE-3](https://risepeople.atlassian.net/browse/RAISE-3))
- **File operations** — Open / Save / Save As, dirty-tab tracking, recent-files menu (electron-store persisted), Cmd+W to close active tab, drag-and-drop of `.md` / `.txt` files into the window. ([RAISE-4](https://risepeople.atlassian.net/browse/RAISE-4))
- **Tab bar with multi-file editing** — drag-to-reorder, middle-click close, dirty-dot indicator, Cmd+Alt+Arrow tab cycling on macOS / Ctrl+Tab on other platforms. Multi-tab close flow with Save All / Review Each / Don't Save / Cancel. ([RAISE-5](https://risepeople.atlassian.net/browse/RAISE-5))
- **WYSIWYG mode** — Milkdown 7 with commonmark + GFM presets, listener / history / clipboard / cursor / tooltip / slash plugins, formatting toolbar, YAML frontmatter split into a styled monospace textarea above the editor. ([RAISE-6](https://risepeople.atlassian.net/browse/RAISE-6))
- **Mode switching** — Source / WYSIWYG / Split with Cmd+1/2/3 + Cmd+\\ cycle, cursor + scroll position preserved per mode per tab, scroll-sync between source and preview in Split. ([RAISE-7](https://risepeople.atlassian.net/browse/RAISE-7))
- **File tree sidebar (Project Mode)** — chokidar 3.6.0 watching, expand/collapse, Cmd+B toggle, draggable resize, persistence of width + visibility + last-opened folder, native context menu (New / Rename / Delete / Reveal), inline name editing, OS-Trash-based delete, drag-folder-onto-window opens. Same-basename tab disambiguation (`CLAUDE.md test_workspace` vs `CLAUDE.md test_workspace2`). ([RAISE-8](https://risepeople.atlassian.net/browse/RAISE-8))
- **Cowork templates** — bundled `CLAUDE.md` and `SKILL.md` scaffolds with all the rollout-guide sections, File → New CLAUDE.md (Cmd+Shift+C) with dynamic label ("Open" when one exists), File → New Skill File, "Created from template" hint banner, workspace banner prompting CLAUDE.md creation when missing. ([RAISE-9](https://risepeople.atlassian.net/browse/RAISE-9))
- **Hybrid theming** — Rise design system (Source Serif Pro Bold + Open Sans, brand B450, P450 interaction) for the WYSIWYG / chrome / welcome / preview zone; Gruvbox for the source editor with three contrast levels (hard / medium / soft) and an independent light / dark / system preference. View → Theme + View → Editor Theme submenus, Cmd+Shift+T cycles app theme, Cmd+Alt+Shift+T cycles editor theme. No-flash bootstrap on launch. ([RAISE-10](https://risepeople.atlassian.net/browse/RAISE-10))
- **Image drag-and-drop and paste** — drop or paste images into either editor; files land in `<dirname(markdownPath)>/assets/` with a markdown reference inserted at the drop / paste point. Custom `raise-asset://` protocol resolves relative paths at render time only (stored markdown stays clean). WYSIWYG image-click tooltip with "View full size". Filename sanitization handles macOS U+202F screenshots. ([RAISE-11](https://risepeople.atlassian.net/browse/RAISE-11))
- **Production builds + auto-update** — universal macOS DMG, Windows NSIS installer, Linux AppImage / deb. File associations for `.md` / `.markdown` / `.txt` on all platforms. electron-updater wired to the GitHub Releases feed; non-modal "Restart to update" banner. ([RAISE-12](https://risepeople.atlassian.net/browse/RAISE-12))

### Notes

- The app icon uses the canonical Rise mark (orange double-ring from `@risepeopleinc/rcl`'s asset bundle) on a white rounded-square background. [RAISE-15](https://risepeople.atlassian.net/browse/RAISE-15) — the original icon-assets ticket — can close as a duplicate.
- macOS builds in this release are unsigned — fine for internal dogfooding, not for external distribution. See `README.md` for the code-signing setup.
- Fonts (Source Serif Pro + Open Sans) load from Google Fonts at app launch. Bundling the woff2 files locally is tracked under [RAISE-16](https://risepeople.atlassian.net/browse/RAISE-16).
- No automated tests yet. Manual test plans live in each PR's description; vitest setup is tracked under [RAISE-14](https://risepeople.atlassian.net/browse/RAISE-14).

[Unreleased]: https://github.com/RisePeopleInc/raise-editor/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/RisePeopleInc/raise-editor/releases/tag/v0.1.2
[0.1.1]: https://github.com/RisePeopleInc/raise-editor/releases/tag/v0.1.1
[0.1.0]: https://github.com/RisePeopleInc/raise-editor/releases/tag/v0.1.0
