interface WorkspaceBannerProps {
  message: string;
  primaryLabel: string;
  onPrimary: () => void;
  onDismiss: () => void;
}

/**
 * A non-modal info banner pinned above the tab bar. Used for workspace-
 * level prompts (e.g. "this folder doesn't have a CLAUDE.md") that the
 * user can either act on or dismiss.
 *
 * Subtle blue palette so it reads as informational rather than as an
 * error / warning.
 */
export function WorkspaceBanner({
  message,
  primaryLabel,
  onPrimary,
  onDismiss,
}: WorkspaceBannerProps) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-sky-900/60 bg-sky-950/70 px-4 py-1.5 text-xs text-sky-100"
    >
      <span className="min-w-0 truncate">{message}</span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onPrimary}
          className="rounded bg-sky-500 px-2 py-0.5 text-[11px] font-medium text-sky-50 hover:bg-sky-400"
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-900/60 hover:text-sky-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
