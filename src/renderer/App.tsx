import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StatusBar } from './components/StatusBar';
import {
  SourceEditor,
  type CursorPosition,
  type SourceEditorHandle,
} from './components/editors/SourceEditor';
import { TEST_MARKDOWN } from './testContent';
import type { MenuActionEvent } from './env';

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

export default function App() {
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const editorRef = useRef<SourceEditorHandle>(null);

  useEffect(() => {
    window.api.setTitle(currentFile ? basename(currentFile) : null);
  }, [currentFile]);

  // File I/O isn't implemented yet — when any file is "opened" we seed the
  // editor with TEST_MARKDOWN so we can verify Monaco's Markdown rendering.
  useEffect(() => {
    setContent(currentFile ? TEST_MARKDOWN : '');
  }, [currentFile]);

  const handleOpenFile = useCallback(async () => {
    const filePath = await window.api.openFile();
    if (filePath) setCurrentFile(filePath);
  }, []);

  const handleOpenFolder = useCallback(async () => {
    await window.api.openFolder();
  }, []);

  useEffect(() => {
    const off = window.api.onMenuAction((event: MenuActionEvent) => {
      switch (event.type) {
        case 'new':
          setCurrentFile(null);
          break;
        case 'open-file':
          if (event.payload?.path) setCurrentFile(event.payload.path);
          break;
        case 'open-recent':
          if (event.payload?.clear) return;
          if (event.payload?.path) setCurrentFile(event.payload.path);
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
    return off;
  }, []);

  const wordCount = useMemo(() => countWords(content), [content]);

  return (
    <div className="flex h-full w-full flex-col">
      <main className="min-h-0 flex-1">
        {currentFile ? (
          <SourceEditor
            ref={editorRef}
            content={content}
            onChange={setContent}
            onCursorChange={setCursor}
          />
        ) : (
          <WelcomeScreen onOpenFile={handleOpenFile} onOpenFolder={handleOpenFolder} />
        )}
      </main>
      {currentFile && (
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
