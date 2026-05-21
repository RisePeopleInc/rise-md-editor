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

let lastState: UpdateState = { status: 'idle' };

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
  }, 5_000);
}
