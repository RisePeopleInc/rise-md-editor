import Store from 'electron-store';

interface Schema {
  lastFolder: string | null;
  sidebarWidth: number;
  sidebarVisible: boolean;
}

const store = new Store<Schema>({
  name: 'project-mode',
  defaults: {
    lastFolder: null,
    sidebarWidth: 250,
    sidebarVisible: true,
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
