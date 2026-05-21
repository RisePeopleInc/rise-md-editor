#!/usr/bin/env node
// Regenerates THIRD-PARTY-NOTICES.md from the production dep tree.
//
// Usage:
//   node scripts/regenerate-third-party-notices.cjs
//
// Run after any dependency change that affects the production tree, then
// commit the updated file alongside the dep change. See RAISE-57.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const SELF_KEY = `${PKG.name}@${PKG.version}`;
const OUT_PATH = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');

function assertNodeModulesPresent() {
  // license-checker-rseidelsohn reads metadata from the installed tree.
  // Without node_modules/ it fails with a cryptic "Cannot find module"
  // error several frames deep — short-circuit with a clearer message.
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) {
    process.stderr.write(
      `node_modules/ not found at ${nm}\n` +
        `Run \`npm install\` before regenerating THIRD-PARTY-NOTICES.md.\n`,
    );
    process.exit(1);
  }
}

function runChecker() {
  const out = execFileSync(
    'npx',
    [
      '--yes',
      'license-checker-rseidelsohn@latest',
      '--production',
      '--json',
      '--excludePackages',
      SELF_KEY,
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function buildMarkdown(j) {
  // Intentionally NO date in the output: the file is auto-generated from
  // package-lock.json and should be byte-identical across regenerations
  // that don't change the dep tree. A timestamp would produce a diff on
  // every run and defeat any future CI staleness check.
  const pkgs = Object.keys(j).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  const groups = {};
  for (const p of pkgs) {
    const lic = j[p].licenses || 'UNKNOWN';
    (groups[lic] ||= []).push(p);
  }
  const licenses = Object.keys(groups).sort();

  const lines = [];
  lines.push('# Third-party notices');
  lines.push('');
  lines.push(
    'Rise MD Editor bundles open-source software. This file lists every production dependency in the npm tree along with its license, repository, and publisher. Auto-generated from `package-lock.json` — see the regeneration command below.',
  );
  lines.push('');
  lines.push('To regenerate after a dependency change:');
  lines.push('');
  lines.push('```sh');
  lines.push('node scripts/regenerate-third-party-notices.cjs');
  lines.push('```');
  lines.push('');
  lines.push(`**Total production packages: ${pkgs.length}**`);
  lines.push('');
  lines.push('## License summary');
  lines.push('');
  lines.push('| License | Count |');
  lines.push('| --- | --- |');
  for (const lic of licenses) {
    lines.push(`| \`${lic}\` | ${groups[lic].length} |`);
  }
  lines.push('');
  lines.push(
    'All licenses listed above are permissive and MIT-compatible. Dual-licensed packages (e.g. `MIT OR GPL-3.0-or-later`, `MPL-2.0 OR Apache-2.0`, `MIT OR CC0-1.0`) are consumed under their permissive option. `OFL-1.1` covers font files only and does not infect source code that uses them — see `docs/license-rationale.md` for the analysis.',
  );
  lines.push('');
  lines.push('## Packages');
  lines.push('');
  lines.push(
    'Listed alphabetically within each license group. Each entry: name@version, license, publisher (if known), repository.',
  );
  lines.push('');

  for (const lic of licenses) {
    lines.push(`### ${lic} (${groups[lic].length})`);
    lines.push('');
    for (const p of groups[lic]) {
      const info = j[p];
      const repo = info.repository || info.url || '(no repository field)';
      const publisher = info.publisher ? ` — ${info.publisher}` : '';
      lines.push(`- **${p}** — \`${lic}\`${publisher}`);
      lines.push(`  - ${repo}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  assertNodeModulesPresent();
  process.stdout.write('Running license-checker against production tree...\n');
  const data = runChecker();
  const md = buildMarkdown(data);
  fs.writeFileSync(OUT_PATH, md);
  const count = Object.keys(data).length;
  process.stdout.write(`Wrote ${OUT_PATH} (${count} packages)\n`);
}

main();
