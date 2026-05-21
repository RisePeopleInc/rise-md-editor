// Unit test for the periodic-check gate (RAISE-21).
//
// The autoUpdater module imports `electron` and `electron-updater`,
// which both pull in native bindings that don't load under a plain
// Node vitest run. We stub both with `vi.mock` so we can import the
// pure `shouldSkipPeriodicCheck` predicate without bringing in the
// full Electron runtime. The gate itself is a tiny pure function —
// the value of the test is locking down the exact set of statuses
// that suppress the 6-hourly recheck loop, so a future status added
// to `UpdateState['status']` doesn't accidentally start firing extra
// network requests on top of an in-flight download.
import { describe, expect, it, vi } from 'vitest';

// electron + electron-updater are imported at module load time by
// autoUpdater.ts. The mocks only need to satisfy the surface the
// import-time code touches; the actual handlers attach inside
// `initAutoUpdater`, which we don't call from this test.
vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  },
}));

import { shouldSkipPeriodicCheck } from '../autoUpdater';

describe('shouldSkipPeriodicCheck', () => {
  it('skips when a download is in flight', () => {
    // AC #5: do not duplicate the existing download flow.
    expect(shouldSkipPeriodicCheck('downloading')).toBe(true);
  });

  it('skips when an update has already been downloaded and is awaiting install', () => {
    // AC #5: the user already has the bits; firing another check
    // would risk redundant work and could re-fire the banner.
    expect(shouldSkipPeriodicCheck('downloaded')).toBe(true);
  });

  it('proceeds for all other update statuses', () => {
    // These are all states where a periodic check is either useful
    // (idle / not-available / available pre-download / error) or
    // already in the right phase (checking is a transient mid-call
    // state that resolves on its own).
    expect(shouldSkipPeriodicCheck('idle')).toBe(false);
    expect(shouldSkipPeriodicCheck('checking')).toBe(false);
    expect(shouldSkipPeriodicCheck('available')).toBe(false);
    expect(shouldSkipPeriodicCheck('not-available')).toBe(false);
    expect(shouldSkipPeriodicCheck('error')).toBe(false);
  });
});
