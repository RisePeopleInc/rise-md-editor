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
}

/**
 * True when the system clipboard has content that Paste could meaningfully
 * insert. Used to hide the Paste menu item when there's nothing to paste —
 * showing it disabled or as a no-op is user-hostile noise. Checked
 * synchronously in main from `electron.clipboard`.
 */
function clipboardHasPasteableContent(): boolean {
  const formats = clipboard.availableFormats();
  return formats.some(
    (f) => f === 'text/plain' || f === 'text/html' || f.startsWith('image/'),
  );
}

export function showEditorContextMenu(
  window: BrowserWindow,
  payload: ShowEditorContextMenuPayload,
  dispatch: (action: MenuAction) => void,
): void {
  const items: MenuItemConstructorOptions[] = [];
  const hasSel = payload.hasSelection;
  const canPaste = clipboardHasPasteableContent();

  // The menu surfaces only the items that would do something useful in
  // the current state. Items that would be greyed out or silently no-op
  // (e.g. Cut / Copy with no selection, Paste with empty clipboard) are
  // hidden entirely — a shorter context menu is friendlier than a list
  // of disabled items the user has to scan past.
  switch (payload.mode) {
    case 'preview': {
      // Preview is read-only rendered HTML. Copy makes sense only if
      // the user has selected text; Select All is always useful.
      if (hasSel) items.push({ role: 'copy' });
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
      break;
    }
    case 'wysiwyg':
    case 'source':
    case 'frontmatter': {
      // Editing surfaces: cut/copy gated on selection, paste gated on
      // clipboard contents, select-all + Copy as Markdown always.
      if (hasSel) {
        items.push({ role: 'cut' }, { role: 'copy' });
      }
      if (canPaste) {
        items.push({ role: 'paste' });
      }
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
  }

  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window });
}
