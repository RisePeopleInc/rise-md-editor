import chokidar, { type FSWatcher } from 'chokidar';
import type { BrowserWindow } from 'electron';

/**
 * One active chokidar watcher at a time — Project Mode opens a single
 * folder. Switching folders or closing the window swaps it out.
 *
 * Watch events are coalesced into a tiny debounce window before re-pushing
 * the tree to the renderer; chokidar tends to emit several events per
 * filesystem operation (e.g., `unlink` then `addDir` for a rename).
 */
let current: FSWatcher | null = null;
let currentRoot: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 75;

interface Listener {
  /** Called after a debounce window when any watched entry changed. */
  onTreeChanged: (root: string) => void;
  /** Called when a single file's *content* (not metadata) changed on disk. */
  onFileChanged: (filePath: string) => void;
}

let listener: Listener | null = null;

export function setListener(next: Listener): void {
  listener = next;
}

export async function watchFolder(rootPath: string): Promise<void> {
  await stopWatching();
  currentRoot = rootPath;

  current = chokidar.watch(rootPath, {
    ignored: (testPath) => {
      // Skip dot-prefixed entries except for `.claude` (and its subtree)
      // so the tree stays tidy and we don't re-fire on .git churn etc.
      if (testPath === rootPath) return false;
      const segments = testPath.split(/[/\\]/);
      return segments.some((seg) => seg.startsWith('.') && seg !== '.claude');
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    persistent: true,
  });

  const scheduleTreeChange = () => {
    if (!currentRoot) return;
    const root = currentRoot;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      listener?.onTreeChanged(root);
    }, DEBOUNCE_MS);
  };

  current.on('add', scheduleTreeChange);
  current.on('addDir', scheduleTreeChange);
  current.on('unlink', scheduleTreeChange);
  current.on('unlinkDir', scheduleTreeChange);

  // File-content changes are reported separately so the renderer can prompt
  // "this file changed on disk — reload?" for any open tab pointing at it.
  current.on('change', (filePath) => {
    listener?.onFileChanged(filePath);
    // A `change` doesn't restructure the tree, so we don't reschedule a tree
    // refresh — but renames sometimes look like change+unlink+add, which the
    // other handlers cover.
  });
}

export async function stopWatching(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (current) {
    await current.close();
    current = null;
  }
  currentRoot = null;
}

export function getWatchedRoot(): string | null {
  return currentRoot;
}

/**
 * Send a renderer-side notification through the given window. Convenience
 * wrapper so main/index.ts can just hand us the window and forget about
 * the channel name.
 */
export function notifyRenderer(window: BrowserWindow | null, event: { type: 'tree' | 'file'; path: string }): void {
  if (!window || window.isDestroyed()) return;
  if (event.type === 'tree') {
    window.webContents.send('folder:tree-changed', { root: event.path });
  } else {
    window.webContents.send('folder:file-changed', { path: event.path });
  }
}
