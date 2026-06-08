# CLAUDE.md — guidance for Claude Code working in this repo

This file is the project's instruction layer for AI agents. Read it before making changes. It captures intent, conventions, and gotchas that aren't obvious from the file tree.

## Project at a glance

**Rise MD Editor** (formerly "rAIse") is a cross-platform Electron markdown editor purpose-built for Rise People's Cowork rollout. Primary users are the ~50 non-engineering Rise employees who maintain personal `CLAUDE.md` files and occasionally edit `SKILL.md` files — they need a clean editor without VS Code's complexity. Engineers can use it but already have alternatives.

**Core principles**:

- **Markdown-native**: standard `.md` files, no proprietary format, no database, no sync layer.
- **Cowork-aware**: understands `CLAUDE.md` and `SKILL.md` as special file types, ships templates and scaffolding.
- **Simple by default, powerful when needed**: opens a file, you edit, you save. Power users can open a workspace folder and get a project tree.

This repo is MIT-licensed and publicly visible at <https://github.com/RisePeopleInc/rise-md-editor>. The Rise brand assets (logo, `--rise-*` design tokens, product name) are trademark-reserved per [`BRAND.md`](BRAND.md) and not covered by the MIT grant. See [`docs/license-rationale.md`](docs/license-rationale.md) for the historical analysis behind the MIT decision.

## Tech stack

| Layer          | What                       | Notes                                                   |
| -------------- | -------------------------- | ------------------------------------------------------- |
| Shell          | Electron 42                | Hardened renderer, contextIsolation, no nodeIntegration |
| Bundler        | electron-vite 3 (Vite 6)   | Three Vite builds (main / preload / renderer)           |
| Source editor  | Monaco                     | VS Code's editor; six Gruvbox theme variants            |
| WYSIWYG editor | Milkdown 7                 | ProseMirror underneath; commonmark + gfm presets        |
| UI             | React 19 + Tailwind CSS 4  | No global state library — composed React hooks          |
| Persistence    | electron-store (main only) | Renderer never touches it directly                      |
| Packaging      | electron-builder 26        | Signed/notarized macOS, Azure-Trusted-Signed Windows    |
| Auto-update    | electron-updater           | GitHub Releases feed                                    |
| Test runner    | vitest 3                   | Pure-logic unit tests under `__tests__/`                |
| Runtime        | Node 22                    | Pinned in `.nvmrc`                                      |

**Why two editors?** Markdown is text; ProseMirror is a tree. Round-tripping every edit through serialization would be lossy and slow. Source mode gives power users a byte-perfect path; WYSIWYG gives non-technical users a familiar editing surface. The cost is dual maintenance — every feature change considers both.

**Why not fork VS Code?** VS Code is ~2M lines. Monaco gives us VS Code's editor without the maintenance burden, and Milkdown gives us WYSIWYG VS Code doesn't have at all.

## Read these before making non-trivial changes

- [`README.md`](README.md) — feature list, code-signing setup, contribution norms
- [`docs/architecture.md`](docs/architecture.md) — process model, IPC, state management, build pipeline
- [`docs/release-process.md`](docs/release-process.md) — how releases are cut and signed
- [`docs/license-rationale.md`](docs/license-rationale.md) — licensing posture
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped when, with Jira-ticket links

## Common commands

Always run with Node 22. If `node --version` shows anything else, run `nvm use` first (the `.nvmrc` is the source of truth).

```sh
nvm use                         # → Node 22 per .nvmrc

npm run dev                     # Electron + Vite dev with hot reload
npm run typecheck               # tsc on web + node tsconfigs (must pass before commit)
npm run lint                    # ESLint flat config (must pass before commit)
npm run build                   # production bundle into out/ (must pass before commit)
npm test                        # vitest run — one-shot unit tests (must pass before commit)
npm run build:mac               # full electron-builder mac packaging (needs signing creds)
npm run build:win               # Windows packaging
npm run format                  # Prettier write
npx prettier --check <files>    # CI-equivalent check; runs against `**/*` minus .prettierignore
```

Before opening any PR, run typecheck + lint + build + test locally. The PR-review skill expects these to pass; CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same four on every push to a non-main branch and every PR.

## Workflow conventions

The project uses a strict per-ticket workflow. **Don't deviate without asking.**

- **Branch naming**: every branch starts with the Jira ticket key. Format: `RAISE-N-short-slug` (e.g. `RAISE-46-table-cell-paste`). The `pr-review` skill parses the branch name to pull the Jira ticket — if the prefix is missing, the review fails. Branches without a ticket (rare — version bumps, doc-only) can use a descriptive slug.
- **PR title** also leads with the ticket key (`RAISE-46: ...`).
- **Commits are GPG-signed**. If signing fails (pinentry cancellation, etc.), retry — never use `--no-gpg-sign` to bypass.
- **Pushing to `main` directly is blocked**. Everything goes through a PR. Even one-line version bumps.
- **Squash-merge** PRs (`gh pr merge <N> --squash --delete-branch`).
- **CHANGELOG.md** has an `[Unreleased]` section at the top; add an entry for any user-visible change. Keep the existing entry style (bold lead, ticket link, plain-language explanation, Notes sub-bullet for migration / behavior caveats).
- **Don't auto-commit unless asked**. The user explicitly says "commit" or "ship it". Until then, edits are reviewable diffs only.

## Documentation maintenance

**Treat documentation as part of the code.** Every PR that changes user-visible behavior, project conventions, dependencies, runtime versions, or architecture must include the corresponding doc updates in the **same PR** — not deferred to a follow-up.

The goal: someone reading the docs at any commit on `main` should find them accurate. Stale docs are worse than missing docs because they confidently mislead.

**When opening a PR, audit the diff against the docs and update wherever they overlap:**

- **Dependency or runtime version bumps** (e.g. Electron major, Node, Vite, electron-builder, Milkdown, Monaco, React, Tailwind) → update the tech-stack table in `CLAUDE.md` _and_ `docs/architecture.md` (both have one).
- **New IPC channels, new state hooks, new processes, security-boundary changes** → update `docs/architecture.md`'s IPC and state-management sections, and any relevant invariants in `CLAUDE.md`.
- **New conventions, gotchas, or pitfalls discovered during the work** → add to the corresponding section in `CLAUDE.md`. If a session burned cycles on a footgun, document it.
- **User-visible features, behavior changes, bug fixes** → add to `CHANGELOG.md`'s `[Unreleased]` section in the existing entry style.
- **Release-pipeline changes** (signing, secrets, workflow YAML, packaging targets) → update `docs/release-process.md`.
- **Licensing changes** (`package.json` `license` field, dep license additions to non-MIT) → update `docs/license-rationale.md` and re-run the dep-license scan.
- **README** is the project's external face — update it for anything a new visitor would expect to see (feature additions, install changes, contribution norms).

**When reviewing a PR, cross-check the diff against the docs.** If the change affects something a doc claims, flag the missing doc update as part of the review — minimum **🔵 Suggestion**, escalating to **🟡 Warning** if the staleness would actively mislead a new contributor. The PR doesn't merge with confident-but-wrong docs.

**Exceptions** (still rare): pure refactors with zero observable surface change, internal-only renames that affect no doc, dep patch bumps that don't change major behavior. Even then, prefer to update if a doc happens to mention the changed thing — the marginal effort is small and prevents drift.

## Coding standards

- **TypeScript strict mode is non-negotiable**. `tsconfig.*.json` has `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noImplicitReturns`. Never relax these.
- **ESLint flat config** in `eslint.config.mjs`. React hooks rules + typescript-eslint.
- **Prettier** for formatting. Run `npm run format` or `npx prettier --write <files>`. CI checks formatting.
- **Comments explain intent**, not syntax. Especially around React effect dependencies, IPC channel contracts, and Electron security boundaries — anything where "what the code does" doesn't tell you "why it has to be this way." Existing comments in `src/main/index.ts` and `src/renderer/index.html` set the tone.
- **No emojis in source files** unless explicitly requested. CHANGELOG and PR body are fine; source comments and code aren't.

## Architecture invariants

These are load-bearing. If a change appears to require violating one, stop and discuss.

- **Renderer is sandboxed** (`contextIsolation: true`, no `nodeIntegration`). Any privileged operation (filesystem, dialogs, electron-store, shell) goes through an explicit IPC channel exposed by the preload. The renderer never imports `electron` or Node modules directly.
- **`src/preload/index.ts` is the canonical IPC surface.** Channel names are colon-namespaced: `files:open`, `folder:get-tree`, `theme:set`, `update:install`. The `MenuActionType` union is the single source of truth for menu-driven actions — adding a new menu item means updating the union, the menu definition (`src/main/menu.ts`), and the handler in `App.tsx`.
- **electron-store lives in main, not renderer.** electron-store instances are constructed at module-import time, so anything depending on them must be imported AFTER `app.whenReady()`. The renderer reads/writes via IPC (`recent:add`, `theme:get`, etc.).
- **Custom `rise-md-asset://` protocol** resolves relative image paths at render time only. The protocol handler enforces an allowed-roots gate — paths outside the open workspace return 403. Don't bypass this gate.
- **Two editors, decoupled themes**: Monaco runs Gruvbox (six variants), Milkdown / chrome / preview runs the Rise design system. The two theme systems must not bleed into each other. Gruvbox vars are scoped to the Monaco container; Rise tokens (`--rise-*`) are everywhere else.
- **Two CSS naming conventions, distinct meanings**: `.rise-md-*` are app-specific class names (e.g. `.rise-md-prose`); `--rise-*` are Rise design-system tokens kept verbatim from the design system. Don't conflate.
- **Bundled templates** (`src/main/templates.ts`) are inlined at build time via Vite's `?raw` import. Never read from disk at runtime.
- **Filename / TLD policy** lives in `src/renderer/state/filenameExtensions.ts`. Two curated lists (`FILE_EXTENSION_TLDS` and `KNOWN_TLDS`) gate autolink behaviour everywhere a URL-shaped string can appear. The README's "Filename / TLD list policy" section has the editorial guidelines — follow them when adding entries.

## Pitfalls and gotchas

These have all bitten in real sessions. Front-load them.

- **`npm install` regenerates the lockfile** and may pick up unrelated transitive dep churn. For version-only bumps use `npm install --package-lock-only`.
- **Electron 38+ dropped the auto-download `postinstall` hook.** A fresh `npm install` no longer fetches the ~100 MB Electron binary — `npm run dev` then errors with `Error: Electron uninstall` (electron-vite's signature for "binary not found at `node_modules/electron/dist/`"). RAISE-70 worked around this by adding a `"postinstall": "node node_modules/electron/install.js"` script in our own `package.json` that re-triggers the download on every `npm install`. If you ever swap to a different Electron distribution (electron-nightly, electron-canary), verify it ships the same `install.js` entry point. The download adds ~5–15 sec to CI on a cold cache; release builds via electron-builder pull their own binaries separately so the duplicate is wasted bytes but not wasted minutes (binaries are cached per-version).
- **`gh pr merge` may fail post-merge if your working tree is dirty.** It does the actual merge first, then tries a local checkout. The remote state is correct even if the local sync errors. After cleanup, `git checkout main && git pull --ff-only`.
- **Empty stray files from typo'd shell redirects** — e.g. `npm install ... > electron-vite` creates a 0-byte file named `electron-vite`. Check `git status` for unexpected untracked entries.
- **Dev mode shows "Electron" in the dock** instead of "Rise MD Editor". That's a dev artifact — `app.setName()` doesn't override the bundle name when running unpackaged. Production builds show the right name.
- **`npm run dev` ignores `electron-builder.yml`.** The dev path is electron-vite + Electron CLI; signing config / file associations / auto-update only apply to packaged builds.
- **Managed installers must not auto-update, on both desktop OSes** (RAISE-90 Windows MSI, RAISE-91 macOS `.pkg`). Releases ship an auto-updating per-user build (NSIS `.exe` / `.dmg`) _and_ a per-machine managed build (`.msi` for Intune / `.pkg` for Mac MDM). Each pair packages the _same_ app bundle from one `build:win` / `build:mac` run, so you can't flip a build-time flag per target — `autoUpdater.ts` detects the managed install at runtime via `isManagedDeployment`: on Windows _or_ macOS, if the install dir (`Program Files` / `/Applications`) isn't user-writable, it skips update checks. If you touch the updater, preserve that gate; a managed install that tries to self-update would just nag with banners a standard user can't action while fighting the MDM. Managed builds are for device-management deployment only — see `docs/release-process.md`.
- **macOS needs TWO Developer ID certs** (RAISE-91). The `.app`/`.dmg` are signed with **Developer ID Application** (`MAC_CSC_LINK` → `CSC_LINK`); the `.pkg` is signed with a separate **Developer ID Installer** cert (`MAC_INSTALLER_CSC_LINK` → `CSC_INSTALLER_LINK`). They are different certificate types from Apple — don't assume one cert signs both. electron-builder picks the right one per target automatically once both env vars are set. macOS-exported `.p12`s use the legacy RC2 cipher, so `openssl pkcs12` needs `-legacy` to inspect them (CI is unaffected — it uses `security import`).
- **The renderer doesn't have `window.prompt()`.** Sandboxed renderers don't get it. That's why the file tree uses inline name-editing (RAISE-8) instead of native prompts.
- **The app is pre-release with no installed users.** No user-data migration code is needed; backward-compat for state shapes is not a constraint. If a refactor would benefit from changing electron-store keys, just change them.
- **`mac.notarize.teamId` in `electron-builder.yml` is intentionally absent** — recent electron-builder versions warn when it's set alongside the `APPLE_TEAM_ID` env var. Notarization is driven entirely by env vars (`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`). See `docs/release-process.md`.
- **OFL-1.1 fonts** ship inside the asar via @fontsource. Each `@fontsource/*` package's `LICENSE` file is automatically included; don't strip it (OFL redistribution requirement).
- **macOS `app.on('open-file')` fires before `whenReady()`.** Any path that ends up calling `new BrowserWindow()` from an early event handler must gate on `app.isReady()` first. Fixed for `dispatchMenuAction` in RAISE-54 — keep the same shape if adding new early-event handlers (`open-url` for custom URL schemes, etc.).
- **Milkdown plugins can fire init-time transactions that look like user edits.** GFM linkify, `autolinkOnTypePlugin`, `trailingParagraphPlugin`, etc. dispatch transactions on the first parsed doc — `markdownUpdated` fires before any user input, with markdown that differs from the on-disk source. Fixed in RAISE-55 via a per-tab `editorBaseline` in `fileState` that captures the editor's first post-load emit as the dirty-comparison reference; future appendTransaction plugins inherit the fix for free.
- **Distinguishing "init emit" from "user-edit emit" requires DOM-event-level signal.** "First emit after load" is NOT a reliable proxy — for files where no plugin fires an init transaction (most files without URL-shaped text), the FIRST emit IS the user's first keystroke. WysiwygEditor's wrapper div attaches an `input` event listener (capture phase) that flips `hasUserInteractedRef` to `true` the moment any descendant input fires — keydown / paste / drop / textarea typing in the frontmatter. MilkdownBody's `markdownUpdated` callback checks this ref to route the emit to either `onMarkdownBaseline` (init) or `onMarkdownChange` (user edit). If you add another emit source inside WysiwygEditor (a new editor surface, a programmatic content update), wire it through `hasUserInteractedRef` too — bypassing it would silently absorb user edits as baselines, hiding the dirty signal.

## Non-goals (intentionally not in scope)

The original spec explicitly excludes these for MVP. Don't propose them without an explicit ticket and discussion:

- Git integration (users have their own Git tools)
- Extension / plugin system
- Cloud sync (local files only)
- Collaborative editing
- Spell check beyond what the OS provides
- AI features in the editor itself (Cowork is the AI layer)

Post-MVP candidates exist (Markdown linting, CLAUDE.md validation, search-across-files, snippets) but stay out unless someone explicitly opens a ticket.

## When in doubt

- **Read the surrounding code first.** This codebase has tight conventions (IPC naming, comment style, theming) that aren't always called out — but reading neighbouring files reveals them quickly.
- **Cite Jira tickets in commit messages and PR descriptions.** The CHANGELOG and `docs/architecture.md` both link to tickets for "why this shape." When in doubt, the ticket has more context.
- **Ask before opening a PR for non-trivial work.** A ticket should exist; the branch name should match; the test plan in the PR body should be specific. The `pr-review` skill expects all of this.
