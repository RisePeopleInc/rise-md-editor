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

interface SplitViewProps {
  sourceRef?: Ref<SourceEditorHandle>;
  content: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
}

const MIN_PERCENT = 20;
const MAX_PERCENT = 80;
const DEFAULT_PERCENT = 50;

export function SplitView({ sourceRef, content, onChange, onCursorChange }: SplitViewProps) {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_PERCENT);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // markdown-it: html disabled (escape any raw HTML in input — local notes
  // don't tend to need it and we'd rather not let arbitrary tags through),
  // linkify on for bare URLs, breaks off so single newlines don't become
  // <br> (matches CommonMark / Milkdown behaviour).
  const md = useMemo(
    () =>
      new MarkdownIt({
        html: false,
        linkify: true,
        typographer: true,
        breaks: false,
      }),
    [],
  );
  const html = useMemo(() => md.render(content), [md, content]);

  // Scroll-sync lock: the side that initiated the scroll bumps a flag the
  // other side checks before mirroring, otherwise a single user scroll
  // bounces back and forth as each side reacts to the other.
  const syncing = useRef<'source' | 'preview' | null>(null);

  const handleSourceScroll = useCallback((scrollTop: number, scrollHeight: number) => {
    if (syncing.current === 'preview') return;
    const preview = previewRef.current;
    if (!preview) return;
    syncing.current = 'source';
    // Monaco reports scrollHeight including the overscroll area; use it as
    // an approximation of the proportional position. Clamp the divisor so
    // a tiny doc doesn't divide by zero.
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
      const ratio =
        target.scrollTop / Math.max(target.scrollHeight - target.clientHeight, 1);
      syncing.current = 'preview';
      // SourceEditor's setScrollTop accepts a pixel offset; we don't have
      // direct access to Monaco's scrollHeight from here, so mirror by
      // proportion against a reasonable estimate. Good enough for a casual
      // sync — exact line-anchor sync is a follow-up.
      // Use the Monaco editor's full content-line-height as the source max.
      // Without that, we conservatively project against 10000 px which lets
      // the editor settle to its actual position.
      const handle = (sourceRef as React.RefObject<SourceEditorHandle | null>)?.current;
      if (handle) {
        // setScrollTop snaps to the closest valid scroll inside Monaco,
        // so an over-projection is harmless.
        handle.setScrollTop(ratio * 1_000_000);
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
    <div ref={containerRef} className="flex h-full w-full bg-slate-950">
      <div className="min-h-0" style={{ width: `${splitPercent}%` }}>
        <SourceEditor
          ref={sourceRef}
          content={content}
          onChange={onChange}
          onCursorChange={onCursorChange}
          onScrollChange={handleSourceScroll}
        />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        onMouseDown={handleDragStart}
        className="w-1 shrink-0 cursor-col-resize bg-slate-800 hover:bg-slate-600 active:bg-brand-500"
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
