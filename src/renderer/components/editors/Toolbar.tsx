import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
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
  insertImageCommand,
} from '@milkdown/preset-commonmark';
import {
  toggleStrikethroughCommand,
  insertTableCommand,
} from '@milkdown/preset-gfm';
import type { Mark, MarkType, ResolvedPos } from '@milkdown/prose/model';

type MarkName = 'strong' | 'emphasis' | 'inlineCode' | 'strike_through';

/**
 * Find the contiguous range of a mark of `type` covering `$pos`.
 * Walks the parent textblock's children outward from the position
 * until it hits a sibling that doesn't carry the mark — the
 * standard prosemirror-utils "getMarkRange" recipe, inlined here
 * to avoid pulling in the dependency for one helper.
 */
function findLinkMarkRange(
  $pos: ResolvedPos,
  type: MarkType,
): { from: number; to: number; mark: Mark } | null {
  if (!$pos.parent.isTextblock) return null;
  const after = $pos.parent.childAfter($pos.parentOffset);
  // `childAfter` returns `{ node, index, offset }` — `node` may be
  // null if the position is at the very end of the parent. In that
  // case there's no text node carrying any mark, so no link.
  if (!after.node) return null;
  const mark = after.node.marks.find((m) => m.type === type);
  if (!mark) return null;
  let startIndex = after.index;
  let startPos = $pos.start() + after.offset;
  while (
    startIndex > 0 &&
    mark.isInSet($pos.parent.child(startIndex - 1).marks)
  ) {
    startIndex -= 1;
    startPos -= $pos.parent.child(startIndex).nodeSize;
  }
  let endPos = startPos + after.node.nodeSize;
  let endIndex = after.index + 1;
  while (
    endIndex < $pos.parent.childCount &&
    mark.isInSet($pos.parent.child(endIndex).marks)
  ) {
    endPos += $pos.parent.child(endIndex).nodeSize;
    endIndex += 1;
  }
  return { from: startPos, to: endPos, mark };
}

/**
 * Auto-prefix the URL scheme so a bare hostname (`www.google.com`)
 * or email (`steve@example.com`) becomes a working link instead of
 * a renderer-relative href that resolves to nothing.
 *
 *   - Already has a scheme (`http:`, `https:`, `mailto:`, anything
 *     matching `[a-z][a-z0-9+\-.]*:`) → leave alone.
 *   - Email-shaped (`local@host.tld`) → prepend `mailto:`.
 *   - Anything else → prepend `https://`.
 *
 * Worth noting: `https://` is the safe default in 2025+; bare
 * `http://` is rare for new content and most servers redirect
 * anyway. Keeping the default aligns with how Slack, Discord,
 * Gmail, and every other modern composer auto-link bare URLs.
 */
function ensureProtocol(url: string): string {
  if (!url) return url;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(url)) return url;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return `mailto:${url}`;
  return `https://${url}`;
}
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

/**
 * Imperative methods the toolbar exposes for parent components to
 * trigger toolbar actions outside of a button click. Currently used
 * by the WYSIWYG context menu's "Add Link…" item, which routes
 * through `WysiwygEditor`'s imperative handle into here.
 */
export interface ToolbarHandle {
  /**
   * Open the link-URL prompt as if the user had clicked the link
   * toolbar button. Captures the editor's current selection range
   * synchronously before opening the modal, so the right-click →
   * context-menu round-trip doesn't lose the user's selection.
   */
  promptLink: () => void;
}

interface ToolbarProps {
  ref?: Ref<ToolbarHandle>;
  /**
   * Resolves the active tab's saved markdown path, prompting Save As
   * for untitled tabs. Used by the image button — assets/ has no
   * anchor without a saved file location.
   */
  requireSavedPath?: () => Promise<string | null>;
}

export function Toolbar({ ref, requireSavedPath }: ToolbarProps = {}) {
  const [loading, get] = useInstance();
  const [activeMarks, setActiveMarks] = useState<Record<MarkName, boolean>>({
    strong: false,
    emphasis: false,
    inlineCode: false,
    strike_through: false,
  });
  const [activeBlock, setActiveBlock] = useState<BlockName>('');

  // RAISE-38: link insertion needs free-text input. We can't use
  // window.prompt because the renderer runs sandboxed (see the
  // comment in src/main/index.ts on assets:pick-and-import — same
  // constraint). Instead, manage an in-renderer modal whose state
  // also carries the selection range captured at button-click time
  // — Chromium collapses contentEditable selections when focus
  // moves to a modal input, so we snapshot before opening and act
  // on the snapshot when the user submits.
  const [linkPrompt, setLinkPrompt] = useState<{
    /** Action range — what gets replaced on submit. Equals the
     *  user's selection for the wrap-selection case, the link's
     *  full range for the edit-existing-link case, or the cursor
     *  position (from === to) for the bare-cursor insert case. */
    from: number;
    to: number;
    /** Original selection at modal-open time. Used by
     *  `cancelLinkPrompt` to restore the user's cursor/selection
     *  if they bail out — it differs from `from` / `to` in the
     *  edit-existing-link case (where the action range is the
     *  whole link but the user's cursor was just a single point
     *  inside it). */
    originalFrom: number;
    originalTo: number;
    /** True when the modal is editing an existing link mark. Used
     *  to switch the modal title and submit-button label. */
    isEditing: boolean;
  } | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const linkUrlInputRef = useRef<HTMLInputElement>(null);
  const linkTextInputRef = useRef<HTMLInputElement>(null);

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
    // Snapshot the selection range AND any existing link mark at
    // the cursor position — the input field that's about to take
    // focus will collapse the contentEditable selection in
    // Chromium, so we have to capture everything we'll need
    // synchronously before opening the modal.
    let from = -1;
    let to = -1;
    let originalFrom = -1;
    let originalTo = -1;
    let isEditing = false;
    let initialText = '';
    let initialUrl = '';
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const sel = state.selection;
      // Always capture the user's actual selection — used for
      // restoring on cancel even if the action range gets
      // expanded below.
      originalFrom = sel.from;
      originalTo = sel.to;
      const linkType = state.schema.marks.link;
      if (!linkType) return;
      // Look for an existing link mark at the current $from. If
      // there's one, expand the working range to span the entire
      // link — the user's intent when invoking the link command on
      // a position inside an existing link is "edit this link",
      // not "create a new link starting at the caret".
      const range = findLinkMarkRange(sel.$from, linkType);
      if (range) {
        from = range.from;
        to = range.to;
        initialText = state.doc.textBetween(from, to);
        initialUrl =
          (range.mark.attrs as { href?: string }).href ?? '';
        isEditing = true;
        return;
      }
      // No existing link at $from — use the user's actual
      // selection. With a non-empty selection, prefill the link
      // text from the selected content; with a collapsed cursor,
      // both fields start empty.
      from = sel.from;
      to = sel.to;
      if (!sel.empty) initialText = state.doc.textBetween(from, to);
    });
    if (from < 0) return;
    setLinkText(initialText);
    setLinkUrl(initialUrl);
    setLinkPrompt({ from, to, originalFrom, originalTo, isEditing });
  }, [loading, get]);

  const cancelLinkPrompt = useCallback(() => {
    const captured = linkPrompt;
    setLinkPrompt(null);
    setLinkUrl('');
    setLinkText('');
    const editor = get();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Restore the original cursor / selection that the user
      // had when they opened the modal. Chromium collapses the
      // contentEditable selection when focus moves to a modal
      // input, so without this restore the user is left with an
      // empty selection after a cancel — particularly bad in the
      // "select text → click toolbar Link → change mind" flow,
      // where the user expects to still have their selection.
      //
      // Note we restore `originalFrom` / `originalTo` (the user's
      // actual selection at modal-open) rather than `from` / `to`
      // (the action range, which may span an entire link in the
      // edit-existing-link flow).
      if (captured) {
        const { originalFrom, originalTo } = captured;
        const max = view.state.doc.content.size;
        const safeFrom = Math.min(Math.max(originalFrom, 0), max);
        const safeTo = Math.min(Math.max(originalTo, 0), max);
        const sel =
          safeFrom !== safeTo
            ? TextSelection.create(view.state.doc, safeFrom, safeTo)
            : TextSelection.near(view.state.doc.resolve(safeFrom));
        view.dispatch(view.state.tr.setSelection(sel));
      }
      view.focus();
    });
  }, [get, linkPrompt]);

  const submitLinkPrompt = useCallback(() => {
    const rawUrl = linkUrl.trim();
    if (!rawUrl || !linkPrompt) {
      cancelLinkPrompt();
      return;
    }
    // Auto-prefix the protocol if the user typed a bare hostname
    // (`www.example.com`) or an email address. Without this the
    // resulting `<a href="www.example.com">` is non-functional —
    // browsers resolve the href relative to the current document
    // (which under rise-md-asset:// produces nothing useful), and
    // mailto: discoverability is poor for casual users.
    const url = ensureProtocol(rawUrl);
    // Visible text falls back to the URL when the user leaves the
    // text field empty — avoids creating an invisible / zero-width
    // link, and matches the previous "URL is its own visible text"
    // behaviour for the no-selection case.
    const text = linkText.trim() || rawUrl;
    const editor = get();
    if (!editor) return;
    const { from, to } = linkPrompt;
    setLinkPrompt(null);
    setLinkUrl('');
    setLinkText('');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const linkMark = state.schema.marks.link;
      if (!linkMark) return;
      // Preserve any other marks active at the start of the
      // captured range — bold / italic / inline-code / etc. — so
      // editing a `**[link](url)**` (bold link) doesn't silently
      // strip the bold. Filter out the existing `link` mark so we
      // can apply a fresh one with the user's new href.
      //
      // Limitation: only the marks at `from` are preserved. If the
      // captured range has heterogeneous marks (e.g. half bold,
      // half plain), the entire replacement gets the marks from
      // the start. Acceptable simplification — the user is
      // explicitly typing new flat text in the modal, so any
      // sub-range mark variation in the original would have been
      // collapsed regardless.
      const $from = state.doc.resolve(from);
      const surroundingMarks = $from
        .marks()
        .filter((m) => m.type !== linkMark);
      // Single transaction for both add and edit: replace the
      // captured [from, to] range with a fresh text node carrying
      // the link mark + preserved surrounding marks. Handles all
      // three flows uniformly:
      //   - editing an existing link (range spans the link)
      //   - wrapping a selection (range spans the selection)
      //   - inserting at a collapsed cursor (range is empty)
      const node = state.schema.text(text, [
        ...surroundingMarks,
        linkMark.create({ href: url }),
      ]);
      const tr = state.tr.replaceRangeWith(from, to, node);
      // Place the caret at the end of the inserted link so the
      // user can keep typing immediately after.
      const insertEnd = from + node.nodeSize;
      tr.setSelection(TextSelection.create(tr.doc, insertEnd));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    });
  }, [linkUrl, linkText, linkPrompt, get, cancelLinkPrompt]);

  // Auto-focus the right input when the modal opens. If the text
  // field is empty (e.g. no selection, no existing link) we focus
  // there — the user needs to type both fields. Otherwise focus
  // the URL field (the more common thing to fill or edit).
  useEffect(() => {
    if (linkPrompt) {
      const id = requestAnimationFrame(() => {
        if (linkText.length === 0) {
          linkTextInputRef.current?.focus();
        } else {
          linkUrlInputRef.current?.focus();
          linkUrlInputRef.current?.select();
        }
      });
      return () => cancelAnimationFrame(id);
    }
    return undefined;
    // linkText is intentionally omitted from deps — its value is
    // captured at modal-open time and shouldn't refocus on every
    // keystroke as the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkPrompt]);

  // RAISE-38: expose `promptLink()` so the WYSIWYG context menu
  // (right-click → Add Link…) can trigger the same flow as the
  // toolbar button. Forwarded through `WysiwygEditor`'s imperative
  // handle to App.tsx's menu-action dispatcher.
  useImperativeHandle(
    ref,
    () => ({
      promptLink: handleLink,
    }),
    [handleLink],
  );

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
    <>
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
      {linkPrompt !== null && (
        <div
          // RAISE-38: link prompt (window.prompt is suppressed in the
          // sandboxed renderer, so we render a small in-app modal
          // instead). Backdrop closes on click; the inner card stops
          // propagation so clicking the inputs doesn't dismiss.
          role="dialog"
          aria-modal="true"
          aria-label={linkPrompt.isEditing ? 'Edit link' : 'Insert link'}
          onClick={cancelLinkPrompt}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              submitLinkPrompt();
            }}
            className="flex min-w-[420px] flex-col gap-3 rounded-[var(--rise-radius-card)] border border-stroke bg-app p-4 shadow-[var(--rise-shadow-depth-1)]"
          >
            <h2 className="text-sm font-semibold text-strong">
              {linkPrompt.isEditing ? 'Edit link' : 'Insert link'}
            </h2>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold text-strong">Text</span>
              <input
                ref={linkTextInputRef}
                type="text"
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelLinkPrompt();
                  }
                }}
                placeholder="Display text (defaults to the URL)"
                className="rounded border border-stroke bg-surface px-3 py-1.5 text-sm text-strong focus:border-interaction focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold text-strong">URL</span>
              <input
                ref={linkUrlInputRef}
                type="text"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelLinkPrompt();
                  }
                }}
                placeholder="https://example.com or name@example.com"
                className="rounded border border-stroke bg-surface px-3 py-1.5 text-sm text-strong focus:border-interaction focus:outline-none"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelLinkPrompt}
                className="rounded border border-stroke px-3 py-1 text-sm text-strong hover:bg-elevated"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!linkUrl.trim()}
                className="rounded bg-interaction px-3 py-1 text-sm font-semibold text-white hover:bg-interaction-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {linkPrompt.isEditing ? 'Update' : 'Insert'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
