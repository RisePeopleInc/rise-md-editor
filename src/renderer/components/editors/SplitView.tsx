import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import MarkdownIt from 'markdown-it';
import markdownItTaskLists from 'markdown-it-task-lists';
import {
  SourceEditor,
  type CursorPosition,
  type SourceEditorHandle,
} from './SourceEditor';
import type { ImageInsertion, PasteImageSnapshot } from '../../state/imageInsert';
import { resolveAssetUrl } from '../../state/assetUrl';
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
   *  the preview pane to raise-asset:// URLs. */
  markdownPath: string | null;
}

const MIN_PERCENT = 20;
const MAX_PERCENT = 80;
const DEFAULT_PERCENT = 50;

// RAISE-29: matches a GFM task-list marker (`* [ ]` / `- [x]` / `+ [X]`)
// at the start of a line. Used to toggle the Nth task marker in source
// when the user clicks a checkbox in the preview pane. See the
// click-handling effect below.
const TASK_MARKER_RE = /^([ \t]*[*\-+][ \t]+)\[([ xX])\]/gm;

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

  // Stable ref to the current markdown path so the markdown-it image
  // rule (registered once per md instance) reads the latest value
  // without forcing an md rebuild on every keystroke.
  const markdownPathRef = useRef(markdownPath);
  markdownPathRef.current = markdownPath;

  // markdown-it: html disabled (escape any raw HTML in input — local notes
  // don't tend to need it and we'd rather not let arbitrary tags through),
  // linkify on for bare URLs, breaks off so single newlines don't become
  // <br> (matches CommonMark / Milkdown behaviour).
  const md = useMemo(() => {
    const instance = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      breaks: false,
    });
    // RAISE-29: render `* [ ]` / `* [x]` GFM task lists as checkboxes
    // in the preview. `enabled: true` removes the `disabled` attribute
    // on the input so the user can click to toggle — a click handler
    // on the preview pane container (further down in this component)
    // intercepts the change and rewrites the source markdown.
    // `label: true` wraps the item text in a <label> for accessibility
    // and gives us a clean CSS hook for completed-item greying.
    instance.use(markdownItTaskLists, { enabled: true, label: true });
    // RAISE-11: translate `<img src="assets/foo.png">` → raise-asset:// URL
    // at render time. The token's `src` attribute is the literal markdown
    // src; we mutate it before delegating to the default renderer.
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
  // Re-render the preview HTML whenever content OR the markdown path
  // changes — a Save As that gives the file a new dir means existing
  // relative paths point at a different location. The image rule reads
  // markdownPath via a ref so it doesn't appear in `md.render`'s
  // signature; eslint can't see that, hence the disable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => md.render(content), [md, content, markdownPath]);

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
  // `disabled` attribute so the input fires click events; we then
  // map the click back to source by counting which checkbox was
  // clicked among all task-list checkboxes in the preview.
  //
  // Source is updated via `onChange` — the parent re-renders the
  // preview from the new content, and the checkbox is shown in its
  // new state. Letting the browser handle the input's visual toggle
  // gives snappier feedback than preventing default and waiting on
  // the re-render.
  //
  // Limitation: the regex matches any `^[ \t]*[*\-+] \[[ xX]\]`
  // marker — including occurrences inside fenced code blocks, which
  // markdown-it-task-lists itself wouldn't render as checkboxes.
  // Files that mix real task lists with code-block-faux task lists
  // would index off-by-one. Acceptable for now; rare in practice.
  // Long-term fix would track source line numbers via markdown-it's
  // env / token.map and target the exact source line.
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const handleClick = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'checkbox') return;
      if (!target.classList.contains('task-list-item-checkbox')) return;
      const allCheckboxes = preview.querySelectorAll(
        'input.task-list-item-checkbox',
      );
      const index = Array.from(allCheckboxes).indexOf(target);
      if (index < 0) return;
      let count = 0;
      let updated = false;
      const next = contentRef.current.replace(
        TASK_MARKER_RE,
        (match, prefix: string, marker: string) => {
          if (count++ !== index) return match;
          updated = true;
          return `${prefix}[${marker === ' ' ? 'x' : ' '}]`;
        },
      );
      if (updated && next !== contentRef.current) {
        onChangeRef.current(next);
      }
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
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ width: `${splitPercent}%` }}
      >
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
       */}
      <div
        ref={previewRef}
        onScroll={handlePreviewScroll}
        className="raise-prose min-h-0 min-w-0 flex-1 overflow-auto px-6 py-8"
        style={{ width: `${100 - splitPercent}%` }}
        // RAISE-28: identity attribute used by App.tsx's
        // `context-preview-select-all` handler to scope a programmatic
        // text selection to this node — `webContents.selectAll()` would
        // otherwise select the entire renderer document.
        data-raise-preview-pane
        // markdown-it is configured with html:false so user-inline HTML is
        // escaped before reaching the DOM; safe to inject the rendered HTML.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
