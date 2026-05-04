import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * One-shot user-data migration after the
 * `raise-editor` → `rise-md-editor` rename
 * ([RAISE-43](https://risepeople.atlassian.net/browse/RAISE-43)).
 *
 * `app.getPath('userData')` is derived from the package.json `name`
 * field. Renaming `raise-editor` → `rise-md-editor` in package.json
 * moved the userData directory:
 *
 *   - macOS: `~/Library/Application Support/raise-editor/`
 *           → `~/Library/Application Support/Rise MD Editor/`
 *   - Windows: `%APPDATA%\raise-editor\`
 *           → `%APPDATA%\Rise MD Editor\`
 *   - Linux: `~/.config/raise-editor/`
 *           → `~/.config/Rise MD Editor/`
 *
 * Without migration, every user who updates loses their settings,
 * recent files, last-opened folder, theme preference, and any other
 * persisted state. The first launch on the renamed binary would
 * present a fresh empty editor — clearly user-hostile for a rename
 * that's mechanical from the user's perspective.
 *
 * **Strategy** — at startup, before any state-reading code runs,
 * check whether the OLD path exists, the NEW path doesn't (or is
 * empty), and the OLD path actually has data. If so, copy the OLD
 * contents into the NEW path and leave the OLD path in place
 * (read-only from then on, never re-read after the copy). The OLD
 * path stays so a user who downgrades to a pre-rename build still
 * finds their data; the NEW path is the source of truth going
 * forward.
 *
 * **Idempotency** — once the NEW path has any content (the result
 * of a previous successful migration OR new files written after the
 * user has been running on the renamed binary for a while), the
 * function is a no-op. Won't clobber freshly-written state with a
 * stale snapshot from the OLD path.
 *
 * **Error handling** — any error during the copy is logged and
 * swallowed. Failure mode: the user gets the fresh-empty experience
 * the rename would have given them anyway. We never ABORT the app
 * launch over this; missing user state is recoverable, app failing
 * to launch is not.
 *
 * **Old name** is hard-coded as `raise-editor`. If we ever rename
 * again, add the new old-name to the array below and the migration
 * runs through the chain — `raise-editor` → `rise-md-editor` →
 * future name. Each old path tried in order.
 */

const PRIOR_USER_DATA_NAMES = ['raise-editor'];

/**
 * Resolve the user-data path for a given app name. Mirrors
 * Electron's own derivation (`app.getPath('userData')`) but for an
 * arbitrary name. Platform-specific paths follow the Electron
 * convention: macOS uses `Application Support`, Windows uses
 * `%APPDATA%`, Linux uses `XDG_CONFIG_HOME` or `~/.config`.
 */
function userDataPathFor(appName: string): string {
  // Electron's `app.getPath('appData')` returns the platform's
  // standard "application data" root WITHOUT the per-app suffix.
  // Joining the app name onto it gives the per-app userData path.
  // This avoids re-implementing the platform dispatch ourselves.
  const appDataRoot = app.getPath('appData');
  return path.join(appDataRoot, appName);
}

/**
 * Check whether a directory has at least one entry. We treat a
 * missing dir or an empty dir as "no migration target", so a fresh
 * NEW path (or one created but never written to) doesn't block the
 * copy from running.
 */
async function hasContents(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function migrateUserDataIfNeeded(): Promise<void> {
  const newPath = app.getPath('userData');
  const newHasContents = await hasContents(newPath).catch(() => false);
  // If the new path already has data, we've either already
  // migrated OR the user has been writing fresh state since the
  // rename. Either way, leave it alone — clobbering would lose
  // current state.
  if (newHasContents) return;

  for (const oldName of PRIOR_USER_DATA_NAMES) {
    const oldPath = userDataPathFor(oldName);
    if (oldPath === newPath) continue; // unchanged in this rename
    let oldHasContents: boolean;
    try {
      oldHasContents = await hasContents(oldPath);
    } catch (err) {
      // readdir failing for reasons other than ENOENT (permissions,
      // symlink loop, etc.) — log and skip this candidate.
      console.warn(
        `[userDataMigration] Could not read prior path ${oldPath}:`,
        err,
      );
      continue;
    }
    if (!oldHasContents) continue;

    console.log(
      `[userDataMigration] Migrating user data from ${oldPath} → ${newPath}`,
    );
    try {
      await fs.mkdir(newPath, { recursive: true });
      // `fs.cp` recursively copies the directory tree, preserving
      // file mode bits and timestamps. `errorOnExist: false` lets
      // it overwrite — but we already gated on `newHasContents`,
      // so the new path is empty and there's nothing to overwrite.
      await fs.cp(oldPath, newPath, {
        recursive: true,
        errorOnExist: false,
        force: true,
      });
      console.log(
        `[userDataMigration] Migration complete. Old path retained at ${oldPath} for downgrade-safety.`,
      );
      // Stop after the first successful migration — chains farther
      // back wouldn't apply once we have data.
      return;
    } catch (err) {
      // Migration failure is non-fatal: we want the app to launch
      // with empty state rather than refuse to start. Log loud so
      // a debugging user can see what went wrong.
      console.error(
        `[userDataMigration] Failed to migrate from ${oldPath}:`,
        err,
      );
      // Don't continue to older candidates after a failed attempt;
      // the failure mode is the same (user-visible empty state)
      // regardless of which prior path we tried.
      return;
    }
  }
}
