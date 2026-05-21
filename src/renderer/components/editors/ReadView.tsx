import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItTaskLists from 'markdown-it-task-lists';
import { resolveAssetUrl } from '../../state/assetUrl';
import { looksLikeFilenameExtension } from '../../state/filenameExtensions';
import { splitFrontmatter } from '../../state/markdown';
import { markdownItComments } from '../../state/markdownItComments';
import { expandSingleTildeStrikethrough } from '../../state/exportPdfHtml';

/**
 * ReadView — read-only rendered markdown
 * ([RAISE-60](https://risepeople.atlassian.net/browse/RAISE-60)).
 *
 * The fourth editor mode, alongside WYSIWYG / Source / Split. Renders
 * the active tab's markdown through the same markdown-it pipeline as
 * `SplitView`'s preview pane, but as a single full-width pane with no
 * accompanying editor surface. The buffer is never edited from this
 * view, so tabs in Read mode are always clean — no dirty tracking,
 * no save prompts on close, the external-edit auto-reload from
 * RAISE-56 always silently refreshes.
 *
 * Design choices:
 *
 *   - **Same markdown-it config as SplitView's preview.** Identical
 *     plugins (`markdown-it-task-lists`, `markdown-it-emoji`,
 *     `markdownItComments`), identical image-src rewrite to
 *     `rise-md-asset://`, identical filename-autolink suppression
 *     from RAISE-47. The visual output matches what the user sees
 *     in Split. A future refactor could extract this shared config
 *     into one place (currently SplitView, exportPdfHtml, and now
 *     ReadView each maintain their own near-identical builder); held
 *     off in this PR to keep the diff focused.
 *
 *   - **`taskLists.enabled: false`** — the rendered checkboxes are
 *     visible but click-disabled. Read mode is genuinely read-only;
 *     toggling a checkbox would mutate the source buffer, which
 *     defeats the point. The Split view's `enabled: true` + click
 *     handler is the right behaviour for *that* mode.
 *
 *   - **Centered max-width column** matching the WYSIWYG layout
 *     (`mx-auto max-w-[720px] px-6 py-8`). Read mode is the polished
 *     reading surface; the print-tuned wide column from Split
 *     wouldn't feel right here.
 *
 *   - **Per-tab scroll persistence** via `readScrollPosition` on the
 *     tab record. Tracked separately from the WYSIWYG and Monaco
 *     scroll fields because the rendered HTML's height differs from
 *     both source text and the WYSIWYG ProseMirror layout.
 *
 *   - **Single-tilde strikethrough preprocessor** (RAISE-53 follow-
 *     up) is wired in here too so `~text~` strikethrough renders
 *     consistently with WYSIWYG, Split-preview, and the HTML export.
 *
 *   - **Hide-comments toggle** mirrored from SplitView's preview pane.
 *     Same `raise.preview.hideComments` localStorage key so the
 *     choice is unified across the two read surfaces.
 */

interface ReadViewProps {
  /** Active tab's markdown source. */
  content: string;
  /** Filesystem path of the active document, if saved. Used to
   *  resolve relative image references via `rise-md-asset://`. */
  markdownPath: string | null;
  /** Initial scroll offset to restore (per-tab persistence). */
  initialScrollTop: number;
  /** Notify on each scroll so the tab's `readScrollPosition` can be
   *  kept in sync (debounced inside the consumer). */
  onScrollChange: (top: number) => void;
}

export function ReadView({
  content,
  markdownPath,
  initialScrollTop,
  onScrollChange,
}: ReadViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Hide-comments toggle (shared with SplitView via the same
  // localStorage key — flipping it in one surface affects the other,
  // which is the intended behaviour).
  const HIDE_COMMENTS_LS_KEY = 'raise.preview.hideComments';
  const [hideComments, setHideComments] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(HIDE_COMMENTS_LS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(HIDE_COMMENTS_LS_KEY, hideComments ? '1' : '0');
    } catch {
      // localStorage can throw in sandboxed contexts — non-fatal.
    }
  }, [hideComments]);

  // Stable ref so the markdown-it image rule (registered once) reads
  // the latest path without forcing an md rebuild on each keystroke.
  const markdownPathRef = useRef(markdownPath);
  markdownPathRef.current = markdownPath;

  const md = useMemo(() => {
    const instance = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      breaks: false,
    });
    // RAISE-47: filename-shaped autolink suppression. Same pattern as
    // SplitView — keep linkify's default `fuzzyLink` so real bare-
    // domain references autolink, but unwrap any rendered link whose
    // href is a filename-shaped suffix (`file.md`, `notes.txt`, etc.).
    const defaultLinkOpen = instance.renderer.rules['link_open'];
    const defaultLinkClose = instance.renderer.rules['link_close'];
    const wrapLinkRule =
      (defaultRule: typeof defaultLinkOpen) =>
      (
        tokens: Parameters<NonNullable<typeof defaultLinkOpen>>[0],
        idx: Parameters<NonNullable<typeof defaultLinkOpen>>[1],
        options: Parameters<NonNullable<typeof defaultLinkOpen>>[2],
        env: Parameters<NonNullable<typeof defaultLinkOpen>>[3],
        self: Parameters<NonNullable<typeof defaultLinkOpen>>[4],
      ) => {
        const token = tokens[idx]!;
        if (token.type === 'link_open') {
          const hrefIdx = token.attrIndex('href');
          if (hrefIdx >= 0) {
            const href = token.attrs?.[hrefIdx]?.[1] ?? '';
            if (looksLikeFilenameExtension(href)) {
              token.meta = { ...(token.meta ?? {}), fileShaped: true };
              return '';
            }
          }
        }
        if (token.type === 'link_close') {
          let depth = 1;
          for (let i = idx - 1; i >= 0; i--) {
            const t = tokens[i]!;
            if (t.type === 'link_close') depth += 1;
            else if (t.type === 'link_open') {
              depth -= 1;
              if (depth === 0) {
                if (t.meta?.['fileShaped']) return '';
                break;
              }
            }
          }
        }
        return defaultRule
          ? defaultRule(tokens, idx, options, env, self)
          : self.renderToken(tokens, idx, options);
      };
    instance.renderer.rules['link_open'] = wrapLinkRule(defaultLinkOpen);
    instance.renderer.rules['link_close'] = wrapLinkRule(defaultLinkClose);
    // RAISE-29: task lists rendered as checkboxes, BUT `enabled: false`
    // so the input element renders with the `disabled` attribute and
    // the user can't toggle them. Read mode is read-only; mutating
    // the source buffer from here would defeat the whole point.
    instance.use(markdownItTaskLists, { enabled: false, label: true });
    instance.use(markdownItEmoji);
    instance.use(markdownItComments);
    // RAISE-11: relative `<img src>` → `rise-md-asset://` URL at render time.
    const defaultImage = instance.renderer.rules.image;
    instance.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx]!;
      const srcIdx = token.attrIndex('src');
      if (srcIdx >= 0) {
        const src = token.attrs?.[srcIdx]?.[1] ?? '';
        const resolved = resolveAssetUrl(markdownPathRef.current, src);
        token.attrs![srcIdx]![1] = resolved;
      }
      return defaultImage
        ? defaultImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
    };
    return instance;
  }, []);

  // Re-render whenever content OR the markdown path changes — a Save As
  // that gives the file a new dir means existing relative paths point
  // at a different location. The image rule reads markdownPath via a
  // ref so it doesn't appear in `md.render`'s signature; eslint can't
  // see that, hence the disable.
  const html = useMemo(() => {
    const { frontmatter, body } = splitFrontmatter(content);
    // Single-tilde strikethrough preprocess (RAISE-53 follow-up) so
    // `~text~` renders consistently with WYSIWYG and the HTML export.
    const preprocessed = expandSingleTildeStrikethrough(body);
    const bodyHtml = md.render(preprocessed);
    if (frontmatter !== null) {
      const escaped = frontmatter
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return (
        `<div class="rise-md-frontmatter-preview"><pre>${escaped}</pre></div>` + bodyHtml
      );
    }
    return bodyHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md, content, markdownPath]);

  // Restore the saved scroll position once after mount / content swap.
  // Use a layout effect-style raf to wait for the rendered HTML to lay
  // out — setting `scrollTop` before the DOM has actual height clamps
  // to 0 and silently loses the restore.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      container.scrollTop = initialScrollTop;
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // Intentionally exhaustive-deps-disabled: the restore is "first
    // mount / content reload only", not every initialScrollTop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  // Persist scroll on each event. The consumer is responsible for
  // debouncing if it cares about state-update churn — this fires
  // synchronously to keep the model honest.
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      onScrollChange(e.currentTarget.scrollTop);
    },
    [onScrollChange],
  );

  // Open links in the OS browser, same handler shape as SplitView's
  // preview-pane. Read mode is read-only so plain click is the right
  // gesture (no cursor-placement intent to preserve).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a');
      if (!anchor || !container.contains(anchor)) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      window.api.openExternal(href);
    };
    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
    };
  }, []);

  // Right-click context menu — Copy / Select All only, no Cut / Paste
  // since Read is read-only. Mirrors SplitView's preview-pane menu.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      const sel = window.getSelection();
      const hasSelection = !!sel && !sel.isCollapsed && sel.toString().length > 0;
      void window.api.contextMenu.showEditor({
        mode: 'preview',
        hasSelection,
      });
    };
    container.addEventListener('contextmenu', handleContextMenu);
    return () => {
      container.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  return (
    <div className="relative h-full w-full bg-app">
      {/* Hide-comments toggle, same affordance as SplitView's preview. */}
      <button
        type="button"
        onClick={() => setHideComments((v) => !v)}
        title={
          hideComments
            ? 'Comments are hidden. Click to show.'
            : 'Comments are visible. Click to hide.'
        }
        aria-pressed={hideComments}
        className="absolute right-3 top-3 z-10 rounded border border-stroke bg-app/90 px-2 py-1 text-[11px] font-semibold text-body shadow-[var(--rise-shadow-depth-1)] backdrop-blur transition hover:bg-elevated hover:text-strong"
      >
        {hideComments ? 'Show comments' : 'Hide comments'}
      </button>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        // Identity attribute used by App.tsx's `context-preview-select-all`
        // handler to scope a programmatic text selection to this node.
        // Same attribute SplitView's preview pane uses, so the menu wiring
        // doesn't need branching by mode.
        data-rise-md-preview-pane
        className="h-full overflow-auto"
      >
        <div
          className={`mx-auto max-w-[720px] px-6 py-8 rise-md-prose ${
            hideComments ? 'rise-md-prose-hide-comments' : ''
          }`}
          // markdown-it is configured with html:false so user-inline HTML
          // is escaped before reaching the DOM; safe to inject the
          // rendered HTML.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
