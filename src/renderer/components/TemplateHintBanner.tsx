interface TemplateHintBannerProps {
  onDismiss: () => void;
}

/**
 * Per-tab hint shown above the editor when a file was just created from
 * a template. Reminds the user to fill in the placeholder text. Lighter
 * styling than the workspace banner — it's a one-tab nudge, not a
 * workspace-level call to action.
 */
export function TemplateHintBanner({ onDismiss }: TemplateHintBannerProps) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/70 px-4 py-1 text-[11px] text-slate-300"
    >
      <span className="min-w-0 truncate">
        Created from template. Replace the placeholder text with your own
        content.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss template hint"
        className="shrink-0 rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
      >
        ×
      </button>
    </div>
  );
}
