import type { Ref } from 'react';
import { ModeSwitcher } from './ModeSwitcher';
import { ReadView } from './ReadView';
import { SourceEditor, type CursorPosition, type SourceEditorHandle } from './SourceEditor';
import { SplitView } from './SplitView';
import { WysiwygEditor, type WysiwygEditorHandle } from './WysiwygEditor';
import type { EditorMode, Tab } from '../../state/fileState';
import type { ImageInsertion, PasteImageSnapshot } from '../../state/imageInsert';
import type { WordWrap } from '../../env';

interface EditorContainerProps {
  tab: Tab;
  onContentChange: (markdown: string) => void;
  /**
   * RAISE-55 follow-up: WYSIWYG-only baseline path. Invoked instead of
   * `onContentChange` for emits that fire before any user input on the
   * editor (the editor's post-parse / post-init-transaction markdown).
   * Lets fileState capture the editor's normalized view as the dirty
   * baseline so cosmetic round-trip drift doesn't show as dirty.
   */
  onContentBaseline?: (markdown: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onCursorChange: (position: CursorPosition) => void;
  /** RAISE-60: persist Read view's scroll offset on the active tab. */
  onReadScrollChange: (top: number) => void;
  sourceRef: Ref<SourceEditorHandle>;
  wysiwygRef: Ref<WysiwygEditorHandle>;
  /** Monaco theme id (gruvbox-{contrast}-{mode}) for the source editor. */
  monacoThemeId: string;
  /** Source-editor word-wrap mode. WYSIWYG / preview ignore it. */
  wordWrap: WordWrap;
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
  onContentBaseline,
  onModeChange,
  onCursorChange,
  onReadScrollChange,
  sourceRef,
  wysiwygRef,
  monacoThemeId,
  wordWrap,
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
      <div className="min-h-0 min-w-0 flex-1">
        {mode === 'read' ? (
          // RAISE-60: Read mode — pure rendered markdown, no editor
          // surface. Re-key on tab id + load epoch so a re-open (which
          // bumps loadEpoch via loadFile) repaints with fresh content.
          // Without the load-epoch key, an external-edit refresh
          // wouldn't trigger ReadView's scroll-restore raf because the
          // `html` memo depends only on content, and React would
          // reconcile in place — the user would stay scrolled to
          // their previous position even though the content changed.
          <ReadView
            key={`${tab.id}-${tab.loadEpoch}`}
            content={tab.content}
            markdownPath={tab.path}
            initialScrollTop={tab.readScrollPosition}
            onScrollChange={onReadScrollChange}
          />
        ) : mode === 'wysiwyg' ? (
          // Re-key on tab id + load epoch so a tab switch OR a re-open of
          // the same file (loadFile bumps loadEpoch) fully remounts Milkdown
          // with the new content (the editor is uncontrolled-with-reset).
          <WysiwygEditor
            key={`${tab.id}-${tab.loadEpoch}`}
            ref={wysiwygRef}
            content={tab.content}
            onChange={onContentChange}
            onMarkdownBaseline={onContentBaseline}
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
            wordWrap={wordWrap}
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
            wordWrap={wordWrap}
            onImageDrop={onImageDrop}
            onImagePaste={onImagePaste}
            markdownPath={tab.path}
          />
        )}
      </div>
    </div>
  );
}
