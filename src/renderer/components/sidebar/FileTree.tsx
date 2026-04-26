import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { TreeNode } from '../../env';
import { isOpenable, type CreatingState } from '../../state/sidebarState';

interface FileTreeProps {
  root: TreeNode;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (filePath: string) => void;
  onContextMenu: (node: TreeNode, e: MouseEvent) => void;

  /** Inline editing — at most one of editingPath / creating is active. */
  editingPath: string | null;
  creating: CreatingState | null;
  onRenameSubmit: (path: string, newName: string) => void;
  onCreateSubmit: (parentPath: string, kind: 'file' | 'folder', name: string) => void;
  onEditCancel: () => void;
}

const ROW_HEIGHT = 'py-0.5';

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden
      className="shrink-0 text-amber-400"
    >
      <path
        fill="currentColor"
        d="M2 4a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z"
      />
    </svg>
  );
}

function MarkdownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden
      className="shrink-0 text-brand-500"
    >
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="currentColor" opacity="0.18" />
      <text
        x="8"
        y="11"
        textAnchor="middle"
        fontFamily="ui-monospace, monospace"
        fontSize="6"
        fontWeight="700"
        fill="currentColor"
      >
        MD
      </text>
    </svg>
  );
}

function GenericFileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden
      className="shrink-0 text-slate-500"
    >
      <path
        fill="currentColor"
        d="M3 2a1 1 0 0 1 1-1h6l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2z"
        opacity="0.7"
      />
    </svg>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
      className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''} text-slate-400`}
    >
      <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
    </svg>
  );
}

interface NameInputProps {
  initialValue: string;
  /** 'rename' selects only the basename; 'create' selects everything. */
  selectMode: 'rename' | 'create';
  /** Icon to show to the left of the input (matches the row it replaces). */
  icon: 'folder' | 'markdown' | 'generic';
  indent: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/**
 * Inline name editor. Auto-focuses on mount, selects all (or just the
 * basename for renames so the extension stays put). Enter commits, Escape
 * cancels, and blur commits if the value changed and is non-empty —
 * otherwise it cancels (matches VS Code's behavior).
 */
function NameInput({
  initialValue,
  selectMode,
  icon,
  indent,
  onSubmit,
  onCancel,
}: NameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set when the user pressed Escape OR Enter — both bypass the blur-handler
  // logic so we don't double-fire onSubmit / onCancel.
  const settledRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectMode === 'rename') {
      // Select only the basename so typing replaces the file's stem but the
      // user can still see (and keep) the extension.
      const dot = initialValue.lastIndexOf('.');
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    } else {
      // For create-file we still want the basename selected (so typing
      // replaces 'Untitled' but '.md' is preserved by default).
      const dot = initialValue.lastIndexOf('.');
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    }
  }, [initialValue, selectMode]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const trimmed = value.trim();
        settledRef.current = true;
        if (!trimmed) onCancel();
        else onSubmit(trimmed);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        settledRef.current = true;
        onCancel();
      }
    },
    [value, onSubmit, onCancel],
  );

  const handleBlur = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialValue) onCancel();
    else onSubmit(trimmed);
  }, [value, initialValue, onSubmit, onCancel]);

  return (
    <div
      className={[
        'flex w-full select-none items-center gap-1.5 pr-2 text-sm',
        ROW_HEIGHT,
      ].join(' ')}
      style={{ paddingLeft: indent + 6 }}
    >
      <span aria-hidden className="inline-block w-[10px] shrink-0" />
      {icon === 'folder' ? (
        <FolderIcon />
      ) : icon === 'markdown' ? (
        <MarkdownIcon />
      ) : (
        <GenericFileIcon />
      )}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          // Editing again after a failed submit re-arms the blur handler —
          // otherwise the input would stay mounted but blur would no
          // longer commit the user's correction.
          settledRef.current = false;
          setValue(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        // Don't propagate clicks: clicking the input shouldn't open the
        // parent row or fire context-menu handlers.
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        className={[
          'min-w-0 flex-1 rounded border px-1 py-px text-sm leading-tight',
          'border-brand-500 bg-slate-900 text-slate-100',
          'outline-none ring-1 ring-brand-500/40',
        ].join(' ')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </div>
  );
}

function iconForName(name: string): 'markdown' | 'generic' {
  return /\.(md|markdown)$/i.test(name) ? 'markdown' : 'generic';
}

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (filePath: string) => void;
  onContextMenu: (node: TreeNode, e: MouseEvent) => void;
  editingPath: string | null;
  creating: CreatingState | null;
  onRenameSubmit: (path: string, newName: string) => void;
  onCreateSubmit: (parentPath: string, kind: 'file' | 'folder', name: string) => void;
  onEditCancel: () => void;
}

function Row(props: RowProps) {
  const {
    node,
    depth,
    expanded,
    onToggle,
    onOpenFile,
    onContextMenu,
    editingPath,
    creating,
    onRenameSubmit,
    onCreateSubmit,
    onEditCancel,
  } = props;

  const isOpen = expanded.has(node.path);
  const openable = isOpenable(node);
  const isEditingThis = editingPath === node.path;
  const isCreatingHere =
    creating !== null && creating.parentPath === node.path && isOpen;

  const handleClick = useCallback(() => {
    if (node.isDirectory) onToggle(node.path);
    else if (openable) onOpenFile(node.path);
  }, [node, openable, onToggle, onOpenFile]);

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(node, e);
    },
    [node, onContextMenu],
  );

  const indent = depth * 12;
  const childIndent = (depth + 1) * 12;

  return (
    <>
      {isEditingThis ? (
        <NameInput
          initialValue={node.name}
          selectMode="rename"
          icon={
            node.isDirectory ? 'folder' : iconForName(node.name)
          }
          indent={indent}
          onSubmit={(newName) => onRenameSubmit(node.path, newName)}
          onCancel={onEditCancel}
        />
      ) : (
        <div
          role="treeitem"
          aria-expanded={node.isDirectory ? isOpen : undefined}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          className={[
            'flex w-full cursor-pointer select-none items-center gap-1.5 rounded pr-2 text-sm',
            ROW_HEIGHT,
            node.isDirectory
              ? 'text-slate-200 hover:bg-slate-800'
              : openable
                ? 'text-slate-300 hover:bg-slate-800'
                : 'text-slate-500 cursor-default hover:bg-slate-900',
          ].join(' ')}
          style={{ paddingLeft: indent + 6 }}
          title={node.path}
        >
          {node.isDirectory ? (
            <Caret open={isOpen} />
          ) : (
            <span aria-hidden className="inline-block w-[10px] shrink-0" />
          )}
          {node.isDirectory ? (
            <FolderIcon />
          ) : /\.(md|markdown)$/i.test(node.name) ? (
            <MarkdownIcon />
          ) : (
            <GenericFileIcon />
          )}
          <span className="truncate">{node.name}</span>
        </div>
      )}
      {node.isDirectory && isOpen && (
        <>
          {/* Inline create-row appears at the top of this folder's children. */}
          {isCreatingHere && creating && (
            <NameInput
              initialValue={creating.initialName}
              selectMode="create"
              icon={
                creating.kind === 'folder'
                  ? 'folder'
                  : iconForName(creating.initialName || 'Untitled.md')
              }
              indent={childIndent}
              onSubmit={(name) =>
                onCreateSubmit(creating.parentPath, creating.kind, name)
              }
              onCancel={onEditCancel}
            />
          )}
          {node.children &&
            node.children.map((child) => (
              <Row
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
                editingPath={editingPath}
                creating={creating}
                onRenameSubmit={onRenameSubmit}
                onCreateSubmit={onCreateSubmit}
                onEditCancel={onEditCancel}
              />
            ))}
        </>
      )}
    </>
  );
}

export function FileTree({
  root,
  expanded,
  onToggle,
  onOpenFile,
  onContextMenu,
  editingPath,
  creating,
  onRenameSubmit,
  onCreateSubmit,
  onEditCancel,
}: FileTreeProps) {
  return (
    <div role="tree" className="flex flex-col py-1">
      <Row
        node={root}
        depth={0}
        expanded={expanded}
        onToggle={onToggle}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        editingPath={editingPath}
        creating={creating}
        onRenameSubmit={onRenameSubmit}
        onCreateSubmit={onCreateSubmit}
        onEditCancel={onEditCancel}
      />
    </div>
  );
}
