import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type {
  EditorContrast,
  ResolvedTheme,
  ThemePreference,
  ThemeState,
} from '../env';
import {
  gruvboxThemeId,
  registerAllGruvboxThemes,
} from '../monaco-themes';

/**
 * Storage key used by the bootstrap script in `index.html` so the next
 * launch can apply the data-theme attribute synchronously, before any
 * paint, avoiding the light-flash-then-dark transition.
 *
 * Stores the *resolved app* value (light/dark) only — the editor zone
 * is independent and lives entirely inside Monaco, so it doesn't need
 * a pre-paint sync.
 */
const BOOT_STORAGE_KEY = 'rise-theme';

interface UseThemeStateResult {
  app: ThemeState['app'];
  editor: ThemeState['editor'];

  /**
   * The current Monaco theme id — one of `gruvbox-{contrast}-{mode}`.
   * Threaded down to SourceEditor as the `theme` prop so Monaco swaps
   * synchronously on contrast/mode changes (no manual setTheme calls
   * needed in apply()).
   */
  monacoThemeId: string;

  /** Set the app-zone preference (system / light / dark). */
  setAppPreference: (pref: ThemePreference) => Promise<void>;
  /** Cycle app preference: system → light → dark → system. */
  cycleAppPreference: () => Promise<void>;

  /** Set the editor-zone preference (system / light / dark). */
  setEditorPreference: (pref: ThemePreference) => Promise<void>;
  /** Set the editor contrast (hard / medium / soft). */
  setEditorContrast: (contrast: EditorContrast) => Promise<void>;
}

/**
 * Single source of truth for theme state in the renderer:
 *   - reads main's preference + resolved values on mount (app + editor)
 *   - subscribes to main's `theme:updated` events
 *   - writes the resolved app value to `data-theme` on `<html>`
 *   - applies the matching Gruvbox variant (contrast + mode) to all
 *     existing Monaco editors via `monaco.editor.setTheme`
 *   - mirrors the resolved app value to localStorage for the next
 *     launch's bootstrap script
 */
export function useThemeState(): UseThemeStateResult {
  const [state, setState] = useState<ThemeState>(() => {
    // Optimistic initial: read the bootstrap-set attribute so the first
    // React render matches the DOM. Editor settings can't be sync-read
    // (no localStorage mirror for them) so we start with sensible
    // defaults; main will overwrite on theme:get.
    const attr = document.documentElement.getAttribute('data-theme');
    const resolved: ResolvedTheme = attr === 'dark' ? 'dark' : 'light';
    return {
      app: { preference: 'system', resolved },
      editor: { preference: 'system', contrast: 'soft', resolved },
    };
  });

  // Track the last applied Monaco theme id so we don't re-call setTheme
  // on every state push when nothing relevant changed.
  const lastMonacoThemeRef = useRef<string | null>(null);

  const apply = useCallback((next: ThemeState) => {
    setState(next);

    // ----- App zone: data-theme + localStorage mirror ------------------
    document.documentElement.setAttribute('data-theme', next.app.resolved);
    try {
      localStorage.setItem(BOOT_STORAGE_KEY, next.app.resolved);
    } catch {
      // localStorage can throw in private/incognito profiles; not fatal.
    }

    // ----- Editor zone: pick the Gruvbox variant -----------------------
    // Themes are registered up front (cheap), so setTheme is a one-call
    // global swap that affects every existing Monaco instance.
    const targetThemeId = gruvboxThemeId(next.editor.contrast, next.editor.resolved);
    if (lastMonacoThemeRef.current !== targetThemeId) {
      lastMonacoThemeRef.current = targetThemeId;
      // Defensive — `registerAllGruvboxThemes` is idempotent and a
      // no-op after first call, but guarantees the id we're about to
      // set is defined (e.g. if someone swapped Monaco instances).
      registerAllGruvboxThemes();
      monaco.editor.setTheme(targetThemeId);
    }
  }, []);

  // Initial fetch + subscription. Empty deps: runs once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const initial = await window.api.theme.get();
      if (cancelled) return;
      apply(initial);
    })();
    const off = window.api.theme.onChange((next) => apply(next));
    return () => {
      cancelled = true;
      off();
    };
  }, [apply]);

  const setAppPreference = useCallback(
    async (pref: ThemePreference) => {
      const next = await window.api.theme.setApp(pref);
      apply(next);
    },
    [apply],
  );

  const cycleAppPreference = useCallback(async () => {
    const order: ThemePreference[] = ['system', 'light', 'dark'];
    const idx = order.indexOf(state.app.preference);
    const next = order[(idx + 1) % order.length] ?? 'system';
    await setAppPreference(next);
  }, [state.app.preference, setAppPreference]);

  const setEditorPreference = useCallback(
    async (pref: ThemePreference) => {
      const next = await window.api.theme.setEditor({ preference: pref });
      apply(next);
    },
    [apply],
  );

  const setEditorContrast = useCallback(
    async (contrast: EditorContrast) => {
      const next = await window.api.theme.setEditor({ contrast });
      apply(next);
    },
    [apply],
  );

  const monacoThemeId = gruvboxThemeId(
    state.editor.contrast,
    state.editor.resolved,
  );

  return {
    app: state.app,
    editor: state.editor,
    monacoThemeId,
    setAppPreference,
    cycleAppPreference,
    setEditorPreference,
    setEditorContrast,
  };
}
