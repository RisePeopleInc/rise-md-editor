import {
  BrowserWindow,
  clipboard,
  Menu,
  MenuItemConstructorOptions,
} from 'electron';
import type { MenuAction } from './menu';

/**
 * Editor context menus for [RAISE-28](https://risepeople.atlassian.net/browse/RAISE-28).
 *
 * Mirrors the file-tree context-menu pattern (see `folder:context-menu`
 * in index.ts) — main process owns menu construction; the renderer
 * fires a `contextmenu` DOM event, sends a request here with the
 * relevant state (mode + selection presence), and we pop the menu at
 * the cursor position.
 *
 * Most items use Electron's built-in `role`s (`cut`, `copy`, `paste`,
 * `selectAll`) which auto-act on the focused web contents — no IPC
 * needed for those. Only `Copy as Markdown` requires custom plumbing:
 * the menu click dispatches a `context-copy-as-markdown` action through
 * the same `menu:action` channel as the app menu, and the renderer's
 * existing handler routes it into the WYSIWYG editor's imperative
 * handle (which has access to the Milkdown serializer).
 */

/**
 * What kind of editor surface the user right-clicked on. `frontmatter`
 * is the YAML editor at the top of WYSIWYG mode — same items as a
 * plain text input (cut/copy/paste/select-all), distinct mode for
 * future flexibility (e.g., a "Format YAML" item).
 */
export type EditorContextMode =
  | 'wysiwyg'
  | 'source'
  | 'preview'
  | 'frontmatter';

export interface ShowEditorContextMenuPayload {
  mode: EditorContextMode;
  /** True if the editor has a non-empty text selection at the click. */
  hasSelection: boolean;
  /**
   * RAISE-38: true when the right-click landed on an existing link
   * element in the WYSIWYG surface. Drives whether the link menu
   * item reads "Edit Link…" (and appears without a selection) or
   * "Add Link…" (selection-only).
   */
  isOnLink?: boolean;
}

/**
 * True when the system clipboard has content that Paste could meaningfully
 * insert *for the given surface*. Used to hide the Paste menu item when
 * there's nothing the surface can do with the clipboard — a Paste that
 * silently no-ops is user-hostile noise. Checked synchronously in main
 * from `electron.clipboard`.
 *
 * Mode-aware because the surfaces differ in what they accept:
 *
 * - WYSIWYG: text *and* images. Milkdown's `handlePaste` route in
 *   WysiwygEditor.tsx accepts `image/*` and inserts a markdown image
 *   reference for it, so an image-only clipboard is a valid Paste.
 * - Source / frontmatter: text only. Monaco and the YAML textarea
 *   can't ingest an image; an image-only clipboard means Paste would
 *   no-op.
 *
 * (Preview mode never offers Paste in the first place — it's read-only.)
 */
function clipboardHasPasteableContent(mode: EditorContextMode): boolean {
  const formats = clipboard.availableFormats();
  const hasText = formats.some((f) => f === 'text/plain' || f === 'text/html');
  if (mode === 'wysiwyg') {
    return hasText || formats.some((f) => f.startsWith('image/'));
  }
  return hasText;
}

export function showEditorContextMenu(
  window: BrowserWindow,
  payload: ShowEditorContextMenuPayload,
  dispatch: (action: MenuAction) => void,
): void {
  const items: MenuItemConstructorOptions[] = [];
  const hasSel = payload.hasSelection;
  const canPaste = clipboardHasPasteableContent(payload.mode);

  // The menu surfaces only the items that would do something useful in
  // the current state. Items that would be greyed out or silently no-op
  // (e.g. Cut / Copy with no selection, Paste with empty clipboard) are
  // hidden entirely — a shorter context menu is friendlier than a list
  // of disabled items the user has to scan past.
  switch (payload.mode) {
    case 'preview': {
      // Preview is read-only rendered HTML. Copy makes sense only if
      // the user has selected text; Select All is always useful.
      //
      // The preview pane is a div with `dangerouslySetInnerHTML`, not
      // a contenteditable surface. `role: 'selectAll'` calls
      // `webContents.selectAll()` which has nothing to scope to and
      // ends up selecting the entire renderer document — including
      // the sidebar, mode switcher, etc. We dispatch a custom action
      // and the renderer scopes the selection to the preview node
      // via `Range.selectNodeContents`.
      if (hasSel) items.push({ role: 'copy' });
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({
        label: 'Select All',
        click: () => dispatch('context-preview-select-all'),
      });
      break;
    }
    case 'source': {
      // Source mode runs Monaco. `role: 'selectAll'` doesn't reach
      // Monaco's internal selection model — its content is rendered
      // via custom DOM, and `webContents.selectAll()` either no-ops
      // or selects nothing useful. Dispatch a custom action and call
      // Monaco's own selectAll command from the renderer.
      if (hasSel) items.push({ role: 'cut' }, { role: 'copy' });
      if (canPaste) items.push({ role: 'paste' });
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({
        label: 'Select All',
        click: () => dispatch('context-source-select-all'),
      });
      break;
    }
    case 'wysiwyg':
    case 'frontmatter': {
      // Both surfaces are real editable DOM (contenteditable for
      // Milkdown, native textarea for the YAML frontmatter), so the
      // built-in `role: 'selectAll'` works as expected.
      if (hasSel) items.push({ role: 'cut' }, { role: 'copy' });
      if (canPaste) items.push({ role: 'paste' });
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
      break;
    }
  }

  if (payload.mode === 'wysiwyg') {
    // Copy as Markdown is always available in WYSIWYG. With no
    // selection it falls back to copying the entire doc — useful
    // shortcut for "give me this document as markdown".
    items.push(
      { type: 'separator' },
      {
        label: 'Copy as Markdown',
        click: () => dispatch('context-copy-as-markdown'),
      },
    );
    // RAISE-38: link menu item — same `context-add-link` action
    // surfaces the in-app link prompt; the modal itself decides
    // whether it's adding or editing based on whether the cursor
    // is on an existing link mark.
    //
    //   - Right-click on an existing link → "Edit Link…" (visible
    //     even without a text selection — the cursor lands on the
    //     link from the right-click and the modal pre-fills with
    //     the existing URL and text).
    //   - Right-click with a selection (and not on a link) → "Add
    //     Link…" (wraps the selection).
    //   - Right-click on plain non-selected text → menu item
    //     hidden (no obvious user intent — the toolbar button
    //     still handles the bare-cursor "insert URL as text" case).
    if (payload.isOnLink) {
      items.push({
        label: 'Edit Link…',
        click: () => dispatch('context-add-link'),
      });
    } else if (hasSel) {
      items.push({
        label: 'Add Link…',
        click: () => dispatch('context-add-link'),
      });
    }
  }

  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window });
}
