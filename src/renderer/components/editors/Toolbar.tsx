import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useInstance } from '@milkdown/react';
import { callCommand } from '@milkdown/utils';
import { editorViewCtx } from '@milkdown/core';
import { listenerCtx } from '@milkdown/plugin-listener';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  wrapInHeadingCommand,
  createCodeBlockCommand,
  insertHrCommand,
  toggleLinkCommand,
  insertImageCommand,
} from '@milkdown/preset-commonmark';
import {
  toggleStrikethroughCommand,
  insertTableCommand,
} from '@milkdown/preset-gfm';

type MarkName = 'strong' | 'emphasis' | 'inlineCode' | 'strike_through';
type BlockName = 'h1' | 'h2' | 'h3' | 'bullet_list' | 'ordered_list' | 'blockquote' | '';

interface ToolbarButtonProps {
  onClick: () => void;
  active?: boolean;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}

function ToolbarButton({ onClick, active, title, disabled, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={[
        'flex h-7 min-w-[28px] items-center justify-center rounded px-2 text-xs font-semibold transition',
        active
          ? 'bg-interaction text-white'
          : 'text-body hover:bg-elevated hover:text-strong',
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-stroke" />;
}

interface ToolbarProps {
  /**
   * Resolves the active tab's saved markdown path, prompting Save As
   * for untitled tabs. Used by the image button — assets/ has no
   * anchor without a saved file location.
   */
  requireSavedPath?: () => Promise<string | null>;
}

export function Toolbar({ requireSavedPath }: ToolbarProps = {}) {
  const [loading, get] = useInstance();
  const [activeMarks, setActiveMarks] = useState<Record<MarkName, boolean>>({
    strong: false,
    emphasis: false,
    inlineCode: false,
    strike_through: false,
  });
  const [activeBlock, setActiveBlock] = useState<BlockName>('');

  const refreshState = useCallback(() => {
    const editor = get();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to, $from } = state.selection;
      const schema = state.schema;

      const next: Record<MarkName, boolean> = {
        strong: false,
        emphasis: false,
        inlineCode: false,
        strike_through: false,
      };
      (Object.keys(next) as MarkName[]).forEach((name) => {
        const mark = schema.marks[name];
        if (!mark) return;
        // For an empty (caret) selection, ProseMirror reports no mark via
        // rangeHasMark; check the active stored marks instead.
        if (from === to) {
          next[name] = !!mark.isInSet(state.storedMarks ?? $from.marks());
        } else {
          next[name] = state.doc.rangeHasMark(from, to, mark);
        }
      });
      setActiveMarks(next);

      const node = $from.parent;
      if (node.type.name === 'heading') {
        const level = (node.attrs as { level?: number }).level;
        if (level === 1) setActiveBlock('h1');
        else if (level === 2) setActiveBlock('h2');
        else if (level === 3) setActiveBlock('h3');
        else setActiveBlock('');
      } else if (
        node.type.name === 'bullet_list' ||
        node.type.name === 'ordered_list' ||
        node.type.name === 'blockquote'
      ) {
        setActiveBlock(node.type.name as BlockName);
      } else {
        // Walk up to find list/blockquote ancestors
        let depth = $from.depth;
        let found: BlockName = '';
        while (depth > 0) {
          const ancestor = $from.node(depth);
          if (
            ancestor.type.name === 'bullet_list' ||
            ancestor.type.name === 'ordered_list' ||
            ancestor.type.name === 'blockquote'
          ) {
            found = ancestor.type.name as BlockName;
            break;
          }
          depth--;
        }
        setActiveBlock(found);
      }
    });
  }, [get]);

  // Subscribe to selection / doc changes so the toolbar reflects what the
  // cursor is actually over. Milkdown's ListenerManager has no unsubscribe
  // API — every call appends — so we guard registration on the editor
  // identity to avoid stacking listeners if this effect re-runs.
  const registeredFor = useRef<unknown>(null);
  useEffect(() => {
    if (loading) return;
    const editor = get();
    if (!editor) return;
    refreshState();
    if (registeredFor.current === editor) return;
    registeredFor.current = editor;
    editor.action((ctx) => {
      const ll = ctx.get(listenerCtx);
      ll.selectionUpdated(() => refreshState());
      ll.updated(() => refreshState());
      ll.focus(() => refreshState());
    });
  }, [loading, refreshState, get]);

  const run = useCallback(
    // The exported $Command<T> types vary by payload (number for headings,
    // unknown for marks, etc.); accept the wider shape via a type-erased
    // interface so the toolbar can dispatch any command uniformly.
    (cmd: { key: unknown }, payload?: unknown) => {
      if (loading) return;
      get()?.action(callCommand(cmd.key as never, payload as never));
      // refreshState fires via the listener, so the toolbar updates itself.
    },
    [loading, get],
  );

  const handleLink = useCallback(() => {
    if (loading) return;
    const url = window.prompt('Link URL');
    if (!url) return;
    run(toggleLinkCommand, { href: url });
  }, [loading, run]);

  const handleImage = useCallback(async () => {
    if (loading) return;
    if (!requireSavedPath) return;
    const markdownPath = await requireSavedPath();
    if (!markdownPath) return; // User cancelled the Save-As prompt.
    const asset = await window.api.assets.pickAndImport(markdownPath);
    if (!asset) return; // User cancelled the file picker.
    const stem = asset.relPath.split('/').pop() ?? '';
    const alt = stem.replace(/\.[^.]+$/, '');
    run(insertImageCommand, { src: asset.relPath, alt });
  }, [loading, run, requireSavedPath]);

  const handleTable = useCallback(() => {
    run(insertTableCommand, { row: 3, col: 3 });
  }, [run]);

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-stroke bg-surface px-2"
    >
      <ToolbarButton
        title="Heading 1"
        active={activeBlock === 'h1'}
        onClick={() => run(wrapInHeadingCommand, 1)}
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        title="Heading 2"
        active={activeBlock === 'h2'}
        onClick={() => run(wrapInHeadingCommand, 2)}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        title="Heading 3"
        active={activeBlock === 'h3'}
        onClick={() => run(wrapInHeadingCommand, 3)}
      >
        H3
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        title="Bold (⌘B)"
        active={activeMarks.strong}
        onClick={() => run(toggleStrongCommand)}
      >
        <span className="font-bold">B</span>
      </ToolbarButton>
      <ToolbarButton
        title="Italic (⌘I)"
        active={activeMarks.emphasis}
        onClick={() => run(toggleEmphasisCommand)}
      >
        <span className="italic">I</span>
      </ToolbarButton>
      <ToolbarButton
        title="Strikethrough"
        active={activeMarks.strike_through}
        onClick={() => run(toggleStrikethroughCommand)}
      >
        <span className="line-through">S</span>
      </ToolbarButton>
      <ToolbarButton
        title="Inline code"
        active={activeMarks.inlineCode}
        onClick={() => run(toggleInlineCodeCommand)}
      >
        <span className="font-mono">{'<>'}</span>
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        title="Bullet list"
        active={activeBlock === 'bullet_list'}
        onClick={() => run(wrapInBulletListCommand)}
      >
        •
      </ToolbarButton>
      <ToolbarButton
        title="Numbered list"
        active={activeBlock === 'ordered_list'}
        onClick={() => run(wrapInOrderedListCommand)}
      >
        1.
      </ToolbarButton>
      <ToolbarButton
        title="Blockquote"
        active={activeBlock === 'blockquote'}
        onClick={() => run(wrapInBlockquoteCommand)}
      >
        ❝
      </ToolbarButton>
      <Divider />
      <ToolbarButton title="Code block" onClick={() => run(createCodeBlockCommand)}>
        <span className="font-mono text-[10px]">{'{ }'}</span>
      </ToolbarButton>
      <ToolbarButton title="Link" onClick={handleLink}>
        🔗
      </ToolbarButton>
      <ToolbarButton title="Image" onClick={handleImage}>
        🖼
      </ToolbarButton>
      <ToolbarButton title="Horizontal rule" onClick={() => run(insertHrCommand)}>
        —
      </ToolbarButton>
      <Divider />
      <ToolbarButton title="Insert table" onClick={handleTable}>
        ⊞
      </ToolbarButton>
    </div>
  );
}
