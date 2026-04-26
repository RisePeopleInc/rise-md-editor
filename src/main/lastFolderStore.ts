import Store from 'electron-store';

interface Schema {
  lastFolder: string | null;
  sidebarWidth: number;
  sidebarVisible: boolean;
  /**
   * Workspace folders for which the user has dismissed the
   * "no CLAUDE.md found, create one?" banner. Tracked per absolute path
   * so re-opening the same workspace doesn't keep nagging — but a fresh
   * folder still gets the prompt.
   */
  dismissedClaudeBannerPaths: string[];
}

const store = new Store<Schema>({
  name: 'project-mode',
  defaults: {
    lastFolder: null,
    sidebarWidth: 250,
    sidebarVisible: true,
    dismissedClaudeBannerPaths: [],
  },
});

export function getLastFolder(): string | null {
  return store.get('lastFolder', null);
}

export function setLastFolder(folder: string | null): void {
  store.set('lastFolder', folder);
}

export function getSidebarWidth(): number {
  return store.get('sidebarWidth', 250);
}

export function setSidebarWidth(width: number): void {
  store.set('sidebarWidth', width);
}

export function getSidebarVisible(): boolean {
  return store.get('sidebarVisible', true);
}

export function setSidebarVisible(visible: boolean): void {
  store.set('sidebarVisible', visible);
}

export function isClaudeBannerDismissed(folderPath: string): boolean {
  const list = store.get('dismissedClaudeBannerPaths', []);
  return list.includes(folderPath);
}

export function dismissClaudeBanner(folderPath: string): void {
  const list = store.get('dismissedClaudeBannerPaths', []);
  if (list.includes(folderPath)) return;
  store.set('dismissedClaudeBannerPaths', [...list, folderPath]);
}
