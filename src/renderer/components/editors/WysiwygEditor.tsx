import { useCallback, useMemo, useRef, useState } from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { tooltipFactory } from '@milkdown/plugin-tooltip';
import { slashFactory } from '@milkdown/plugin-slash';
import { nord } from '@milkdown/theme-nord';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { Toolbar } from './Toolbar';

interface WysiwygEditorProps {
  content: string;
  onChange: (markdown: string) => void;
}

// Match a YAML frontmatter block at the very start of the document. The
// closing fence may or may not be followed by a newline.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface Split {
  frontmatter: string | null;
  body: string;
}

function splitFrontmatter(content: string): Split {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1] ?? '', body: content.slice(match[0].length) };
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
  initial: string;
  onMarkdownChange: (markdown: string) => void;
}

function MilkdownBody({ initial, onMarkdownChange }: MilkdownBodyProps) {
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

  return <Milkdown />;
}

export function WysiwygEditor({ content, onChange }: WysiwygEditorProps) {
  // Split once at mount; the parent keys this component by tab id, so a tab
  // switch fully remounts and we re-split against the new content.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialSplit = useMemo<Split>(() => splitFrontmatter(content), []);

  const [frontmatter, setFrontmatter] = useState<string | null>(initialSplit.frontmatter);
  const bodyRef = useRef<string>(initialSplit.body);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const emit = useCallback((nextFrontmatter: string | null, nextBody: string) => {
    onChangeRef.current(joinFrontmatter(nextFrontmatter, nextBody));
  }, []);

  const handleFrontmatterChange = useCallback(
    (next: string) => {
      setFrontmatter(next);
      emit(next, bodyRef.current);
    },
    [emit],
  );

  const handleBodyChange = useCallback(
    (markdown: string) => {
      bodyRef.current = markdown;
      // Read frontmatter from state via a closure capture — but we always
      // want the latest, so use the functional setter to re-emit.
      setFrontmatter((current) => {
        emit(current, markdown);
        return current;
      });
    },
    [emit],
  );

  return (
    <MilkdownProvider>
      <div className="flex h-full w-full flex-col bg-slate-950">
        <Toolbar />
        <div className="min-h-0 flex-1 overflow-auto">
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
              <MilkdownBody initial={initialSplit.body} onMarkdownChange={handleBodyChange} />
            </div>
          </div>
        </div>
      </div>
    </MilkdownProvider>
  );
}
