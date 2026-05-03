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
import { TextSelection } from '@milkdown/prose/state';
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
import { callCommand } from '@milkdown/utils';
import { Toolbar, type ToolbarHandle } from './Toolbar';
import {
  firstImageItem,
  pickImageFiles,
  snapshotPasteItem,
  type ImageInsertion,
  type PasteImageSnapshot,
} from '../../state/imageInsert';
import { resolveAssetUrl } from '../../state/assetUrl';
import {
  getMarkdownFromClipboard,
  unescapeHeadingNumberDot,
} from '../../state/clipboardPaste';
import {
  commentDecorationsPlugin,
  unescapeCommentDelimiters,
  unescapeIndentEntities,
} from '../../state/commentDecorations';
import { stripEmptyParagraphMarkers } from '../../state/emptyParagraphMarker';
import { emojiToShortcodes, gemojiPlugins } from '../../state/gemojiNode';
import {
  joinFrontmatter,
  splitFrontmatter,
  type FrontmatterSplit,
} from '../../state/markdown';
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
}

interface WysiwygEditorProps {
  ref?: Ref<WysiwygEditorHandle>;
  content: string;
  onChange: (markdown: string) => void;
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
  onImageDrop?: (files: File[]) => Promise<ImageInsertion[]>;
  onImagePaste?: (snapshot: PasteImageSnapshot) => Promise<ImageInsertion | null>;
  /** Used by the image NodeView to resolve relative src → raise-asset:// URL. */
  markdownPath: string | null;
}

function MilkdownBody({
  ref,
  scrollContainerRef,
  toolbarRef,
  initial,
  initialCursorOffset,
  onMarkdownChange,
  onImageDrop,
  onImagePaste,
  markdownPath,
}: MilkdownBodyProps) {
  // Hold the latest callback in a ref so the editor's listener (registered
  // once on mount) always invokes the current handler, even if the parent
  // re-renders with a new closure.
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;

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
              unescapeHeadingNumberDot(
                emojiToShortcodes(stripEmptyParagraphMarkers(markdown)),
              ),
            ),
          );
          onChangeRef.current(processed);
        });
        // Once Milkdown finishes its initial mount, jump the caret to the
        // captured ProseMirror offset (clamped). This is the WYSIWYG
        // analogue of SourceEditor's onMount cursor restore.
        ctx.get(listenerCtx).mounted((mountedCtx) => {
          const offset = initialCursorOffsetRef.current;
          if (!offset) return;
          const view = mountedCtx.get(editorViewCtx);
          const max = view.state.doc.content.size;
          const safe = Math.min(Math.max(offset, 0), max);
          const tr = view.state.tr.setSelection(
            TextSelection.create(view.state.doc, safe),
          );
          view.dispatch(tr);
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
          // raise-asset:// URL at render time only; the stored src
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
                checkbox.classList.add('raise-task-checkbox');
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
                  view.dispatch(
                    view.state.tr.setNodeAttribute(pos, 'checked', checkbox!.checked),
                  );
                });
                li.insertBefore(checkbox, content);
              }

              const applyAttrs = (n: typeof node): void => {
                const checked =
                  (n.attrs as { checked?: boolean | null }).checked ?? null;
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
                  const newIsTask =
                    (newNode.attrs as { checked?: boolean | null }).checked != null;
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
            const images = pickImageFiles(dt.files);
            if (images.length === 0) return false;
            const dropEvent = event as DragEvent;
            const coords = view.posAtCoords({
              left: dropEvent.clientX,
              top: dropEvent.clientY,
            });
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
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, safe),
                ),
              );
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
              // The parser returns a doc-level node. To insert at
              // the selection, slice its full content as a Slice —
              // open ends 0 means a clean cut on both sides, which
              // gives us the closest behaviour to "insert this
              // content here, preserving block structure where it
              // makes sense".
              const slice = parsed.slice(0, parsed.content.size);
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
      // text on load, so notes that reference `file.md` don't get
      // wrapped in a clickable-but-broken link. Real URLs (text has
      // explicit scheme) and emails (url has `mailto:` prefix)
      // survive untouched. See state/remarkUnautolink.ts.
      //
      // **Known limitation**: a typed-but-not-yet-promoted URL
      // (`https://x.com` typed in Edit, never round-tripped through
      // a parse cycle) gets serialized via remark-stringify with
      // `mdast-util-gfm-autolink-literal`'s `unsafe` rules active
      // — so `:` after `[ps]`, `@` between word chars, and `.`
      // after `[Ww]` get backslash-escaped in the saved source.
      // The escape prevents the next parse from re-autolinking, so
      // the text stays as plain text on reload (which IS what the
      // RAISE-47 AC asks for `file.md`-shaped strings, just an
      // unfortunate side effect for real URLs typed in WYSIWYG).
      // The cleaner fix would be to remove the autolink-literal
      // serializer extension at the unified-processor level, but
      // every approach we tried (replacing `remark-gfm`, splitting
      // the gfm preset, post-filtering `data.toMarkdownExtensions`,
      // hooking SchemaReady) either hit Milkdown's plugin-loader
      // race condition or broke the toolbar / link mark wiring.
      // Tracked separately for follow-up.
      .use(remarkUnautolinkPlugin)
      // RAISE-47: Chromium's contenteditable URL auto-detector
      // wraps typed URL-shaped text in `<a href>` tags, which the
      // link mark schema picks up via parseDOM. The detection is
      // partial and adds synthesised-scheme `href` attrs that
      // serialize as ugly `[text](http://text)` link syntax mixed
      // with surrounding-text autolink-literal escapes. This plugin
      // strips those marks at the appendTransaction layer.
      .use(stripBrowserAutolinkPlugin)
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
      .use(commentDecorationsPlugin),
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
          const tr = view.state.tr.setSelection(
            TextSelection.create(view.state.doc, safe),
          );
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
          const target =
            from === to ? view.state.doc : view.state.doc.cut(from, to);
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
    }),
    [get, scrollContainerRef, toolbarRef],
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
      if (target.closest('.raise-frontmatter')) return;
      e.preventDefault();

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
              !pmSel.empty &&
              coords.pos >= pmSel.from &&
              coords.pos <= pmSel.to;
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

  return <Milkdown />;
}

export function WysiwygEditor({
  ref,
  content,
  onChange,
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
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // RAISE-38: modifier-click on a link opens it in the user's
      // default external browser. Plain clicks fall through to
      // ProseMirror's default (caret positioning inside the link
      // text), matching the convention used by VS Code, iA Writer,
      // and most other editors with contentEditable links.
      const anchor = target.closest('a');
      if (anchor && container.contains(anchor)) {
        const isMac = window.api.platform === 'darwin';
        const modifier = isMac ? e.metaKey : e.ctrlKey;
        if (modifier) {
          const href = anchor.getAttribute('href');
          if (href) {
            e.preventDefault();
            e.stopPropagation();
            window.api.openExternal(href);
            return;
          }
        }
      }
      if (target.closest('[data-image-tooltip]')) return; // tooltip clicks
      if (target.tagName === 'IMG' && container.contains(target)) {
        // The NodeView writes the original markdown src to
        // `data-asset-src` while the rendered `src` is a
        // raise-asset:// URL — for the "View full size" handler we
        // want the original (relative) path so main can resolve it
        // against the markdown file's directory.
        const original =
          target.getAttribute('data-asset-src') ?? target.getAttribute('src') ?? '';
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
    container.addEventListener('click', handleClick);
    container.addEventListener('scroll', handleScroll);
    document.addEventListener('keydown', handleKey);
    return () => {
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
      <div className="flex h-full w-full flex-col bg-app">
        <Toolbar ref={toolbarRef} requireSavedPath={requireSavedPath} />
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[720px] px-6 py-8">
            {frontmatter !== null && (
              <textarea
                value={frontmatter}
                onChange={(e) => handleFrontmatterChange(e.target.value)}
                spellCheck={false}
                aria-label="YAML frontmatter"
                className="raise-frontmatter mb-6 block w-full resize-y rounded border border-stroke bg-surface p-3 font-mono text-xs leading-relaxed text-secondary focus:border-interaction focus:outline-none"
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
            <div className="raise-prose">
              <MilkdownBody
                ref={ref}
                scrollContainerRef={scrollContainerRef}
                toolbarRef={toolbarRef}
                initial={initialSplit.body}
                initialCursorOffset={initialCursorOffset}
                onMarkdownChange={handleBodyChange}
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
