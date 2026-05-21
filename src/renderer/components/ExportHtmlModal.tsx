import { useState } from 'react';
import type { ExportHtmlImageMode } from '../env';

/**
 * Export-to-HTML modal
 * ([RAISE-53](https://risepeople.atlassian.net/browse/RAISE-53)).
 *
 * Triggered by File → Export → HTML…. Collects the user's two
 * choices — image bundling mode (inline data URIs vs external zip)
 * and whether to strip review-style comments — and submits to main
 * via `window.api.export.toHtml`.
 *
 * Mirrors the ExportPdfModal's UX shape (fixed-inset backdrop,
 * centered card, Cancel / Export buttons, ESC and click-on-backdrop
 * dismiss) but with far fewer controls: HTML doesn't need page
 * size, margins, scale, header/footer, etc.
 */

export interface ExportHtmlSubmitPayload {
  imageMode: ExportHtmlImageMode;
  range: 'document' | 'selection';
  openAfter: boolean;
  /** Strip review-style comments (`<!-- … -->`, `// …`) before rendering. */
  stripComments: boolean;
}

interface ExportHtmlModalProps {
  /** Whether the active document has a non-empty selection in the
   *  current view. Drives the enable-state of the "Selection only" radio. */
  hasSelection: boolean;
  onCancel: () => void;
  onSubmit: (payload: ExportHtmlSubmitPayload) => void;
}

// Persist the last-chosen image mode so the next export remembers
// (no app-preference UI to design — same pattern as the PDF modal's
// author/email persistence).
const IMAGE_MODE_LS_KEY = 'raise.export.html.imageMode';

function loadPersistedImageMode(): ExportHtmlImageMode {
  try {
    const v = window.localStorage.getItem(IMAGE_MODE_LS_KEY);
    if (v === 'inline' || v === 'external') return v;
  } catch {
    // localStorage access can throw in some sandboxed contexts.
    // Default fallback applies.
  }
  // Default: inline. Single-file output is the dominant ask
  // (sharing via email / Slack, archiving). External-zip is the
  // power-user mode.
  return 'inline';
}

function persistImageMode(mode: ExportHtmlImageMode): void {
  try {
    window.localStorage.setItem(IMAGE_MODE_LS_KEY, mode);
  } catch {
    // Non-fatal.
  }
}

export function ExportHtmlModal({ hasSelection, onCancel, onSubmit }: ExportHtmlModalProps) {
  const [imageMode, setImageMode] = useState<ExportHtmlImageMode>(loadPersistedImageMode);
  const [range, setRange] = useState<'document' | 'selection'>('document');
  const [openAfter, setOpenAfter] = useState(true);
  // Default ON to match the PDF export's behavior, and the
  // competitor convention across Obsidian / iA Writer / Typora /
  // Marked 2 / VSCode-markdown-pdf — review-style comments hide
  // in exports unless the user opts in.
  const [stripComments, setStripComments] = useState(true);

  // Intentionally NOT auto-focusing the first form control on
  // mount: the first focusable in this modal is the "Inline" radio
  // button (already selected by default), and OS-native focus
  // rings on radios are visually loud — flagged as confusing on
  // first open during smoke-testing. The PDF modal can get away
  // with the auto-focus pattern because its first focusable is a
  // `<select>` (page size), which renders a subtler focus ring.
  // Users keyboard-navigating this modal can Tab in from wherever
  // focus rests after the menu click; the dialog itself is
  // reachable via screen readers via `role="dialog"` + `aria-modal`.

  const submit = (): void => {
    persistImageMode(imageMode);
    onSubmit({
      imageMode,
      range: range === 'selection' && hasSelection ? 'selection' : 'document',
      openAfter,
      stripComments,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Export to HTML"
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className="flex w-[420px] max-w-[95vw] flex-col gap-4 rounded-[var(--rise-radius-card)] border border-stroke bg-app p-4 shadow-[var(--rise-shadow-depth-1)]"
      >
        <h2 className="text-sm font-semibold text-strong">Export to HTML</h2>

        {/* Image mode */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Images
          </legend>
          <label className="flex cursor-pointer items-start gap-2 rounded border border-stroke bg-surface p-2 text-xs text-strong hover:bg-elevated">
            <input
              type="radio"
              name="image-mode"
              value="inline"
              checked={imageMode === 'inline'}
              onChange={() => setImageMode('inline')}
              className="mt-0.5 accent-interaction"
            />
            <span className="flex flex-col">
              <span className="font-medium">Inline (single HTML file)</span>
              <span className="text-muted">
                Images embedded as base64 data URIs. Output is one self-contained
                <code className="rise-md-code px-0.5">.html</code> file — opens anywhere, shareable
                via email/Slack. Larger file size.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded border border-stroke bg-surface p-2 text-xs text-strong hover:bg-elevated">
            <input
              type="radio"
              name="image-mode"
              value="external"
              checked={imageMode === 'external'}
              onChange={() => setImageMode('external')}
              className="mt-0.5 accent-interaction"
            />
            <span className="flex flex-col">
              <span className="font-medium">External (zip bundle)</span>
              <span className="text-muted">
                Images in an <code className="rise-md-code px-0.5">assets/</code> folder alongside
                the HTML, packaged as a <code className="rise-md-code px-0.5">.zip</code>. Good for
                hosting or editing the result later. Unpack before viewing.
              </span>
            </span>
          </label>
        </fieldset>

        {/* Range */}
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Range
          </legend>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-strong">
            <input
              type="radio"
              name="range"
              value="document"
              checked={range === 'document'}
              onChange={() => setRange('document')}
              className="accent-interaction"
            />
            Entire document
          </label>
          <label
            className={`flex items-center gap-2 text-xs ${
              hasSelection ? 'cursor-pointer text-strong' : 'cursor-not-allowed text-disabled'
            }`}
          >
            <input
              type="radio"
              name="range"
              value="selection"
              checked={range === 'selection'}
              disabled={!hasSelection}
              onChange={() => setRange('selection')}
              className="accent-interaction"
            />
            Selection only
            {!hasSelection && <span className="text-muted">(no selection in the editor)</span>}
          </label>
        </fieldset>

        {/* Toggles */}
        <div className="flex flex-col gap-1">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-strong">
            <input
              type="checkbox"
              checked={stripComments}
              onChange={(e) => setStripComments(e.target.checked)}
              className="accent-interaction"
            />
            Strip review-style comments before export
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-strong">
            <input
              type="checkbox"
              checked={openAfter}
              onChange={(e) => setOpenAfter(e.target.checked)}
              className="accent-interaction"
            />
            Open after export
          </label>
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs font-medium text-strong hover:bg-elevated"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-interaction px-3 py-1.5 text-xs font-semibold text-white hover:bg-interaction-hover active:bg-interaction-active"
          >
            Export
          </button>
        </div>
      </form>
    </div>
  );
}
