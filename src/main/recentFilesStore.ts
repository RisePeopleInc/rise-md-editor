import { existsSync } from 'node:fs';
import Store from 'electron-store';

const MAX_RECENT = 10;

interface Schema {
  recentFiles: string[];
}

const store = new Store<Schema>({
  name: 'recent-files',
  defaults: { recentFiles: [] },
});

/**
 * Returns recent files that still exist on disk, and prunes any dead entries
 * from persistent storage so the menu doesn't keep offering files that were
 * deleted or moved between sessions.
 */
export function getRecent(): string[] {
  const stored = store.get('recentFiles', []);
  const live = stored.filter((p) => existsSync(p));
  if (live.length !== stored.length) store.set('recentFiles', live);
  return live;
}

export function addRecent(filePath: string): string[] {
  const current = getRecent();
  const next = [filePath, ...current.filter((p) => p !== filePath)].slice(0, MAX_RECENT);
  store.set('recentFiles', next);
  return next;
}

export function clearRecent(): void {
  store.set('recentFiles', []);
}
