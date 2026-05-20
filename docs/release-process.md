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
   - Windows: installer launches without the "Unknown publisher" SmartScreen warning. Right-click → Properties → Digital Signatures → details should show **Rise People Inc.** as the verified signer. (Reputation-based SmartScreen may still nag for the first few dozen downloads of a brand-new binary; that's separate from the unknown-publisher warning and fades with usage.)
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

### Windows signing — Azure Trusted Signing

Windows installers are signed via [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) ([RAISE-58](https://risepeople.atlassian.net/browse/RAISE-58)). FIPS 140-2 Level 3 HSM-backed cert, ~$10/month (Basic tier). The cert never leaves Microsoft's HSM — the build runner authenticates to Azure via OIDC federation, calls the signing service through `signtool.exe` + the Trusted Signing dlib, and the service signs in place.

**Three new repo secrets** (under _Settings → Secrets and variables → Actions_):

| Secret                  | Source                                                 | Notes                                                  |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `AZURE_TENANT_ID`       | Microsoft Entra directory ID                           | Steve's tenant: `0123a73c-a400-44e5-8960-15337cf2e8f0` |
| `AZURE_CLIENT_ID`       | App registration `rise-md-editor-github-signing`       | `1335db74-9168-463d-b6de-940d8e9ad742`                 |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription holding the Trusted Signing account | `a1471a7e-eaf3-4a3b-adfc-ae05298698e1`                 |

None of these are sensitive in the traditional sense (they're publicly-visible identifiers), but they're configured as secrets so they don't leak into PRs or fork logs.

**Non-secret config** (hardcoded in the workflow):

|                         |                                        |
| ----------------------- | -------------------------------------- |
| Account URI             | `https://eus.codesigning.azure.net/`   |
| Trusted Signing account | `rise-md-editor-signing` (East US)     |
| Certificate profile     | `rise-md-editor-public` (Public Trust) |

**OIDC federation** — the signing job declares `environment: rise-md-editor-signing` and the Entra app registration has a federated credential keyed to that environment + repo. Only workflow runs that match both can mint an Azure access token. No long-lived service-principal secret on the runner.

**Impact for users**: signed installers no longer trigger SmartScreen's "Unknown publisher" warning. Reputation-based SmartScreen may still nag for the first dozens of installs of a brand-new binary; that fades after a few hundred downloads.

**SmartScreen audit notes**: Right-click installer → Properties → Digital Signatures → details should show:

- Signer: `Rise People Inc.` (matches the Identity Validation submitted to Microsoft)
- Issuer: chains up to Microsoft's trusted root
- Status: This digital signature is OK
- Timestamp: stamped by `http://timestamp.acs.microsoft.com`

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
