# Azure Artifact Signing setup

> **Naming note**: Microsoft has gone through three names for this service. Earliest was **Azure Code Signing** (preview, 2023). Then it briefly became **Trusted Signing** (most of the Microsoft Learn docs and many third-party tutorials still use this label). The Azure portal currently surfaces it as **Artifact Signing** in the breadcrumb / navigation. The Azure resource provider name is unchanged across all three (`Microsoft.CodeSigning/codeSigningAccounts`), and the NuGet client package is still `Microsoft.Trusted.Signing.Client`. This doc uses **Artifact Signing** as the canonical name (matching the current portal UI) but the package and DLL literal names retain their `Trusted.Signing` / `CodeSigning` prefixes — those are out of our control.

This doc captures the one-time setup that wires Rise MD Editor's Windows release builds into Azure Artifact Signing. The release workflow itself ([`docs/release-process.md`](release-process.md)) covers ongoing operation; this doc covers _how the Azure side got provisioned_ in the first place, so it can be re-created cleanly if the tenant changes, the app registration gets rotated, the cert profile needs renewing, or a successor takes over.

Provisioned by `Steve.bond@risepeople.com` on 2026-05-05 under [RAISE-58](https://risepeople.atlassian.net/browse/RAISE-58).

## Why Azure Artifact Signing

Picked over the other Windows code-signing options:

| Vendor / approach | Cost | SOC 2 Type II? | Comment |
| --- | --- | --- | --- |
| **Azure Artifact Signing** | ~$10/month (Basic tier) | Via Azure platform | Chosen. FIPS 140-2 L3 HSM. No `.pfx` ever on disk. |
| SSL.com eSigner | ~$65/year | No public SOC 2 report | Cheapest but fails Rise's vendor assessment. |
| Sectigo / DigiCert OV | $300–500/year | Yes | More expensive, needs hardware token for some products. |
| Sectigo / DigiCert EV | $500–800/year | Yes | Hardware token required; marginal SmartScreen benefit over Microsoft-trusted OV. |
| Self-signed | Free | N/A | Doesn't help with SmartScreen at all. |

Azure was the cheapest path that satisfied Rise's vendor SOC 2 requirement (via Microsoft's underlying compliance). The HSM-hosted cert is also the strongest security posture — no key file to lose, no laptop to steal a `.pfx` from.

## Resource topology

```
Azure subscription: a1471a7e-eaf3-4a3b-adfc-ae05298698e1
└── Resource group: rg-rise-md-editor-signing (Canada Central — billing/metadata only)
    └── Artifact Signing account: rise-md-editor-signing (East US — service availability)
        ├── Identity validation: Rise People Inc. (Public Trust, validated 2026-05-15)
        └── Certificate profile: rise-md-editor-public (Public Trust)
            └── role: Trusted Signing Certificate Profile Signer
                └── assigned to: rise-md-editor-github-signing (Entra app registration)
                    └── federated credential: GitHub OIDC
                        └── subject: repo:RisePeopleInc/rise-md-editor:environment:rise-md-editor-signing

Microsoft Entra ID (tenant: 0123a73c-a400-44e5-8960-15337cf2e8f0)
└── App registration: rise-md-editor-github-signing
    └── Client ID: 1335db74-9168-463d-b6de-940d8e9ad742

GitHub repo: RisePeopleInc/rise-md-editor
├── Environment: rise-md-editor-signing (no protection rules currently)
└── Secrets: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_SUBSCRIPTION_ID
```

Two key invariants:

1. **No long-lived secrets on the runner.** The Entra app registration has no client secret. The runner mints a fresh OIDC token per job; Azure exchanges it for a short-lived access token via the federated credential trust. The three GitHub secrets above are publicly-visible identifiers, not credentials.

2. **Role is scoped to the cert profile, not the account or subscription.** Compromising the app registration only lets an attacker sign through `rise-md-editor-public` — not the entire Artifact Signing account, not other Azure resources.

## Phase 1 — Azure resources

### 1.1 Resource group

Top portal search → **Resource groups** → **+ Create**.

| Field | Value |
| --- | --- |
| Subscription | _Rise's pay-as-you-go subscription_ |
| Resource group name | `rg-rise-md-editor-signing` |
| Region | Canada Central |

Region here is metadata only — the resource group is just an organizational container for billing and cleanup.

### 1.2 Artifact Signing account

Top portal search → **Artifact Signing accounts** (or **Trusted Signing accounts** in stale portal labels) → **+ Create**.

| Field | Value |
| --- | --- |
| Subscription | _same_ |
| Resource group | `rg-rise-md-editor-signing` |
| Account name | `rise-md-editor-signing` |
| Region | **East US** |
| Pricing tier | **Basic** ($9.99/month flat) |

**Region note**: as of 2026-05, Artifact Signing wasn't generally available in Canada Central despite the resource group being there. East US is the closest GA region. The cross-region routing is transparent in practice (signing requests are small and infrequent during a release build).

The account exposes an endpoint URI — for East US, it's `https://eus.codesigning.azure.net/`. Region code prefix follows the standard Azure region code list (`eus` = East US, `wus2` = West US 2, etc.). Find the actual value at any time via Azure portal → account's Overview → JSON View → `properties.accountUri`.

### 1.3 Identity validation (slow step — kick off first)

This is the part that requires Microsoft to vet your organization. **Submit it before doing anything else** because it takes 1–7 business days.

On the Artifact Signing account → **Identity validation** → **+ New identity validation**.

Choose **Public Trust** (the option that makes Windows SmartScreen accept the resulting cert without warnings).

Fill in the form — every field must match the org's DUNS record character-for-character:

| Field | Value |
| --- | --- |
| Display name | `Rise People Inc.` (appears in cert subject CN) |
| Country / state / city / postal code | from Rise's DUNS record |
| Street address | from DUNS |
| DUNS number | Rise's D-U-N-S®. Look up at [dnb.com/duns/lookup](https://www.dnb.com/duns/lookup.html) |
| Primary contact | a real Rise employee reachable at the phone on the DUNS record |
| Website URL | `https://risepeople.com` |

**Submit**. Microsoft validates over 1–7 business days. They may also request additional documents — for Rise's submission they asked for a screenshot of the company website showing the registered address (since the GoDaddy whois was masked by privacy proxy). See [the appendix below](#identity-validation-document-tips) for what worked.

While waiting, you may need to grant yourself the **Trusted Signing Identity Verifier** role on the Artifact Signing account (Access control (IAM) → Add role assignment) before the portal will let you create or update identity validations. Subscription Owner doesn't automatically include data-plane permissions for this service.

### 1.4 Certificate profile

Blocked on 1.3 completing. Once the identity validation shows **Completed**:

On the Artifact Signing account → **Certificate profiles** → **+ Create**.

| Field | Value |
| --- | --- |
| Identity validation | _select the completed one from 1.3_ |
| Profile name | `rise-md-editor-public` |
| Profile type | **Public Trust** |
| Include city / state / postal / street in subject | Optional; toggle on if desired |

After provisioning (~30 sec), the profile shows up under the account's Certificate profiles list with Status **Active** and a thumbprint. The current cert version has a 3-day expiry — Microsoft auto-rotates the cert profile's underlying cert and you'll always be signing with a fresh one; what matters is that the profile keeps issuing new ones.

## Phase 2 — Authentication

### 2.1 Entra app registration

Microsoft Entra ID → **App registrations** → **+ New registration**.

| Field | Value |
| --- | --- |
| Name | `rise-md-editor-github-signing` |
| Supported account types | **Accounts in this organizational directory only** (single tenant) |
| Redirect URI | _leave blank_ |

After creation, capture from the **Overview** page:

- **Application (client) ID**: `1335db74-9168-463d-b6de-940d8e9ad742`
- **Directory (tenant) ID**: `0123a73c-a400-44e5-8960-15337cf2e8f0`

### 2.2 Federated credential for GitHub Actions OIDC

On the same app registration → **Certificates & secrets** → **Federated credentials** → **+ Add credential**.

| Field | Value |
| --- | --- |
| Federated credential scenario | **GitHub Actions deploying Azure resources** |
| Organization | `RisePeopleInc` |
| Repository | `rise-md-editor` |
| Entity type | **Environment** |
| GitHub environment name | `rise-md-editor-signing` |
| Name (display label) | `github-signing-environment` |

The resulting trust says: "GitHub workflow runs targeting environment `rise-md-editor-signing` in `RisePeopleInc/rise-md-editor` may mint OIDC tokens that this app registration will accept."

If you need to support additional trigger shapes (e.g. a workflow_dispatch that doesn't go through an environment), add a second federated credential matching a different entity type (e.g. `Branch` with value `main`, or `Pull request`). Each entity-type/value pair needs its own federated credential — there's no wildcard support in the subject string.

### 2.3 Role assignment on the certificate profile

The data-plane permission that lets the app registration call into the signing service. **Scope to the cert profile, not the whole account**, for least privilege.

Navigate to the **certificate profile** (not the account):

Artifact Signing account → Certificate profiles → click `rise-md-editor-public` → **Access control (IAM)** → **+ Add** → **Add role assignment**.

| Tab | Field | Value |
| --- | --- | --- |
| Role | _search and select_ | **Trusted Signing Certificate Profile Signer** |
| Members | Assign access to | User, group, or service principal |
| Members | + Select members | `rise-md-editor-github-signing` |

Review + assign. Propagation takes ~30 seconds; in rare cases up to 5 minutes.

### 2.4 GitHub environment

Repository → **Settings** → **Environments** → **New environment**.

| Field | Value |
| --- | --- |
| Name | `rise-md-editor-signing` (must exactly match 2.2's GitHub environment name) |

**Optional deployment protection rules** (not currently configured):

- **Required reviewers**: leave empty — adds friction to every tag push.
- **Deployment branches and tags**: could restrict to `v*` tags only, so workflow_dispatch from other branches can't sign. Not currently set; if signing-access scope tightens in the future, add this.

## Phase 3 — Repository configuration

### 3.1 Repository secrets

Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add three (these are public identifiers, configured as secrets only to keep them out of fork logs and PR transcripts):

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | `0123a73c-a400-44e5-8960-15337cf2e8f0` |
| `AZURE_CLIENT_ID` | `1335db74-9168-463d-b6de-940d8e9ad742` |
| `AZURE_SUBSCRIPTION_ID` | `a1471a7e-eaf3-4a3b-adfc-ae05298698e1` |

### 3.2 Workflow + sign callback

These are already in the repo from [RAISE-58](https://risepeople.atlassian.net/browse/RAISE-58):

- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — the `build-win` job declares `environment: rise-md-editor-signing`, requests `id-token: write` permission, installs .NET 8, installs the `Microsoft.Trusted.Signing.Client` NuGet package, writes a metadata JSON file, calls `azure/login@v2` (OIDC exchange), runs `npm run build:win`, and post-build runs `Get-AuthenticodeSignature` to verify the installer is signed.
- [`scripts/sign-windows.cjs`](../scripts/sign-windows.cjs) — the electron-builder sign callback. Reads `AZURE_ARTIFACT_SIGNING_DLIB_PATH` and `AZURE_ARTIFACT_SIGNING_METADATA_PATH` env vars (set by the workflow steps above), shells out to `signtool.exe` with `/dlib` + `/dmdf`. Skips with a warning if env vars aren't set (local `npm run build:win` without Azure auth).
- [`electron-builder.yml`](../electron-builder.yml) — the `win.signtoolOptions.sign` field points at the callback.

### 3.3 Non-secret config (hardcoded in the workflow)

Lives in the workflow YAML, not in secrets:

| | |
| --- | --- |
| Endpoint URI | `https://eus.codesigning.azure.net/` |
| Account name | `rise-md-editor-signing` |
| Cert profile name | `rise-md-editor-public` |

If any of these change (region migration, account rename, cert profile rotation), update the metadata JSON written by the **Write Artifact Signing metadata** workflow step.

## Verification

After everything's wired up, kick off a `workflow_dispatch` run on any branch and watch the `build-win` job's logs. Key checkpoints in order:

1. **Set up .NET** completes (any .NET 8 SDK).
2. **Install Artifact Signing dlib** prints `Dlib path: <runner-temp>/artifact-signing/.../Azure.CodeSigning.Dlib.dll`. Failure here usually means the NuGet package version was bumped and removed — check [NuGet.org/packages/Microsoft.Trusted.Signing.Client](https://www.nuget.org/packages/Microsoft.Trusted.Signing.Client) for the latest stable version.
3. **Write Artifact Signing metadata** prints `Metadata path: <runner-temp>/artifact-signing-metadata.json`.
4. **Azure login (OIDC)** succeeds. Failure with `AADSTS70021` ("No matching federated identity record found") means the federated credential subject doesn't match — go back to Phase 2.2 and verify the entity type and environment name.
5. **Build & sign Windows** runs the normal electron-builder build. Look for repeated `Successfully signed` lines from signtool (one per `.exe`).
6. **Verify signature on the installer** prints `Signer: CN=Rise People Inc., O=Rise People Inc., L=Burnaby, S=British Columbia, C=CA` and `Status: Valid`. If `NotSigned`, the dlib swallowed an error — scroll back to the build step's output for signtool's diagnostic message.

Then on a Windows machine (clean VM ideally), right-click the downloaded installer → **Properties** → **Digital Signatures** → **Details**. Confirm:

- Signer: **Rise People Inc.**
- Issuer: chains to a Microsoft trusted root (e.g. `Microsoft Identity Verification Root Certificate Authority 2020`)
- Status: **This digital signature is OK**
- Timestamp: signed by `http://timestamp.acs.microsoft.com`

Double-click to install — **no "Unknown publisher" warning** expected. SmartScreen may still warn based on the binary's download reputation for the first dozens of installs of a brand-new version; that's separate from the unknown-publisher gate and fades with usage.

## Maintenance

### Cert profile rotation

The cert profile's underlying cert is auto-rotated by Microsoft every ~3 days (visible in the portal as a new cert version with a fresh thumbprint). **No action required** — the build picks up whichever cert is current at signing time.

### Identity validation re-vetting

Microsoft re-validates the org behind a Public Trust identity validation **annually**. The portal will surface a re-validation request 30–60 days before expiry. The flow is the same shape as the initial submission; have the DUNS record up to date.

### Secret rotation

The three repo secrets (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID`) are public identifiers and don't rotate. The actual credential is the OIDC token GitHub mints per-job, which is short-lived and per-run.

If the app registration is compromised, rotate it: create a new Entra app registration with the same federated-credential and role-assignment setup, update `AZURE_CLIENT_ID`, delete the old registration.

### Disabling signing temporarily

If you need a build that intentionally skips signing (debugging, signed-binary issues, etc.):

- **From the workflow side**: delete one of the env-var-setting steps (Install Artifact Signing dlib / Write Artifact Signing metadata). The sign callback in `scripts/sign-windows.cjs` checks for both env vars and falls back to no-op skip with a warning.
- **Locally**: `npm run build:win` from your laptop without Azure auth env vars produces unsigned binaries by default (same path as the no-op skip).

## Troubleshooting

### `AADSTS70021: No matching federated identity record found`

Cause: the federated credential's entity-type / subject doesn't match the GitHub OIDC token's `sub` claim.

Fix: in Entra → app registration → Federated credentials → check the credential's Subject identifier. For environment-scoped:

```
repo:RisePeopleInc/rise-md-editor:environment:rise-md-editor-signing
```

Then in the workflow, confirm the job declares `environment: rise-md-editor-signing` _exactly_. Capitalization matters.

### `The signer's certificate is not valid for signing`

Usually a role-assignment timing issue. Roles can take up to 5 minutes to propagate. Wait, then retry.

If still failing, check the cert profile is Active (Azure portal → Artifact Signing account → Certificate profiles → status column).

### `signtool: error 0x80070522` ("client does not possess required privilege")

The runner can't write to wherever signtool's temp dir is. Usually a transient runner issue — re-run the workflow.

### Signature shows in Get-AuthenticodeSignature but SmartScreen still warns

Two flavors of SmartScreen warning:

1. **"Unknown publisher"** — fixed by signing. If this still appears post-signing, the signature is broken; check `Get-AuthenticodeSignature`.
2. **"Windows protected your PC"** — reputation-based, even for properly-signed binaries. New binary versions need to build download reputation. Clears after ~50–100 unique installs. Microsoft's reputation database is opaque; there's no way to fast-track.

### NuGet install hangs or fails

Try pinning to a slightly older `Microsoft.Trusted.Signing.Client` version in the workflow step. The workflow pins via `$packageVersion = '...'` — bump in tandem with explicit testing.

## Appendix: Identity validation document tips

Microsoft's identity validation is the slowest part of the setup (~1–7 business days). For Rise's submission, the initial form was accepted but Microsoft followed up requesting one of:

1. Domain ownership records (Whois)
2. Domain purchase invoices
3. **Website showing name, address, contact info** ← we used this
4. Assignment letter from an authorized representative

**Option 3 was the path of least resistance**: a PDF screenshot of `risepeople.com/contact` and `risepeople.com/privacy` showing the registered Burnaby BC address in the footer. Sent via the portal upload form. Approved within a business day.

Notes:

- Whois (Option 1) didn't work for Rise because GoDaddy's privacy proxy hides the registrant. Disabling the proxy temporarily would have worked but exposes the address publicly.
- The registered website must be operational and contain the address. A landing page with just a logo wouldn't satisfy.
- If Rise's registered address ever changes, the identity validation will need to be re-submitted with the new address — and the cert profile's subject CN will pick up the new value at the next cert rotation.
