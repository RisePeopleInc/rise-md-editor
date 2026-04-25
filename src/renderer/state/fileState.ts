import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  /**
   * Bumped each time `loadFile` reloads this tab from disk while it is
   * already open. Editors that are uncontrolled-with-reset (Milkdown) key
   * off `${id}-${loadEpoch}` so a re-open visibly refreshes the document.
   */
  loadEpoch: number;
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
  reviewEachDirtyTab: () => Promise<boolean>;

  switchTo: (id: string) => void;
  closeTab: (id: string) => Promise<boolean>;
  closeActiveTab: () => Promise<boolean>;
  nextTab: () => void;
  prevTab: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;

  setActiveCursor: (cursor: CursorPos) => void;
  setActiveScroll: (top: number) => void;
  setActiveEditorMode: (mode: EditorMode) => void;

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
    // RAISE-7: WYSIWYG is the welcoming default — both new files and freshly
    // opened files land in formatted mode. Users can flip to Source or Split
    // per tab via the mode switcher (or Cmd+1/2/3, or Cmd+\ to cycle).
    editorMode: 'wysiwyg',
    loadEpoch: 0,
  };
}

export function FileProvider({ children }: FileProviderProps) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Authoritative refs: every state mutation goes through `writeTabs` /
  // `writeActiveTabId`, which update the ref *synchronously* and then queue
  // the React state update. Subsequent calls in the same tick (e.g. a rapid
  // double-open) see the latest state without waiting for the next commit —
  // that's what prevents duplicate tabs when two `loadFile` calls land back
  // to back before React has had a chance to flush.
  const tabsRef = useRef<Tab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);

  const writeTabs = useCallback((next: Tab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const writeActiveTabId = useCallback((next: string | null) => {
    activeTabIdRef.current = next;
    setActiveTabId(next);
  }, []);

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
      writeTabs(
        tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
    },
    [writeTabs],
  );

  const setContent = useCallback(
    (content: string) => {
      const id = activeTabIdRef.current;
      if (!id) return;
      updateTab(id, { content });
    },
    [updateTab],
  );

  const switchTo = useCallback(
    (id: string) => {
      writeActiveTabId(id);
    },
    [writeActiveTabId],
  );

  const loadFile = useCallback(
    (nextPath: string, nextContent: string) => {
      // Read + write against the synchronous ref so two `loadFile` calls in
      // the same tick can't both miss an existing tab and create duplicates.
      const existing = tabsRef.current.find((t) => t.path === nextPath);
      if (existing) {
        writeTabs(
          tabsRef.current.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  content: nextContent,
                  savedContent: nextContent,
                  // Bump epoch so editors keyed by id+epoch (e.g., Milkdown,
                  // which reads its initial value once) remount and pick up
                  // the refreshed content.
                  loadEpoch: t.loadEpoch + 1,
                }
              : t,
          ),
        );
        writeActiveTabId(existing.id);
        return;
      }
      const tab = makeTab(nextPath, nextContent);
      writeTabs([...tabsRef.current, tab]);
      writeActiveTabId(tab.id);
    },
    [writeTabs, writeActiveTabId],
  );

  const newFile = useCallback(() => {
    const tab = makeTab(null, '');
    writeTabs([...tabsRef.current, tab]);
    writeActiveTabId(tab.id);
  }, [writeTabs, writeActiveTabId]);

  const reorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      const prev = tabsRef.current;
      if (
        fromIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex < 0 ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved!);
      writeTabs(next);
    },
    [writeTabs],
  );

  const setActiveCursor = useCallback(
    (cursor: CursorPos) => {
      const id = activeTabIdRef.current;
      if (!id) return;
      updateTab(id, { cursorPosition: cursor });
    },
    [updateTab],
  );

  const setActiveScroll = useCallback(
    (top: number) => {
      const id = activeTabIdRef.current;
      if (!id) return;
      updateTab(id, { scrollPosition: top });
    },
    [updateTab],
  );

  const setActiveEditorMode = useCallback(
    (mode: EditorMode) => {
      const id = activeTabIdRef.current;
      if (!id) return;
      updateTab(id, { editorMode: mode });
    },
    [updateTab],
  );

  const saveAs = useCallback(
    async (id?: string): Promise<boolean> => {
      const targetId = id ?? activeTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === targetId);
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
    [updateTab],
  );

  const save = useCallback(
    async (id?: string): Promise<boolean> => {
      const targetId = id ?? activeTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === targetId);
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
    [updateTab, saveAs],
  );

  const saveAllDirty = useCallback(async (): Promise<boolean> => {
    // Iterate from the live ref so an updated savedContent (after each save)
    // doesn't re-trigger an already-saved tab.
    for (const tab of tabsRef.current) {
      const live = tabsRef.current.find((t) => t.id === tab.id);
      if (!live || !isTabDirty(live)) continue;
      // Switch first so any saveAs dialog has obvious context.
      writeActiveTabId(live.id);
      const ok = await save(live.id);
      if (!ok) return false;
    }
    return true;
  }, [save, writeActiveTabId]);

  // Walk dirty tabs one by one, prompting the user for each (Save / Don't
  // Save / Cancel). 'Don't Save' silently skips that tab; 'Cancel' aborts
  // the whole flow so the window stays open.
  const reviewEachDirtyTab = useCallback(async (): Promise<boolean> => {
    for (const tab of tabsRef.current) {
      const live = tabsRef.current.find((t) => t.id === tab.id);
      if (!live || !isTabDirty(live)) continue;
      writeActiveTabId(live.id);
      const choice = await window.api.confirmUnsavedChanges(basenameOf(live.path));
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        const ok = await save(live.id);
        if (!ok) return false;
      }
    }
    return true;
  }, [save, writeActiveTabId]);

  const withDirtyGuard = useCallback(
    async (action: () => void | Promise<void>): Promise<boolean> => {
      const current = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      if (current && isTabDirty(current)) {
        const choice = await window.api.confirmUnsavedChanges(basenameOf(current.path));
        if (choice === 'cancel') return false;
        if (choice === 'save') {
          const ok = await save(current.id);
          if (!ok) return false;
        }
      }
      await action();
      return true;
    },
    [save],
  );

  const closeTab = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return false;
      if (isTabDirty(tab)) {
        // Surface which tab the prompt is about — switch to it so the user
        // sees its content before deciding.
        writeActiveTabId(id);
        const choice = await window.api.confirmUnsavedChanges(basenameOf(tab.path));
        if (choice === 'cancel') return false;
        if (choice === 'save') {
          const ok = await save(id);
          if (!ok) return false;
        }
      }
      // Re-read against the live ref after the await; another close in flight
      // could have shifted the array.
      const fresh = tabsRef.current;
      const idx = fresh.findIndex((t) => t.id === id);
      if (idx === -1) return false;
      const next = fresh.slice();
      next.splice(idx, 1);
      writeTabs(next);
      if (id === activeTabIdRef.current) {
        const neighbour = next[idx] ?? next[idx - 1] ?? null;
        writeActiveTabId(neighbour ? neighbour.id : null);
      }
      return true;
    },
    [save, writeTabs, writeActiveTabId],
  );

  const closeActiveTab = useCallback(async (): Promise<boolean> => {
    const id = activeTabIdRef.current;
    if (!id) {
      // No tabs — close the window (matches macOS Cmd+W on the welcome screen).
      window.api.closeWindow();
      return true;
    }
    return closeTab(id);
  }, [closeTab]);

  const nextTab = useCallback(() => {
    const list = tabsRef.current;
    if (list.length === 0) return;
    const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
    const next = list[(idx + 1) % list.length];
    if (next) writeActiveTabId(next.id);
  }, [writeActiveTabId]);

  const prevTab = useCallback(() => {
    const list = tabsRef.current;
    if (list.length === 0) return;
    const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
    const prev = list[(idx - 1 + list.length) % list.length];
    if (prev) writeActiveTabId(prev.id);
  }, [writeActiveTabId]);

  // Window-close dirty-tab resolution. Main asks for either a Save All sweep
  // or a tab-by-tab walkthrough; we run the chosen flow and report success.
  useEffect(() => {
    const off = window.api.onResolveDirty(async (mode) => {
      const ok =
        mode === 'save-all' ? await saveAllDirty() : await reviewEachDirtyTab();
      window.api.respondResolveDirty(ok);
    });
    return off;
  }, [saveAllDirty, reviewEachDirtyTab]);

  // If main saved a file on the renderer's behalf during close-flow (legacy
  // path — no longer the primary route), update the matching tab.
  useEffect(() => {
    const off = window.api.onFileSavedAs(({ path: savedPath, content: savedBytes }) => {
      const next = tabsRef.current.map((t) =>
        t.path === savedPath || (t.id === activeTabIdRef.current && !t.path)
          ? { ...t, path: savedPath, savedContent: savedBytes }
          : t,
      );
      writeTabs(next);
    });
    return off;
  }, [writeTabs]);

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
      reviewEachDirtyTab,
      switchTo,
      closeTab,
      closeActiveTab,
      nextTab,
      prevTab,
      reorderTabs,
      setActiveCursor,
      setActiveScroll,
      setActiveEditorMode,
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
      reviewEachDirtyTab,
      switchTo,
      closeTab,
      closeActiveTab,
      nextTab,
      prevTab,
      reorderTabs,
      setActiveCursor,
      setActiveScroll,
      setActiveEditorMode,
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
