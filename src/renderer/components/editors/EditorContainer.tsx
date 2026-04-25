import type { Ref } from 'react';
import { ModeSwitcher } from './ModeSwitcher';
import { SourceEditor, type CursorPosition, type SourceEditorHandle } from './SourceEditor';
import { SplitView } from './SplitView';
import { WysiwygEditor, type WysiwygEditorHandle } from './WysiwygEditor';
import type { EditorMode, Tab } from '../../state/fileState';

interface EditorContainerProps {
  tab: Tab;
  onContentChange: (markdown: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onCursorChange: (position: CursorPosition) => void;
  sourceRef: Ref<SourceEditorHandle>;
  wysiwygRef: Ref<WysiwygEditorHandle>;
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
}: EditorContainerProps) {
  const mode = tab.editorMode;

  return (
    <div className="flex h-full w-full flex-col bg-slate-950">
      <div className="flex h-9 shrink-0 items-center justify-end border-b border-slate-800 bg-slate-950 px-2">
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
          />
        ) : mode === 'split' ? (
          <SplitView
            sourceRef={sourceRef}
            content={tab.content}
            onChange={onContentChange}
            onCursorChange={onCursorChange}
          />
        ) : (
          <SourceEditor
            ref={sourceRef}
            content={tab.content}
            onChange={onContentChange}
            onCursorChange={onCursorChange}
          />
        )}
      </div>
    </div>
  );
}
