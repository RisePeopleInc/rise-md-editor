# Release process

Rise MD Editor releases run from GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) — a tag push triggers a parallel macOS + Windows build, and the workflow assembles the artifacts into a draft GitHub Release for a human to review and publish.

This document covers what the workflow expects, how to cut a release, and how to dry-run without spending notary minutes. The "why" of each step (signing rationale, hardened-runtime entitlements, etc.) lives in the README's _Code signing setup_ section — this doc focuses on the operational mechanics.

## Cutting a release

1. **Bump the version** in `package.json` on `main` (semver) and commit. The version drives the `dmg` / `exe` / auto-update artifact names.
2. **Tag and push**:
   ```sh
   git tag -a v0.1.3 -m "Release 0.1.3"
   git push origin v0.1.3
   ```
3. **Watch the workflow** at `https://github.com/RisePeopleInc/rise-md-editor/actions`. The macOS job takes ~25–35 minutes (notarization is most of that); Windows takes ~10 minutes.
4. **Review the draft Release** at `https://github.com/RisePeopleInc/rise-md-editor/releases`. Both `latest-mac.yml` and `latest.yml` should be present alongside the installers — these are what `electron-updater` reads.
5. **Smoke-test** the installers by downloading and running them on a clean machine (or VM). Verify:
   - macOS: Gatekeeper shows "macOS verified that this app is free of malware" with an **Open** button (not the "Apple could not verify" dialog).
   - Windows: SmartScreen warns on first download (expected — see _Windows signing — deferred_ below); click _More info_ → _Run anyway_.
6. **Publish** the draft Release. This makes it available to existing installs via electron-updater on next launch.

## Dry-run via `workflow_dispatch`

For testing the build pipeline without burning notary minutes (Apple rate-limits app-specific passwords) or creating a Release:

1. Go to the _Actions_ tab → _Release_ workflow → _Run workflow_.
2. Tick **Skip macOS signing & notarization** if you're testing changes that don't touch signing — the macOS job will produce an unsigned DMG roughly 4× faster.
3. The workflow runs both build jobs but the `release` job is gated on `startsWith(github.ref, 'refs/tags/v')`, so a `workflow_dispatch` run never publishes a Release. Artifacts are available via the workflow run's _Artifacts_ section for download (7-day retention).

## Required secrets

All five live under _Settings → Secrets and variables → Actions_ on the repo. Rotate annually or whenever someone with access leaves the team. **Never** commit any of these or write them to disk on the runner.

### macOS signing

| Secret name            | Source                                                                                     | Notes                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`         | Base64-encoded `.p12` of the _Developer ID Application: Rise People Inc (TJFLUA3UJ3)_ cert | Generate with `base64 -i cert.p12 \| pbcopy`. The `.p12` itself lives in 1Password. |
| `MAC_CSC_KEY_PASSWORD` | Password set when exporting the `.p12` from Keychain Access                                | Same 1Password entry as the `.p12`                                                  |

### macOS notarization

| Secret name                   | Source                                                                        | Notes                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `APPLE_ID`                    | `techpurchasing@risepeople.com`                                               | The Apple ID enrolled in the Developer Program                                                             |
| `APPLE_APP_SPECIFIC_PASSWORD` | https://appleid.apple.com → _Sign-In and Security_ → _App-Specific Passwords_ | 16 chars, format `xxxx-xxxx-xxxx-xxxx`. Apple shows it once at creation — record in 1Password immediately. |
| `APPLE_TEAM_ID`               | `TJFLUA3UJ3`                                                                  | Rise's Apple Developer team ID; matches the cert's Common Name                                             |

### Windows signing — deferred

No Windows signing secrets are configured right now. RAISE-45 phase 1 ships unsigned Windows installers; the workflow's `build-win` job intentionally has no `CSC_*` env vars wired, so electron-builder skips signing and emits a plain `.exe`.

**Why**: SSL.com eSigner ($65/yr) is the obvious cheap option but lacks a SOC 2 Type II report, which complicates Rise's vendor assessment. Azure Artifact Signing (FIPS 140-2 Level 3, SOC 2 Type II via Microsoft) is the chosen replacement at ~$120/yr — but it requires a Microsoft Entra ID tenant + workload-identity OIDC federation setup that's tracked separately.

**Impact for users**: SmartScreen Defender warns on first download for a few weeks until the unsigned binary builds reputation. Click _More info_ → _Run anyway_ to install. Auto-update across versions still works because `electron-updater` validates against the SHA listed in `latest.yml` rather than a code-signing chain.

**When signing lands**: the `build-win` step will gain a `signtoolOptions.sign` callback in `electron-builder.yml` plus an Azure-auth step in the workflow (OIDC federation, no long-lived secrets on the runner). Until then, the workflow comment block in `build-win` documents the future shape so the integration is straightforward.

## Troubleshooting

### "Notarization failed"

Most common causes:

- `APPLE_APP_SPECIFIC_PASSWORD` was rotated and the secret is stale → regenerate at appleid.apple.com and update the secret.
- `APPLE_ID` doesn't match the team that owns the signing cert → both must reference team `TJFLUA3UJ3`.
- An Apple notary service outage → check https://developer.apple.com/system-status/, retry the workflow.

The notary returns a request UUID in the build log. To pull the full log for a specific submission:

```sh
xcrun notarytool log <UUID> --apple-id <APPLE_ID> --password <APP_SPECIFIC_PASSWORD> --team-id TJFLUA3UJ3
```

### "Cert not found" / `CSC_LINK` issues

`MAC_CSC_LINK` is the **entire** base64 of the `.p12`, not a file path. If electron-builder reports "no identity found":

- Verify the secret was set with `base64 -i cert.p12` (not the raw binary).
- Verify the cert hasn't expired — Developer ID Application certs are valid for 5 years; check at https://developer.apple.com/account/resources/certificates.
- Verify `MAC_CSC_KEY_PASSWORD` matches the password set at `.p12` export time.

### Auto-update doesn't pick up the new release

- Confirm both `latest-mac.yml` and `latest.yml` made it into the published Release (they should be in the file list alongside the installers — the workflow uploads them explicitly).
- Confirm the Release is **published**, not still a draft. Drafts aren't visible to `electron-updater`.
- Confirm `package.json`'s `version` was bumped before tagging — `electron-updater` compares against installed version and won't downgrade or re-install the same version.
