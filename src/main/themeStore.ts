import Store from 'electron-store';
import { nativeTheme } from 'electron';

/**
 * Three-way preference: explicit light/dark, or "follow whatever the OS
 * is doing". `'system'` is the default — picks up the user's macOS
 * appearance setting on launch and updates live when they switch.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface Schema {
  themePreference: ThemePreference;
}

const store = new Store<Schema>({
  name: 'theme',
  defaults: {
    themePreference: 'system',
  },
});

export function getThemePreference(): ThemePreference {
  return store.get('themePreference', 'system');
}

export function setThemePreference(pref: ThemePreference): void {
  store.set('themePreference', pref);
  // Sync Electron's nativeTheme — this drives chrome (window controls,
  // scrollbars on some platforms) and also lets `nativeTheme.shouldUseDarkColors`
  // give us the correct effective value when pref==='system'.
  nativeTheme.themeSource = pref;
}

/** Resolve the current preference into a concrete light/dark value. */
export function getResolvedTheme(): ResolvedTheme {
  const pref = getThemePreference();
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * Apply the persisted preference to nativeTheme on app start. Without
 * this, an explicit light/dark choice would be ignored on relaunch
 * because nativeTheme.themeSource defaults to 'system'.
 */
export function bootstrapNativeTheme(): void {
  nativeTheme.themeSource = getThemePreference();
}
