import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, BrowserWindow, shell } from 'electron';

/** A single entry in the file-tree returned to the renderer. */
export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

const HIDDEN_ALLOWLIST = new Set(['.claude']);

function isHiddenAllowed(name: string): boolean {
  if (!name.startsWith('.')) return true;
  return HIDDEN_ALLOWLIST.has(name);
}

/**
 * Recursively read a directory and return a sorted tree. Hidden files /
 * directories (starting with `.`) are omitted except for explicit allowlist
 * entries. Directories sort before files; both alphabetical case-insensitive.
 */
export async function readFolderTree(rootPath: string): Promise<TreeNode> {
  const stats = await fs.stat(rootPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }
  const node: TreeNode = {
    name: path.basename(rootPath),
    path: rootPath,
    isDirectory: true,
    children: await readDirChildren(rootPath),
  };
  return node;
}

async function readDirChildren(dirPath: string): Promise<TreeNode[]> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    // Symlinks pointing nowhere, permissions errors, etc. — skip silently.
    return [];
  }
  const children: TreeNode[] = [];
  for (const entry of entries) {
    if (!isHiddenAllowed(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      children.push({
        name: entry.name,
        path: full,
        isDirectory: true,
        children: await readDirChildren(full),
      });
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      children.push({
        name: entry.name,
        path: full,
        isDirectory: false,
      });
    }
  }
  return sortTreeChildren(children);
}

function sortTreeChildren(children: TreeNode[]): TreeNode[] {
  return children.slice().sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/**
 * Show the native folder-selection dialog and return the chosen path, or
 * null if the user cancelled.
 */
export async function pickFolder(window: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0]!;
}

/**
 * Create a new (empty) file in `parentPath` with the given name. Throws
 * EEXIST (via the `wx` flag) if a file with that name already exists, so
 * the renderer can surface a proper error instead of silently overwriting.
 */
/**
 * Reject names that would let a caller escape the parent directory or
 * cause confusing/duplicate behaviour. The renderer already filters most
 * of these, but keeping the check in main is defence-in-depth: any future
 * IPC caller is guaranteed to get a same-folder, single-segment name.
 */
function assertValidLeafName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Name cannot be empty');
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Name cannot be "." or ".."');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Name cannot contain "/" or "\\"');
  }
  if (trimmed.includes('\0')) {
    throw new Error('Name cannot contain a null byte');
  }
}

export async function createFileNamed(
  parentPath: string,
  name: string,
): Promise<string> {
  assertValidLeafName(name);
  const target = path.join(parentPath, name);
  await fs.writeFile(target, '', { encoding: 'utf-8', flag: 'wx' });
  return target;
}

export async function createNewFolder(dirPath: string, name: string): Promise<string> {
  assertValidLeafName(name);
  const target = path.join(dirPath, name);
  await fs.mkdir(target, { recursive: false });
  return target;
}

export async function renamePath(oldPath: string, newName: string): Promise<string> {
  assertValidLeafName(newName);
  const dir = path.dirname(oldPath);
  const target = path.join(dir, newName);
  await fs.rename(oldPath, target);
  return target;
}

/**
 * Move a file or folder into a new parent directory
 * ([RAISE-13](https://risepeople.atlassian.net/browse/RAISE-13)).
 *
 * Validates and rejects:
 *
 *   - `destDir === path.dirname(srcPath)` — no-op move, same parent.
 *   - `destDir === srcPath` — moving into itself.
 *   - `destDir` is a descendant of `srcPath` — moving a folder into
 *     a path inside itself (would corrupt the tree).
 *   - A file or folder with the same name already exists in `destDir`
 *     — refuse rather than silently overwrite. `fs.rename` on POSIX
 *     overwrites a same-named TARGET by default; on Windows it errors
 *     (EEXIST). Pre-checking and throwing a synthetic EEXIST gives
 *     the renderer a consistent surface to handle.
 *
 * Cross-device moves: `fs.rename` returns EXDEV when src and dest
 * live on different filesystems (a workspace folder on an external
 * drive with `destDir` on the system disk, for example). We don't
 * implement the copy+delete fallback in this pass — re-throw a
 * clearer message so the renderer can surface the right dialog.
 */
export async function movePath(srcPath: string, destDir: string): Promise<string> {
  // Defence in depth — these are also validated renderer-side.
  const srcParent = path.dirname(srcPath);
  if (destDir === srcParent) {
    throw new Error('Item is already in that folder');
  }
  if (destDir === srcPath) {
    throw new Error('Cannot move an item into itself');
  }
  // Trailing-separator guard so `/foo/bar` isn't treated as a
  // descendant of `/foo/ba`. `path.sep` is the platform-correct
  // separator; we also check the opposite separator because the
  // path strings can come from main on either platform.
  const srcWithSep = srcPath + path.sep;
  const srcWithAltSep = srcPath + (path.sep === '/' ? '\\' : '/');
  if (destDir.startsWith(srcWithSep) || destDir.startsWith(srcWithAltSep)) {
    throw new Error('Cannot move a folder into one of its own descendants');
  }

  const target = path.join(destDir, path.basename(srcPath));

  // Pre-check for an existing entry at the target. `fs.rename`'s
  // overwrite-by-default on POSIX would silently clobber a same-named
  // file at destDir; we want a clear error instead.
  try {
    await fs.stat(target);
    // No throw → an entry exists. Synthesise an EEXIST so the
    // renderer's existing error-handling treats it consistently
    // with rename / create.
    const err: NodeJS.ErrnoException = new Error(
      `An item named "${path.basename(srcPath)}" already exists in the destination`,
    );
    err.code = 'EEXIST';
    throw err;
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    // ENOENT = nothing there, all good. Other codes (EEXIST from our
    // synthetic above, permission errors, etc.) propagate.
    if (errno !== 'ENOENT') throw err;
  }

  try {
    await fs.rename(srcPath, target);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'EXDEV') {
      // Cross-device — out of scope for the current ticket. The
      // user can still move the file manually via Finder / Explorer.
      throw new Error(
        'Cannot move across different drives or filesystems. Move the item using your file manager instead.',
      );
    }
    throw err;
  }
  return target;
}

/**
 * Copy a file or folder into a new parent directory
 * ([RAISE-13](https://risepeople.atlassian.net/browse/RAISE-13) follow-up).
 *
 * Mirrors `movePath` for validation (no self-into-self, no folder-
 * into-descendant) but with one key difference: a SAME-PARENT copy
 * is valid and auto-renames to avoid the inevitable collision. The
 * generated name is `<stem> 2.<ext>`, `<stem> 3.<ext>`, etc. —
 * lowest available integer, Finder-style.
 *
 * For cross-parent copies, a name collision in the destination is
 * an error (consistent with `movePath`). The user explicitly chose
 * a destination; silently overwriting or auto-renaming would
 * surprise them.
 *
 * Uses `fs.cp` with `recursive: true` so folders get their full
 * subtree copied. Works across filesystems unlike `fs.rename`,
 * so there's no cross-device error path here.
 */
export async function copyPath(srcPath: string, destDir: string): Promise<string> {
  const srcParent = path.dirname(srcPath);
  if (destDir === srcPath) {
    throw new Error('Cannot copy an item into itself');
  }
  const srcWithSep = srcPath + path.sep;
  const srcWithAltSep = srcPath + (path.sep === '/' ? '\\' : '/');
  if (destDir.startsWith(srcWithSep) || destDir.startsWith(srcWithAltSep)) {
    throw new Error('Cannot copy a folder into one of its own descendants');
  }

  const srcName = path.basename(srcPath);
  let target: string;

  if (destDir === srcParent) {
    // Same-parent copy → auto-rename. Split name into stem and
    // extension at the LAST dot (so `foo.tar.gz` becomes
    // `foo.tar 2.gz`, matching the dominant file-manager
    // convention). Folders have no extension; the whole name is
    // the stem.
    target = await allocateCopyName(destDir, srcName);
  } else {
    target = path.join(destDir, srcName);
    // Cross-parent collision — refuse rather than overwrite or
    // auto-rename. Same shape as `movePath`'s pre-check.
    try {
      await fs.stat(target);
      const err: NodeJS.ErrnoException = new Error(
        `An item named "${srcName}" already exists in the destination`,
      );
      err.code = 'EEXIST';
      throw err;
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno !== 'ENOENT') throw err;
    }
  }

  // `errorOnExist: true` is defensive — the pre-check above (for
  // cross-parent) and the allocator (for same-parent) already
  // guarantee the target doesn't exist, but a concurrent
  // file-system change between check and copy could race. Better
  // to surface an error than to overwrite.
  await fs.cp(srcPath, target, { recursive: true, errorOnExist: true, force: false });
  return target;
}

/**
 * Find the lowest-numbered `<stem> N.<ext>` filename in `dir` that
 * doesn't already exist, starting at N=2 (so the first duplicate
 * of `report.md` is `report 2.md`). The split point is the LAST
 * dot in the name; folders (no dot, or leading-dot dotfiles) get
 * the whole name as the stem.
 */
async function allocateCopyName(dir: string, srcName: string): Promise<string> {
  const lastDot = srcName.lastIndexOf('.');
  const hasExt = lastDot > 0 && lastDot < srcName.length - 1;
  const stem = hasExt ? srcName.slice(0, lastDot) : srcName;
  const ext = hasExt ? srcName.slice(lastDot) : '';
  for (let n = 2; n < 10_000; n++) {
    const candidate = path.join(dir, `${stem} ${n}${ext}`);
    try {
      await fs.stat(candidate);
      // Exists — keep walking.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return candidate;
      }
      throw err;
    }
  }
  // Astronomically unlikely — 10k existing duplicates means
  // something has gone very wrong. Fall through to a
  // disambiguating error rather than spin forever.
  throw new Error(`Could not allocate a copy name for "${srcName}"`);
}

/**
 * Move a file or folder to the system trash. Uses Electron's shell.trashItem
 * which is reversible via the OS trash UI.
 */
export async function trashPath(itemPath: string): Promise<void> {
  await shell.trashItem(itemPath);
}

/** Reveal a file or folder in Finder / Explorer / file manager. */
export function revealInFolder(itemPath: string): void {
  shell.showItemInFolder(itemPath);
}
