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
      className="flex items-center justify-between gap-3 border-b border-stroke bg-interaction-tint px-4 py-1.5 text-xs text-strong"
    >
      <span className="min-w-0 truncate">{message}</span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onPrimary}
          className="rounded bg-interaction px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-interaction-hover active:bg-interaction-active"
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-[11px] text-secondary hover:bg-elevated hover:text-strong"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
