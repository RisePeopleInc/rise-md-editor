import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeNode } from '../env';

const ACCEPTED_EXTENSIONS = /\.(md|markdown|txt)$/i;

export function isOpenable(node: TreeNode): boolean {
  if (node.isDirectory) return false;
  return ACCEPTED_EXTENSIONS.test(node.name);
}

export type CreateKind = 'file' | 'folder';

export interface CreatingState {
  parentPath: string;
  kind: CreateKind;
  /** Initial value the input should show — e.g. 'Untitled.md' for files. */
  initialName: string;
}

export interface SidebarState {
  /** Open folder root (null when in single-file mode). */
  rootPath: string | null;
  rootTree: TreeNode | null;

  /** Visibility / sizing — both persisted via main's electron-store. */
  visible: boolean;
  width: number;
  setWidth: (width: number) => void;
  toggleVisible: () => void;
  setVisible: (visible: boolean) => void;

  /** Set of directory paths the user has expanded. */
  expanded: Set<string>;
  toggleExpanded: (path: string) => void;
  expandPath: (path: string) => void;
  collapseAll: () => void;

  /**
   * Inline editing state. At most one of these is non-null at a time —
   * starting a rename cancels an in-flight create, and vice versa.
   */
  editingPath: string | null;
  creating: CreatingState | null;
  startRename: (path: string) => void;
  startCreate: (parentPath: string, kind: CreateKind) => void;
  cancelEdit: () => void;

  openFolderDialog: () => Promise<string | null>;
  openFolderByPath: (folderPath: string) => Promise<string | null>;
  closeFolder: () => Promise<void>;
  /** Re-fetch the tree without restarting the watcher. */
  refreshTree: () => Promise<void>;
}

const SIDEBAR_DEFAULT_WIDTH = 250;

/**
 * Centralised sidebar state hook. App.tsx instantiates it once and threads
 * the slices down to <Sidebar> / <FileTree>; we keep this out of the file
 * context because the file context is per-tab and the sidebar is global.
 */
export function useSidebarState(): SidebarState {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootTree, setRootTree] = useState<TreeNode | null>(null);
  const [visible, setVisibleState] = useState<boolean>(true);
  const [width, setWidthState] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);

  // Restore visibility / width on mount (from electron-store via IPC), and
  // attempt to re-open the last folder.
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void (async () => {
      const pref = await window.api.folder.getSidebarPref();
      setVisibleState(pref.visible);
      setWidthState(pref.width);
      const last = await window.api.folder.getLast();
      if (last) {
        setRootPath(last.path);
        setRootTree(last.tree);
        // Auto-expand the root so the user sees their files immediately.
        setExpanded(new Set([last.path]));
      }
    })();
  }, []);

  const setWidth = useCallback((next: number) => {
    setWidthState(next);
    window.api.folder.setSidebarWidth(next);
  }, []);

  const setVisible = useCallback((next: boolean) => {
    setVisibleState(next);
    window.api.folder.setSidebarVisible(next);
  }, []);

  const toggleVisible = useCallback(() => {
    setVisibleState((prev) => {
      const next = !prev;
      window.api.folder.setSidebarVisible(next);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandPath = useCallback((path: string) => {
    setExpanded((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const startRename = useCallback((path: string) => {
    setCreating(null);
    setEditingPath(path);
  }, []);

  const startCreate = useCallback(
    (parentPath: string, kind: CreateKind) => {
      setEditingPath(null);
      // Make sure the user can see the input we're about to render.
      setExpanded((prev) => {
        if (prev.has(parentPath)) return prev;
        const next = new Set(prev);
        next.add(parentPath);
        return next;
      });
      setCreating({
        parentPath,
        kind,
        initialName: kind === 'file' ? 'Untitled.md' : '',
      });
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    setEditingPath(null);
    setCreating(null);
  }, []);

  const collapseAll = useCallback(() => {
    setExpanded((prev) => {
      // Keep the root expanded so the user still sees the top level — that
      // matches most file-tree UIs (collapse-all = collapse children, not
      // hide the entire tree).
      const next = new Set<string>();
      if (rootPath) next.add(rootPath);
      return prev.size === next.size && [...prev][0] === rootPath ? prev : next;
    });
  }, [rootPath]);

  const openFolderDialog = useCallback(async () => {
    const result = await window.api.folder.open();
    if (!result) return null;
    setRootPath(result.path);
    setRootTree(result.tree);
    setExpanded(new Set([result.path]));
    return result.path;
  }, []);

  const openFolderByPath = useCallback(async (folderPath: string) => {
    try {
      const result = await window.api.folder.openPath(folderPath);
      setRootPath(result.path);
      setRootTree(result.tree);
      setExpanded(new Set([result.path]));
      return result.path;
    } catch (err) {
      window.api.showError(
        'Could not open folder',
        `${folderPath}\n\n${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }, []);

  const closeFolder = useCallback(async () => {
    await window.api.folder.close();
    setRootPath(null);
    setRootTree(null);
    setExpanded(new Set());
  }, []);

  // Capture rootPath in a ref so the listener (registered once) reads the
  // current value rather than a stale closure.
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;

  const refreshTree = useCallback(async () => {
    const root = rootPathRef.current;
    if (!root) return;
    try {
      const tree = await window.api.folder.getTree(root);
      setRootTree(tree);
    } catch {
      // Folder might have disappeared; close out cleanly.
      await closeFolder();
    }
  }, [closeFolder]);

  // Listen for chokidar tree-changed events from main.
  useEffect(() => {
    const off = window.api.folder.onTreeChanged(() => {
      void refreshTree();
    });
    return off;
  }, [refreshTree]);

  return {
    rootPath,
    rootTree,
    visible,
    width,
    setWidth,
    toggleVisible,
    setVisible,
    expanded,
    toggleExpanded,
    expandPath,
    collapseAll,
    editingPath,
    creating,
    startRename,
    startCreate,
    cancelEdit,
    openFolderDialog,
    openFolderByPath,
    closeFolder,
    refreshTree,
  };
}
