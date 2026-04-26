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
