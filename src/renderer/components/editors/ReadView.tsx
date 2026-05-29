import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItTaskLists from 'markdown-it-task-lists';
import { resolveAssetUrl } from '../../state/assetUrl';
import { looksLikeFilenameExtension } from '../../state/filenameExtensions';
import { splitFrontmatter } from '../../state/markdown';
import { markdownItComments } from '../../state/markdownItComments';
import { expandSingleTildeStrikethrough } from '../../state/exportPdfHtml';
import { toggleTaskLine } from '../../state/taskListToggle';

/**
 * ReadView — read-only rendered markdown
 * ([RAISE-60](https://risepeople.atlassian.net/browse/RAISE-60)).
 *
 * The fourth editor mode, alongside WYSIWYG / Source / Split. Renders
 * the active tab's markdown through the same markdown-it pipeline as
 * `SplitView`'s preview pane, but as a single full-width pane with no
 * accompanying editor surface. The only edit affordance is the GFM
 * task-list checkbox (RAISE-85, below); every other interaction is
 * read-only.
 *
 * RAISE-85: clicking a task-list checkbox toggles the underlying
 * `[ ]` / `[x]` and *silently saves the file to disk* — the user
 * stays in Read mode, no dirty marker, no prompt. The write-back
 * runs through `onToggleTask`, which App.tsx wires to a `files.save`
 * + `setActiveContentSaved` pair so the tab's content and saved
 * baseline move together and the tab reads clean. A failed save
 * (read-only file, permissions) reverts the clicked checkbox and
 * surfaces a small non-modal notice rather than a blocking dialog.
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
 *   - **`taskLists.enabled: true`** (RAISE-85) — the rendered
 *     checkboxes are interactive; a click flips the marker in the
 *     source and silently persists it. Same `enabled: true` + click
 *     handler shape as SplitView's preview, but where SplitView routes
 *     the new source through `onChange` (marking the tab dirty), Read
 *     mode routes through `onToggleTask` (silent save, tab stays
 *     clean). Was `enabled: false` before RAISE-85, when Read mode was
 *     a strictly read-only surface.
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
  /** Called once, on unmount, with the final scroll offset so the tab's
   *  `readScrollPosition` is persisted for a later re-mount. Deliberately
   *  NOT called per scroll event — a per-scroll state update re-renders
   *  the view and corrupts the live text selection (RAISE-78 / RAISE-79);
   *  see the scroll handler in the body. */
  onScrollChange: (top: number) => void;
  /**
   * RAISE-85: invoked when the user clicks a task-list checkbox. Receives
   * the full new markdown source (the toggled line already flipped) and
   * is responsible for the silent write-back: persist to disk and realign
   * the tab's saved baseline so it stays clean. Resolves `true` if the
   * source was persisted (the optimistic DOM toggle stands), `false` if
   * the save failed or the document can't be saved (untitled / read-only)
   * — in which case ReadView reverts the clicked checkbox and shows a
   * non-modal notice.
   */
  onToggleTask: (newContent: string) => Promise<boolean>;
}

export function ReadView({
  content,
  markdownPath,
  initialScrollTop,
  onScrollChange,
  onToggleTask,
}: ReadViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // RAISE-85: transient "couldn't save" notice. Shown when the silent
  // checkbox write-back fails (read-only file, permissions). Non-modal,
  // auto-dismissing — no blocking dialog.
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const saveNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (saveNoticeTimerRef.current !== null) {
        clearTimeout(saveNoticeTimerRef.current);
      }
    };
  }, []);

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
    // RAISE-29 + RAISE-85: task lists rendered as checkboxes. `enabled:
    // true` (changed from `false` in RAISE-85) drops the `disabled`
    // attribute so the input fires events; a `change` listener on the
    // container (further down) flips the source marker and silently
    // saves the file. `label: true` wraps the item text in a <label>
    // for accessibility / a CSS hook for completed-item greying.
    instance.use(markdownItTaskLists, { enabled: true, label: true });
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
  //
  // RAISE-85: alongside the rendered HTML, build a parallel array of
  // absolute source line numbers for each task-list item — same
  // technique as SplitView's preview. markdown-it-task-lists marks each
  // task `<li>`'s `list_item_open` token with a `task-list-item` class;
  // that token's `.map[0]` is the body-relative 0-indexed source line.
  // We offset it by `bodyLineOffset` (the frontmatter line count) so the
  // checkbox click handler targets the right absolute line when it
  // rewrites the full source. Indexed by checkbox order in the rendered
  // output, which matches the DOM order the click handler walks.
  const { html, taskLines } = useMemo(() => {
    const { frontmatter, body, bodyLineOffset } = splitFrontmatter(content);
    // Single-tilde strikethrough preprocess (RAISE-53 follow-up) so
    // `~text~` renders consistently with WYSIWYG and the HTML export.
    // The rewrite never adds or removes newlines, so task-list source
    // line numbers survive it intact.
    const preprocessed = expandSingleTildeStrikethrough(body);
    const env = {};
    const tokens = md.parse(preprocessed, env);
    const bodyHtml = md.renderer.render(tokens, md.options, env);
    const lines: number[] = [];
    for (const t of tokens) {
      if (t.type !== 'list_item_open') continue;
      const cls = t.attrGet('class') ?? '';
      if (!cls.includes('task-list-item')) continue;
      const lineIdx = t.map?.[0];
      if (lineIdx != null) lines.push(bodyLineOffset + lineIdx);
    }
    if (frontmatter !== null) {
      const escaped = frontmatter
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return {
        html: `<div class="rise-md-frontmatter-preview"><pre>${escaped}</pre></div>` + bodyHtml,
        taskLines: lines,
      };
    }
    return { html: bodyHtml, taskLines: lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md, content, markdownPath]);

  // RAISE-78 / RAISE-79: persist scroll WITHOUT a per-scroll React state
  // update. Read mode renders into a `dangerouslySetInnerHTML` div and the
  // user selects text directly in that DOM. Pushing the offset into
  // `fileState` on every scroll event re-rendered this view, and that
  // re-render corrupted the live `window.getSelection()` — it collapsed and
  // re-anchored the range to document-start (confirmed by instrumentation:
  // a single scroll tick reset the range to offset 0 of the first node).
  // That surfaced two ways from one cause: the selection visibly vanished
  // while scrolling (RAISE-78), and a subsequent Cmd+C copied from the top
  // of the document to the old selection end (RAISE-79), because the copy
  // reflected the corrupted, top-anchored range.
  //
  // Fix: keep the latest offset in a ref (no setState, no re-render) and
  // commit it once on unmount. A tab switch, mode switch, or re-open all
  // unmount this view via EditorContainer's keyed remount, so the final
  // offset is still captured for the next restore — but nothing re-renders
  // while the user is reading and selecting.
  //
  // RAISE-85: this ref is initialised to `initialScrollTop` so the genuine
  // restore-on-mount below still lands the reader where they left off. But
  // the scroll-restore effect now reads `latestScrollTopRef.current` rather
  // than the `initialScrollTop` prop: a checkbox toggle mutates `content`,
  // which recomputes `html`, which re-fires the `[html]`-keyed restore
  // effect. If that effect restored the (now-stale) `initialScrollTop`,
  // every checkbox click would jump the reader back to their mount
  // position. Reading the live ref instead preserves the current scroll
  // across a toggle while still restoring correctly on the first mount.
  const latestScrollTopRef = useRef(initialScrollTop);

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
      // RAISE-85: restore to the LIVE position (ref), not the mount-time
      // prop. On first mount the ref equals `initialScrollTop`; after a
      // checkbox toggle it holds the reader's current offset — so the
      // re-render from the content change doesn't scroll-jump.
      container.scrollTop = latestScrollTopRef.current;
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // Keyed on `html` only: the restore should fire on first mount and on
    // a content reload (both recompute `html`), reading the live scroll
    // ref. RAISE-85 dropped the `initialScrollTop` reference from the body
    // (we read `latestScrollTopRef.current` instead), so exhaustive-deps
    // no longer wants it listed — no disable directive needed.
  }, [html]);

  // Live ref to the callback so the unmount-only effect always invokes the
  // current one without re-subscribing (and thus without re-running cleanup
  // mid-session, which would defeat the purpose).
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    latestScrollTopRef.current = e.currentTarget.scrollTop;
  }, []);

  useEffect(() => {
    return () => {
      onScrollChangeRef.current(latestScrollTopRef.current);
    };
  }, []);

  // RAISE-85: live refs for the checkbox `change` listener (registered
  // once, below). Keeping the latest content / taskLines / callback in
  // refs means the listener never re-subscribes — and, crucially, that
  // each toggle computes from the CURRENT content. `contentRef` is
  // advanced synchronously inside the handler before awaiting the save,
  // so a rapid second click composes on top of the first flip rather
  // than racing against a stale base (see the handler for detail).
  const contentRef = useRef(content);
  contentRef.current = content;
  const taskLinesRef = useRef<number[]>(taskLines);
  taskLinesRef.current = taskLines;
  const onToggleTaskRef = useRef(onToggleTask);
  onToggleTaskRef.current = onToggleTask;
  // Tracks the in-flight save chain so rapid clicks serialize: each
  // toggle's write-back waits for the previous one to settle, which
  // keeps disk writes ordered and lets a failure cleanly revert.
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  // RAISE-85: clicking a task-list checkbox toggles the corresponding
  // `[ ]` / `[x]` in the source and silently saves the file. Mirrors
  // SplitView's preview-pane handler (listen for `change`, not `click`,
  // to catch mouse + keyboard Space + label-for synthesis without
  // double-firing), but routes the new source through `onToggleTask`
  // (silent save) instead of `onChange` (dirty edit).
  //
  // The browser has already flipped `target.checked` visually by the
  // time `change` fires; we treat that as optimistic. The toggle math
  // runs against `contentRef.current` (advanced synchronously so rapid
  // clicks compose), then the write-back is queued behind any in-flight
  // save. If the save resolves `false` (untitled / read-only / write
  // error), we roll `contentRef` back and revert the DOM checkbox so the
  // rendered state matches what's actually on disk, and show a notice.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleChange = (e: Event): void => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'checkbox') return;
      if (!target.classList.contains('task-list-item-checkbox')) return;
      const allCheckboxes = container.querySelectorAll('input.task-list-item-checkbox');
      const index = Array.from(allCheckboxes).indexOf(target);
      if (index < 0) return;
      const lineIdx = taskLinesRef.current[index];
      if (lineIdx == null) return;
      const base = contentRef.current;
      const next = toggleTaskLine(base, lineIdx);
      // No-op (out-of-range / no marker on the line) — toggleTaskLine
      // returns the input unchanged. Revert the optimistic DOM flip.
      if (next === base) {
        target.checked = !target.checked;
        return;
      }
      // Advance the ref synchronously BEFORE awaiting, so a rapid second
      // click composes on top of this flip rather than the stale base.
      contentRef.current = next;
      const wasChecked = target.checked;
      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(() => onToggleTaskRef.current(next))
        .then((ok) => {
          if (ok) return;
          // Save failed / not saveable — undo this flip in the ref and the
          // DOM so the view reflects the unchanged on-disk source.
          contentRef.current = toggleTaskLine(contentRef.current, lineIdx);
          target.checked = !wasChecked;
          setSaveNotice("This file is read-only — couldn't update.");
          if (saveNoticeTimerRef.current !== null) {
            clearTimeout(saveNoticeTimerRef.current);
          }
          saveNoticeTimerRef.current = setTimeout(() => setSaveNotice(null), 4000);
        });
    };
    container.addEventListener('change', handleChange);
    return () => {
      container.removeEventListener('change', handleChange);
    };
  }, []);

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

  // Cmd/Ctrl+A select-all, scoped to the preview content. Without this
  // binding the default `webContents.selectAll()` would select the
  // entire renderer document (sidebar, mode pill, statusbar) — not
  // what the user means by "select all" while reading. The keydown
  // listener attaches only to the preview container, so other modes
  // (Source / WYSIWYG / Split) keep their own native or Monaco-managed
  // Cmd+A behaviour. Matches the scope-to-preview-node logic used by
  // the right-click `Select All` menu item (`context-preview-select-all`).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleKeydown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(container);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    };
    // Keydown on `window` rather than the container: the read pane
    // isn't keyboard-focusable by default (no tabindex, no editor),
    // so keystrokes don't land on it. `window` catches Cmd+A
    // regardless of focus, and the `mode === 'read'` mount/unmount
    // gating happens for free — this listener only exists while
    // ReadView is mounted.
    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
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
      {/* RAISE-85: non-modal "couldn't save" notice for a failed silent
          checkbox write-back (read-only file, permissions). Bottom-center
          toast that auto-dismisses; `role="status"` + `aria-live` so a
          screen reader announces it without stealing focus the way a
          dialog would. */}
      {saveNotice !== null && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded border border-stroke bg-app/95 px-3 py-2 text-[12px] font-medium text-body shadow-[var(--rise-shadow-depth-1)] backdrop-blur"
        >
          {saveNotice}
        </div>
      )}
    </div>
  );
}
