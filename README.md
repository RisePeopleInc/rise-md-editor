# Rise MD Editor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A markdown editor for Rise People — designed for editing the `CLAUDE.md` and `SKILL.md` files that drive our AI workflows. Open-source under the MIT license; the Rise brand assets shipped alongside it are reserved (see [BRAND.md](BRAND.md)).

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

- **Node 22** (pinned in [`.nvmrc`](.nvmrc); `engines.node` allows `>=20` for downstream flexibility but development and CI target 22). NVM users:
  ```sh
  nvm use
  ```
- **macOS / Windows / Linux** — the dev experience targets all three. Builds are platform-scoped (see below).

### Setup

```sh
git clone https://github.com/RisePeopleInc/rise-md-editor.git
cd rise-md-editor
npm install
```

### Run

```sh
npm run dev
```

Opens the Electron app with hot module reload for the renderer (Vite) and a watch + restart loop for the main process. Source maps are enabled.

### Lint, type-check, build, test

```sh
npm run lint        # ESLint flat config
npm run typecheck   # tsc --noEmit
npm run build       # electron-vite build (no installer)
npm test            # vitest run (unit tests, one-shot CI mode)
npm run format      # Prettier write
```

All four (lint / typecheck / build / test) should pass before opening a PR. CI runs the same four on every push to a non-main branch and every PR ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The build step writes to `out/`; it's the same output the dev server consumes.

## Production builds

Each platform target wraps `electron-vite build` and then runs `electron-builder` with the matching flag. Output lands in `dist/`.

```sh
npm run build:mac     # → dist/Rise MD Editor-{version}-universal.dmg + .zip
npm run build:win     # → dist/Rise MD Editor-{version}-Setup.exe + .zip
npm run build:linux   # → dist/Rise MD Editor-{version}.AppImage + .deb
npm run build:all     # all three (only useful on a CI host with the toolchains)
```

### Code signing setup (macOS)

The current cert is `Developer ID Application: Rise People Inc (TJFLUA3UJ3)`, hardcoded in `electron-builder.yml`. To set up a build host that can produce a signed DMG:

1. **Generate a Certificate Signing Request (CSR)** in Keychain Access:
   - Keychain Access → Certificate Assistant → _Request a Certificate from a Certificate Authority…_
   - Save to disk; this also generates a private key in your Login keychain.
2. **Submit the CSR to Apple** at https://developer.apple.com/account/resources/certificates → _Create a Certificate_ → _Developer ID Application_. Apple returns a `.cer` file (Apple-signed copy of your public key).
3. **Import the cert into your Login keychain**:
   ```sh
   security import path/to/developerID_application.cer \
     -k ~/Library/Keychains/login.keychain-db
   ```
4. **Install the Apple G2 intermediate** — without it, the chain doesn't validate and `security find-identity` reports `0 valid identities`:
   ```sh
   curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer \
     -o /tmp/DeveloperIDG2CA.cer
   security import /tmp/DeveloperIDG2CA.cer \
     -k ~/Library/Keychains/login.keychain-db
   ```
5. **Verify** the identity is now usable:
   ```sh
   security find-identity -v -p codesigning
   #  1) 245C2A28A7F9670315A4B01F1D8F7ED00ABF8DD3 "Developer ID Application: Rise People Inc (TJFLUA3UJ3)"
   #     1 valid identities found
   ```
6. `npm run build:mac` now produces a signed `.dmg`. Verify with:
   ```sh
   codesign -dvv dist/mac-universal/Rise MD Editor.app | head -10
   # Should print: "Authority=Developer ID Application: Rise People Inc..."
   ```

#### Building unsigned (CI without secrets)

If the host doesn't have the cert (e.g. PR check on a runner without secrets), set `CSC_IDENTITY_AUTO_DISCOVERY=false` and the build skips signing:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
```

The resulting DMG is unsigned and Gatekeeper-quarantined on download — fine for smoke testing, not for distribution.

#### Notarization

On macOS Catalina (10.15) and later, code signing alone is **not enough** — Gatekeeper specifically checks for an Apple-issued _notarization ticket_ and shows the same `"could not verify Rise MD Editor is free of malware"` dialog for both unsigned and signed-but-unnotarized apps. Notarization uploads the signed bundle to Apple's notary service; Apple scans it for malware and returns a ticket which `electron-builder` staples to the DMG. After that, first launch on a clean Mac shows `"macOS verified that this app is free of malware"` with a real **Open** button.

Three env vars need to be present in the build host's environment:

```sh
export APPLE_ID='techpurchasing@risepeople.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='TJFLUA3UJ3'
npm run build:mac
```

- `APPLE_ID` — the Apple ID enrolled in the Apple Developer Program (`techpurchasing@risepeople.com` for Rise).
- `APPLE_APP_SPECIFIC_PASSWORD` — generated at https://appleid.apple.com → _Sign-In and Security_ → _App-Specific Passwords_ → "+", label e.g. `rise-md-editor-notarization`. The 16-char password is shown **once** at creation; record it in 1Password immediately. **Don't** put it in `~/.zshrc` or any committed file — set it inline for the build, or source it from a password manager / `op read` / `direnv` envrc that's `.gitignore`d.
- `APPLE_TEAM_ID` — `TJFLUA3UJ3` (Rise's developer team). The env var is what Apple's notary CLI uses to authenticate the upload.

Notarization is driven entirely by these env vars — `electron-builder.yml` deliberately has no `notarize:` block (recent electron-builder versions warn if you set `notarize.teamId` in the config, since it can drift out of sync with what notarytool actually reads). If any of the three env vars are missing, electron-builder logs a warning and skips notarization; the build still produces a signed-but-unnotarized DMG, which is useful for local smoke tests but **will trigger the Gatekeeper malware dialog on end-user machines**. Don't ship those.

Notarization adds 5–15 minutes to the build (Apple's scan time); `electron-builder` polls and staples automatically. To verify after the build:

```sh
spctl --assess --type execute --verbose=4 dist/mac-universal/Rise MD Editor.app
# Expect: "accepted" with "source=Notarized Developer ID"

xcrun stapler validate dist/Rise MD Editor-*-universal.dmg
# Expect: "The validate action worked!"
```

### Code signing setup (Windows)

Windows installers are signed via [**Azure Artifact Signing**](https://learn.microsoft.com/en-us/azure/trusted-signing/) — Microsoft's HSM-hosted code signing service (FIPS 140-2 Level 3, SOC 2 Type II via Azure's underlying compliance). ~$10/month (Basic tier). The cert never leaves Microsoft's HSM; the build runner authenticates via OIDC federation and the actual private-key operation happens server-side.

> Microsoft rebranded "Trusted Signing" → "Artifact Signing" in the Azure portal. Microsoft Learn docs and the NuGet client package (`Microsoft.Trusted.Signing.Client`) still use the older name; the service is the same.

Signing flow:

1. The `build-win` job in `.github/workflows/release.yml` declares `environment: rise-md-editor-signing` and requests `id-token: write` permissions.
2. `azure/login@v2` exchanges GitHub's OIDC token for an Azure access token.
3. The job installs Microsoft's Artifact Signing dlib (NuGet package `Microsoft.Trusted.Signing.Client`).
4. electron-builder's `signtoolOptions.sign` callback ([`scripts/sign-windows.cjs`](scripts/sign-windows.cjs)) shells out to `signtool.exe` with the dlib for every `.exe` it produces.
5. The dlib calls into Azure for the signing operation against cert profile `rise-md-editor-public` in account `rise-md-editor-signing`.

No `.pfx` on the runner, no long-lived service-principal secret. The federated credential is scoped to this repo's `rise-md-editor-signing` environment, so only workflow runs that opt into that environment can sign.

For local `npm run build:win` (no Azure auth), the sign callback logs a "skipping" warning and returns — producing an unsigned `.exe`. Same behavior as before for dev builds.

- Operational release guide (cutting releases, secrets, troubleshooting): [`docs/release-process.md`](docs/release-process.md)
- One-time Azure provisioning recipe (resource topology, identity validation, app registration, federated credential): [`docs/azure-signing-setup.md`](docs/azure-signing-setup.md)

### Cert management — responsible practices

The Developer ID cert + private key give anyone who has them the ability to publish software as Rise People. Treat them like a production secret.

**Storage**

- The **private key** lives in your Login keychain, paired with the imported `.cer`. macOS keeps it encrypted at rest by your login password.
- For backup or to move to another build host, **export as `.p12`** from Keychain Access (right-click the identity → _Export…_ → choose `.p12` → set a strong password). Store the `.p12` and its password in a password manager (1Password, Bitwarden) — **never** commit them to git, **never** Slack them, **never** email them.
- The `.cer` (downloaded from Apple) is the public half and is safe to share; only the `.p12` / Login keychain entry is sensitive.

**CI handling**

- Don't ship the `.p12` or its password in the repo. Use repo secrets:
  - `CSC_LINK` — base64-encoded `.p12` (`base64 -i cert.p12 | pbcopy`)
  - `CSC_KEY_PASSWORD` — the export password
- electron-builder picks these up automatically when building on a host that doesn't have the cert in its Keychain.
- Rotate the secrets if anyone with access to them leaves the team.

**Rotation + revocation**

- The cert expires after **5 years** from the issue date. Mark a calendar reminder ~3 months before expiry to generate a new one.
- If you suspect the private key is compromised (laptop stolen, leaked `.p12`, etc.), **revoke immediately** at https://developer.apple.com/account/resources/certificates → select the cert → _Revoke_. Apple invalidates every artifact signed with it; users with affected installs see a Gatekeeper failure on next launch and need to reinstall.
- Generate a new cert from a fresh CSR. Old apps signed with the revoked cert won't auto-update — the new release needs to be installed manually by users (or pushed via your MDM).

**Single-cert hygiene**

- One Developer ID Application cert covers every app under that team. Don't generate a per-app cert; it's redundant and multiplies the rotation surface.
- Don't share the `.p12` with people outside the dev team. Each new release operator should either share access to a single CI's secret store or be added to the Apple Developer team and generate their own CSR + cert from the same team.

**Notarization credentials (separate from the signing cert)**

The notarization flow uses an Apple ID + app-specific password — a separate secret from the signing cert's `.p12`. They're both required to ship a clean macOS build, and they have independent lifecycles.

- The **app-specific password** is created at https://appleid.apple.com → _Sign-In and Security_ → _App-Specific Passwords_. Apple shows it once; if you lose it you generate a new one and revoke the old.
- Store it in 1Password under an entry like _"Rise MD Editor — Apple notary app-specific password"_ with the Apple ID email and Team ID alongside. **Never** in dotfiles, **never** committed.
- Up to ten app-specific passwords per Apple ID. Revoke the entry whenever someone with access to it leaves the team.
- Rotation: no fixed expiry on app-specific passwords, but plan to rotate annually or whenever the password manager flags it.
- For CI: store as repo secrets (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and inject at build time. Don't write them to disk on the runner.
- The Apple ID itself (`techpurchasing@risepeople.com`) needs 2FA enabled — Apple requires it for app-specific password creation. The 2FA device is the bottleneck for generating new passwords; document who has it.

### App icon

The Rise mark (orange double-ring) on a white rounded square. Source is `build/icon.svg`; the rendered bitmap at `build/icon.png` is what electron-builder reads.

To regenerate the PNG after editing the SVG:

```sh
npx --yes @resvg/resvg-js-cli --fit-width 1024 build/icon.svg build/icon.png
```

Any tool that produces a 1024×1024 PNG works. Electron-builder generates the platform-specific `.icns` / `.ico` from `icon.png` at build time — no manual export needed. To swap the design entirely, replace `icon.svg` and re-run the command above.

## Auto-update

`electron-updater` runs in production builds (skipped in `npm run dev`). On launch it checks `RisePeopleInc/rise-md-editor`'s GitHub Releases for a newer version. If one's found:

1. The new version downloads in the background.
2. A non-modal banner appears in the editor: _"Rise MD Editor `{x.y.z}` is ready. Restart to update."_
3. **Restart** quits the app, installs, and relaunches. **Later** dismisses the banner; the update is on disk and applies on the next normal app exit.

To cut a new release:

```sh
# Bump the version in package.json (semver), commit, push.
git tag -a v0.1.3 -m "Release 0.1.3"
git push origin v0.1.3
```

The `Release` workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) picks up the tag, builds + signs + notarizes on GitHub-hosted runners (macOS-14 + windows-latest), and assembles the artifacts into a draft GitHub Release. Review the artifact list, smoke-test the installers, and publish.

The full operational guide — secrets, dry-run via `workflow_dispatch`, troubleshooting — lives in [`docs/release-process.md`](docs/release-process.md).

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
- **Autolink discrimination by suffix**: `file.md` references stay plain text; `www.cbc.ca` and `internet.com` autolink. Implementation lives in `src/renderer/state/filenameExtensions.ts` — see "Filename / TLD list policy" below. ([RAISE-47](https://risepeople.atlassian.net/browse/RAISE-47))

### Filename / TLD list policy

`src/renderer/state/filenameExtensions.ts` exports two curated string sets that gate autolink behaviour everywhere a URL-shaped string can appear (WYSIWYG type-time, parse-side mdast revert, browser-injected mark strip, markdown-it preview, PDF export):

- **`FILE_EXTENSION_TLDS`** — strings we treat as file extensions, NOT real TLDs. `file.md`, `notes.txt`, `config.json`, etc. don't autolink in any surface.
- **`KNOWN_TLDS`** — strings we treat as real-domain TLDs. `www.cbc.ca`, `internet.com`, `example.io`, etc. DO autolink in the WYSIWYG type-time path (markdown-it linkify in preview / PDF uses its own broader TLD list).

The two lists are independent — a string can be in one, the other, both, or neither, and the autolink decision is made per surface from the relevant list. **Adding to `FILE_EXTENSION_TLDS`** is appropriate when a real-domain reference like `notes.app` is being false-positive autolinked as `http://notes.app` because `app` is in `KNOWN_TLDS`; flipping the entry to file-extension treatment keeps notes-as-files working at the cost of `*.app` URLs no longer autolinking. **Adding to `KNOWN_TLDS`** is appropriate when a real-URL reference like `example.foo` isn't autolinking; new entries should be ICANN-recognised TLDs ([list](https://www.iana.org/domains/root/db)) and not also common file extensions or natural-language abbreviations.

When in doubt, prefer the conservative path — leave the extension out of both lists, so the text falls through to plain rendering. The user can always wrap a real URL in `<https://example.foo>` (CommonMark autolink syntax) or `[label](https://example.foo)` (explicit link syntax) to force a link.

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

[vitest](https://vitest.dev/) runs the unit-test suite ([RAISE-14](https://risepeople.atlassian.net/browse/RAISE-14)). Tests live alongside the code they cover under `__tests__/` directories — e.g. `src/renderer/state/__tests__/filenameExtensions.test.ts`. Run them locally with `npm test` (one-shot) or `npx vitest` (watch mode). The discovery glob is in [`vitest.config.ts`](vitest.config.ts).

Current scope is pure-logic surfaces in renderer and main (input → output functions). React component rendering and Electron integration are out of scope for now — the manual test plan in each PR description still covers those. The `pr-review` skill cross-references the test plan against the diff.

### Adding a feature

1. Pick (or create) a Jira ticket with clear acceptance criteria.
2. Branch from `main` with the ticket key prefix.
3. Implement, then `npm run lint && npm run typecheck && npm run build && npm test`.
4. Open a PR. The PR-review skill (`/pr-review`) runs against it and posts a structured review.
5. Address warnings + actionable suggestions; file follow-ups for anything punted.
6. Squash-merge. Transition the Jira ticket to Done.

## Contributing

External contributions are welcome but the primary audience is Rise internal users, so expect a higher-than-usual bar on scope alignment. The branch / PR conventions in [CLAUDE.md](CLAUDE.md) apply to everyone:

- Branch names start with the Jira ticket key (`RAISE-N-short-slug`). If you don't have Rise Jira access, prefix with `external-` and describe the change in the PR body.
- PR titles lead with the ticket key.
- Commits are GPG-signed.
- `npm run typecheck && npm run lint && npm run build && npm test` all pass before opening a PR.
- Be patient — maintainer attention is bounded.

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE) — the source code is freely usable, modifiable, and redistributable with attribution.

**Rise brand assets are reserved.** The Rise word marks, the orange double-ring logo, the `--rise-*` design tokens, and the product name "Rise MD Editor" are not covered by the MIT grant. See [BRAND.md](BRAND.md) for what forks need to do before redistributing.

Third-party dependency licenses are catalogued in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The historical analysis that informed the MIT decision lives in [docs/license-rationale.md](docs/license-rationale.md).
