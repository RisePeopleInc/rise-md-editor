# Security policy

## Status

Rise MD Editor is provided **as-is, with no warranty** (see
[`LICENSE`](LICENSE)). The project does not run a formal security
program. There is no response SLA, no coordinated-disclosure process,
and **no bug bounty or similar compensation arrangement** — security
findings reported here are not in scope for any bounty.

## Reporting a vulnerability

If you find a security issue and would like to share it, you may email:

`security@risepeople.com`

This is a best-effort courtesy channel only. You should not expect an
acknowledgement, a triage timeline, or a response of any kind. Treat the
email as a one-way notification, not as an open ticket.

If you do report, include:

- Version (visible in `Help → About`), OS, build channel.
- Reproduction steps with enough detail to confirm the issue.
- A short statement of impact.

Please don't publicly disclose exploit details in a way that puts users
at immediate risk before a fix has had a reasonable chance to ship.

## Out-of-band signing

The published binaries are signed:

- macOS: signed and notarized by Apple Developer ID `Rise People Inc.`.
- Windows: signed via Azure Artifact Signing (Microsoft-rooted trust
  chain), publisher `Rise People Inc.`.

If you ever encounter a Rise MD Editor binary that doesn't validate
against those publisher identities, treat it as suspicious.
