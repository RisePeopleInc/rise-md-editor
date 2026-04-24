import { useCallback, useEffect, useState } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import type { MenuActionEvent } from './env';

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export default function App() {
  const [currentFile, setCurrentFile] = useState<string | null>(null);

  useEffect(() => {
    window.api.setTitle(currentFile ? basename(currentFile) : null);
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
        // Other actions (save, find, view modes, etc.) are wired here as
        // editor features land. The menu already dispatches them.
        default:
          break;
      }
    });
    return off;
  }, []);

  return (
    <div className="h-full w-full">
      {currentFile ? (
        <div className="flex h-full items-center justify-center text-slate-300">
          <span className="text-sm">Editor placeholder for {basename(currentFile)}</span>
        </div>
      ) : (
        <WelcomeScreen onOpenFile={handleOpenFile} onOpenFolder={handleOpenFolder} />
      )}
    </div>
  );
}
