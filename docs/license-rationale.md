# License rationale

> **Status**: MIT relicense implemented in [RAISE-57](https://risepeople.atlassian.net/browse/RAISE-57). This document is retained as a historical record of the analysis that informed the decision — it predates the actual flip and intentionally reads from the "are we sure?" perspective rather than the "this is the policy" perspective. The current state is: source is MIT, brand is reserved (see [`../LICENSE`](../LICENSE) and [`../BRAND.md`](../BRAND.md)).

This document explains where Rise MD Editor stood on licensing before RAISE-57 and what an MIT relicensing entailed. It is **not** legal advice — the dependency analysis here is technical, but the actual license change was run past whoever owns the IP / brand policy at Rise before being implemented.

## State before RAISE-57

- `package.json` declared `"license": "UNLICENSED"` and `"private": true`.
- No `LICENSE` file in the repo root.
- Effect: all rights reserved by Rise People Inc. by default. Third parties had no permission to copy, redistribute, or modify the code.

## Why closed-source today

The reason isn't documented anywhere in the repo. Plausible drivers — none verified, none mutually exclusive:

- **Default-keep-options-open**: easier to start closed and open later than to retract an OSS release. Electron-app starter templates default to `private: true`, and that default has carried forward.
- **Brand and trademark concerns**: the Rise design tokens, brand colors, and the canonical Rise mark are Rise IP regardless of source-code license. A permissive code license without explicit trademark carve-outs could be misread as authorising third-party redistribution of the brand.
- **Rise-internal template content**: `src/main/templates/` ships pre-filled `CLAUDE.md` / `SKILL.md` scaffolds that reference Rise-internal terminology and rollout-guide structure.
- **Procurement / legal hasn't approved an external release**: typically the actual blocker for any "should we open this?" question.
- **Liability and support**: open source tends to attract issues / PRs from strangers; staying closed creates no support obligation.

## Are dependencies a blocker for MIT? No.

A scan of the production tree finds zero copyleft licenses (no GPL, LGPL, AGPL, CDDL, EPL anywhere — including devDependencies). Snapshot of the production licenses:

| License                     | Count                    | MIT-compatible?                              |
| --------------------------- | ------------------------ | -------------------------------------------- |
| MIT                         | 265                      | Yes — same license                           |
| ISC                         | 6                        | Yes — functionally identical to MIT          |
| BSD-2-Clause / BSD-3-Clause | 6                        | Yes — permissive, attribution only           |
| Apache-2.0                  | 1 (`typescript`, devDep) | Yes — permissive, attribution + patent grant |
| BlueOak-1.0.0               | 1 (`sax`)                | Yes — modern permissive, MIT-like            |
| MIT OR CC0-1.0              | 1 (`type-fest`)          | Yes — pick MIT                               |
| MPL-2.0 OR Apache-2.0       | 1 (`dompurify`)          | Yes — pick Apache-2.0                        |
| Python-2.0                  | 1 (`argparse`)           | Yes — permissive, MIT-compatible             |
| OFL-1.1                     | 2 (bundled fonts)        | See "Fonts" below                            |

Reproduce the snapshot with:

```sh
npx --yes license-checker-rseidelsohn --production --summary
```

### Fonts

`@fontsource/source-serif-pro` and `@fontsource/open-sans` ship under SIL Open Font License 1.1. **OFL covers the font files specifically, not source code that uses them.** The OFL imposes three obligations:

1. The OFL text must travel with the font files when redistributed. The `@fontsource` packages already bundle a `LICENSE` file at their package root, and electron-builder includes those files in the asar — already handled.
2. The fonts themselves can't be sold as a standalone product. Doesn't apply here.
3. Modifications can't reuse the original font name. Doesn't apply here.

The OFL does not infect the source-code license. The app source can be MIT while the bundled `.woff2` bytes remain OFL.

## What would an MIT relicense require?

1. **Add a `LICENSE` file** at the repo root with the standard MIT text and `Copyright © Rise People Inc.`
2. **Update `package.json`**: `"license": "UNLICENSED"` → `"license": "MIT"`. Remove or set `"private": false` only if there's a reason to publish to npm (irrelevant for an Electron app — `private: true` doesn't affect electron-builder).
3. **Carve out brand assets explicitly**. The `LICENSE` file should note that the Rise mark and brand colors are Rise trademarks not covered by the MIT grant. Pattern used elsewhere — e.g. a separate `BRAND.md` or a dedicated paragraph in the LICENSE / README:

   > The Rise word mark, the Rise logo, and the visual identity of Rise People Inc. are trademarks of Rise People Inc. The MIT license granted by this repository does not grant any right to use those marks. Forks must replace the brand assets in `build/icon.*` and `src/renderer/styles/themes.css` before redistribution.

4. **Audit `src/main/templates/`** for Rise-confidential content. Likely fine, but a review pass is cheap.
5. **Audit any future `@risepeopleinc/*` npm dep** — none in the tree today, but if `@risepeopleinc/rcl` is ever pulled in (mentioned in the icon notes for the Rise-mark provenance) its license needs a separate check.
6. **Add `THIRD-PARTY-NOTICES.md`** — generate via `license-checker-rseidelsohn` and check in. Several OSS Electron apps ship something equivalent in About / Help, sometimes both.

## Historical recommendation

> The original recommendation was: don't change anything until there's a reason to. The trigger that overrode this was the auto-update bug — `electron-updater` returns 404 on a private repo's Releases feed because `electron-builder.yml` doesn't pass a token. Flipping the repo public was the lowest-effort fix, and once the repo was going public anyway the marginal cost of doing the full MIT flip instead of "public + no LICENSE" was a few hours of paperwork. RAISE-57 captured both.

Original wording, preserved verbatim:

> Don't change anything until there's a reason to. The technical answer is: MIT works for the deps. The policy answer is: ask whoever owns the trademark and IP policy at Rise. Until there's a stakeholder asking to open-source it, "UNLICENSED + private" is a perfectly reasonable default for an internal-only tool.

## What actually shipped in RAISE-57

1. `LICENSE` — MIT text with `Copyright © 2026 Rise People Inc.` and a closing paragraph pointing readers to `BRAND.md` for the trademark carve-out.
2. `BRAND.md` — explicit list of reserved Rise marks (word marks, logo, `--rise-*` design tokens, product name) and a "what forks must change" checklist.
3. `package.json` — `"license"` flipped from `"UNLICENSED"` to `"MIT"`. `"private": true` stayed (it gates npm publish, not GitHub visibility, and we don't publish to npm).
4. `THIRD-PARTY-NOTICES.md` — generated from `license-checker-rseidelsohn` against the production dep tree.
5. `CODE_OF_CONDUCT.md` — adopts Contributor Covenant v2.1 by reference (not inlined verbatim) with `conduct@risepeople.com` as the reporting contact.
6. `SECURITY.md` — vulnerability-reporting policy pointing to GitHub private advisories with `security@risepeople.com` as the backup channel.
7. README, CLAUDE.md, CHANGELOG.md updates to match the new posture.

Templates were audited (`src/resources/templates/claude-md-template.md`, `skill-md-template.md`) and found to contain no Rise-confidential content — they're generic scaffolds that happen to be shipped by a Rise product.

The `@risepeopleinc/rcl` dep is still not pulled into the tree. The Rise mark in `build/icon.svg` was authored fresh by tracing the canonical RCL SVG; the BRAND.md carve-out covers it.
