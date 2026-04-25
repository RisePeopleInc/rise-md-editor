import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StatusBar } from './components/StatusBar';
import {
  SourceEditor,
  type CursorPosition,
  type SourceEditorHandle,
} from './components/editors/SourceEditor';
import { FileProvider, useFileState } from './state/fileState';
import type { MenuActionEvent } from './env';

const ACCEPTED_EXTENSIONS = /\.(md|markdown|txt)$/i;

function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

function AppContent() {
  const file = useFileState();
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const editorRef = useRef<SourceEditorHandle>(null);

  const handleOpenFile = useCallback(async () => {
    await file.withDirtyGuard(async () => {
      const result = await window.api.files.open();
      if (result) {
        file.loadFile(result.path, result.content);
        window.api.addRecent(result.path);
      }
    });
  }, [file]);

  const handleOpenPath = useCallback(
    async (filePath: string) => {
      await file.withDirtyGuard(async () => {
        try {
          const result = await window.api.files.openPath(filePath);
          file.loadFile(result.path, result.content);
          window.api.addRecent(result.path);
        } catch (err) {
          console.error('Failed to open file', filePath, err);
        }
      });
    },
    [file],
  );

  const handleOpenFolder = useCallback(async () => {
    await window.api.openFolder();
  }, []);

  const handleNewFile = useCallback(async () => {
    await file.withDirtyGuard(() => {
      file.newFile();
    });
  }, [file]);

  // Drag-and-drop: dragging a markdown file onto the window opens it.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const dropped = e.dataTransfer?.files;
      if (!dropped || dropped.length === 0) return;
      const target = Array.from(dropped).find((f) => ACCEPTED_EXTENSIONS.test(f.name));
      if (!target) return;
      const filePath = window.api.files.getPathForFile(target);
      if (!filePath) return;
      void handleOpenPath(filePath);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleOpenPath]);

  // Menu IPC dispatch. notifyReady fires inside the same effect (after the
  // listener is attached) so main can drain any actions it queued while the
  // window was closed or the renderer was still mounting.
  useEffect(() => {
    const off = window.api.onMenuAction((event: MenuActionEvent) => {
      switch (event.type) {
        case 'new':
          void handleNewFile();
          break;
        case 'open-file':
          void handleOpenFile();
          break;
        case 'open-path':
          if (event.payload?.path) void handleOpenPath(event.payload.path);
          break;
        case 'open-folder':
          void window.api.openFolder();
          break;
        case 'save':
          void file.save();
          break;
        case 'save-as':
          void file.saveAs();
          break;
        case 'undo':
          editorRef.current?.triggerUndo();
          break;
        case 'redo':
          editorRef.current?.triggerRedo();
          break;
        case 'find':
          editorRef.current?.triggerFind();
          break;
        case 'replace':
          editorRef.current?.triggerReplace();
          break;
        case 'font-zoom-in':
          editorRef.current?.zoomIn();
          break;
        case 'font-zoom-out':
          editorRef.current?.zoomOut();
          break;
        case 'font-zoom-reset':
          editorRef.current?.zoomReset();
          break;
        default:
          break;
      }
    });
    window.api.notifyReady();
    return off;
  }, [file, handleNewFile, handleOpenFile, handleOpenPath]);

  const wordCount = useMemo(() => countWords(file.content), [file.content]);

  return (
    <div className="flex h-full w-full flex-col">
      <main className="min-h-0 flex-1">
        {file.hasDocument ? (
          <SourceEditor
            ref={editorRef}
            content={file.content}
            onChange={file.setContent}
            onCursorChange={setCursor}
          />
        ) : (
          <WelcomeScreen onOpenFile={handleOpenFile} onOpenFolder={handleOpenFolder} />
        )}
      </main>
      {file.hasDocument && (
        <StatusBar
          line={cursor.line}
          column={cursor.column}
          wordCount={wordCount}
          mode="Source"
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <FileProvider>
      <AppContent />
    </FileProvider>
  );
}
