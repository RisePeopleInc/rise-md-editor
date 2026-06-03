import { accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * RAISE-19: install trigger lives outside this module. The `update:install`
 * IPC handler is owned by `src/main/index.ts` because it needs to coordinate
 * with the main window's dirty-tab close prompt — if any tab is dirty, the
 * install runs only after the user has resolved the prompt (Save All /
 * Review / Discard). Re-exporting the underlying call lets that handler
 * fire the install without needing a back-reference to electron-updater.
 *
 * `isSilent: false` → show the installer UI (Windows). `isForceRunAfter: true`
 * → relaunch into the new version after install completes. These match the
 * RAISE-12 wiring; do not change them without a release-process review.
 */
export function quitAndInstallNow(): void {
  autoUpdater.quitAndInstall(false, true);
}

/**
 * RAISE-12: auto-update wiring.
 *
 * Flow:
 *   1. App launches. If packaged (not dev), check GitHub Releases for
 *      a newer version.
 *   2. If found, electron-updater starts the download in the background.
 *      Renderer is notified via `update:available` so it can show a
 *      non-intrusive "A new version is downloading…" banner.
 *   3. When the download completes, renderer is notified via
 *      `update:downloaded`. The banner flips to "Restart to update"
 *      with a button.
 *   4. User clicks Restart → renderer fires `update:install` → main
 *      calls `autoUpdater.quitAndInstall()`. The user is never forced.
 *
 * Skipping in dev / unpackaged builds is important — autoUpdater would
 * otherwise try to fetch GitHub Releases artifacts that don't exist for
 * a `dev` version, and log noisy errors.
 */

export interface UpdateState {
  /** Most recent state seen from autoUpdater. */
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  /** Version string of the available update, if any (e.g. '0.2.0'). */
  version?: string;
  /** Last error message — surfaced in the renderer for debug; not auto-shown. */
  error?: string;
}

/**
 * RAISE-12 deferred the first launch check by 5s so it doesn't compete
 * with first-paint network and so the renderer has time to subscribe.
 * Named here so the periodic-check constant below has a peer to follow.
 */
const INITIAL_CHECK_DELAY_MS = 5_000;

/**
 * RAISE-21: re-check the GitHub Releases feed every 6 hours while the
 * app is running so users who keep the window open over weekends still
 * pick up security and correctness fixes. Tuned conservatively — the
 * download itself is bandwidth-cheap but the check is a real network
 * round-trip and the feed doesn't change that often. Bump down only if
 * a release cadence change makes 6h feel sluggish.
 */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastState: UpdateState = { status: 'idle' };

/**
 * RAISE-21: timer handle for the periodic re-check loop. Held at
 * module scope so the `before-quit` listener installed by
 * `initAutoUpdater` can clear it cleanly on quit (AC #2 — no orphaned
 * timers). `null` while no check loop is running (dev / unpackaged,
 * or post-teardown).
 */
let recheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * RAISE-21: gate that the periodic-check loop consults before firing
 * another `checkForUpdates()`. Skip when a download is already in
 * flight or finished so we don't duplicate the work the existing
 * event handlers are already driving (AC #5). Extracted as a pure
 * function so it's testable without touching electron-updater.
 */
export function shouldSkipPeriodicCheck(status: UpdateState['status']): boolean {
  return status === 'downloading' || status === 'downloaded';
}

/**
 * RAISE-90: decide whether this is a managed / per-machine install that
 * must NOT self-update. Pure so it's unit-testable without touching the
 * filesystem or electron — the runtime wrapper below feeds it the live
 * platform and an install-dir writability probe.
 *
 * The signal is "the directory the app runs from is not writable by the
 * current user." That's exactly the per-machine case: our MSI (RAISE-90)
 * installs to `Program Files` in the system context for Intune, so a
 * standard user can't write there. `electron-updater` (NSIS differential
 * update) can't rewrite the install in place under those conditions — it
 * would only ever surface an un-actionable "update available" banner while
 * fighting Intune, which now owns the version. So we skip update checks
 * entirely for this build.
 *
 * Scoped to Windows: the NSIS per-user build installs to a writable
 * `%LOCALAPPDATA%` location (stays self-updating), and macOS / Linux use
 * different update mechanisms whose writability semantics we don't want to
 * second-guess here — they always return false (keep updating).
 */
export function isManagedDeployment(
  platform: NodeJS.Platform,
  installDirWritable: boolean,
): boolean {
  if (platform !== 'win32') return false;
  return !installDirWritable;
}

/** Probe whether the directory containing the app executable is writable. */
function installDirIsWritable(): boolean {
  try {
    accessSync(dirname(app.getPath('exe')), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runtime convenience wrapper around {@link isManagedDeployment}. */
function isManagedInstall(): boolean {
  return isManagedDeployment(process.platform, installDirIsWritable());
}

/**
 * RAISE-19: read the most recent UpdateState from outside this module —
 * `src/main/index.ts` needs the pending version string for the dirty-tab
 * dialog copy ("Save changes before restarting to install Rise MD Editor
 * 0.2.0?"). Returns a defensive copy so callers can't mutate the cache.
 */
export function getLastUpdateState(): UpdateState {
  return { ...lastState };
}

function broadcast(state: UpdateState, window: BrowserWindow | null): void {
  lastState = state;
  if (!window || window.isDestroyed()) return;
  window.webContents.send('update:state', state);
}

/**
 * Wire the autoUpdater event handlers + kick off a check. Safe to call
 * multiple times — guards against double-registration. Pass the main
 * window so update events can be pushed to the renderer.
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // Auto-download is the default but make it explicit so the contract
  // is visible at the call site. Auto-install on quit stays off — we
  // want explicit user consent via the renderer banner.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    broadcast({ status: 'checking' }, getWindow());
  });

  autoUpdater.on('update-available', (info) => {
    broadcast({ status: 'available', version: info.version }, getWindow());
  });

  autoUpdater.on('update-not-available', () => {
    broadcast({ status: 'not-available' }, getWindow());
  });

  autoUpdater.on('download-progress', () => {
    // We don't surface progress percentage in the UI yet — too noisy.
    // The 'downloading' status keeps the banner saying "downloading…"
    // until the 'update-downloaded' event flips it to ready-to-install.
    if (lastState.status !== 'downloading') {
      broadcast({ status: 'downloading', version: lastState.version }, getWindow());
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ status: 'downloaded', version: info.version }, getWindow());
  });

  autoUpdater.on('error', (err) => {
    broadcast(
      { status: 'error', error: err instanceof Error ? err.message : String(err) },
      getWindow(),
    );
  });

  // Renderer asks "what's the latest you've heard?" on its hook init,
  // so a banner that was already triggered before the renderer mounted
  // (rare, but possible on slow machines) still shows up.
  ipcMain.handle('update:get-state', async (): Promise<UpdateState> => lastState);

  // RAISE-19: `update:install` is registered in `src/main/index.ts` so the
  // close handler there can intercept the install attempt, surface the
  // dirty-tab prompt with install-aware copy, and only fire `quitAndInstall`
  // after the user has resolved (or cancelled, in which case we leave the
  // banner intact so they can click Restart again later).

  // Skip the actual check in dev / unpackaged. autoUpdater would log a
  // benign error ("update info file not found") otherwise.
  if (!app.isPackaged) {
    broadcast({ status: 'idle' }, getWindow());
    return;
  }

  // RAISE-90: skip auto-update for a managed / per-machine install (the
  // MSI we ship for Intune deployment). Such installs live in Program
  // Files — not user-writable — so electron-updater can't self-update and
  // would only nag with un-actionable banners while fighting Intune, which
  // owns the version. IT pushes new versions through Intune supersedence.
  // The NSIS per-user build is writable and keeps auto-updating.
  if (isManagedInstall()) {
    broadcast({ status: 'idle' }, getWindow());
    return;
  }

  // Defer the first check by a few seconds so it doesn't compete with
  // the window's first-paint network and the renderer has time to
  // subscribe to the 'update:state' channel.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      broadcast(
        { status: 'error', error: err instanceof Error ? err.message : String(err) },
        getWindow(),
      );
    });
  }, INITIAL_CHECK_DELAY_MS);

  // RAISE-21: periodic re-check for long-running sessions. The launch
  // check above only fires once; without this loop, a user who keeps
  // the app open over the weekend misses any release that ships in
  // the meantime. Failures here are deliberately silent (AC #3) —
  // intermittent offline / DNS hiccups during a long session aren't a
  // useful signal to surface in the banner, and the next tick will
  // recover on its own. Mid-flight downloads are gated out (AC #5)
  // via `shouldSkipPeriodicCheck` so we don't fight the existing
  // download / installed flows. If a check does find an update, the
  // existing `update-available` / `update-downloaded` event handlers
  // flow into the same `broadcast()` path the launch check uses, so
  // the renderer banner appears without any extra wiring (AC #4).
  recheckTimer = setInterval(() => {
    if (shouldSkipPeriodicCheck(lastState.status)) return;
    autoUpdater.checkForUpdates().catch(() => {
      // Silent — periodic check failures shouldn't nag.
    });
  }, RECHECK_INTERVAL_MS);

  // RAISE-21: clear the interval on app quit so we don't leak the
  // timer (AC #2). Scoped to this module — the `before-quit` listener
  // in `src/main/index.ts` owns its own `quitting` flag and we don't
  // want to entangle the two. Electron permits multiple listeners on
  // the same event; both fire on quit.
  app.on('before-quit', () => {
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
  });
}
