import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * RAISE-86: link popover for Edit (WYSIWYG) mode.
 *
 * When the caret lands inside a link mark — by plain click, arrow-key
 * navigation, or any other selection change — WysiwygEditor surfaces
 * this floating popover anchored to the link. It mirrors the existing
 * image-tooltip pattern in WysiwygEditor.tsx (viewport-fixed `<div>`
 * positioned from a `getBoundingClientRect`-derived screen point,
 * Rise design tokens, depth-1 shadow) so the two floating chrome
 * surfaces are visually consistent.
 *
 * The popover offers three controls — Open / Edit / Remove — plus the
 * link's URL and a muted one-line pro-tip about the modifier-click
 * shortcut. Cmd/Ctrl-click never reaches here: RAISE-87's capture-phase
 * mousedown handler stops that event before ProseMirror moves the
 * selection, so the selection-driven trigger never fires for a
 * modifier-click (the URL opens directly instead).
 *
 * The component is intentionally "dumb": it owns only its own
 * edit-mode input state. The actual ProseMirror mutations (open the
 * URL, replace the link mark, strip the mark) live in WysiwygEditor,
 * which has the editor instance — they're passed in as callbacks.
 */
export interface LinkPopoverProps {
  /** The link's `href` attribute (already protocol-qualified). */
  href: string;
  /** Viewport-fixed top-left anchor, in CSS px (left/top). */
  x: number;
  y: number;
  /** `window.api.platform` — drives the ⌘ vs Ctrl pro-tip wording. */
  platform: NodeJS.Platform;
  /**
   * RAISE-86: open directly in the inline edit field. Set by the
   * context menu's "Edit Link" route so right-click → Edit Link
   * surfaces the URL input immediately, matching the popover's own
   * Edit button.
   */
  initialEditing?: boolean;
  /** Open the URL in the system browser, then dismiss. */
  onOpen: () => void;
  /**
   * Apply an edited href to the link mark. Empty / blank input is
   * treated by the parent as a Remove (the popover passes the trimmed
   * value through unchanged; the decision lives in WysiwygEditor so
   * the range-selection logic stays in one place).
   */
  onEdit: (newHref: string) => void;
  /** Strip the link mark, keeping the visible text. */
  onRemove: () => void;
  /** Dismiss without acting (Escape, click-outside, etc.). */
  onDismiss: () => void;
}

export function LinkPopover({
  href,
  x,
  y,
  platform,
  initialEditing = false,
  onOpen,
  onEdit,
  onRemove,
  onDismiss,
}: LinkPopoverProps) {
  // Local edit-mode: when true the URL row is replaced by an <input>
  // + Apply / Cancel. Seeded from `initialEditing` (the context-menu
  // "Edit Link" route opens straight into the field) and reset
  // whenever the popover re-anchors to a new link (keyed on `href` so
  // navigating between adjacent links doesn't leave a stale field
  // open).
  const [editing, setEditing] = useState(initialEditing);
  const [draftHref, setDraftHref] = useState(href);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Re-sync the draft and collapse any open editor when the anchored
  // link changes. Without this, arrow-keying from one link straight
  // into another would keep the previous link's URL in the field.
  // Skip the very first run so an `initialEditing` open (context-menu
  // "Edit Link") isn't immediately collapsed on mount.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setEditing(false);
    setDraftHref(href);
  }, [href]);

  // Focus + select the input when entering edit mode so the user can
  // immediately overwrite or tweak the URL.
  useEffect(() => {
    if (!editing) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [editing]);

  const applyEdit = useCallback(() => {
    onEdit(draftHref.trim());
  }, [draftHref, onEdit]);

  const isMac = platform === 'darwin';
  const proTip = isMac
    ? 'Pro tip: ⌘-click to open the link directly in your browser.'
    : 'Pro tip: Ctrl+click to open the link directly in your browser.';

  return (
    <div
      ref={popoverRef}
      data-link-popover
      role="dialog"
      aria-label="Link actions"
      // Viewport-fixed so the screen coords from coordsAtPos line up.
      // The container scroll listener in WysiwygEditor dismisses the
      // popover on scroll, so drift isn't a concern.
      style={{ left: x, top: y }}
      className="fixed z-50 flex max-w-[360px] flex-col gap-2 rounded-[var(--rise-radius-card)] border border-stroke bg-app p-2.5 text-xs text-strong shadow-[var(--rise-shadow-depth-1)]"
      // Keep mousedowns inside the popover from bubbling to the
      // container's capture-phase handlers (which would otherwise treat
      // a button click as a click-outside or steal focus from the
      // input). The buttons still receive their own click events.
      onMouseDown={(e) => {
        // Don't block the URL input — it needs native focus / caret
        // placement on mousedown.
        if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
        e.stopPropagation();
      }}
    >
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={draftHref}
            aria-label="Link URL"
            onChange={(e) => setDraftHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                // First Escape backs out of edit mode rather than
                // dismissing the whole popover — less destructive.
                setEditing(false);
                setDraftHref(href);
              }
            }}
            className="min-w-0 flex-1 rounded border border-stroke bg-surface px-2 py-1 font-mono text-[11px] text-secondary focus:border-interaction focus:outline-none"
          />
          <button
            type="button"
            onClick={applyEdit}
            className="rounded bg-interaction px-2 py-1 text-[11px] font-semibold text-white hover:bg-interaction-hover active:bg-interaction-active"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraftHref(href);
            }}
            className="rounded px-2 py-1 text-[11px] text-muted hover:bg-elevated hover:text-strong"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="max-w-[28ch] truncate font-mono text-muted" title={href}>
              {href}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onOpen}
              title="Open in browser"
              className="flex items-center gap-1 rounded bg-interaction px-2 py-1 text-[11px] font-semibold text-white hover:bg-interaction-hover active:bg-interaction-active"
            >
              <span aria-hidden>↗</span> Open
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Edit link URL"
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-body hover:bg-elevated hover:text-strong"
            >
              <span aria-hidden>✎</span> Edit
            </button>
            <button
              type="button"
              onClick={onRemove}
              title="Remove link (keep text)"
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-body hover:bg-elevated hover:text-strong"
            >
              <span aria-hidden>×</span> Remove
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="ml-auto rounded px-1 text-muted hover:bg-elevated hover:text-strong"
            >
              ×
            </button>
          </div>
        </>
      )}
      <span className="text-[10px] leading-snug text-muted">{proTip}</span>
    </div>
  );
}
