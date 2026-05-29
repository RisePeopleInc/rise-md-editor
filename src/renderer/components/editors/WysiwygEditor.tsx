import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  serializerCtx,
} from '@milkdown/core';
import { Plugin, Selection, TextSelection } from '@milkdown/prose/state';
import {
  Fragment,
  Slice,
  type Mark,
  type MarkType,
  type Node as ProseNode,
  type ResolvedPos,
} from '@milkdown/prose/model';
import { commonmark, insertImageCommand } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history, undoCommand, redoCommand } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { tooltipFactory } from '@milkdown/plugin-tooltip';
import { slashFactory } from '@milkdown/plugin-slash';
import { nord } from '@milkdown/theme-nord';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';
import { $prose, callCommand } from '@milkdown/utils';
import { Toolbar, type ToolbarHandle } from './Toolbar';
import { LinkPopover } from './LinkPopover';
import {
  firstImageItem,
  pickImageFiles,
  snapshotPasteItem,
  type ImageInsertion,
  type PasteImageSnapshot,
} from '../../state/imageInsert';
import { resolveAssetUrl } from '../../state/assetUrl';
import { getMarkdownFromClipboard, unescapeHeadingNumberDot } from '../../state/clipboardPaste';
import { computeInsertedPath, getTreeDragSourcePath, isImagePath } from '../../state/sidebarDrop';
import {
  commentDecorationsPlugin,
  unescapeCommentDelimiters,
  unescapeIndentEntities,
} from '../../state/commentDecorations';
import { stripEmptyParagraphMarkers } from '../../state/emptyParagraphMarker';
import { emojiToShortcodes, gemojiPlugins } from '../../state/gemojiNode';
import { joinFrontmatter, splitFrontmatter, type FrontmatterSplit } from '../../state/markdown';
import { autolinkOnTypePlugin, PLUGIN_KEY as autolinkPluginKey } from '../../state/autolinkOnType';
import { remarkUnautolinkPlugin } from '../../state/remarkUnautolink';
import { stripBrowserAutolinkPlugin } from '../../state/stripBrowserAutolink';
import { trailingParagraphPlugin } from '../../state/trailingParagraph';

export interface WysiwygEditorHandle {
  triggerUndo: () => void;
  triggerRedo: () => void;
  getScrollTop: () => number;
  setScrollTop: (top: number) => void;
  /** ProseMirror selection-from offset (absolute char position in the doc). */
  getCursorOffset: () => number;
  /** Move the caret. Clamped to the current doc size. */
  setCursorOffset: (offset: number) => void;
  /**
   * RAISE-28: serialize the current selection to markdown and write
   * to the system clipboard. With no selection, copies the entire
   * doc. Resolves once the clipboard write completes.
   */
  copyAsMarkdown: () => Promise<void>;
  /**
   * RAISE-38: open the link-URL prompt as if the user clicked the
   * link toolbar button. Routed here from App.tsx's menu-action
   * dispatcher so the WYSIWYG context menu's "Add Link…" item can
   * surface the same modal as the toolbar.
   */
  promptLink: () => void;
  /**
   * RAISE-51: insert raw text at the current selection — no link
   * marks, no inline formatting marks, no tables / lists /
   * headings, just plain text runs with `hard_break` between
   * newlines. Drives the Paste and Match Style flow
   * (Cmd/Ctrl+Shift+V) which bypasses the regular paste pipeline's
   * markdown / Turndown / image branches.
   */
  pastePlain: (text: string) => void;
  /**
   * RAISE-86: open the link the caret is currently inside in the
   * user's default external browser. Routed from the WYSIWYG context
   * menu's "Open Link" item; the popover's Open button calls the
   * internal handler directly. No-op when the caret isn't on a link.
   */
  openLink: () => void;
  /**
   * RAISE-86: open the link popover's inline edit field for the link
   * the caret is currently inside. Routed from the context menu's
   * "Edit Link" item — surfaces the same edit UI the popover's Edit
   * button shows. No-op when the caret isn't on a link.
   */
  editLink: () => void;
  /**
   * RAISE-86: strip the link mark the caret is currently inside,
   * keeping the visible text. Routed from the context menu's "Remove
   * Link" item; the popover's Remove button calls the internal
   * handler directly. No-op when the caret isn't on a link.
   */
  removeLink: () => void;
}

interface WysiwygEditorProps {
  ref?: Ref<WysiwygEditorHandle>;
  content: string;
  onChange: (markdown: string) => void;
  /**
   * RAISE-55 follow-up: invoked instead of `onChange` when the editor
   * emits markdown before the user has interacted with the tab. Lets
   * fileState capture the editor's post-parse / post-init-transaction
   * markdown as the dirty-comparison baseline, so cosmetic round-trip
   * drift (autolinks added to bare URLs, list-marker normalization,
   * etc.) doesn't show as dirty. After the first input event on this
   * editor — keydown / paste / drop / `input` from anywhere inside
   * the WysiwygEditor wrapper, including the frontmatter textarea —
   * all subsequent emits flow through `onChange` as real user edits.
   */
  onMarkdownBaseline?: (markdown: string) => void;
  /** Restored on mount via the scroll-container ref. */
  initialScrollTop?: number;
  /** ProseMirror cursor offset to restore once Milkdown is mounted. */
  initialCursorOffset?: number;
  /**
   * Image-drop callback. Should save the dropped images and return the
   * markdown insertions to dispatch into the editor at the drop point.
   */
  onImageDrop?: (files: File[]) => Promise<ImageInsertion[]>;
  /**
   * Image-paste callback. Should save the clipboard image and return
   * the markdown insertion (or null) to dispatch at the cursor.
   */
  onImagePaste?: (snapshot: PasteImageSnapshot) => Promise<ImageInsertion | null>;
  /** Path of the markdown file currently in the editor — used to
   *  resolve image relPaths against the right base for image clicks. */
  markdownPath: string | null;
  /** "View full size" handler for an image clicked in WYSIWYG. */
  onOpenImage?: (relPath: string) => void;
  /** Used by the toolbar's image button (file picker → assets/ copy). */
  requireSavedPath?: () => Promise<string | null>;
}

// Tooltip / slash plugins in Milkdown v7 are factory-created so each
// instance can have its own provider UI. We don't ship custom UIs yet —
// the factories register the plugin slots so the keystroke / typing hooks
// are wired and downstream features (e.g., a /-command menu) can plug in.
const tooltipPlugin = tooltipFactory('raise-tooltip');
const slashPlugin = slashFactory('raise-slash');

/**
 * RAISE-46: container types whose content schema is *inline-only*
 * — pasting a top-level block (e.g. a `paragraph` produced by
 * markdown parse) into one of these breaks the surrounding
 * structure. Detected by walking up the resolved-pos path; any
 * match means the paste destination is "inline-only" and a
 * block-shaped slice would need to be flattened to inline content
 * before insertion.
 *
 * `table_cell` / `table_header` are the bug-report's worst case —
 * dropping a paragraph into a cell ejects the cell content as a
 * top-level paragraph, fragmenting the surrounding table.
 *
 * `heading` is included on the same shape: ProseMirror's heading
 * schema is inline-only; pasting a paragraph into the middle of
 * an `<h2>` would split the heading. The bug report's AC names
 * this case explicitly.
 */
const INLINE_ONLY_CONTAINERS = new Set(['table_cell', 'table_header', 'heading']);

/**
 * Inspect the resolved-pos chain to decide whether the paste
 * destination's container only allows inline content. Walks from
 * the deepest enclosing node outward; the first match wins.
 */
function isInlineOnlyContext(from: ResolvedPos): boolean {
  for (let depth = from.depth; depth >= 0; depth--) {
    if (INLINE_ONLY_CONTAINERS.has(from.node(depth).type.name)) return true;
  }
  return false;
}

/**
 * Flatten a parsed-doc node into a Fragment of inline-only content
 * suitable for splicing into a table cell / heading without
 * fragmenting the surrounding block structure (RAISE-46).
 *
 * Walks the parsed doc gathering text and inline atoms (image,
 * hard_break, etc.), inserting a `hard_break` between adjacent
 * paragraphs so a multi-paragraph paste lands as
 * "line one<br>line two" inside a cell — matches the AC's
 * "preferred" outcome for multi-line cell paste, instead of
 * either fragmenting the table or silently dropping all but the
 * first paragraph.
 *
 * Block-only content (tables, code_block, lists nested inside the
 * paste) gets flattened to its inner text. That's a deliberate
 * trade — pasting a fenced code block into a table cell can't
 * produce a `<code>` block inside the cell (schema rejects it),
 * so we keep the visible text and drop the formatting. Same for
 * nested tables / lists. Out-of-scope edge cases for this bug;
 * the dominant flow is "user types text in another app and
 * pastes it into a single cell".
 */
function flattenToInline(parsed: ProseNode, schema: ProseNode['type']['schema']): Fragment {
  const inlineNodes: ProseNode[] = [];
  // RAISE-51 review caught this: node name is `hardbreak`
  // (Milkdown's commonmark preset name), not `hard_break` (the
  // standard ProseMirror name). Pre-fix the lookup always
  // returned undefined under Milkdown's schema and the
  // `if (breakType)` guard below was always false — so multi-
  // paragraph paste into a table cell silently dropped its line
  // breaks instead of getting `<br>`-separated runs as the
  // surrounding comment claims. Latent bug from RAISE-46 caught
  // during RAISE-51 paste-plain work.
  const breakType = schema.nodes['hardbreak'];
  let firstParagraph = true;

  parsed.content.forEach((blockNode) => {
    // Insert a hard_break between paragraphs so the user's
    // line structure survives as visible breaks in the cell.
    if (!firstParagraph && breakType) {
      inlineNodes.push(breakType.create());
    }
    firstParagraph = false;
    blockNode.descendants((node) => {
      if (node.isText) {
        inlineNodes.push(node);
        return false;
      }
      // Inline atoms (image, hard_break, mention, etc.) ride
      // through unchanged.
      if (node.isInline && !node.isText) {
        inlineNodes.push(node);
        return false;
      }
      // For nested block content (e.g. a table cell pasted into
      // another table cell — pathological but possible), recurse;
      // the descendants() walk reaches the leaf inline content
      // eventually.
      return true;
    });
  });

  return Fragment.from(inlineNodes);
}

/**
 * RAISE-86: the contiguous span a link mark covers, plus its href.
 * Resolved from a collapsed selection so the popover can anchor to
 * the whole link (not just the click point) and so Edit / Remove can
 * select the full range before running their commands.
 */
interface LinkMarkRange {
  from: number;
  to: number;
  href: string;
  mark: Mark;
}

/**
 * RAISE-86: find the contiguous range of a link mark covering `$pos`,
 * returning its bounds + href. Same prosemirror-utils "getMarkRange"
 * recipe inlined in Toolbar.tsx (`findLinkMarkRange`) — re-implemented
 * here rather than shared because the two call sites want slightly
 * different return shapes (the toolbar wants the `Mark`; we also want
 * the resolved `href`), and the dependency is one small pure walk.
 *
 * Walks the parent textblock's children outward from the position
 * until it hits a sibling that no longer carries the mark.
 */
function resolveLinkMarkRange($pos: ResolvedPos, type: MarkType): LinkMarkRange | null {
  if (!$pos.parent.isTextblock) return null;
  // Look at the text node on BOTH sides of the position. A collapsed
  // caret sitting at the boundary between a link and plain text
  // resolves `childAfter` to the plain text — so we also check
  // `childBefore` and prefer whichever carries the link mark. This is
  // what makes "click at the end of a link" still detect the link.
  const after = $pos.parent.childAfter($pos.parentOffset);
  const before = $pos.parent.childBefore($pos.parentOffset);
  const pick = (() => {
    if (after.node?.marks.some((m) => m.type === type)) return after;
    if (before.node?.marks.some((m) => m.type === type)) return before;
    return null;
  })();
  if (!pick || !pick.node) return null;
  const mark = pick.node.marks.find((m) => m.type === type);
  if (!mark) return null;

  let startIndex = pick.index;
  let startPos = $pos.start() + pick.offset;
  while (startIndex > 0 && mark.isInSet($pos.parent.child(startIndex - 1).marks)) {
    startIndex -= 1;
    startPos -= $pos.parent.child(startIndex).nodeSize;
  }
  let endPos = startPos + pick.node.nodeSize;
  let endIndex = pick.index + 1;
  while (endIndex < $pos.parent.childCount && mark.isInSet($pos.parent.child(endIndex).marks)) {
    endPos += $pos.parent.child(endIndex).nodeSize;
    endIndex += 1;
  }
  const href = mark.attrs['href'];
  if (typeof href !== 'string' || !href) return null;
  return { from: startPos, to: endPos, href, mark };
}

/**
 * RAISE-86: popover state. `href` / `from` / `to` describe the link
 * mark the caret is currently inside; `x` / `y` are the viewport-fixed
 * anchor (link's bounding rect, bottom-left + a small gap). `null`
 * means no link under the caret → popover hidden.
 */
interface LinkPopoverState {
  href: string;
  from: number;
  to: number;
  x: number;
  /** Anchor's bottom edge — the popover's default (below-link) top. */
  y: number;
  /** Anchor's top edge — lets the popover flip ABOVE the link when
   *  placing it below would overflow the viewport bottom (RAISE-86 #4). */
  anchorTop: number;
  /**
   * RAISE-86: when true the popover opens straight into its inline
   * edit field rather than the read view. Set by the context menu's
   * "Edit Link" route (and bumped via `editNonce` so a repeat request
   * on the same link re-opens the field). Plain click / arrow-key
   * detection leaves it false.
   */
  startEditing?: boolean;
  /** Forces LinkPopover to remount when an Edit request repeats on the
   *  same link (so the edit field re-opens even if it was just closed). */
  editNonce?: number;
}

interface MilkdownBodyProps {
  ref?: Ref<WysiwygEditorHandle>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * RAISE-38: ref to the Toolbar (which is rendered in
   * WysiwygEditor's tree, sibling to MilkdownBody, not inside it).
   * MilkdownBody owns the imperative handle exposed to App.tsx,
   * and one of those methods (`promptLink`) needs to delegate
   * into the toolbar — so the toolbar ref is created in
   * WysiwygEditor and passed in here.
   */
  toolbarRef: React.RefObject<ToolbarHandle | null>;
  initial: string;
  initialCursorOffset?: number;
  onMarkdownChange: (markdown: string) => void;
  /**
   * RAISE-55 follow-up: invoked instead of `onMarkdownChange` when the
   * Milkdown listener fires its post-parse / post-init-transaction
   * emit BEFORE any user input on the WysiwygEditor wrapper. Routed by
   * `hasUserInteractedRef` below. See WysiwygEditorProps for the full
   * rationale.
   */
  onMarkdownBaseline?: (markdown: string) => void;
  /**
   * RAISE-55 follow-up: owned by the WysiwygEditor parent and set to
   * `true` by an `input`-event listener on the parent's wrapper div.
   * MilkdownBody's `markdownUpdated` callback reads `.current` at emit
   * time to decide whether the emit is an init transaction (route
   * through `onMarkdownBaseline`) or a real user edit (route through
   * `onMarkdownChange`).
   */
  hasUserInteractedRef: React.MutableRefObject<boolean>;
  onImageDrop?: (files: File[]) => Promise<ImageInsertion[]>;
  onImagePaste?: (snapshot: PasteImageSnapshot) => Promise<ImageInsertion | null>;
  /** Used by the image NodeView to resolve relative src → rise-md-asset:// URL. */
  markdownPath: string | null;
}

function MilkdownBody({
  ref,
  scrollContainerRef,
  toolbarRef,
  initial,
  initialCursorOffset,
  onMarkdownChange,
  onMarkdownBaseline,
  hasUserInteractedRef,
  onImageDrop,
  onImagePaste,
  markdownPath,
}: MilkdownBodyProps) {
  // Hold the latest callback in a ref so the editor's listener (registered
  // once on mount) always invokes the current handler, even if the parent
  // re-renders with a new closure.
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;
  const onBaselineRef = useRef(onMarkdownBaseline);
  onBaselineRef.current = onMarkdownBaseline;

  // Capture initial cursor offset in a ref so the listener (registered once
  // at editor creation) closes over the latest value rather than a stale
  // prop from a re-render.
  const initialCursorOffsetRef = useRef(initialCursorOffset);
  initialCursorOffsetRef.current = initialCursorOffset;

  // Image handlers go through refs too — the prosemirror plugin
  // registered in the editor's config closes over these once at
  // creation, so a ref keeps later renders' callbacks reachable.
  const onImageDropRef = useRef(onImageDrop);
  onImageDropRef.current = onImageDrop;
  const onImagePasteRef = useRef(onImagePaste);
  onImagePasteRef.current = onImagePaste;
  // Captured editor instance — needed inside the prosemirror handler
  // to dispatch insertImageCommand. useInstance() returns it once
  // creation finishes; we mirror into a ref so the handler can use it
  // without a re-render dependency.
  const editorInstanceRef = useRef<Editor | null>(null);
  // Same pattern for markdownPath — the image NodeView is registered
  // once at editor creation, so it reads the current value through a
  // ref instead of capturing the prop.
  const markdownPathRef = useRef(markdownPath);
  markdownPathRef.current = markdownPath;

  // RAISE-86: link popover. `linkPopover` drives the floating popover;
  // the `$prose` detection plugin (registered in the `.use(...)` chain
  // below) computes the cursor-in-link state after every transaction
  // and reports it through `setLinkPopoverRef` — a ref so the plugin's
  // long-lived `update(view)` closure always reaches the latest setter
  // (same pattern as the image handlers above). Click, arrow-key, and
  // any other selection change all flow through the same `update`.
  const [linkPopover, setLinkPopover] = useState<LinkPopoverState | null>(null);
  const setLinkPopoverRef = useRef(setLinkPopover);
  setLinkPopoverRef.current = setLinkPopover;
  // Mirror the popover state into a ref so the imperative handle's
  // link methods (openLink / editLink / removeLink), registered once,
  // can read the live `from`/`to`/`href` without a stale closure.
  const linkPopoverRef = useRef<LinkPopoverState | null>(null);
  linkPopoverRef.current = linkPopover;

  // RAISE-86 (#2 + #3): track the last pointer button and the
  // modifier-held state. `lastWasRightClickRef` lets the link-detection
  // plugin skip the popover for right-clicks (the context menu handles
  // those — showing both is redundant). The `data-modifier-held`
  // attribute drives a pointer cursor on ⌘/Ctrl-hover over a link (see
  // milkdown.css), signalling the "⌘-click to open" affordance.
  const lastWasRightClickRef = useRef(false);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const isMac = window.api.platform === 'darwin';
    const setModifier = (held: boolean) => {
      if (held) container.setAttribute('data-modifier-held', '');
      else container.removeAttribute('data-modifier-held');
    };
    const onMouseDownCapture = (e: MouseEvent) => {
      lastWasRightClickRef.current = e.button === 2;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Keyboard navigation isn't a right-click — let the popover show.
      lastWasRightClickRef.current = false;
      if (isMac ? e.key === 'Meta' : e.key === 'Control') setModifier(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isMac ? e.key === 'Meta' : e.key === 'Control') setModifier(false);
    };
    const onBlur = () => setModifier(false);
    container.addEventListener('mousedown', onMouseDownCapture, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      container.removeEventListener('mousedown', onMouseDownCapture, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [scrollContainerRef]);

  // RAISE-89: a click in the empty space BELOW the last block places the
  // caret at the end of the document (and focuses the editor) rather than
  // doing nothing. ProseMirror's contentEditable only fills its content
  // height, so clicks in the scroll container's trailing padding never
  // reach it — and a reader can't tell the last line apart from the empty
  // space beneath it. Guarded tightly: only act when the click landed
  // OUTSIDE the editable AND below its bottom edge, so clicks on content,
  // links, images, and side-margin / above-content areas fall through
  // untouched (the link / image / RAISE-87 handlers still win).
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleBelowContentClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const editor = editorInstanceRef.current;
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pmDom = view.dom as HTMLElement;
        if (pmDom.contains(target)) return; // click hit real editor content
        if (e.clientY <= pmDom.getBoundingClientRect().bottom) return; // not below
        const selection = Selection.atEnd(view.state.doc);
        view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
        view.focus();
      });
    };
    container.addEventListener('click', handleBelowContentClick);
    return () => container.removeEventListener('click', handleBelowContentClick);
  }, [scrollContainerRef]);

  useEditor((root) =>
    Editor.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initial);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prev) => {
          if (markdown === prev) return;
          // Two-stage serialize-side post-process. Both functions are
          // pure string -> string and idempotent; the order doesn't
          // matter functionally, but we run the cheaper one (empty-
          // paragraph-marker strip) first so emojiToShortcodes works
          // on a slightly smaller string.
          //
          // RAISE-37: `stripEmptyParagraphMarkers` drops Milkdown's
          // empty-paragraph round-trip marker (`<br />` lines that
          // paragraph.toMarkdown emits for empty middle paragraphs;
          // the paired remark plugin strips them on parse, but our
          // listener observes the raw serializer output before that
          // could happen, so they leak to disk).
          //
          // RAISE-34: `emojiToShortcodes` is the inverse of the
          // parse-side `remarkGemojiSubstitute`; converts emoji
          // characters back to `:name:` so source preserves the
          // shortcode form.
          //
          // RAISE-39: `unescapeHeadingNumberDot` undoes the `1\.`
          // escape that lands in heading lines on the WYSIWYG
          // round-trip after a Google Docs paste — cleanup at
          // paste time strips the Google-Docs escape but the
          // round-trip re-introduces it via mdast-util-to-
          // markdown's safe-escape patterns; this is the
          // belt-and-braces strip on the way to disk.
          //
          // RAISE-31: `unescapeCommentDelimiters` strips the
          // backslash that remark-stringify inserts in front of
          // `<!--` for inline-HTML safety AND the per-character
          // escapes the safe step adds inside the comment body
          // (`\[`, `\]`, `\(`, `\)`, etc.). Comments are
          // deliberately HTML-shaped so the escapes aren't doing
          // useful work; without this fix the source on disk
          // shows `\<!-- with \[a link\]\(http://x\) -->` and
          // round-trips that clutter back into WYSIWYG.
          //
          // RAISE-31: `unescapeIndentEntities` decodes `&#x20;`
          // back to a literal space. mdast-util-to-markdown emits
          // the entity for a *leading* paragraph space so commonmark
          // doesn't re-interpret it as an indented code block; our
          // typical case (`  // indented note`) ends up rendered as
          // `&#x20; // indented note` in source which is jarring.
          const processed = unescapeIndentEntities(
            unescapeCommentDelimiters(
              unescapeHeadingNumberDot(emojiToShortcodes(stripEmptyParagraphMarkers(markdown))),
            ),
          );
          // RAISE-55 follow-up: route the emit to the baseline path
          // when no user input has been observed on this WysiwygEditor
          // instance yet (the post-parse + post-init-transaction emit
          // from Milkdown's listener). After the first input event on
          // the editor's wrapper — keydown / paste / drop / `input`,
          // from either the body or the frontmatter textarea — every
          // subsequent emit is a real user edit and flows through
          // `onChange`. The parent owns the ref so frontmatter-side
          // interactions count too.
          if (hasUserInteractedRef.current) {
            onChangeRef.current(processed);
          } else if (onBaselineRef.current) {
            onBaselineRef.current(processed);
          } else {
            // Backstop: parent didn't wire `onMarkdownBaseline`. Fall
            // back to the user-edit callback so content still
            // propagates — slightly worse dirty-tracking than ideal
            // but no data loss.
            onChangeRef.current(processed);
          }
        });
        // Once Milkdown finishes its initial mount, focus the editor view
        // and (if we have a captured offset from a prior session in this
        // tab) jump the caret to it. WYSIWYG analogue of SourceEditor's
        // onMount cursor restore.
        //
        // RAISE-60 follow-up: previously this gated BOTH the focus and the
        // cursor restore behind `if (!offset) return`. That meant a freshly-
        // opened file in Edit mode (offset === 0) never received focus —
        // the user had to click in to start typing. And even with a saved
        // offset > 0, the cursor was positioned but the view wasn't
        // focused, so the first keystroke went to whatever document body
        // happened to have keyboard focus. Now always focus on mount; the
        // cursor-restore is the conditional part.
        ctx.get(listenerCtx).mounted((mountedCtx) => {
          const view = mountedCtx.get(editorViewCtx);
          const offset = initialCursorOffsetRef.current;
          if (offset) {
            const max = view.state.doc.content.size;
            const safe = Math.min(Math.max(offset, 0), max);
            const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, safe));
            view.dispatch(tr);
          }
          view.focus();
        });
        // RAISE-11: image drop / paste interception. ProseMirror's
        // editor view exposes `handleDrop` / `handlePaste` hooks that
        // run before the default behaviour — returning true tells
        // ProseMirror we handled it.
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          // RAISE-11: image NodeView. The default toDOM produces
          // `<img src="assets/foo.png">`, which Chromium tries to
          // resolve against the renderer's origin (file:// or
          // localhost) — broken icon. We rewrite to a
          // rise-md-asset:// URL at render time only; the stored src
          // attribute on the node stays as the original markdown
          // path so toMarkdown serializes it back correctly.
          nodeViews: {
            ...prev.nodeViews,
            image: (node) => {
              const dom = document.createElement('img');
              // Reasonable inline rendering — matches the WYSIWYG's
              // 720px content width without overflowing.
              dom.style.maxWidth = '100%';
              dom.style.height = 'auto';

              const applyAttrs = (n: typeof node): void => {
                const src = (n.attrs as { src?: string }).src ?? '';
                const alt = (n.attrs as { alt?: string }).alt ?? '';
                const title = (n.attrs as { title?: string | null }).title ?? '';
                // Stash the original (relative) src so the click-tooltip's
                // "View full size" can resolve via main's IPC. Without
                // this we'd lose the markdown-relative path.
                dom.setAttribute('data-asset-src', src);
                dom.src = resolveAssetUrl(markdownPathRef.current, src);
                dom.alt = alt;
                if (title) dom.title = title;
                else dom.removeAttribute('title');
              };
              applyAttrs(node);

              return {
                dom,
                // ProseMirror calls update on attribute changes (e.g.
                // undo/redo of an alt-text edit). Returning true tells
                // ProseMirror we handled it and the existing DOM can be
                // reused — without this it'd destroy + recreate the
                // NodeView per change.
                update(newNode) {
                  if (newNode.type.name !== 'image') return false;
                  applyAttrs(newNode);
                  return true;
                },
              };
            },
            // RAISE-29: list-item NodeView. The GFM preset extends the
            // listItem schema with a `checked: boolean | null` attribute —
            // `null` for normal list items, `true` / `false` for GFM
            // task-list items. The schema's default `toDOM` emits
            // `<li data-item-type="task" data-checked="...">content</li>`
            // with no checkbox UI and no click handler — that's left to
            // the consumer.
            //
            // We render an actual `<input type="checkbox">` that toggles
            // via `setNodeAttribute` so the markdown source flips
            // between `[ ]` and `[x]` on click. For non-task items
            // (checked == null) we fall back to a plain `<li>` with
            // ProseMirror's default styling — same shape as the
            // schema's baseSchema toDOM.
            list_item: (node, view, getPos) => {
              const li = document.createElement('li');
              const content = document.createElement('div');
              li.appendChild(content);

              const isTask = node.attrs.checked != null;
              let checkbox: HTMLInputElement | null = null;

              if (isTask) {
                checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.contentEditable = 'false';
                checkbox.classList.add('rise-md-task-checkbox');
                // Stop ProseMirror from interpreting the click as
                // selection-into-the-document — without this the
                // caret would jump to the start of the list item on
                // every checkbox click.
                checkbox.addEventListener('mousedown', (e) => {
                  e.stopPropagation();
                });
                // `change` fires AFTER the browser's native toggle, so
                // the visual checkbox state has already updated. Don't
                // preventDefault — letting the browser handle the
                // visual flip avoids a class of bugs where our
                // `applyAttrs` doesn't re-render the input fast enough
                // and the user sees a strikethrough on text but the
                // checkbox itself stays unchecked.
                checkbox.addEventListener('change', () => {
                  if (typeof getPos !== 'function') return;
                  const pos = getPos();
                  if (pos == null) return;
                  view.dispatch(view.state.tr.setNodeAttribute(pos, 'checked', checkbox!.checked));
                });
                li.insertBefore(checkbox, content);
              }

              const applyAttrs = (n: typeof node): void => {
                const checked = (n.attrs as { checked?: boolean | null }).checked ?? null;
                if (checked == null) {
                  li.removeAttribute('data-item-type');
                  li.removeAttribute('data-checked');
                } else {
                  li.dataset.itemType = 'task';
                  li.dataset.checked = String(checked);
                  if (checkbox) checkbox.checked = checked === true;
                }
              };
              applyAttrs(node);

              return {
                dom: li,
                contentDOM: content,
                update(newNode) {
                  if (newNode.type.name !== 'list_item') return false;
                  // Don't try to transition a NodeView between task ↔
                  // non-task in place — let ProseMirror remount us with
                  // the right shape (with or without the checkbox).
                  const newIsTask = (newNode.attrs as { checked?: boolean | null }).checked != null;
                  if (newIsTask !== isTask) return false;
                  applyAttrs(newNode);
                  return true;
                },
              };
            },
            // RAISE-34: emoji shortcodes don't need a NodeView (or
            // a custom schema, or any contentEditable special-casing)
            // because they aren't custom nodes. `:cat:` is substituted
            // for `🐱` at parse time (remark plugin) and at type time
            // (input rule), and the resulting emoji is a plain text
            // character in a text node — same as any other character
            // in the doc. See state/gemojiNode.ts.
          },
          handleDrop(view, event) {
            const dt = (event as DragEvent).dataTransfer;
            if (!dt) return false;
            const dropEvent = event as DragEvent;
            const coords = view.posAtCoords({
              left: dropEvent.clientX,
              top: dropEvent.clientY,
            });

            // Sidebar-originated drag (RAISE-13 follow-up). The
            // RAISE_TREE_DND_TYPE marker tells us this is one of
            // our own drags rather than a Finder file drop. Image
            // files insert as a markdown image; non-image files are
            // intentionally suppressed (no-op) so ProseMirror's
            // default doesn't drop the raw path text into the doc.
            // A future ticket can extend non-image handling
            // (markdown link, attachment reference, etc.).
            const treeSrc = getTreeDragSourcePath(dt);
            if (treeSrc) {
              event.preventDefault();
              if (!coords || !isImagePath(treeSrc)) return true;
              const editor = editorInstanceRef.current;
              if (!editor) return true;
              const rel = computeInsertedPath(treeSrc, markdownPathRef.current);
              const stem = (rel.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
              // Move caret to the drop point first so
              // insertImageCommand (which uses replaceSelectionWith)
              // lands the image there rather than at the previous
              // selection.
              const max = view.state.doc.content.size;
              const safe = Math.min(Math.max(coords.pos, 0), max);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, safe)));
              editor.action(callCommand(insertImageCommand.key, { src: rel, alt: stem }));
              view.focus();
              return true;
            }

            const images = pickImageFiles(dt.files);
            if (images.length === 0) return false;
            if (!coords) return false;
            event.preventDefault();
            void (async () => {
              const handler = onImageDropRef.current;
              if (!handler) return;
              const insertions = await handler(images);
              if (insertions.length === 0) return;
              const editor = editorInstanceRef.current;
              if (!editor) return;
              // Move the caret to the drop point so insertImageCommand
              // (which uses replaceSelectionWith) lands the image
              // there. Subsequent images stack at the new caret.
              const max = view.state.doc.content.size;
              const safe = Math.min(Math.max(coords.pos, 0), max);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, safe)));
              for (const ins of insertions) {
                const stem = ins.asset.relPath.split('/').pop() ?? '';
                const alt = stem.replace(/\.[^.]+$/, '');
                editor.action(
                  callCommand(insertImageCommand.key, {
                    src: ins.asset.relPath,
                    alt,
                  }),
                );
              }
            })();
            return true;
          },
          handlePaste(view, event) {
            const cd = (event as ClipboardEvent).clipboardData;
            if (!cd) return false;
            const items = cd.items;
            // RAISE-39: only treat the paste as image-only when
            // there's NO text/html alongside the image. Word /
            // Excel / browser / PowerPoint clipboards routinely
            // bundle a screenshot of the source content with the
            // text/html version, and we want the text in those
            // cases — a screenshot loses all the structure (and
            // triggers the requireSavedPath save-as dialog for
            // an untitled doc, which is the smoke-test report).
            // For genuine image-only paste (screenshot tool,
            // Preview's clipboard, drag-from-image-on-disk), no
            // text/html is present and the image branch fires.
            const hasHtml = !!cd.getData('text/html');
            const imageItem = hasHtml ? null : firstImageItem(items);
            if (imageItem) {
              // Synchronous snapshot — the DataTransferItem is invalidated
              // when this handler returns, so a later read of `.type` or
              // `getAsFile()` across an await would yield empty values.
              const snapshot = snapshotPasteItem(imageItem);
              if (!snapshot) return false;
              event.preventDefault();
              void (async () => {
                const handler = onImagePasteRef.current;
                if (!handler) return;
                const insertion = await handler(snapshot);
                if (!insertion) return;
                const editor = editorInstanceRef.current;
                if (!editor) return;
                const stem = insertion.asset.relPath.split('/').pop() ?? '';
                const alt = stem.replace(/\.[^.]+$/, '');
                editor.action(
                  callCommand(insertImageCommand.key, {
                    src: insertion.asset.relPath,
                    alt,
                  }),
                );
                // Re-focus the editor — the system-level paste interrupts
                // ProseMirror's focus tracking; without this the user
                // sees the image inserted but the caret on the wrong side.
                view.focus();
              })();
              return true;
            }

            // RAISE-39: route every text paste through the shared
            // clipboard helper. The helper picks the best source
            // for clean markdown:
            //
            //   - `text/plain` already looks like markdown (Google
            //     Docs "Copy as markdown", Notion, IntelliJ, etc.)
            //     → use it directly with cleanup applied.
            //   - `text/html` exists → Turndown it with GFM for
            //     tables / strikethrough / task-list support
            //     (covers Word, browser pages, Slack, Excel).
            //   - Otherwise → return the plain text as-is, treated
            //     as markdown (RAISE-28 behaviour for typed-out
            //     `**bold**` etc.).
            //
            // We then run the result through Milkdown's parser and
            // insert the doc slice at the current selection. This
            // replaces the previous "fall through to Milkdown's
            // clipboard plugin when html is present" path, which
            // gave inferior output for Google Docs paste because
            // the html branch threw away the cleaner text/plain
            // markdown the source app had already prepared.
            const markdown = getMarkdownFromClipboard(cd);
            if (!markdown) return false;

            const editor = editorInstanceRef.current;
            if (!editor) return false;

            event.preventDefault();
            editor.action((ctx) => {
              const parser = ctx.get(parserCtx);
              const parsed = parser(markdown);
              if (!parsed) return;
              // RAISE-46: shape the slice based on whether the
              // destination is an inline-only container (table cell,
              // heading) or the document body.
              //
              //   - **Inline-only destination** — flatten the parsed
              //     doc to a `Fragment` of inline nodes (text + inline
              //     atoms + hard_break between paragraphs) and insert
              //     it as `Slice(fragment, 0, 0)`. The cell / heading
              //     keeps its block-level wrapper; only its inline
              //     content changes. Table structure stays intact.
              //
              //   - **Body destination** — use the parsed doc's
              //     content with `openStart: 1, openEnd: 1` when the
              //     content opens / closes with a paragraph, so the
              //     pasted paragraph's inline content merges with the
              //     destination paragraph rather than nesting as a
              //     sibling block. Multi-paragraph / heading / code
              //     paste still gets the right block structure between
              //     the open ends.
              //
              // Pre-fix the slice was always
              // `parsed.slice(0, parsed.content.size)` — `openStart=0,
              // openEnd=0`. Inserting that block-shaped slice into a
              // table cell ejected the cell's existing paragraph as a
              // top-level node and fragmented the surrounding table.
              const $from = view.state.selection.$from;
              let slice: Slice;
              if (isInlineOnlyContext($from)) {
                const inlineFragment = flattenToInline(parsed, view.state.schema);
                slice = new Slice(inlineFragment, 0, 0);
              } else {
                // Best-effort open-ends: only "open" the boundary
                // when the slice's outermost node on that side is a
                // paragraph (the case where merging into the
                // destination makes sense). Other shapes (heading,
                // code_block, list) stay as discrete blocks.
                const firstChild = parsed.content.firstChild;
                const lastChild = parsed.content.lastChild;
                const openStart = firstChild?.type.name === 'paragraph' ? 1 : 0;
                const openEnd = lastChild?.type.name === 'paragraph' ? 1 : 0;
                slice = new Slice(parsed.content, openStart, openEnd);
              }
              view.dispatch(view.state.tr.replaceSelection(slice));
            });
            return true;
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      // RAISE-47: revert filename-shaped autolinks
      // (`file.md` → `link { url: 'http://file.md' }`) back to plain
      // text on parse, so notes that reference `file.md` don't get
      // wrapped in a clickable-but-broken link. Real URLs (text has
      // explicit scheme) and emails (url has `mailto:` prefix)
      // survive untouched. See state/remarkUnautolink.ts.
      .use(remarkUnautolinkPlugin)
      // RAISE-47: Chromium's contenteditable URL auto-detector
      // wraps typed URL-shaped text in `<a href>` tags, which the
      // link mark schema picks up via parseDOM. The detection is
      // partial and adds synthesised-scheme `href` attrs that
      // would serialise as ugly `[text](http://text)` link syntax
      // surrounded by the unmarked half of the URL. This plugin
      // strips those marks at the appendTransaction layer so only
      // user-intent link marks (toolbar, paste, parsed `[text](url)`
      // syntax) make it to the model. See
      // state/stripBrowserAutolink.ts.
      .use(stripBrowserAutolinkPlugin)
      // RAISE-47 UX follow-up: typed URLs and emails autolink
      // immediately as the user finishes them (anchored on whitespace,
      // end-of-node, or sentence punctuation). Without this, a typed
      // URL would only become a link after a parse cycle (mode
      // switch, doc reload) — friction-heavy. See
      // state/autolinkOnType.ts.
      .use(autolinkOnTypePlugin)
      .use(listener)
      .use(history)
      .use(clipboard)
      .use(cursor)
      .use(tooltipPlugin)
      .use(slashPlugin)
      // RAISE-34: emoji-shortcode rendering with source round-trip.
      // Bundles the parse-side remark plugin (`:name:` -> emoji
      // substitution in mdast text nodes) and the type-side input
      // rule (replaces `:name:` with the emoji character on the
      // closing colon). Serialize-side conversion lives in the
      // markdownUpdated listener above, via emojiToShortcodes —
      // the model carries plain text throughout, so there's no
      // schema or NodeView for emoji.
      .use(gemojiPlugins)
      // RAISE-36: keep an empty paragraph trailing any code block
      // that lands at the end of the doc, so the user can navigate
      // out of the code block via Down arrow / click / End rather
      // than being trapped inside it. See state/trailingParagraph.ts.
      .use(trailingParagraphPlugin)
      // RAISE-31: visually grey out review-style comments —
      // `<!-- text -->` (inline or block) and `// text` (line-
      // start). Pure decoration, no model change, so the source
      // round-trips with the literal characters intact. Code
      // blocks and inline-code text are skipped. See
      // state/commentDecorations.ts.
      .use(commentDecorationsPlugin)
      // RAISE-86: cursor-in-link detection driving the link popover.
      // A `$prose` plugin whose `view().update(view)` runs after every
      // transaction — covering plain click, arrow-key cursor movement,
      // and programmatic selection changes alike (the ACs call out
      // both click and arrow-key entry). When the selection is
      // collapsed and inside a link mark, we resolve the mark's full
      // range, read its href, and anchor the popover to the link
      // element's bounding rect; otherwise we clear it. The setter is
      // reached through `setLinkPopoverRef` (a ref) so this closure —
      // created once at editor construction — always sees the live
      // React setter rather than a stale one. Modifier-clicks never
      // reach here: RAISE-87's capture-phase mousedown handler stops
      // the event before ProseMirror moves the selection, so no
      // transaction fires and the popover stays hidden.
      .use(
        $prose(
          () =>
            new Plugin({
              view: () => ({
                update: (view) => {
                  const setPopover = setLinkPopoverRef.current;
                  // RAISE-86 (#2): a right-click resolves to the context
                  // menu (Open / Edit / Remove Link), not the popover — so
                  // skip showing it. The flag is reset by the next
                  // left-click or keypress (see the tracking effect).
                  if (lastWasRightClickRef.current) {
                    setPopover(null);
                    return;
                  }
                  const { selection } = view.state;
                  // Only a collapsed caret triggers the popover — a
                  // text selection (e.g. the user dragging across a
                  // link to copy it) shouldn't pop the UI.
                  if (!selection.empty) {
                    setPopover(null);
                    return;
                  }
                  const linkType = view.state.schema.marks['link'];
                  if (!linkType) {
                    setPopover(null);
                    return;
                  }
                  const range = resolveLinkMarkRange(selection.$from, linkType);
                  if (!range) {
                    setPopover(null);
                    return;
                  }
                  // Anchor to the link's on-screen box. `coordsAtPos`
                  // gives caret coords at the mark boundaries; using
                  // the start's `left` and the end's `bottom` places
                  // the popover just below the link's start. Clamp the
                  // start coord so a link wrapping to a second line
                  // doesn't push the popover off-screen-left.
                  const startCoords = view.coordsAtPos(range.from);
                  setPopover({
                    href: range.href,
                    from: range.from,
                    to: range.to,
                    x: Math.max(8, startCoords.left),
                    y: startCoords.bottom + 6,
                    anchorTop: startCoords.top,
                  });
                },
              }),
            }),
        ),
      ),
  );

  // Bridge the imperative handle to Milkdown's history commands. The menu's
  // CmdOrCtrl+Z accelerator otherwise reaches editorRef (the SourceEditor
  // ref) and silently no-ops in WYSIWYG mode.
  const [, get] = useInstance();
  // Mirror the Milkdown instance into a ref so the prosemirror plugin
  // registered above can dispatch commands once creation finishes. The
  // plugin closes over `editorInstanceRef` (defined above), not `get()`,
  // because `get()` returns the current value at call-site whereas the
  // plugin needs lazy access from inside a future event handler.
  editorInstanceRef.current = get() ?? null;

  // RAISE-86: link popover actions. All three operate on the popover's
  // captured `from`/`to` range (read live from `linkPopoverRef` so the
  // imperative-handle / popover-callback closures don't go stale).
  //
  // `dismissLinkPopover` clears the state and refocuses the editor so
  // the caret stays put after the popover closes.
  const dismissLinkPopover = useCallback(() => {
    setLinkPopover(null);
  }, []);

  const handleLinkOpen = useCallback(() => {
    const state = linkPopoverRef.current;
    if (state) window.api.openExternal(state.href);
    setLinkPopover(null);
  }, []);

  // Apply an edited href. Empty input removes the link (keep text);
  // otherwise we replace the captured range's link mark with a fresh
  // one carrying the new href, preserving any surrounding marks
  // (bold / italic) — same single-transaction shape Toolbar.tsx uses
  // for its link edits. `updateLinkCommand` would only touch the
  // mark under the *current* selection, which is a collapsed caret
  // here, so we drive the transaction directly against the range.
  const handleLinkEdit = useCallback(
    (rawHref: string) => {
      const state = linkPopoverRef.current;
      if (!state) return;
      const next = rawHref.trim();
      const editor = get();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const linkType = view.state.schema.marks['link'];
        if (!linkType) return;
        const { from, to } = state;
        // setMeta(autolinkPluginKey) opts this transaction OUT of the
        // autolink-on-type re-processing (RAISE-86 fix): without it, the
        // autolinker re-links the still-URL-shaped text in the SAME
        // dispatch — so Remove appeared to do nothing and an edited href
        // reverted to the text-derived original.
        if (!next) {
          // Empty URL → treat as Remove: strip the mark, keep text.
          const tr = view.state.tr.removeMark(from, to, linkType);
          tr.setMeta(autolinkPluginKey, true);
          view.dispatch(tr);
        } else {
          const tr = view.state.tr;
          tr.removeMark(from, to, linkType);
          tr.addMark(from, to, linkType.create({ href: next }));
          tr.setMeta(autolinkPluginKey, true);
          view.dispatch(tr);
        }
        view.focus();
      });
      setLinkPopover(null);
    },
    [get],
  );

  const handleLinkRemove = useCallback(() => {
    const state = linkPopoverRef.current;
    if (!state) return;
    const editor = get();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const linkType = view.state.schema.marks['link'];
      if (!linkType) return;
      // Opt out of autolink re-processing (see handleLinkEdit) so the
      // stripped link isn't immediately re-linked from its URL-shaped text.
      const tr = view.state.tr.removeMark(state.from, state.to, linkType);
      tr.setMeta(autolinkPluginKey, true);
      view.dispatch(tr);
      view.focus();
    });
    setLinkPopover(null);
  }, [get]);

  // RAISE-86: context-menu "Edit Link" → re-anchor the popover (in
  // case it wasn't already showing) and force it into edit mode. The
  // right-click handler has already moved the caret onto the link, so
  // we resolve the link range from the live selection here. `editNonce`
  // remounts LinkPopover so the edit field re-opens even on a repeat
  // request for the same link.
  const requestLinkEdit = useCallback(() => {
    const editor = get();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const linkType = view.state.schema.marks['link'];
      if (!linkType) return;
      const range = resolveLinkMarkRange(view.state.selection.$from, linkType);
      if (!range) return;
      const startCoords = view.coordsAtPos(range.from);
      setLinkPopover({
        href: range.href,
        from: range.from,
        to: range.to,
        x: Math.max(8, startCoords.left),
        y: startCoords.bottom + 6,
        anchorTop: startCoords.top,
        startEditing: true,
        editNonce: Date.now(),
      });
    });
  }, [get]);

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
      getCursorOffset: () => {
        const editor = get();
        if (!editor) return 0;
        let offset = 0;
        editor.action((ctx) => {
          offset = ctx.get(editorViewCtx).state.selection.from;
        });
        return offset;
      },
      setCursorOffset: (offset) => {
        const editor = get();
        if (!editor) return;
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          // Clamp into the current doc — the doc may have grown / shrunk
          // since the offset was captured (e.g., user typed in Source then
          // came back). 0 is always a valid position.
          const max = view.state.doc.content.size;
          const safe = Math.min(Math.max(offset, 0), max);
          const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, safe));
          view.dispatch(tr);
          view.focus();
        });
      },
      copyAsMarkdown: async () => {
        const editor = get();
        if (!editor) return;
        let markdown = '';
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const serializer = ctx.get(serializerCtx);
          const { from, to } = view.state.selection;
          // ProseMirror's `Node.cut(from, to)` returns a node of the same
          // type (here: doc) with content trimmed to the selected range,
          // preserving any wrapping nodes (lists, blockquotes, etc.). The
          // serializer expects a doc-level node, so this is the right
          // shape regardless of selection size — and falls back cleanly
          // to the entire doc when from === to (collapsed cursor).
          const target = from === to ? view.state.doc : view.state.doc.cut(from, to);
          markdown = serializer(target);
        });
        if (!markdown) return;
        try {
          await navigator.clipboard.writeText(markdown);
        } catch (err) {
          // Clipboard write can fail under headless / no-permission
          // contexts. Surface via the same dialog channel as other
          // user-visible errors rather than swallowing silently.
          window.api.showError(
            'Could not copy as Markdown',
            err instanceof Error ? err.message : String(err),
          );
        }
      },
      promptLink: () => {
        toolbarRef.current?.promptLink();
      },
      pastePlain: (text) => {
        if (!text) return;
        const editor = get();
        if (!editor) return;
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { schema } = view.state;
          // Build a Fragment of inline content: text runs separated
          // by `hardbreak` for newlines. Matches the ticket spec
          // ("single text run if the clipboard had a single line;
          // hard_break-separated runs if it had newlines") and
          // works in any inline context (body paragraph, table
          // cell, heading, list item) because `hardbreak` is
          // schema-valid in every inline group.
          //
          // ⚠ Node name is `hardbreak` (lowercase, no underscore) —
          // Milkdown's commonmark preset names it that way, not the
          // standard-ProseMirror `hard_break`. The smoke-test version
          // of this code used `hard_break` and silently failed on
          // every multi-line paste because `schema.nodes['hard_break']`
          // is undefined under Milkdown's schema. (The single-line
          // path happens to work because the lookup never runs.)
          //
          // Why not `tr.insertText(text)`? ProseMirror's
          // `insertText` inserts the string as text content into
          // the current selection's parent block; embedded `\n`
          // characters land as literal newlines in the text node,
          // which renders as a single line with the newlines
          // collapsed to spaces by the contenteditable layout
          // engine. Splitting on `\n` and emitting `hardbreak`
          // nodes is the only way to get visible line breaks.
          //
          // Defensive: if the schema doesn't expose `hardbreak`
          // (a future schema swap, a custom preset), fall back to
          // a single text node with spaces in place of newlines.
          // The content survives; the visible line breaks don't.
          // Strictly better than throwing inside dispatch and
          // having the user's paste silently disappear.
          const hardbreakType = schema.nodes['hardbreak'];
          const inlineNodes: ProseNode[] = [];
          const lines = text.split('\n');
          if (!hardbreakType) {
            const flattened = lines.join(' ');
            if (flattened.length > 0) inlineNodes.push(schema.text(flattened));
          } else {
            lines.forEach((line, i) => {
              if (i > 0) inlineNodes.push(hardbreakType.create());
              if (line.length > 0) inlineNodes.push(schema.text(line));
            });
          }
          if (inlineNodes.length === 0) return;
          const slice = new Slice(Fragment.from(inlineNodes), 0, 0);
          view.dispatch(view.state.tr.replaceSelection(slice));
          // Focus after dispatch — the menu accelerator's IPC
          // round-trip can interrupt ProseMirror's focus tracking,
          // and without an explicit refocus the inserted caret
          // sits at the right model position but typing goes to
          // the previously-focused element (toolbar button, body
          // chrome, etc.).
          view.focus();
        });
      },
      // RAISE-86: context-menu link routes. The right-click handler
      // (below) moves the caret onto the link before the menu pops, so
      // these resolve the link from the live selection — independent of
      // whether the popover happens to be showing.
      openLink: () => {
        const editor = get();
        if (!editor) return;
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const linkType = view.state.schema.marks['link'];
          if (!linkType) return;
          const range = resolveLinkMarkRange(view.state.selection.$from, linkType);
          if (range) window.api.openExternal(range.href);
        });
      },
      editLink: () => requestLinkEdit(),
      removeLink: () => {
        const editor = get();
        if (!editor) return;
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const linkType = view.state.schema.marks['link'];
          if (!linkType) return;
          const range = resolveLinkMarkRange(view.state.selection.$from, linkType);
          if (!range) return;
          const tr = view.state.tr.removeMark(range.from, range.to, linkType);
          tr.setMeta(autolinkPluginKey, true);
          view.dispatch(tr);
          view.focus();
        });
        setLinkPopover(null);
      },
    }),
    [get, scrollContainerRef, toolbarRef, requestLinkEdit],
  );

  // RAISE-28: right-click context menu. Lives in MilkdownBody (not the
  // outer WysiwygEditor) so it can close over `editorInstanceRef`,
  // which is needed to focus the editor view synchronously before
  // the menu pops — without that, the very first right-click in a
  // session (before the body has been clicked into) hits an unfocused
  // webContents and Electron's role-bound items (Cut / Copy / Paste /
  // Select All) end up disabled.
  //
  // The frontmatter textarea has its own `onContextMenu` prop in the
  // JSX below, so this listener early-exits when the click lands
  // there to avoid double-firing.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleContextMenu = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.rise-md-frontmatter')) return;
      e.preventDefault();

      // RAISE-86 (#2): mark this as a right-click so the link-detection
      // plugin suppresses the popover when the caret-move below lands on
      // a link — the context menu (Open / Edit / Remove Link) is the
      // right-click affordance, not the popover. Set on the `contextmenu`
      // event itself rather than the mousedown button, so it's robust to
      // Ctrl-click / trackpad right-click (which can report button 0).
      // Reset by the next left-click or keypress.
      lastWasRightClickRef.current = true;

      const sel = window.getSelection();
      const hasSelection = !!sel && !sel.isCollapsed && sel.toString().length > 0;
      // RAISE-38: detect right-click on an existing link so the
      // context menu can show "Edit Link…" instead of "Add Link…".
      const isOnLink = !!target.closest('a');

      const editor = editorInstanceRef.current;
      if (editor) {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          view.focus();
          // RAISE-38: Chromium contentEditable doesn't reliably
          // move the caret on right-click. Synthesize standard
          // text-editor behaviour:
          //
          //   - Right-click *inside* the current selection
          //     → preserve selection (the menu's Cut / Copy /
          //     selection-sensitive actions all expect the
          //     selection to still be there).
          //   - Right-click *outside* the current selection
          //     → move the caret to the click point and clear
          //     the selection. Subsequent menu actions (Add /
          //     Edit Link, Copy as Markdown, etc.) operate on
          //     the new cursor position. This also fixes the
          //     "Edit Link…" flow that needs the caret on the
          //     clicked link to read its href / text, and the
          //     "Add Link…" flow that should ignore an
          //     unrelated existing link the caret happened to
          //     be inside.
          //
          // Matches TextEdit / Word / VS Code / Chromium's own
          // textarea right-click behaviour.
          const coords = view.posAtCoords({
            left: e.clientX,
            top: e.clientY,
          });
          if (coords) {
            const pmSel = view.state.selection;
            const clickInSelection =
              !pmSel.empty && coords.pos >= pmSel.from && coords.pos <= pmSel.to;
            if (!clickInSelection) {
              const tr = view.state.tr.setSelection(
                TextSelection.near(view.state.doc.resolve(coords.pos)),
              );
              view.dispatch(tr);
            }
          }
        });
      }

      void window.api.contextMenu.showEditor({
        mode: 'wysiwyg',
        hasSelection,
        isOnLink,
      });
    };
    container.addEventListener('contextmenu', handleContextMenu);
    return () => {
      container.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [scrollContainerRef]);

  // RAISE-86: dismiss the link popover on Escape, click-outside, and
  // container scroll — mirrors the image-tooltip dismissal in the
  // outer WysiwygEditor. (The "caret leaves the link" case is handled
  // by the `$prose` plugin's `update` clearing the state, so it isn't
  // duplicated here.) Only wired while a popover is showing so the
  // listeners aren't live for the common no-link case.
  useEffect(() => {
    if (!linkPopover) return;
    const container = scrollContainerRef.current;
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLinkPopover(null);
    };
    const handleScroll = (): void => setLinkPopover(null);
    const handlePointerDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      // Clicks inside the popover are handled by the popover itself.
      if (target?.closest('[data-link-popover]')) return;
      setLinkPopover(null);
    };
    document.addEventListener('keydown', handleKey);
    container?.addEventListener('scroll', handleScroll);
    // Capture phase so we see the click before ProseMirror — but we
    // intentionally do NOT preventDefault, so a click elsewhere still
    // moves the caret (and the `$prose` plugin re-evaluates the new
    // position, re-showing the popover if it landed on another link).
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => {
      document.removeEventListener('keydown', handleKey);
      container?.removeEventListener('scroll', handleScroll);
      document.removeEventListener('mousedown', handlePointerDown, true);
    };
  }, [linkPopover, scrollContainerRef]);

  return (
    <>
      <Milkdown />
      {linkPopover && (
        <LinkPopover
          // Remount on link change (href + range) AND on a repeated
          // context-menu Edit request (editNonce) so the inline edit
          // field re-opens cleanly each time.
          key={`${linkPopover.from}-${linkPopover.to}-${linkPopover.editNonce ?? ''}`}
          href={linkPopover.href}
          x={linkPopover.x}
          y={linkPopover.y}
          anchorTop={linkPopover.anchorTop}
          platform={window.api.platform}
          initialEditing={linkPopover.startEditing}
          onOpen={handleLinkOpen}
          onEdit={handleLinkEdit}
          onRemove={handleLinkRemove}
          onDismiss={dismissLinkPopover}
        />
      )}
    </>
  );
}

export function WysiwygEditor({
  ref,
  content,
  onChange,
  onMarkdownBaseline,
  initialScrollTop,
  initialCursorOffset,
  onImageDrop,
  onImagePaste,
  markdownPath,
  onOpenImage,
  requireSavedPath,
}: WysiwygEditorProps) {
  // Split once at mount; the parent keys this component by tab id + load
  // epoch, so a tab switch or re-open of the same file fully remounts and
  // we re-split against the new content.
  const initialSplit = useMemo<FrontmatterSplit>(
    () => splitFrontmatter(content),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // RAISE-38: ref to the Toolbar component, created here (not in
  // MilkdownBody) because Toolbar is rendered as a sibling to
  // MilkdownBody in this component's tree. Forwarded into
  // MilkdownBody as a prop so its imperative handle can route
  // `promptLink()` into the toolbar's existing flow.
  const toolbarRef = useRef<ToolbarHandle | null>(null);
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
  const onBaselineRef = useRef(onMarkdownBaseline);
  onBaselineRef.current = onMarkdownBaseline;

  // RAISE-55 follow-up: tracks whether the user has interacted with this
  // WysiwygEditor instance (either the frontmatter textarea or the
  // Milkdown body). Set to `true` by the wrapper-level `input` listener
  // below, OR explicitly by `handleFrontmatterChange` as a belt-and-
  // suspenders (the textarea fires `input` first, but doing it
  // synchronously here means the order can't get unlucky).
  //
  // MilkdownBody reads `.current` inside its `markdownUpdated` callback
  // to decide whether the current emit is an init transaction (route
  // through `onMarkdownBaseline`) or a real user edit (route through
  // `onMarkdownChange`).
  //
  // Mount-keyed via `useRef`: every fresh instance of WysiwygEditor
  // (tab switch, mode switch, file reload via `loadEpoch` bump) starts
  // with `false`, which is exactly when we want to be capturing the
  // baseline.
  const hasUserInteractedRef = useRef(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // RAISE-55 follow-up: wire the user-interaction signal. `input` fires
  // when the value of any descendant text input / contenteditable
  // actually changes (Milkdown's body, the frontmatter textarea). It
  // does NOT fire for selection / cursor movement / Cmd+S / Cmd+W /
  // mode-switch shortcuts — exactly the events we want to ignore.
  // Capture phase (`true` as the third arg) ensures we see the event
  // before ProseMirror or React stops propagation.
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;
    const handler = () => {
      hasUserInteractedRef.current = true;
    };
    root.addEventListener('input', handler, true);
    return () => {
      root.removeEventListener('input', handler, true);
    };
  }, []);

  const emit = useCallback((nextFrontmatter: string | null, nextBody: string) => {
    onChangeRef.current(joinFrontmatter(nextFrontmatter, nextBody));
  }, []);

  const emitBaseline = useCallback((nextFrontmatter: string | null, nextBody: string) => {
    onBaselineRef.current?.(joinFrontmatter(nextFrontmatter, nextBody));
  }, []);

  const handleFrontmatterChange = useCallback(
    (next: string) => {
      // Defensive: the textarea fires `input` (which sets
      // hasUserInteractedRef via the wrapper listener) before this
      // handler runs, but capturing it here too means a future code
      // path that calls handleFrontmatterChange programmatically
      // (e.g. paste, undo) won't accidentally bypass the signal.
      hasUserInteractedRef.current = true;
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

  // RAISE-55 follow-up: the body's "baseline" path. MilkdownBody picks
  // this over handleBodyChange when no user interaction has been
  // observed yet — see MilkdownBody's `markdownUpdated` callback.
  const handleBodyBaseline = useCallback(
    (markdown: string) => {
      bodyRef.current = markdown;
      emitBaseline(frontmatterRef.current, markdown);
    },
    [emitBaseline],
  );

  // Image-click tooltip state. Shows filename + "View full size" when
  // an <img> in the prose surface is clicked. Dismissed by Escape, by
  // clicking elsewhere, or by scrolling (the tooltip is viewport-fixed
  // and would drift away from the image otherwise).
  const [imageTooltip, setImageTooltip] = useState<{
    relPath: string;
    filename: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // RAISE-38 / RAISE-87: modifier-click on a link opens it in the user's
    // default external browser. Handled on MOUSEDOWN (not click) because
    // ProseMirror moves the selection on mousedown — before any click event
    // fires — so the previous click-time `preventDefault` was too late and
    // the modifier-click left a stray line-wide NodeSelection (the "purple
    // box across the whole line", RAISE-87). This listener is registered in
    // the capture phase on `container`, an ancestor of the editor's
    // contentEditable, so it runs before ProseMirror's own mousedown handler;
    // `stopPropagation` then keeps the event from reaching ProseMirror at all
    // and `preventDefault` blocks the native text selection. We open the URL
    // here as well, since the click that used to do it is no longer a
    // reliable hook once the default is prevented. Plain clicks are untouched
    // and fall through to ProseMirror's default caret positioning.
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a');
      if (!anchor || !container.contains(anchor)) return;
      const isMac = window.api.platform === 'darwin';
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (!modifier) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      window.api.openExternal(href);
    };
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-image-tooltip]')) return; // tooltip clicks
      if (target.tagName === 'IMG' && container.contains(target)) {
        // The NodeView writes the original markdown src to
        // `data-asset-src` while the rendered `src` is a
        // rise-md-asset:// URL — for the "View full size" handler we
        // want the original (relative) path so main can resolve it
        // against the markdown file's directory.
        const original = target.getAttribute('data-asset-src') ?? target.getAttribute('src') ?? '';
        const filename = original.split('/').pop() || original;
        const rect = target.getBoundingClientRect();
        setImageTooltip({
          relPath: original,
          filename,
          x: rect.left,
          y: rect.bottom + 6,
        });
        return;
      }
      setImageTooltip(null);
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setImageTooltip(null);
    };
    const handleScroll = (): void => setImageTooltip(null);
    container.addEventListener('mousedown', handleMouseDown, true);
    container.addEventListener('click', handleClick);
    container.addEventListener('scroll', handleScroll);
    document.addEventListener('keydown', handleKey);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
      container.removeEventListener('click', handleClick);
      container.removeEventListener('scroll', handleScroll);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  const dismissTooltip = useCallback(() => setImageTooltip(null), []);
  const handleViewFullSize = useCallback(() => {
    if (imageTooltip && onOpenImage) onOpenImage(imageTooltip.relPath);
    setImageTooltip(null);
  }, [imageTooltip, onOpenImage]);

  return (
    <MilkdownProvider>
      <div ref={wrapperRef} className="flex h-full w-full flex-col bg-app">
        <Toolbar ref={toolbarRef} requireSavedPath={requireSavedPath} />
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[720px] px-6 py-8">
            {frontmatter !== null && (
              <textarea
                value={frontmatter}
                onChange={(e) => handleFrontmatterChange(e.target.value)}
                spellCheck={false}
                aria-label="YAML frontmatter"
                className="rise-md-frontmatter mb-6 block w-full resize-y rounded border border-stroke bg-surface p-3 font-mono text-xs leading-relaxed text-secondary focus:border-interaction focus:outline-none"
                rows={Math.max(3, frontmatter.split('\n').length + 1)}
                // RAISE-28: explicit context menu on the frontmatter
                // textarea. Electron has no default menu for `<textarea>`
                // (unlike a regular browser), so without this listener
                // right-click lands silently. The textarea is focused
                // automatically by the right-click itself, so role:'paste'
                // etc. find a valid target.
                onContextMenu={(e) => {
                  e.preventDefault();
                  const t = e.currentTarget;
                  const hasSelection = t.selectionStart !== t.selectionEnd;
                  void window.api.contextMenu.showEditor({
                    mode: 'frontmatter',
                    hasSelection,
                  });
                }}
              />
            )}
            <div className="rise-md-prose">
              <MilkdownBody
                ref={ref}
                scrollContainerRef={scrollContainerRef}
                toolbarRef={toolbarRef}
                initial={initialSplit.body}
                initialCursorOffset={initialCursorOffset}
                onMarkdownChange={handleBodyChange}
                onMarkdownBaseline={handleBodyBaseline}
                hasUserInteractedRef={hasUserInteractedRef}
                onImageDrop={onImageDrop}
                onImagePaste={onImagePaste}
                markdownPath={markdownPath}
              />
            </div>
          </div>
        </div>
        {imageTooltip && (
          <div
            data-image-tooltip
            role="dialog"
            aria-label={`Image: ${imageTooltip.filename}`}
            // Viewport-fixed so absolute coords from getBoundingClientRect
            // line up. The container scroll listener (above) dismisses
            // the tooltip if the user scrolls, so drift isn't a concern.
            style={{ left: imageTooltip.x, top: imageTooltip.y }}
            className="fixed z-50 flex items-center gap-3 rounded-[var(--rise-radius-card)] border border-stroke bg-app px-3 py-1.5 text-xs text-strong shadow-[var(--rise-shadow-depth-1)]"
          >
            <span className="max-w-[24ch] truncate font-mono text-muted">
              {imageTooltip.filename}
            </span>
            <button
              type="button"
              onClick={handleViewFullSize}
              disabled={!markdownPath}
              className="rounded bg-interaction px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-interaction-hover active:bg-interaction-active disabled:cursor-not-allowed disabled:opacity-50"
              title={
                markdownPath
                  ? 'Open in system image viewer'
                  : 'Save the file first to resolve image paths'
              }
            >
              View full size
            </button>
            <button
              type="button"
              onClick={dismissTooltip}
              aria-label="Dismiss"
              className="rounded px-1 text-muted hover:bg-elevated hover:text-strong"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </MilkdownProvider>
  );
}
