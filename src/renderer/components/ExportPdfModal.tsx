import { useEffect, useRef, useState } from 'react';
import type { ExportPdfOptions, ExportPdfPageSize } from '../env';

/**
 * Export-to-PDF modal
 * ([RAISE-42](https://risepeople.atlassian.net/browse/RAISE-42)).
 *
 * Triggered by File → Export → PDF…, the Cmd/Ctrl+Shift+E
 * accelerator, or the editor context menu. Collects the user's
 * page-setup choices (size / orientation / margins / scale,
 * optional header & footer with placeholder text, range, open-
 * after-export) and submits to main via `window.api.export.toPdf`.
 *
 * UX shape mirrors the existing link-prompt modal in
 * `Toolbar.tsx`: fixed-inset backdrop, centered card, Cancel /
 * Export buttons, ESC and click-on-backdrop both dismiss.
 *
 * Locale-aware default page size: `Letter` for North American
 * locales, `A4` everywhere else. Pulled from `navigator.language`
 * (the renderer-side equivalent of `app.getLocale()` from the
 * ticket's spec) — both ultimately read the same OS preference.
 */

type Margins = ExportPdfOptions['margins'];
type HeaderFooter = NonNullable<ExportPdfOptions['headerFooter']>;

interface MarginPreset {
  label: string;
  /** Margin in inches (uniform on all sides for the presets). */
  inches: number;
}

const MARGIN_PRESETS: MarginPreset[] = [
  { label: 'None', inches: 0 },
  { label: 'Small', inches: 0.5 },
  { label: 'Medium', inches: 0.79 }, // ~20mm — print-default
  { label: 'Large', inches: 1.26 }, // ~32mm
];

const PAGE_SIZES: ExportPdfPageSize[] = [
  'Letter',
  'A4',
  'Legal',
  'A3',
  'A5',
  'Tabloid',
];

function defaultPageSize(): ExportPdfPageSize {
  const lang = (navigator.language || '').toLowerCase();
  // North American locales default to Letter; everyone else to A4.
  // Liberia and Philippines also use Letter but their locale codes
  // (`en-LR`, `en-PH`) are rare enough that pinning to en-US / en-CA
  // covers the realistic cases without a longer match list.
  if (lang.startsWith('en-us') || lang.startsWith('en-ca')) return 'Letter';
  return 'A4';
}

const DEFAULT_HEADER_FOOTER: HeaderFooter = {
  showHeader: false,
  showFooter: false,
  headerLeft: '{title}',
  headerCenter: '',
  headerRight: '',
  footerLeft: '',
  footerCenter: '{page} of {pages}',
  footerRight: '{date}',
  author: '',
  email: '',
};

// Smoke-test feedback round 1: users want their name + email
// in the header/footer (e.g. "{author} — {email}" in the right
// slot of the footer for printable hand-offs). Persist whatever
// the user typed last time so the next export remembers — no
// new app-preference UI to design.
const AUTHOR_LS_KEY = 'raise.export.pdf.author';
const EMAIL_LS_KEY = 'raise.export.pdf.email';

function loadPersistedAuthor(): { author: string; email: string } {
  try {
    return {
      author: window.localStorage.getItem(AUTHOR_LS_KEY) ?? '',
      email: window.localStorage.getItem(EMAIL_LS_KEY) ?? '',
    };
  } catch {
    // Storage access can throw in some sandbox / private-browsing
    // configurations. Return empty defaults — re-typing on every
    // export beats crashing the modal.
    return { author: '', email: '' };
  }
}

function persistAuthor(author: string, email: string): void {
  try {
    window.localStorage.setItem(AUTHOR_LS_KEY, author);
    window.localStorage.setItem(EMAIL_LS_KEY, email);
  } catch {
    // Same reason as `loadPersistedAuthor` — non-fatal.
  }
}

export interface ExportPdfSubmitPayload {
  pageSize: ExportPdfOptions['pageSize'];
  landscape: boolean;
  margins: Margins;
  scale: number;
  headerFooter: ExportPdfOptions['headerFooter'];
  range: 'document' | 'selection';
  openAfter: boolean;
}

interface ExportPdfModalProps {
  /** Whether the active document has a non-empty selection in the
   *  current view (Source / Split / WYSIWYG). Drives the
   *  enable-state of the "Selection only" radio. */
  hasSelection: boolean;
  onCancel: () => void;
  onSubmit: (payload: ExportPdfSubmitPayload) => void;
}

export function ExportPdfModal({
  hasSelection,
  onCancel,
  onSubmit,
}: ExportPdfModalProps) {
  const [pageSize, setPageSize] = useState<ExportPdfPageSize>(defaultPageSize());
  const [landscape, setLandscape] = useState(false);
  const [marginPresetIdx, setMarginPresetIdx] = useState(2); // Medium
  const [scale, setScale] = useState(100);
  const [headerFooter, setHeaderFooter] = useState<HeaderFooter>(() => {
    // Hydrate the author / email fields from localStorage so the
    // user's previous values are pre-filled. Other fields use the
    // module-level defaults.
    const persisted = loadPersistedAuthor();
    return {
      ...DEFAULT_HEADER_FOOTER,
      author: persisted.author,
      email: persisted.email,
    };
  });
  const [headerFooterExpanded, setHeaderFooterExpanded] = useState(false);
  const [range, setRange] = useState<'document' | 'selection'>('document');
  const [openAfter, setOpenAfter] = useState(true);

  const formRef = useRef<HTMLFormElement>(null);

  // Auto-focus the page-size select on mount so the user can
  // arrow-through the options without an extra click.
  useEffect(() => {
    const firstFocusable = formRef.current?.querySelector<HTMLElement>(
      'select, input, button',
    );
    firstFocusable?.focus();
  }, []);

  const submit = (): void => {
    const margin = MARGIN_PRESETS[marginPresetIdx]!.inches;
    const margins: Margins = {
      top: margin,
      bottom: margin,
      left: margin,
      right: margin,
    };
    // Persist the author / email so the next export pre-fills.
    // Always persist (even if header/footer is off) — the user
    // might enable it on a later export and expect their values
    // to come back.
    persistAuthor(headerFooter.author, headerFooter.email);
    onSubmit({
      pageSize,
      landscape,
      margins,
      scale: scale / 100,
      headerFooter:
        headerFooter.showHeader || headerFooter.showFooter
          ? headerFooter
          : null,
      range: range === 'selection' && hasSelection ? 'selection' : 'document',
      openAfter,
    });
  };

  const updateHeaderFooter = (patch: Partial<HeaderFooter>): void => {
    setHeaderFooter((prev) => ({ ...prev, ...patch }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Export to PDF"
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <form
        ref={formRef}
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
        className="flex w-[460px] max-w-[95vw] flex-col gap-3 rounded-[var(--rise-radius-card)] border border-stroke bg-app p-4 shadow-[var(--rise-shadow-depth-1)]"
      >
        <h2 className="text-sm font-semibold text-strong">Export to PDF</h2>

        {/* Page size + orientation row */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold text-strong">Page size</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value as ExportPdfPageSize)}
              className="rounded border border-stroke bg-surface px-2 py-1.5 text-sm text-strong focus:border-interaction focus:outline-none"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold text-strong">Orientation</span>
            <select
              value={landscape ? 'landscape' : 'portrait'}
              onChange={(e) => setLandscape(e.target.value === 'landscape')}
              className="rounded border border-stroke bg-surface px-2 py-1.5 text-sm text-strong focus:border-interaction focus:outline-none"
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
        </div>

        {/* Margins + scale row */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold text-strong">Margins</span>
            <select
              value={marginPresetIdx}
              onChange={(e) => setMarginPresetIdx(Number(e.target.value))}
              className="rounded border border-stroke bg-surface px-2 py-1.5 text-sm text-strong focus:border-interaction focus:outline-none"
            >
              {MARGIN_PRESETS.map((preset, idx) => (
                <option key={preset.label} value={idx}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold text-strong">
              Scale: {scale}%
            </span>
            <input
              type="range"
              min={50}
              max={200}
              step={10}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              className="mt-2"
            />
          </label>
        </div>

        {/* Header / footer accordion */}
        <div className="rounded border border-stroke">
          <button
            type="button"
            onClick={() => setHeaderFooterExpanded((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm font-semibold text-strong hover:bg-elevated"
          >
            <span>Header &amp; footer</span>
            <span className="text-xs text-body">
              {headerFooterExpanded ? '▾' : '▸'}
            </span>
          </button>
          {headerFooterExpanded && (
            <div className="flex flex-col gap-2 border-t border-stroke px-3 py-2 text-sm">
              <p className="text-xs text-body">
                Placeholders: <code>{'{title}'}</code>, <code>{'{date}'}</code>,{' '}
                <code>{'{page}'}</code>, <code>{'{pages}'}</code>,{' '}
                <code>{'{author}'}</code>, <code>{'{email}'}</code>
              </p>
              {/* Author / email fields. Persisted to localStorage on
                  submit so the next export pre-fills. Smoke-test
                  feedback round 1 — users wanted name + email in
                  printable hand-offs. */}
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-semibold text-strong">Author name</span>
                  <input
                    type="text"
                    value={headerFooter.author}
                    onChange={(e) =>
                      updateHeaderFooter({ author: e.target.value })
                    }
                    placeholder="Used for {author} placeholder"
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-semibold text-strong">Author email</span>
                  <input
                    type="text"
                    value={headerFooter.email}
                    onChange={(e) =>
                      updateHeaderFooter({ email: e.target.value })
                    }
                    placeholder="Used for {email} placeholder"
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={headerFooter.showHeader}
                  onChange={(e) =>
                    updateHeaderFooter({ showHeader: e.target.checked })
                  }
                />
                <span className="font-semibold text-strong">Show header</span>
              </label>
              {headerFooter.showHeader && (
                <div className="grid grid-cols-3 gap-2 pl-6">
                  <input
                    type="text"
                    placeholder="Left"
                    value={headerFooter.headerLeft}
                    onChange={(e) =>
                      updateHeaderFooter({ headerLeft: e.target.value })
                    }
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Center"
                    value={headerFooter.headerCenter}
                    onChange={(e) =>
                      updateHeaderFooter({ headerCenter: e.target.value })
                    }
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Right"
                    value={headerFooter.headerRight}
                    onChange={(e) =>
                      updateHeaderFooter({ headerRight: e.target.value })
                    }
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                </div>
              )}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={headerFooter.showFooter}
                  onChange={(e) =>
                    updateHeaderFooter({ showFooter: e.target.checked })
                  }
                />
                <span className="font-semibold text-strong">Show footer</span>
              </label>
              {headerFooter.showFooter && (
                <div className="grid grid-cols-3 gap-2 pl-6">
                  <input
                    type="text"
                    placeholder="Left"
                    value={headerFooter.footerLeft}
                    onChange={(e) =>
                      updateHeaderFooter({ footerLeft: e.target.value })
                    }
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Center"
                    value={headerFooter.footerCenter}
                    onChange={(e) =>
                      updateHeaderFooter({ footerCenter: e.target.value })
                    }
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Right"
                    value={headerFooter.footerRight}
                    onChange={(e) =>
                      updateHeaderFooter({ footerRight: e.target.value })
                    }
                    className="rounded border border-stroke bg-surface px-2 py-1 text-xs text-strong focus:border-interaction focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Range */}
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="font-semibold text-strong">Range</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="range"
              value="document"
              checked={range === 'document'}
              onChange={() => setRange('document')}
            />
            <span>Whole document</span>
          </label>
          <label
            className="flex items-center gap-2"
            title={hasSelection ? '' : 'No active selection'}
          >
            <input
              type="radio"
              name="range"
              value="selection"
              checked={range === 'selection'}
              onChange={() => setRange('selection')}
              disabled={!hasSelection}
            />
            <span className={hasSelection ? '' : 'text-body opacity-60'}>
              Selection only
            </span>
          </label>
        </fieldset>

        {/* Open after */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={openAfter}
            onChange={(e) => setOpenAfter(e.target.checked)}
          />
          <span>Open after export</span>
        </label>

        {/* Always-light note: documents the auto-light behaviour
            so a user wondering why their dark theme didn't apply
            sees the answer in-context. */}
        <p className="text-xs text-body">
          PDFs export with the light theme regardless of the editor&apos;s
          current appearance.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-stroke px-3 py-1 text-sm text-strong hover:bg-elevated"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-interaction px-3 py-1 text-sm font-semibold text-white hover:bg-interaction-hover"
          >
            Export
          </button>
        </div>
      </form>
    </div>
  );
}
