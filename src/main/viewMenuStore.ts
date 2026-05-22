// RAISE-74: persistence for the View menu's transient enable/disable
// state. Currently a single boolean — whether Zoom In / Out / Reset
// should be enabled (true when the active editor mode is Monaco-backed,
// i.e. Code or Split). Persisted so the menu can render with the
// correct state on launch before the renderer's first IPC push arrives.
// Without persistence the menu would briefly show the default (false)
// until the renderer mounts and pushes the current `isMonacoActive`
// — a ~100ms flicker visible to anyone reaching for Cmd+= immediately
// after launch.
//
// The renderer is still the source of truth for the value at runtime;
// this store just caches the most recent reported value across launches.
import Store from 'electron-store';

interface Schema {
  zoomEnabled: boolean;
}

const store = new Store<Schema>({
  name: 'view-menu',
  defaults: {
    zoomEnabled: false,
  },
});

export function getZoomEnabled(): boolean {
  return store.get('zoomEnabled', false);
}

export function setZoomEnabledPersisted(enabled: boolean): void {
  store.set('zoomEnabled', enabled);
}
