import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useInstance } from '@milkdown/react';
import { callCommand } from '@milkdown/utils';
import { editorViewCtx } from '@milkdown/core';
import { listenerCtx } from '@milkdown/plugin-listener';
import { TextSelection } from '@milkdown/prose/state';
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
type BlockName =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet_list'
  | 'ordered_list'
  | 'task_list'
  | 'blockquote'
  | '';

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
      } else {
        // Walk up to find list / blockquote / task ancestors. The
        // task-list check inspects the nearest list_item's `checked`
        // attribute (set by @milkdown/preset-gfm — `null` for
        // ordinary items, `true` / `false` for task items).
        let depth = $from.depth;
        let found: BlockName = '';
        while (depth > 0) {
          const ancestor = $from.node(depth);
          if (ancestor.type.name === 'list_item') {
            const checked = (ancestor.attrs as { checked?: boolean | null })
              .checked;
            if (checked != null) {
              found = 'task_list';
              break;
            }
          }
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
    const editor = get();
    if (!editor) return;
    const url = window.prompt('Link URL');
    if (!url) return;
    // RAISE-38: `toggleLinkCommand` is `toggleMark` under the hood —
    // it only adds the link mark to a non-empty selection. With a
    // collapsed cursor (no selection) it just sets ProseMirror's
    // "stored marks" so the next typed character gets the link
    // mark, which gives the user the (wrong) impression that the
    // button did nothing. Detect the collapsed-cursor case and
    // insert the URL itself as both the link's visible text AND
    // its href, with the inserted text selected so the user can
    // immediately retype to replace the visible text without
    // losing the link.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to, empty } = state.selection;
      if (!empty) {
        // Selection present: existing toggle behaviour.
        view.focus();
        run(toggleLinkCommand, { href: url });
        return;
      }
      const linkMark = state.schema.marks.link;
      if (!linkMark) return;
      const node = state.schema.text(url, [linkMark.create({ href: url })]);
      const tr = state.tr.replaceRangeWith(from, to, node);
      // Select the just-inserted text so a subsequent keystroke
      // replaces the visible URL with the user's intended link
      // text. ProseMirror's `TextSelection.create(doc, from, to)`
      // does exactly that.
      const insertEnd = from + node.nodeSize;
      const sel = TextSelection.create(tr.doc, from, insertEnd);
      view.dispatch(tr.setSelection(sel).scrollIntoView());
      view.focus();
    });
  }, [loading, run, get]);

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

  // RAISE-29: task list toggle. The GFM preset doesn't ship a
  // `wrapInTaskListCommand` — only an input rule that fires when
  // typing `[ ] `. To toggle from a button:
  //   - If the cursor is already inside a `list_item`, just flip the
  //     containing item's `checked` attribute between `null` (regular
  //     bullet) and `false` (unchecked task).
  //   - Otherwise (cursor in a paragraph), wrap in a bullet list
  //     first via `wrapInBulletListCommand`, then mark the resulting
  //     list_item as a task.
  //
  // The "already in a list?" pre-check is important: ProseMirror's
  // `wrapInBulletListCommand` is a *toggle* — calling it inside an
  // existing bullet list unwraps the surrounding list. Without the
  // check, clicking ☑ on an existing bullet would unwrap it (back
  // to a paragraph) and *then* the list_item lookup below would
  // find no ancestor, leaving the user with a paragraph and no
  // task. Skipping the wrap when already in a list_item turns the
  // button into a clean "convert this bullet to/from a task".
  const handleTaskList = useCallback(() => {
    if (loading) return;
    const editor = get();
    if (!editor) return;

    // Step 1: detect if we're already inside a list_item.
    let alreadyInListItem = false;
    editor.action((ctx) => {
      const { $from } = ctx.get(editorViewCtx).state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === 'list_item') {
          alreadyInListItem = true;
          return;
        }
      }
    });

    // Step 2: if not in a list, wrap into a bullet list first.
    if (!alreadyInListItem) {
      editor.action(callCommand(wrapInBulletListCommand.key));
    }

    // Step 3: flip the list_item's `checked` attribute.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const state = view.state;
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name !== 'list_item') continue;
        const pos = $from.before(depth);
        const node = state.doc.nodeAt(pos);
        const checked = (node?.attrs as { checked?: boolean | null }).checked;
        view.dispatch(
          state.tr.setNodeAttribute(
            pos,
            'checked',
            // Already a task → unmark (back to plain bullet).
            // Plain bullet → mark as unchecked task.
            checked == null ? false : null,
          ),
        );
        break;
      }
    });
  }, [loading, get]);

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
        title="Task list"
        active={activeBlock === 'task_list'}
        onClick={handleTaskList}
      >
        ☑
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
