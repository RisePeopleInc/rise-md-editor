// RAISE-58: Windows code-signing callback for electron-builder via
// Azure Trusted Signing. Invoked by electron-builder's
// `signtoolOptions.sign` for every `.exe` that needs signing during
// the build (the unpacked app exe, helper exes like `elevate.exe` and
// `__uninstaller-nsis-*.exe`, and the final NSIS installer).
//
// Flow:
//   1. CI workflow logs into Azure via OIDC federation (no static
//      service-principal secret). `DefaultAzureCredential` picks up
//      the OIDC token automatically from the runner environment.
//   2. CI workflow installs Microsoft's Trusted Signing client
//      (NuGet package `Microsoft.Trusted.Signing.Client`), which
//      contains `Azure.CodeSigning.Dlib.dll`. The workflow exports
//      the path via `AZURE_TRUSTED_SIGNING_DLIB_PATH`.
//   3. CI workflow writes a JSON metadata file pointing at the
//      account endpoint + cert profile, and exports the path via
//      `AZURE_TRUSTED_SIGNING_METADATA_PATH`.
//   4. This script shells out to `signtool.exe` (Windows SDK,
//      pre-installed on `windows-latest`) with `/dlib` + `/dmdf`,
//      which delegates the actual signing to the Azure-hosted HSM.
//
// Behavior when the env vars aren't set (local `npm run build:win`
// without Azure auth): log a clear "skipping" warning and return
// without signing. electron-builder will produce an unsigned `.exe`,
// which is fine for local smoke tests. The CI workflow has the env
// vars set so this branch only fires in dev.

const { execFileSync } = require('node:child_process');

/**
 * @param {{ path: string, hash?: string, isNest?: boolean, name?: string, site?: string }} configuration
 */
exports.default = async function sign(configuration) {
  const filePath = configuration.path;

  const dlibPath = process.env.AZURE_TRUSTED_SIGNING_DLIB_PATH;
  const metadataPath = process.env.AZURE_TRUSTED_SIGNING_METADATA_PATH;

  if (!dlibPath || !metadataPath) {
    // Local dev or any build where Azure auth isn't configured. Don't
    // throw — electron-builder treats a thrown sign callback as a hard
    // failure. Skipping cleanly produces an unsigned `.exe` (matching
    // the pre-RAISE-58 behavior on the same runner).
    console.warn(
      '[sign-windows] AZURE_TRUSTED_SIGNING_DLIB_PATH or _METADATA_PATH not set — skipping signing for',
      filePath,
    );
    return;
  }

  // signtool args:
  //   sign            — operation
  //   /v              — verbose output (handy for CI logs)
  //   /fd SHA256      — digest algorithm
  //   /tr <url>       — RFC 3161 timestamp authority. ACS endpoint
  //                     pairs with the Trusted Signing cert; using a
  //                     non-Microsoft timestamper here would attach a
  //                     valid timestamp but the cert chain wouldn't
  //                     match. Microsoft's docs are explicit about
  //                     this endpoint.
  //   /td SHA256      — timestamp digest algorithm
  //   /dlib <path>    — pluggable signing module — the Trusted Signing
  //                     dlib that calls into Azure for the actual
  //                     private-key operation.
  //   /dmdf <path>    — dlib metadata JSON: endpoint, account name,
  //                     cert profile name.
  //   <file>          — target to sign
  //
  // `execFileSync` (not `execSync`) so each arg is passed positionally
  // and we don't have to worry about quoting paths with spaces (e.g.
  // `Rise MD Editor-0.1.3-Setup.exe`).
  const args = [
    'sign',
    '/v',
    '/fd',
    'SHA256',
    '/tr',
    'http://timestamp.acs.microsoft.com',
    '/td',
    'SHA256',
    '/dlib',
    dlibPath,
    '/dmdf',
    metadataPath,
    filePath,
  ];

  try {
    execFileSync('signtool.exe', args, { stdio: 'inherit' });
  } catch (err) {
    // Re-throw so electron-builder marks the build as failed. The
    // stdout/stderr from signtool already went to inherit so the
    // log line above the throw is what diagnoses the failure.
    throw new Error(
      `signtool failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
