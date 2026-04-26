import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history, undoCommand, redoCommand } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { tooltipFactory } from '@milkdown/plugin-tooltip';
import { slashFactory } from '@milkdown/plugin-slash';
import { nord } from '@milkdown/theme-nord';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';
import { callCommand } from '@milkdown/utils';
import { Toolbar } from './Toolbar';

export interface WysiwygEditorHandle {
  triggerUndo: () => void;
  triggerRedo: () => void;
  getScrollTop: () => number;
  setScrollTop: (top: number) => void;
}

interface WysiwygEditorProps {
  ref?: Ref<WysiwygEditorHandle>;
  content: string;
  onChange: (markdown: string) => void;
  /** Restored on mount via the scroll-container ref. */
  initialScrollTop?: number;
}

// Match a YAML frontmatter block at the very start of the document. The
// closing fence may or may not be followed by a newline.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface Split {
  frontmatter: string | null;
  body: string;
}

function splitFrontmatter(content: string): Split {
  // Strip a leading UTF-8 BOM — fs.readFile('utf-8') doesn't, and a BOM
  // would push the `---` past the regex's `^` anchor and we'd miss the
  // frontmatter on files saved by Notepad / older Windows tools.
  const stripped = content.replace(/^\uFEFF/, '');
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: stripped };
  return { frontmatter: match[1] ?? '', body: stripped.slice(match[0].length) };
}

function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  return `---\n${frontmatter}\n---\n\n${body}`;
}

// Tooltip / slash plugins in Milkdown v7 are factory-created so each
// instance can have its own provider UI. We don't ship custom UIs yet —
// the factories register the plugin slots so the keystroke / typing hooks
// are wired and downstream features (e.g., a /-command menu) can plug in.
const tooltipPlugin = tooltipFactory('raise-tooltip');
const slashPlugin = slashFactory('raise-slash');

interface MilkdownBodyProps {
  ref?: Ref<WysiwygEditorHandle>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  initial: string;
  onMarkdownChange: (markdown: string) => void;
}

function MilkdownBody({
  ref,
  scrollContainerRef,
  initial,
  onMarkdownChange,
}: MilkdownBodyProps) {
  // Hold the latest callback in a ref so the editor's listener (registered
  // once on mount) always invokes the current handler, even if the parent
  // re-renders with a new closure.
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;

  useEditor((root) =>
    Editor.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initial);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prev) => {
          if (markdown === prev) return;
          onChangeRef.current(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(history)
      .use(clipboard)
      .use(cursor)
      .use(tooltipPlugin)
      .use(slashPlugin),
  );

  // Bridge the imperative handle to Milkdown's history commands. The menu's
  // CmdOrCtrl+Z accelerator otherwise reaches editorRef (the SourceEditor
  // ref) and silently no-ops in WYSIWYG mode.
  const [, get] = useInstance();
  useImperativeHandle(
    ref,
    () => ({
      triggerUndo: () => get()?.action(callCommand(undoCommand.key)),
      triggerRedo: () => get()?.action(callCommand(redoCommand.key)),
      getScrollTop: () => scrollContainerRef.current?.scrollTop ?? 0,
      setScrollTop: (top) => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = top;
        }
      },
    }),
    [get, scrollContainerRef],
  );

  return <Milkdown />;
}

export function WysiwygEditor({
  ref,
  content,
  onChange,
  initialScrollTop,
}: WysiwygEditorProps) {
  // Split once at mount; the parent keys this component by tab id + load
  // epoch, so a tab switch or re-open of the same file fully remounts and
  // we re-split against the new content.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialSplit = useMemo<Split>(() => splitFrontmatter(content), []);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Capture the initial scrollTop on mount so the restore effect (below)
  // runs against the value that was current when the component mounted.
  const initialScrollTopRef = useRef(initialScrollTop);

  // Restore scroll position once Milkdown has finished its initial layout.
  // Defer to the next frame so scrollHeight is meaningful — setting it
  // synchronously could clamp to 0 before the editor renders.
  useEffect(() => {
    const container = scrollContainerRef.current;
    const target = initialScrollTopRef.current;
    if (!container || target === undefined || target === 0) return;
    const id = requestAnimationFrame(() => {
      container.scrollTop = target;
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const [frontmatter, setFrontmatter] = useState<string | null>(initialSplit.frontmatter);
  // Mirror the React state in a ref so handleBodyChange can read the latest
  // frontmatter without a setState side-effect — strict-mode-double-invoke
  // would otherwise double-fire onChange per keystroke.
  const frontmatterRef = useRef<string | null>(initialSplit.frontmatter);
  const bodyRef = useRef<string>(initialSplit.body);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const emit = useCallback((nextFrontmatter: string | null, nextBody: string) => {
    onChangeRef.current(joinFrontmatter(nextFrontmatter, nextBody));
  }, []);

  const handleFrontmatterChange = useCallback(
    (next: string) => {
      frontmatterRef.current = next;
      setFrontmatter(next);
      emit(next, bodyRef.current);
    },
    [emit],
  );

  const handleBodyChange = useCallback(
    (markdown: string) => {
      bodyRef.current = markdown;
      emit(frontmatterRef.current, markdown);
    },
    [emit],
  );

  return (
    <MilkdownProvider>
      <div className="flex h-full w-full flex-col bg-slate-950">
        <Toolbar />
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[720px] px-6 py-8">
            {frontmatter !== null && (
              <textarea
                value={frontmatter}
                onChange={(e) => handleFrontmatterChange(e.target.value)}
                spellCheck={false}
                aria-label="YAML frontmatter"
                className="raise-frontmatter mb-6 block w-full resize-y rounded border border-slate-700 bg-slate-900/60 p-3 font-mono text-xs leading-relaxed text-slate-200 focus:border-brand-500 focus:outline-none"
                rows={Math.max(3, frontmatter.split('\n').length + 1)}
              />
            )}
            <div className="raise-prose">
              <MilkdownBody
                ref={ref}
                scrollContainerRef={scrollContainerRef}
                initial={initialSplit.body}
                onMarkdownChange={handleBodyChange}
              />
            </div>
          </div>
        </div>
      </div>
    </MilkdownProvider>
  );
}
