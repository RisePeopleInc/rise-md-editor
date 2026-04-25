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

export interface FileState {
  hasDocument: boolean;
  path: string | null;
  content: string;
  savedContent: string;
  isDirty: boolean;
}

export interface FileActions {
  setContent: (next: string) => void;
  loadFile: (path: string, content: string) => void;
  newFile: () => void;
  save: () => Promise<boolean>;
  saveAs: () => Promise<boolean>;
  /**
   * Run an action that replaces the current document. If the current document
   * has unsaved changes, prompts the user (Save / Don't Save / Cancel).
   * Returns true if the action ran, false if the user canceled or save failed.
   */
  withDirtyGuard: (action: () => void | Promise<void>) => Promise<boolean>;
}

export type FileContextValue = FileState & FileActions;

const FileContext = createContext<FileContextValue | null>(null);

interface FileProviderProps {
  children: ReactNode;
}

function basename(p: string | null): string {
  if (!p) return 'Untitled';
  return p.split(/[\\/]/).pop() || p;
}

export function FileProvider({ children }: FileProviderProps) {
  const [hasDocument, setHasDocument] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [content, setContentState] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');

  const isDirty = hasDocument && content !== savedContent;

  // Push the cheap signal (path + isDirty) synchronously on every change so
  // main's close-with-unsaved decision can never read a stale "clean" flag
  // immediately after a keystroke. The window-title update rides on the
  // same channel — also wants to stay in sync with isDirty.
  useEffect(() => {
    if (!hasDocument) return;
    window.api.pushFileMeta({ path, isDirty });
  }, [hasDocument, path, isDirty]);

  // Content can be debounced — it's only consumed by the Save-on-close path
  // and a small lag there costs at most a few keystrokes, not the whole
  // dirty-state guarantee.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hasDocument) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      window.api.pushFileContent(content);
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [hasDocument, content]);

  const loadFile = useCallback((nextPath: string, nextContent: string) => {
    setHasDocument(true);
    setPath(nextPath);
    setContentState(nextContent);
    setSavedContent(nextContent);
  }, []);

  const newFile = useCallback(() => {
    setHasDocument(true);
    setPath(null);
    setContentState('');
    setSavedContent('');
  }, []);

  const setContent = useCallback((next: string) => {
    setContentState(next);
  }, []);

  const saveAs = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.api.files.saveAs(content, basename(path));
      if (!result) return false;
      setPath(result.path);
      setSavedContent(content);
      window.api.addRecent(result.path);
      return true;
    } catch (err) {
      window.api.showError(
        'Could not save file',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }, [content, path]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!path) return saveAs();
    try {
      await window.api.files.save(path, content);
      setSavedContent(content);
      return true;
    } catch (err) {
      window.api.showError(
        'Could not save file',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }, [content, path, saveAs]);

  const withDirtyGuard = useCallback(
    async (action: () => void | Promise<void>): Promise<boolean> => {
      if (isDirty) {
        const choice = await window.api.confirmUnsavedChanges(basename(path));
        if (choice === 'cancel') return false;
        if (choice === 'save') {
          const ok = await save();
          if (!ok) return false;
        }
      }
      await action();
      return true;
    },
    [isDirty, path, save],
  );

  // If main saves on our behalf during the close-with-unsaved flow, it will
  // tell us the new path and exact bytes written so the renderer can update
  // its baseline. Currently the window is closing when this fires, but
  // future "save without close" flows will need the correct savedContent.
  useEffect(() => {
    const off = window.api.onFileSavedAs(({ path: savedPath, content: savedBytes }) => {
      setPath(savedPath);
      setSavedContent(savedBytes);
    });
    return off;
  }, []);

  const value = useMemo<FileContextValue>(
    () => ({
      hasDocument,
      path,
      content,
      savedContent,
      isDirty,
      setContent,
      loadFile,
      newFile,
      save,
      saveAs,
      withDirtyGuard,
    }),
    [
      hasDocument,
      path,
      content,
      savedContent,
      isDirty,
      setContent,
      loadFile,
      newFile,
      save,
      saveAs,
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
