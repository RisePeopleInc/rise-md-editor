import { useRef } from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

export interface CursorPosition {
  line: number;
  column: number;
}

interface SourceEditorProps {
  content: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
}

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  wordWrap: 'on',
  minimap: { enabled: false },
  lineNumbers: 'on',
  fontSize: 14,
  fontFamily: MONO_STACK,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
  tabSize: 2,
};

export function SourceEditor({ content, onChange, onCursorChange }: SourceEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = (instance) => {
    editorRef.current = instance;
    const pos = instance.getPosition();
    if (pos && onCursorChange) {
      onCursorChange({ line: pos.lineNumber, column: pos.column });
    }
    instance.onDidChangeCursorPosition((e) => {
      onCursorChange?.({ line: e.position.lineNumber, column: e.position.column });
    });
  };

  return (
    <Editor
      height="100%"
      language="markdown"
      theme="vs-dark"
      value={content}
      onChange={(value) => onChange(value ?? '')}
      onMount={handleMount}
      options={EDITOR_OPTIONS}
    />
  );
}
