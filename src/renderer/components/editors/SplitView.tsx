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
import {
  SourceEditor,
  type CursorPosition,
  type SourceEditorHandle,
} from './SourceEditor';
import type { ImageInsertion, PasteImageSnapshot } from '../../state/imageInsert';
import { resolveAssetUrl } from '../../state/assetUrl';

interface SplitViewProps {
  sourceRef?: Ref<SourceEditorHandle>;
  content: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
  initialCursor?: CursorPosition;
  initialScrollTop?: number;
  /** Monaco theme id passed through to the source pane. */
  monacoThemeId: string;
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

export function SplitView({
  sourceRef,
  content,
  onChange,
  onCursorChange,
  initialCursor,
  initialScrollTop,
  monacoThemeId,
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

  return (
    <div ref={containerRef} className="flex h-full w-full bg-app">
      <div className="min-h-0" style={{ width: `${splitPercent}%` }}>
        <SourceEditor
          ref={sourceRef}
          content={content}
          onChange={onChange}
          onCursorChange={onCursorChange}
          onScrollChange={handleSourceScroll}
          initialCursor={initialCursor}
          initialScrollTop={initialScrollTop}
          monacoThemeId={monacoThemeId}
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
      <div
        ref={previewRef}
        onScroll={handlePreviewScroll}
        className="raise-prose min-h-0 flex-1 overflow-auto px-6 py-8"
        style={{ width: `${100 - splitPercent}%` }}
        // markdown-it is configured with html:false so user-inline HTML is
        // escaped before reaching the DOM; safe to inject the rendered HTML.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
