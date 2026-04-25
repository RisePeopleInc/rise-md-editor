import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createElement } from 'react';

export interface CursorPos {
  line: number;
  column: number;
}

export type EditorMode = 'source' | 'wysiwyg' | 'split';

export interface Tab {
  id: string;
  path: string | null;
  content: string;
  savedContent: string;
  cursorPosition: CursorPos;
  scrollPosition: number;
  editorMode: EditorMode;
}

export interface FileContextValue {
  tabs: Tab[];
  activeTabId: string | null;
  activeTab: Tab | null;
  isDirty: boolean;

  setContent: (content: string) => void;
  loadFile: (path: string, content: string) => void;
  newFile: () => void;
  save: (id?: string) => Promise<boolean>;
  saveAs: (id?: string) => Promise<boolean>;
  saveAllDirty: () => Promise<boolean>;

  switchTo: (id: string) => void;
  closeTab: (id: string) => Promise<boolean>;
  closeActiveTab: () => Promise<boolean>;
  nextTab: () => void;
  prevTab: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;

  setActiveCursor: (cursor: CursorPos) => void;
  setActiveScroll: (top: number) => void;

  withDirtyGuard: (action: () => void | Promise<void>) => Promise<boolean>;
}

const FileContext = createContext<FileContextValue | null>(null);

interface FileProviderProps {
  children: ReactNode;
}

function basenameOf(p: string | null): string {
  if (!p) return 'Untitled';
  return p.split(/[\\/]/).pop() || p;
}

function isTabDirty(t: Tab): boolean {
  return t.content !== t.savedContent;
}

function makeTab(path: string | null, content: string): Tab {
  return {
    id: crypto.randomUUID(),
    path,
    content,
    savedContent: content,
    cursorPosition: { line: 1, column: 1 },
    scrollPosition: 0,
    editorMode: 'source',
  };
}

export function FileProvider({ children }: FileProviderProps) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const isDirty = activeTab ? isTabDirty(activeTab) : false;
  const dirtyCount = useMemo(() => tabs.filter(isTabDirty).length, [tabs]);

  // Push the active tab's title-relevant signal + the global dirty count
  // synchronously on every change. Title needs path + isDirty (active);
  // window close needs dirtyCount (any tab dirty).
  useEffect(() => {
    window.api.pushFileMeta({
      path: activeTab?.path ?? null,
      isDirty: activeTab ? isTabDirty(activeTab) : false,
      dirtyCount,
    });
  }, [activeTab, dirtyCount]);

  const updateTab = useCallback(
    (id: string, patch: Partial<Tab>) => {
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [],
  );

  const setContent = useCallback(
    (content: string) => {
      if (!activeTabId) return;
      updateTab(activeTabId, { content });
    },
    [activeTabId, updateTab],
  );

  const switchTo = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const loadFile = useCallback((nextPath: string, nextContent: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === nextPath);
      if (existing) {
        setActiveTabId(existing.id);
        // Refresh content from disk in case it changed externally.
        return prev.map((t) =>
          t.id === existing.id
            ? { ...t, content: nextContent, savedContent: nextContent }
            : t,
        );
      }
      const tab = makeTab(nextPath, nextContent);
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const newFile = useCallback(() => {
    const tab = makeTab(null, '');
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs((prev) => {
      if (
        fromIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex < 0 ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return prev;
      }
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved!);
      return next;
    });
  }, []);

  const setActiveCursor = useCallback(
    (cursor: CursorPos) => {
      if (!activeTabId) return;
      updateTab(activeTabId, { cursorPosition: cursor });
    },
    [activeTabId, updateTab],
  );

  const setActiveScroll = useCallback(
    (top: number) => {
      if (!activeTabId) return;
      updateTab(activeTabId, { scrollPosition: top });
    },
    [activeTabId, updateTab],
  );

  const saveAs = useCallback(
    async (id?: string): Promise<boolean> => {
      const targetId = id ?? activeTabId;
      const tab = tabs.find((t) => t.id === targetId);
      if (!tab) return false;
      try {
        const result = await window.api.files.saveAs(tab.content, basenameOf(tab.path));
        if (!result) return false;
        updateTab(tab.id, { path: result.path, savedContent: tab.content });
        window.api.addRecent(result.path);
        return true;
      } catch (err) {
        window.api.showError(
          'Could not save file',
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    },
    [activeTabId, tabs, updateTab],
  );

  const save = useCallback(
    async (id?: string): Promise<boolean> => {
      const targetId = id ?? activeTabId;
      const tab = tabs.find((t) => t.id === targetId);
      if (!tab) return false;
      if (!tab.path) return saveAs(tab.id);
      try {
        await window.api.files.save(tab.path, tab.content);
        updateTab(tab.id, { savedContent: tab.content });
        return true;
      } catch (err) {
        window.api.showError(
          'Could not save file',
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    },
    [activeTabId, tabs, updateTab, saveAs],
  );

  const saveAllDirty = useCallback(async (): Promise<boolean> => {
    for (const tab of tabs) {
      if (!isTabDirty(tab)) continue;
      // Switch to the tab first so any saveAs dialog has obvious context.
      setActiveTabId(tab.id);
      const ok = await save(tab.id);
      if (!ok) return false;
    }
    return true;
  }, [tabs, save]);

  const withDirtyGuard = useCallback(
    async (action: () => void | Promise<void>): Promise<boolean> => {
      // Active-tab guard, used for actions that REPLACE the active document
      // in place (would discard unsaved changes). Multi-tab opens just add a
      // new tab and don't need this — they go through loadFile directly.
      if (activeTab && isTabDirty(activeTab)) {
        const choice = await window.api.confirmUnsavedChanges(basenameOf(activeTab.path));
        if (choice === 'cancel') return false;
        if (choice === 'save') {
          const ok = await save(activeTab.id);
          if (!ok) return false;
        }
      }
      await action();
      return true;
    },
    [activeTab, save],
  );

  const closeTab = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return false;
      if (isTabDirty(tab)) {
        // Surface which tab the prompt is about — switch to it so the user
        // sees its content before deciding.
        setActiveTabId(id);
        const choice = await window.api.confirmUnsavedChanges(basenameOf(tab.path));
        if (choice === 'cancel') return false;
        if (choice === 'save') {
          const ok = await save(id);
          if (!ok) return false;
        }
      }
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) return prev;
        const next = prev.slice();
        next.splice(idx, 1);
        if (id === activeTabId) {
          // Pick neighbour: prefer the tab to the right, else the one before.
          const newActive = next[idx] ?? next[idx - 1] ?? null;
          setActiveTabId(newActive ? newActive.id : null);
        }
        return next;
      });
      return true;
    },
    [tabs, save, activeTabId],
  );

  const closeActiveTab = useCallback(async (): Promise<boolean> => {
    if (!activeTabId) {
      // No tabs — close the window (matches macOS Cmd+W on the welcome screen).
      window.api.closeWindow();
      return true;
    }
    return closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const nextTab = useCallback(() => {
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) setActiveTabId(next.id);
  }, [tabs, activeTabId]);

  const prevTab = useCallback(() => {
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
    if (prev) setActiveTabId(prev.id);
  }, [tabs, activeTabId]);

  // Window-close save-all flow: main asks renderer to save every dirty tab,
  // renderer responds with the aggregate result.
  useEffect(() => {
    const off = window.api.onSaveAllRequest(async () => {
      const ok = await saveAllDirty();
      window.api.respondSaveAll(ok);
    });
    return off;
  }, [saveAllDirty]);

  // If main saved a file on the renderer's behalf during close-flow (legacy
  // path — no longer the primary route), update the matching tab.
  useEffect(() => {
    const off = window.api.onFileSavedAs(({ path: savedPath, content: savedBytes }) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.path === savedPath || (t.id === activeTabId && !t.path)
            ? { ...t, path: savedPath, savedContent: savedBytes }
            : t,
        ),
      );
    });
    return off;
  }, [activeTabId]);

  const value = useMemo<FileContextValue>(
    () => ({
      tabs,
      activeTabId,
      activeTab,
      isDirty,
      setContent,
      loadFile,
      newFile,
      save,
      saveAs,
      saveAllDirty,
      switchTo,
      closeTab,
      closeActiveTab,
      nextTab,
      prevTab,
      reorderTabs,
      setActiveCursor,
      setActiveScroll,
      withDirtyGuard,
    }),
    [
      tabs,
      activeTabId,
      activeTab,
      isDirty,
      setContent,
      loadFile,
      newFile,
      save,
      saveAs,
      saveAllDirty,
      switchTo,
      closeTab,
      closeActiveTab,
      nextTab,
      prevTab,
      reorderTabs,
      setActiveCursor,
      setActiveScroll,
      withDirtyGuard,
    ],
  );

  return createElement(FileContext.Provider, { value }, children);
}

export function useFileState(): FileContextValue {
  const ctx = useContext(FileContext);
  if (!ctx) throw new Error('useFileState must be used within FileProvider');
  return ctx;
}
