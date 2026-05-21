# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in Rise MD Editor — anything
that could compromise a user's machine, their data, their workspace files,
or the integrity of the auto-update channel — please report it privately so
we can address it before public disclosure.

### Preferred channel

Open a [private security advisory][advisory] on GitHub. Advisories are
visible only to repository maintainers until published, support attaching
proof-of-concept code, and let us coordinate a patch + release before any
public disclosure.

- <https://github.com/RisePeopleInc/rise-md-editor/security/advisories/new>

### Backup channel

If GitHub advisories aren't accessible to you, email:

**`security@risepeople.com`**

Use a clear subject line — e.g. "Security: Rise MD Editor — <one-line
summary>" — and include the same details listed below.

### What to include

A useful report has:

- **What's affected** — version (visible in `Help → About`), OS, build
  channel (production / dev build).
- **Reproduction steps** — the minimum sequence needed to trigger the issue.
- **Impact** — what an attacker could do; what data or capability is at risk.
- **Mitigations you've found** — workarounds, related CVEs, references.

Proof-of-concept code is welcome but not required.

## What to expect

- **Acknowledgement** within five business days of receipt.
- **Initial triage** (severity assessment, ownership) within ten business
  days.
- **Fix timeline** depends on severity. Critical issues that put users at
  immediate risk are prioritized; lower-severity issues are scheduled into
  normal release work.
- **Coordinated disclosure** — we'll work with you on the public disclosure
  timing. A typical window is up to 90 days from acknowledgement, sooner if
  a fix ships first.
- **Credit** — reporters are credited in the GitHub advisory and the
  CHANGELOG entry for the fix unless you ask to remain anonymous.

## Scope

In scope:

- The Rise MD Editor application itself — main process, renderer, preload,
  build / signing / packaging pipeline.
- The auto-update channel and its integrity guarantees.
- IPC boundary issues (renderer escaping the sandbox, privilege escalation
  via IPC channels, etc.).
- The custom `rise-md-asset://` protocol and its allowed-roots gate.

Out of scope:

- Bugs in upstream dependencies (Electron, Chromium, Node, Milkdown, Monaco,
  markdown-it, etc.). Report those to the relevant upstream project.
  We'll absorb upstream fixes via dependency updates as they're released.
- Social-engineering issues that don't have a technical vector inside the
  app.
- Denial-of-service against a single local user's own machine (e.g. an
  intentionally pathological markdown file that hangs the renderer on
  *their own* computer) — interesting bug reports, but not security issues.

## Out-of-band signing

The published binaries are signed:

- macOS: signed and notarized by Apple Developer ID `Rise People Inc.`.
- Windows: signed via Azure Artifact Signing (Microsoft-rooted trust chain),
  publisher `Rise People Inc.`.

If you ever encounter a Rise MD Editor binary that doesn't validate against
those publisher identities, treat it as suspicious and report it.

[advisory]: https://github.com/RisePeopleInc/rise-md-editor/security/advisories/new
