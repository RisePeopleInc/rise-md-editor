import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { SourceEditor, type CursorPosition, type SourceEditorHandle } from './SourceEditor';
import type { ImageInsertion, PasteImageSnapshot } from '../../state/imageInsert';
import { resolveAssetUrl } from '../../state/assetUrl';
import { splitFrontmatter } from '../../state/markdown';
import { buildPreviewMarkdownIt } from '../../state/previewMarkdownIt';
import { expandSingleTildeStrikethrough } from '../../state/exportPdfHtml';
import type { WordWrap } from '../../env';

interface SplitViewProps {
  sourceRef?: Ref<SourceEditorHandle>;
  content: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
  initialCursor?: CursorPosition;
  initialScrollTop?: number;
  /** Monaco theme id passed through to the source pane. */
  monacoThemeId: string;
  /** Source-editor word-wrap mode. Preview pane always wraps regardless. */
  wordWrap: WordWrap;
  /** Image-drop handler forwarded to the source pane. */
  onImageDrop?: (files: File[]) => Promise<ImageInsertion[]>;
  /** Image-paste handler forwarded to the source pane. */
  onImagePaste?: (snapshot: PasteImageSnapshot) => Promise<ImageInsertion | null>;
  /** Path of the markdown file — used to resolve relative image src in
   *  the preview pane to rise-md-asset:// URLs. */
  markdownPath: string | null;
}

const MIN_PERCENT = 20;
const MAX_PERCENT = 80;
const DEFAULT_PERCENT = 50;

// RAISE-29: matches `[ ]` / `[x]` / `[X]` on a known task-list line.
// Used to flip the marker on the specific source line that
// markdown-it identified as a task-list item — applied to a single
// line at a time so we don't have to worry about false-positive
// matches inside fenced code blocks.
const TASK_LINE_MARKER_RE = /\[([ xX])\]/;

export function SplitView({
  sourceRef,
  content,
  onChange,
  onCursorChange,
  initialCursor,
  initialScrollTop,
  monacoThemeId,
  wordWrap,
  onImageDrop,
  onImagePaste,
  markdownPath,
}: SplitViewProps) {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_PERCENT);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // RAISE-31 + RAISE-42 follow-up: per-user preference for hiding
  // review-style comments in the preview pane. Default OFF (show)
  // — preview's purpose is author-mode review where seeing the
  // comments matters; the toggle lets the author flip to a
  // reader-view to see what an exported recipient would see, or
  // to skim past comment clutter when proofreading. Persisted
  // in localStorage so the choice survives reloads / sessions.
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
      // localStorage can throw in private-browsing / sandboxed
      // contexts; non-fatal — the toggle just won't persist.
    }
  }, [hideComments]);

  // Stable ref to the current markdown path so the markdown-it image
  // rule (registered once per md instance) reads the latest value
  // without forcing an md rebuild on every keystroke.
  const markdownPathRef = useRef(markdownPath);
  markdownPathRef.current = markdownPath;

  // Shared read-only preview markdown-it pipeline (RAISE-61). Task-list
  // checkboxes are interactive in Split (click-to-toggle); the image rule
  // resolves relative srcs to `rise-md-asset://` via the path ref, so a
  // Save As that moves the file repoints existing images without an md
  // rebuild on every keystroke.
  const md = useMemo(
    () =>
      buildPreviewMarkdownIt({
        taskListsEnabled: true,
        imageSrcResolver: (src) => resolveAssetUrl(markdownPathRef.current, src),
      }),
    [],
  );
  // Re-render the preview HTML whenever content OR the markdown path
  // changes — a Save As that gives the file a new dir means existing
  // relative paths point at a different location. The image rule reads
  // markdownPath via a ref so it doesn't appear in `md.render`'s
  // signature; eslint can't see that, hence the disable.
  //
  // RAISE-29: alongside the rendered HTML, build a parallel array of
  // *source line numbers* for each task-list item. markdown-it-task-lists
  // marks each task `<li>`'s `list_item_open` token with a
  // `task-list-item` class; that token's `.map[0]` is the 0-indexed
  // source line of the `* [ ]` / `* [x]` it represents. This lets the
  // click handler below toggle the exact source line by index instead
  // of regexing through the source for the Nth `[ ]` (which would
  // false-match markers inside fenced code blocks etc.).
  const { html, taskLines } = useMemo(() => {
    // RAISE-32: split YAML frontmatter off the body before parsing.
    // Without this, markdown-it sees `---\nkey: v\n---\n# Heading`
    // and parses the second `---` as a Setext H2 underline,
    // rendering `key: v` as a giant heading at the top of the
    // preview. We render the frontmatter as a styled metadata block
    // above the body's HTML, mirroring the way the WYSIWYG editor
    // shows frontmatter in its own dedicated textarea above the
    // prose surface.
    const { frontmatter, body, bodyLineOffset } = splitFrontmatter(content);
    // Rewrite single-tilde strikethrough (`~text~`) to double tildes
    // before parsing, so the preview matches the WYSIWYG editor's
    // behaviour (Milkdown's GFM input rule accepts both forms, but
    // markdown-it's built-in strikethrough rule requires `~~`).
    // Source line numbers for task-list mapping are preserved because
    // the rewrite is in-line and never adds or removes newlines.
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
      // markdown-it `.map[0]` is body-relative (we parsed only the
      // body); offset back to absolute source-line indices so the
      // task-checkbox click handler (which rewrites the source)
      // targets the right line.
      if (lineIdx != null) lines.push(bodyLineOffset + lineIdx);
    }
    let renderedHtml = bodyHtml;
    if (frontmatter !== null) {
      // Escape HTML special chars in the frontmatter content — it
      // ships as plain text inside a `<pre>`, but markdown-it is
      // configured with `html: false` so any `<`, `>`, `&` need
      // escaping for safety regardless.
      const escaped = frontmatter
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      renderedHtml =
        `<div class="rise-md-frontmatter-preview"><pre>${escaped}</pre></div>` + bodyHtml;
    }
    return { html: renderedHtml, taskLines: lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md, content, markdownPath]);

  // Scroll-sync lock: the side that initiated the scroll bumps a flag the
  // other side checks before mirroring, otherwise a single user scroll
  // bounces back and forth as each side reacts to the other.
  const syncing = useRef<'source' | 'preview' | null>(null);

  // Cache Monaco's scrollHeight from its onDidScrollChange events so the
  // preview→source mirror has the real source-side range to project against
  // (rather than an over-projected magic number that clamps to the bottom).
  // The two panes share the same clientHeight in this layout, so we read
  // that off the preview when computing the inverse.
  const sourceScrollHeightRef = useRef(0);

  const handleSourceScroll = useCallback((scrollTop: number, scrollHeight: number) => {
    sourceScrollHeightRef.current = scrollHeight;
    if (syncing.current === 'preview') return;
    const preview = previewRef.current;
    if (!preview) return;
    syncing.current = 'source';
    const sourceMax = Math.max(scrollHeight - preview.clientHeight, 1);
    const ratio = Math.max(0, Math.min(1, scrollTop / sourceMax));
    const previewMax = preview.scrollHeight - preview.clientHeight;
    preview.scrollTop = ratio * previewMax;
    requestAnimationFrame(() => {
      if (syncing.current === 'source') syncing.current = null;
    });
  }, []);

  const handlePreviewScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (syncing.current === 'source') return;
      const target = e.currentTarget;
      const ratio = Math.max(
        0,
        Math.min(1, target.scrollTop / Math.max(target.scrollHeight - target.clientHeight, 1)),
      );
      syncing.current = 'preview';
      const handle = (sourceRef as React.RefObject<SourceEditorHandle | null>)?.current;
      if (handle) {
        // Project ratio against Monaco's actual scrollHeight (cached from
        // its scroll listener); Monaco still clamps internally if the doc
        // grew between events.
        const sourceMax = Math.max(sourceScrollHeightRef.current - target.clientHeight, 1);
        handle.setScrollTop(ratio * sourceMax);
      }
      requestAnimationFrame(() => {
        if (syncing.current === 'preview') syncing.current = null;
      });
    },
    [sourceRef],
  );

  const handleDragStart = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const percent = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPercent(Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, percent)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // After the preview re-renders from new content, projects of large scroll
  // values will clamp; nothing extra needed.
  useEffect(() => {
    // No-op effect placeholder; left intentionally to mark that we don't
    // re-sync on content change. Monaco's onDidScrollChange will fire and
    // drive the preview when the user actually scrolls.
  }, [html]);

  // RAISE-29: clicking a task-list checkbox in the preview pane
  // toggles the corresponding `[ ]` / `[x]` in the source markdown.
  // markdown-it-task-lists' `enabled: true` config removes the
  // `disabled` attribute so the input fires events; we listen for
  // `change` (rather than `click`) to catch all activation methods —
  // mouse, keyboard Space, label-for synthetic — without
  // double-firing on label-wrapped click→input synthesis.
  //
  // Mapping from clicked checkbox to source line uses the
  // `taskLines` array built alongside the HTML render: index N in
  // the preview's checkbox order corresponds to source line
  // `taskLines[N]`. We flip the marker on that line in place,
  // `lines.join('\n')`, and propagate via `onChange`. Updating
  // `contentRef.current` synchronously *before* `onChange` makes
  // sequential rapid clicks compose correctly even if React's
  // re-render hasn't propagated the new content prop back to us yet.
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const taskLinesRef = useRef<number[]>(taskLines);
  taskLinesRef.current = taskLines;
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const handleChange = (e: Event): void => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'checkbox') return;
      if (!target.classList.contains('task-list-item-checkbox')) return;
      const allCheckboxes = preview.querySelectorAll('input.task-list-item-checkbox');
      const index = Array.from(allCheckboxes).indexOf(target);
      if (index < 0) return;
      const lineIdx = taskLinesRef.current[index];
      if (lineIdx == null) return;
      const lines = contentRef.current.split('\n');
      const sourceLine = lines[lineIdx];
      if (sourceLine == null) return;
      const updatedLine = sourceLine.replace(
        TASK_LINE_MARKER_RE,
        (_, marker: string) => `[${marker === ' ' ? 'x' : ' '}]`,
      );
      if (updatedLine === sourceLine) return;
      lines[lineIdx] = updatedLine;
      const next = lines.join('\n');
      // Sync ref BEFORE calling onChange so a rapid second click
      // composes on top of this update, not on the stale base.
      contentRef.current = next;
      onChangeRef.current(next);
    };
    preview.addEventListener('change', handleChange);
    return () => {
      preview.removeEventListener('change', handleChange);
    };
  }, []);

  // RAISE-38: open links in the user's default external browser instead
  // of in the renderer's webContents. The preview pane is read-only so
  // plain click is the right gesture (no cursor-positioning to preserve).
  // Without this handler, `<a href>` clicks navigate the renderer to the
  // URL, blowing away the editor — a footgun that's both UX-bad and
  // security-bad. window.api.openExternal validates the scheme on the
  // main side (only http / https / mailto are forwarded), so we don't
  // need to filter here.
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a');
      if (!anchor || !preview.contains(anchor)) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      window.api.openExternal(href);
    };
    preview.addEventListener('click', handleClick);
    return () => {
      preview.removeEventListener('click', handleClick);
    };
  }, []);

  // RAISE-28: right-click in the preview pane gets a Copy / Select All
  // menu (no Cut / Paste — preview is read-only). Copy here yields the
  // rendered text, which is the right default; "Copy as Markdown" from
  // preview would require an HTML→markdown reverse-mapping that's a
  // separate, much larger feature, deliberately out of scope for this
  // ticket.
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const handleContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      const sel = window.getSelection();
      const hasSelection = !!sel && !sel.isCollapsed && sel.toString().length > 0;
      void window.api.contextMenu.showEditor({
        mode: 'preview',
        hasSelection,
      });
    };
    preview.addEventListener('contextmenu', handleContextMenu);
    return () => {
      preview.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex h-full w-full bg-app">
      {/*
       * `min-w-0` is load-bearing: flex items default to `min-width: auto`,
       * which means a flex child won't shrink below its intrinsic content
       * width. Monaco lays out to fill its parent, so a long line in the
       * markdown source would push this wrapper wider than `splitPercent`%
       * and overflow the WYSIWYG pane off the right of the window — exactly
       * the regression in [RAISE-26](https://risepeople.atlassian.net/browse/RAISE-26).
       * `min-w-0` lets the explicit `width` percentage actually take effect;
       * `overflow-hidden` ensures Monaco's own horizontal scrollbar handles
       * long lines instead of the parent layout.
       */}
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ width: `${splitPercent}%` }}>
        <SourceEditor
          ref={sourceRef}
          content={content}
          onChange={onChange}
          onCursorChange={onCursorChange}
          onScrollChange={handleSourceScroll}
          initialCursor={initialCursor}
          initialScrollTop={initialScrollTop}
          monacoThemeId={monacoThemeId}
          wordWrap={wordWrap}
          onImageDrop={onImageDrop}
          onImagePaste={onImagePaste}
          markdownPath={markdownPath}
        />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        onMouseDown={handleDragStart}
        className="w-1 shrink-0 cursor-col-resize bg-stroke hover:bg-elevated active:bg-interaction"
      />
      {/*
       * `min-w-0` here too — same flex floor applies if Milkdown ever
       * produces wide content (long unbroken code blocks, very wide tables).
       *
       * Wrapping div: `relative` so the comment-visibility toggle
       * button can absolute-position into the top-right corner
       * without altering preview layout. Was a single `.rise-md-prose`
       * div before the RAISE-42 follow-up that added the toggle.
       */}
      <div className="relative min-h-0 min-w-0 flex-1" style={{ width: `${100 - splitPercent}%` }}>
        {/*
         * Comment-visibility toggle — flips `.rise-md-prose-hide-comments`
         * on the preview node. Default OFF (comments visible) so the
         * author sees their review notes muted-italic per RAISE-31; ON
         * gives a reader-view that matches what a recipient sees in
         * an exported PDF (where "Strip comments before export" is on
         * by default, mirroring the dominant convention across
         * Obsidian / iA Writer / Typora / Marked 2 / VSCode-markdown-pdf).
         *
         * Positioned absolute top-right with a small backdrop so it
         * stays readable over content without committing to a full
         * preview-pane toolbar (which would steal vertical space and
         * doesn't match the rest of the app's chrome-light aesthetic).
         */}
        <button
          type="button"
          onClick={() => setHideComments((v) => !v)}
          title={
            hideComments
              ? 'Comments are hidden in this preview. Click to show.'
              : 'Comments are visible. Click to hide (matches what a PDF recipient sees).'
          }
          aria-pressed={hideComments}
          className="absolute right-3 top-3 z-10 rounded border border-stroke bg-app/90 px-2 py-1 text-[11px] font-semibold text-body shadow-[var(--rise-shadow-depth-1)] backdrop-blur transition hover:bg-elevated hover:text-strong"
        >
          {hideComments ? 'Show comments' : 'Hide comments'}
        </button>
        <div
          ref={previewRef}
          onScroll={handlePreviewScroll}
          className={`rise-md-prose h-full overflow-auto px-6 py-8 ${hideComments ? 'rise-md-prose-hide-comments' : ''}`}
          // RAISE-28: identity attribute used by App.tsx's
          // `context-preview-select-all` handler to scope a programmatic
          // text selection to this node — `webContents.selectAll()` would
          // otherwise select the entire renderer document.
          data-rise-md-preview-pane
          // markdown-it is configured with html:false so user-inline HTML is
          // escaped before reaching the DOM; safe to inject the rendered HTML.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
