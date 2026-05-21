import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
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
  /**
   * RAISE-13: drag-and-drop move handler. `srcPath` is the dragged
   * row's path; `destDir` is the resolved destination folder
   * (folder-row drops use the folder itself; file-row drops use the
   * file's parent). Validation already passed renderer-side; main
   * re-validates and surfaces collision / cross-device errors via
   * `window.api.showError`. The renderer never sees a success
   * without a real fs.rename.
   */
  onMove: (srcPath: string, destDir: string) => void;
  /**
   * RAISE-13 follow-up: opt-drag / ctrl-drag copy handler. Same
   * shape as `onMove`. Same-parent drops are valid for copy
   * (main auto-renames `report.md` → `report 2.md`); cross-parent
   * collisions still error out.
   */
  onCopy: (srcPath: string, destDir: string) => void;
}

/**
 * Custom MIME-ish format used to mark a drag as originating from our
 * own tree — distinct from text/uri-list (drag from Finder) so we
 * can ignore foreign drags during `onDragOver`. The browser only
 * exposes `types` (not data) during the dragover event, so this is
 * the only signal available pre-drop. Value of the entry isn't
 * read — the source path is read from a module-scoped ref during
 * the over/drop handlers to avoid any platform quirks around
 * `getData()` mid-drag (Firefox + some Chromium builds return ''
 * for non-text/plain types during dragover).
 */
const RAISE_DND_TYPE = 'application/x-rise-tree-move';

/**
 * Extract the parent-directory portion of an absolute path without
 * relying on the Node `path` module (which doesn't ship to the
 * renderer in this sandboxed build). Splits on the last forward or
 * backslash, whichever appears later. For workspace-rooted paths
 * (which is all this tree ever sees) the result is the immediate
 * parent dir.
 */
function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
}

/**
 * True if `candidate` is a descendant of `ancestor` — i.e., the
 * absolute path begins with `ancestor` followed by a path
 * separator. Trailing-separator guard so `/foo/bar` isn't a
 * descendant of `/foo/ba`. Handles both POSIX and Windows
 * separators because path strings from main are platform-native
 * but the renderer doesn't normalise them.
 */
function isDescendantOf(candidate: string, ancestor: string): boolean {
  return candidate.startsWith(ancestor + '/') || candidate.startsWith(ancestor + '\\');
}

/**
 * Resolve a drop-target row to the destination folder the move would
 * land in. Dropping on a folder lands inside that folder; dropping
 * on a file lands in that file's parent.
 */
function effectiveDestDir(node: TreeNode): string {
  return node.isDirectory ? node.path : dirnameOf(node.path);
}

/**
 * Renderer-side validity check for a drop. Mirrors the rules
 * `folderOps.{movePath,copyPath}` enforce in main; we duplicate them
 * here so we can disable the drop visual and `dropEffect` *during*
 * the drag (the user sees a "no" cursor before they release), not
 * just after they've committed.
 *
 *   - `src === ''` — no drag in progress.
 *   - `dest === src` — onto itself (move OR copy).
 *   - `src is ancestor of dest` — folder into one of its descendants
 *     (move OR copy).
 *   - `dest === srcParent` — same-parent is a no-op for move but
 *     VALID for copy (main auto-renames). The `isCopy` flag flips
 *     this one rule.
 */
function isValidDrop(srcPath: string, destDir: string, isCopy: boolean): boolean {
  if (!srcPath) return false;
  if (destDir === srcPath) return false;
  if (isDescendantOf(destDir, srcPath)) return false;
  if (!isCopy && destDir === dirnameOf(srcPath)) return false;
  return true;
}

/**
 * Read the OS-level copy modifier from a drag event. macOS = Option;
 * Win/Linux = Ctrl. Supporting both keeps cross-OS muscle memory
 * intact — a macOS user dragging on a Windows install (and vice
 * versa) still gets the expected behaviour.
 */
function isCopyModifier(e: ReactDragEvent<HTMLDivElement>): boolean {
  return e.altKey || e.ctrlKey;
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
      className="shrink-0 text-interaction"
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
      className="shrink-0 text-disabled"
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
      className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''} text-muted`}
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
          'border-interaction bg-app text-strong',
          'outline-none ring-1 ring-interaction/40',
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
  /** True for the root node — drives the "root isn't draggable" rule. */
  isRoot: boolean;
  onToggle: (path: string) => void;
  onOpenFile: (filePath: string) => void;
  onContextMenu: (node: TreeNode, e: MouseEvent) => void;
  editingPath: string | null;
  creating: CreatingState | null;
  onRenameSubmit: (path: string, newName: string) => void;
  onCreateSubmit: (parentPath: string, kind: 'file' | 'folder', name: string) => void;
  onEditCancel: () => void;
  /**
   * RAISE-13: drag-and-drop coordination. The source path is held in
   * a ref at the FileTree level (DataTransfer can't be read during
   * dragover on all browsers, and the source path is the same for
   * every dragover event in a single drag). The dropTarget is React
   * state so the highlight re-renders as the user moves between rows.
   */
  dragSourceRef: React.RefObject<string | null>;
  dropTargetPath: string | null;
  setDropTargetPath: (p: string | null) => void;
  onMove: (srcPath: string, destDir: string) => void;
  onCopy: (srcPath: string, destDir: string) => void;
}

function Row(props: RowProps) {
  const {
    node,
    depth,
    expanded,
    isRoot,
    onToggle,
    onOpenFile,
    onContextMenu,
    editingPath,
    creating,
    onRenameSubmit,
    onCreateSubmit,
    onEditCancel,
    dragSourceRef,
    dropTargetPath,
    setDropTargetPath,
    onMove,
    onCopy,
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

  // RAISE-13: drag-and-drop. The handlers below are no-ops on the
  // root row (`isRoot === true`) for the drag SOURCE side — root
  // can't be moved — but root IS a valid drop target (drop a file
  // onto the workspace folder name to move it to the top level).
  const handleDragStart = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (isRoot) {
        e.preventDefault();
        return;
      }
      // Marker type lets `onDragOver` distinguish our own tree
      // drags from foreign drags (Finder file drops, browser link
      // drops, etc.) — those should keep their existing semantics
      // and not trigger our move flow.
      e.dataTransfer.setData(RAISE_DND_TYPE, node.path);
      e.dataTransfer.setData('text/plain', node.path);
      // `copyMove` so the user can switch between move (default)
      // and copy (Opt-drag / Ctrl-drag) mid-drag via modifier
      // keys — the OS cursor updates in response to `dropEffect`
      // set during dragover. Setting just `'move'` here would
      // lock copies out regardless of modifier state.
      e.dataTransfer.effectAllowed = 'copyMove';
      dragSourceRef.current = node.path;
    },
    [isRoot, node.path, dragSourceRef],
  );

  const handleDragEnd = useCallback(() => {
    dragSourceRef.current = null;
    setDropTargetPath(null);
  }, [dragSourceRef, setDropTargetPath]);

  const handleDragOver = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      // Foreign drag (Finder file drop, etc.) — let the existing
      // window-level drop handler in App.tsx handle it. Without
      // this guard we'd swallow file-from-OS drops here.
      if (!e.dataTransfer.types.includes(RAISE_DND_TYPE)) return;
      const src = dragSourceRef.current;
      if (!src) return;
      const dest = effectiveDestDir(node);
      const isCopy = isCopyModifier(e);
      if (!isValidDrop(src, dest, isCopy)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      // preventDefault is what enables a `drop` event. Without it
      // the row never receives `onDrop`. Setting `dropEffect`
      // here is what the OS uses to pick the cursor — `'copy'`
      // shows the + sign, `'move'` shows the arrow. The cursor
      // updates live as the user presses / releases the modifier
      // (each dragover re-reads `e.altKey`).
      e.preventDefault();
      e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move';
      if (dropTargetPath !== dest) setDropTargetPath(dest);
    },
    [node, dragSourceRef, dropTargetPath, setDropTargetPath],
  );

  const handleDragLeave = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      // Clear the highlight only if the pointer is leaving this
      // row's bounds entirely (the related target isn't a child).
      // Without the contains-check, dragging over an icon inside
      // the row fires dragleave on the parent and the highlight
      // flickers.
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      const dest = effectiveDestDir(node);
      if (dropTargetPath === dest) setDropTargetPath(null);
    },
    [node, dropTargetPath, setDropTargetPath],
  );

  const handleDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(RAISE_DND_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      const src = dragSourceRef.current ?? e.dataTransfer.getData(RAISE_DND_TYPE);
      const dest = effectiveDestDir(node);
      const isCopy = isCopyModifier(e);
      dragSourceRef.current = null;
      setDropTargetPath(null);
      if (!isValidDrop(src, dest, isCopy)) return;
      if (isCopy) onCopy(src, dest);
      else onMove(src, dest);
    },
    [node, dragSourceRef, setDropTargetPath, onMove, onCopy],
  );

  const indent = depth * 12;
  const childIndent = (depth + 1) * 12;
  // The drop-target highlight lights up the folder the drop would
  // land in. For folder rows that's themselves; for file rows
  // it's the file's parent — but the file row doesn't host the
  // highlight because that would visually misalign with the
  // destination. Only folder rows render the highlight.
  const isDropTargetHighlighted =
    node.isDirectory && dropTargetPath === node.path;

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
          // RAISE-13: source side is gated by `isRoot` inside the
          // dragstart handler — `draggable` is on every row so the
          // OS shows the drag affordance, but root rejects in
          // dragstart so it can't be moved. Drop side is on every
          // row including root (root is a valid destination).
          draggable={!isRoot}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={[
            'flex w-full cursor-pointer select-none items-center gap-1.5 rounded pr-2 text-sm',
            ROW_HEIGHT,
            node.isDirectory
              ? 'text-strong hover:bg-elevated'
              : openable
                ? 'text-body hover:bg-elevated'
                : 'text-disabled cursor-default hover:bg-elevated/40',
            // RAISE-13: drop-target highlight. Tinted ring + bg so
            // the user sees exactly which folder the drop will
            // land in. Brighter than `bg-elevated` (the hover
            // state) to distinguish "hovering" from "would drop
            // here on release."
            isDropTargetHighlighted ? 'bg-interaction/10 ring-1 ring-interaction/50' : '',
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
                isRoot={false}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
                editingPath={editingPath}
                creating={creating}
                onRenameSubmit={onRenameSubmit}
                onCreateSubmit={onCreateSubmit}
                onEditCancel={onEditCancel}
                dragSourceRef={dragSourceRef}
                dropTargetPath={dropTargetPath}
                setDropTargetPath={setDropTargetPath}
                onMove={onMove}
                onCopy={onCopy}
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
  onMove,
  onCopy,
}: FileTreeProps) {
  // RAISE-13: drag-and-drop coordination. The source-path ref is
  // populated on dragstart and consulted during dragover/drop —
  // some platforms restrict DataTransfer.getData to drop-only,
  // and re-reading types every dragover is cheap. The drop-target
  // path is React state so the highlight re-renders as the user
  // moves between rows during the drag.
  const dragSourceRef = useRef<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  return (
    <div role="tree" className="flex flex-col py-1">
      <Row
        node={root}
        depth={0}
        expanded={expanded}
        isRoot
        onToggle={onToggle}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        editingPath={editingPath}
        creating={creating}
        onRenameSubmit={onRenameSubmit}
        onCreateSubmit={onCreateSubmit}
        onEditCancel={onEditCancel}
        dragSourceRef={dragSourceRef}
        dropTargetPath={dropTargetPath}
        setDropTargetPath={setDropTargetPath}
        onMove={onMove}
        onCopy={onCopy}
      />
    </div>
  );
}
