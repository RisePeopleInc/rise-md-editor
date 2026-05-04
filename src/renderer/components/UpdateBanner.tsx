import type { UpdateStatus } from '../env';

interface UpdateBannerProps {
  status: UpdateStatus;
  version: string | undefined;
  onInstall: () => void;
  onDismiss: () => void;
}

/**
 * RAISE-12: non-modal "update available / ready" banner pinned above
 * the tab bar (same slot as the workspace banner). Two visible states:
 *
 *  - `downloading`: passive "A new version is downloading…" — no action,
 *    just keeps the user informed. Doesn't get a Dismiss button because
 *    the user can't really do anything meaningful with this state.
 *  - `downloaded`: actionable "A new version of Rise MD Editor is available.
 *    Restart to update." with **Restart** + **Later**. Clicking Later
 *    just hides the banner — the update is already on disk and applies
 *    next time the app quits via the user's normal exit path.
 *
 * Other statuses (`checking`, `available`, `not-available`, `error`,
 * `idle`) don't render the banner. The hook exposes them for debugging
 * but the user never sees them.
 */
export function UpdateBanner({
  status,
  version,
  onInstall,
  onDismiss,
}: UpdateBannerProps) {
  if (status === 'downloading') {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-3 border-b border-stroke bg-interaction-tint px-4 py-1.5 text-xs text-strong"
      >
        <span className="min-w-0 truncate">
          {version
            ? `Downloading Rise MD Editor ${version}…`
            : 'Downloading a new version of Rise MD Editor…'}
        </span>
      </div>
    );
  }

  if (status === 'downloaded') {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-3 border-b border-stroke bg-interaction-tint px-4 py-1.5 text-xs text-strong"
      >
        <span className="min-w-0 truncate">
          {version
            ? `Rise MD Editor ${version} is ready. Restart to update.`
            : 'A new version of Rise MD Editor is ready. Restart to update.'}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onInstall}
            className="rounded bg-interaction px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-interaction-hover active:bg-interaction-active"
          >
            Restart
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded px-2 py-0.5 text-[11px] text-secondary hover:bg-elevated hover:text-strong"
          >
            Later
          </button>
        </div>
      </div>
    );
  }

  return null;
}
