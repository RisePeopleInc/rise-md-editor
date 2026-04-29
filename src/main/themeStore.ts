import Store from 'electron-store';
import { nativeTheme } from 'electron';

/**
 * Three-way preference: explicit light/dark, or "follow whatever the OS
 * is doing". `'system'` is the default — picks up the user's macOS
 * appearance setting on launch and updates live when they switch.
 *
 * Used for both the app chrome / WYSIWYG zone and (independently) the
 * Monaco source editor zone.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/**
 * Gruvbox contrast level for the source editor. The ramps differ
 * (especially the background); accent colors are shared. Soft is the
 * default — the high-contrast variants can feel harsh on long sessions.
 */
export type EditorContrast = 'hard' | 'medium' | 'soft';

/**
 * Word-wrap mode for the Monaco source editor (Source-only and the
 * source pane in Split). `'on'` wraps long lines to pane width — the
 * historical default since RAISE-3, sensible for prose Markdown.
 * `'off'` exposes Monaco's own horizontal scrollbar — better for
 * code-heavy or table-heavy markdown where alignment matters.
 *
 * WYSIWYG / preview zones ignore this — Milkdown and the rendered
 * preview always wrap; horizontal-scrolling rendered prose has no
 * good use case.
 */
export type WordWrap = 'on' | 'off';

interface Schema {
  /** App chrome / WYSIWYG / preview theme. */
  themePreference: ThemePreference;
  /** Source-editor (Monaco) theme — independent of the app preference. */
  editorThemePreference: ThemePreference;
  /** Source-editor contrast. */
  editorContrast: EditorContrast;
  /** Source-editor word-wrap mode. */
  wordWrap: WordWrap;
}

const store = new Store<Schema>({
  name: 'theme',
  defaults: {
    themePreference: 'system',
    editorThemePreference: 'system',
    editorContrast: 'soft',
    wordWrap: 'on',
  },
});

// ---- App theme -----------------------------------------------------------

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

// ---- Editor theme --------------------------------------------------------

export function getEditorThemePreference(): ThemePreference {
  return store.get('editorThemePreference', 'system');
}

export function setEditorThemePreference(pref: ThemePreference): void {
  store.set('editorThemePreference', pref);
  // Note: nativeTheme.themeSource is owned by the app preference; the
  // editor's "system" follows nativeTheme.shouldUseDarkColors directly.
}

export function getEditorContrast(): EditorContrast {
  return store.get('editorContrast', 'soft');
}

export function setEditorContrast(contrast: EditorContrast): void {
  store.set('editorContrast', contrast);
}

export function getWordWrap(): WordWrap {
  return store.get('wordWrap', 'on');
}

export function setWordWrap(wrap: WordWrap): void {
  store.set('wordWrap', wrap);
}

/**
 * Resolve the editor's preference into a concrete light/dark value.
 * 'system' follows the OS regardless of what the app theme is set to —
 * the two zones are intentionally independent.
 */
export function getResolvedEditorTheme(): ResolvedTheme {
  const pref = getEditorThemePreference();
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// ---- Bootstrap -----------------------------------------------------------

/**
 * Apply the persisted app preference to nativeTheme on app start.
 * Without this, an explicit light/dark choice would be ignored on
 * relaunch because nativeTheme.themeSource defaults to 'system'.
 */
export function bootstrapNativeTheme(): void {
  nativeTheme.themeSource = getThemePreference();
}
