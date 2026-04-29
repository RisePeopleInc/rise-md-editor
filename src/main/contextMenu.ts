import { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
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

/** What kind of editor surface the user right-clicked on. */
export type EditorContextMode = 'wysiwyg' | 'source' | 'preview';

export interface ShowEditorContextMenuPayload {
  mode: EditorContextMode;
  /** True if the editor has a non-empty text selection at the click. */
  hasSelection: boolean;
}

export function showEditorContextMenu(
  window: BrowserWindow,
  payload: ShowEditorContextMenuPayload,
  dispatch: (action: MenuAction) => void,
): void {
  const items: MenuItemConstructorOptions[] = [];

  if (payload.mode === 'preview') {
    // Preview is rendered HTML — no editing surface, so Cut and Paste
    // make no sense. Keep Copy + Select All so the user can still
    // grab text out of the preview.
    items.push(
      { role: 'copy', enabled: payload.hasSelection },
      { type: 'separator' },
      { role: 'selectAll' },
    );
  } else {
    // wysiwyg + source share Cut / Copy / Paste / Select All.
    items.push(
      { role: 'cut', enabled: payload.hasSelection },
      { role: 'copy', enabled: payload.hasSelection },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    );
  }

  if (payload.mode === 'wysiwyg') {
    // Copy as Markdown — serializes the current selection (or the
    // entire doc, if nothing's selected) back to its source form via
    // Milkdown's serializerCtx, then writes the string to the
    // clipboard. Implemented in the renderer because that's where the
    // Milkdown editor instance lives.
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
