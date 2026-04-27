import type { Ref } from 'react';
import { ModeSwitcher } from './ModeSwitcher';
import { SourceEditor, type CursorPosition, type SourceEditorHandle } from './SourceEditor';
import { SplitView } from './SplitView';
import { WysiwygEditor, type WysiwygEditorHandle } from './WysiwygEditor';
import type { EditorMode, Tab } from '../../state/fileState';
import type { ImageInsertion, PasteImageSnapshot } from '../../state/imageInsert';

interface EditorContainerProps {
  tab: Tab;
  onContentChange: (markdown: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onCursorChange: (position: CursorPosition) => void;
  sourceRef: Ref<SourceEditorHandle>;
  wysiwygRef: Ref<WysiwygEditorHandle>;
  /** Monaco theme id (gruvbox-{contrast}-{mode}) for the source editor. */
  monacoThemeId: string;
  /** Image-drop handler — saves files via IPC, returns markdown to insert. */
  onImageDrop: (files: File[]) => Promise<ImageInsertion[]>;
  /** Image-paste handler — saves clipboard image, returns markdown to insert.
   *  Receives a synchronous snapshot of the DataTransferItem (the live
   *  item is invalidated when the paste handler returns). */
  onImagePaste: (snapshot: PasteImageSnapshot) => Promise<ImageInsertion | null>;
  /** "View full size" handler for image-click tooltip in WYSIWYG. */
  onOpenImage: (relPath: string) => void;
  /** WYSIWYG toolbar's image button uses this to ensure the tab is
   *  saved before opening the file picker. */
  requireSavedPath: () => Promise<string | null>;
}

/**
 * Single home for "which editor is active for the active tab". Markdown is
 * the source of truth — every editor reads and writes the same string. The
 * mode switcher is rendered top-right and stays put across modes.
 */
export function EditorContainer({
  tab,
  onContentChange,
  onModeChange,
  onCursorChange,
  sourceRef,
  wysiwygRef,
  monacoThemeId,
  onImageDrop,
  onImagePaste,
  onOpenImage,
  requireSavedPath,
}: EditorContainerProps) {
  const mode = tab.editorMode;

  return (
    <div className="flex h-full w-full flex-col bg-app">
      <div className="flex h-9 shrink-0 items-center justify-end border-b border-stroke bg-app px-2">
        <ModeSwitcher mode={mode} onChange={onModeChange} />
      </div>
      <div className="min-h-0 flex-1">
        {mode === 'wysiwyg' ? (
          // Re-key on tab id + load epoch so a tab switch OR a re-open of
          // the same file (loadFile bumps loadEpoch) fully remounts Milkdown
          // with the new content (the editor is uncontrolled-with-reset).
          <WysiwygEditor
            key={`${tab.id}-${tab.loadEpoch}`}
            ref={wysiwygRef}
            content={tab.content}
            onChange={onContentChange}
            initialScrollTop={tab.wysiwygScrollPosition}
            initialCursorOffset={tab.wysiwygCursorOffset}
            onImageDrop={onImageDrop}
            onImagePaste={onImagePaste}
            markdownPath={tab.path}
            onOpenImage={onOpenImage}
            requireSavedPath={requireSavedPath}
          />
        ) : mode === 'split' ? (
          <SplitView
            sourceRef={sourceRef}
            content={tab.content}
            onChange={onContentChange}
            onCursorChange={onCursorChange}
            initialCursor={tab.cursorPosition}
            initialScrollTop={tab.scrollPosition}
            monacoThemeId={monacoThemeId}
            onImageDrop={onImageDrop}
            onImagePaste={onImagePaste}
            markdownPath={tab.path}
          />
        ) : (
          <SourceEditor
            ref={sourceRef}
            content={tab.content}
            onChange={onContentChange}
            onCursorChange={onCursorChange}
            initialCursor={tab.cursorPosition}
            initialScrollTop={tab.scrollPosition}
            monacoThemeId={monacoThemeId}
            onImageDrop={onImageDrop}
            onImagePaste={onImagePaste}
          />
        )}
      </div>
    </div>
  );
}
