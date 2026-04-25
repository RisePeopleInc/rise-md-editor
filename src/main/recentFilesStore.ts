import Store from 'electron-store';

const MAX_RECENT = 10;

interface Schema {
  recentFiles: string[];
}

const store = new Store<Schema>({
  name: 'recent-files',
  defaults: { recentFiles: [] },
});

export function getRecent(): string[] {
  return store.get('recentFiles', []);
}

export function addRecent(filePath: string): string[] {
  const current = store.get('recentFiles', []);
  const next = [filePath, ...current.filter((p) => p !== filePath)].slice(0, MAX_RECENT);
  store.set('recentFiles', next);
  return next;
}

export function clearRecent(): void {
  store.set('recentFiles', []);
}
