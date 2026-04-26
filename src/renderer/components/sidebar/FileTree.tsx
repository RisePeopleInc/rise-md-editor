import { useCallback, type MouseEvent } from 'react';
import type { TreeNode } from '../../env';
import { isOpenable } from '../../state/sidebarState';

interface FileTreeProps {
  root: TreeNode;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (filePath: string) => void;
  onContextMenu: (node: TreeNode, e: MouseEvent) => void;
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

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (filePath: string) => void;
  onContextMenu: (node: TreeNode, e: MouseEvent) => void;
}

function Row({ node, depth, expanded, onToggle, onOpenFile, onContextMenu }: RowProps) {
  const isOpen = expanded.has(node.path);
  const openable = isOpenable(node);

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

  // Indentation per depth, plus a fixed slot for the caret (so file rows
  // line up with their sibling-folders).
  const indent = depth * 12;

  return (
    <>
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
          // Empty 10px slot so file icons line up with directory carets.
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
      {node.isDirectory && isOpen && node.children && (
        <>
          {node.children.map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
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
}: FileTreeProps) {
  // The root row is always shown even when collapsed-all has been hit; we
  // start the children at depth 1 so the indent matches the visual hierarchy.
  return (
    <div role="tree" className="flex flex-col py-1">
      <Row
        node={root}
        depth={0}
        expanded={expanded}
        onToggle={onToggle}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}
