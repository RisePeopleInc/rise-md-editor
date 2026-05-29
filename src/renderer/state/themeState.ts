import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type {
  EditorContrast,
  ResolvedTheme,
  ThemePreference,
  ThemeState,
  WordWrap,
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
 *
 * MUST stay in sync with the literal string in `src/renderer/index.html`'s
 * inline bootstrap script. Renaming one without the other silently
 * breaks the no-flash launch (next boot reads the old key, gets null,
 * falls back to matchMedia).
 */
const BOOT_STORAGE_KEY = 'rise-theme';

/**
 * Sync mirror for the source-editor word-wrap mode ([RAISE-27](https://risepeople.atlassian.net/browse/RAISE-27)).
 * Read in the `useState` initializer below so SourceEditor mounts with
 * the user's last-set value rather than the `'on'` default → `'off'`
 * flicker that happens when we have to wait on the `theme.get()` IPC.
 *
 * Written from `apply()` on every state push. localStorage in the
 * renderer is plenty fast (sync, in-process) so we don't need an
 * inline bootstrap script for this — the React useState initializer
 * runs before the first paint of any editor anyway.
 *
 * The other editor prefs (theme preference, contrast) have the same
 * flicker on launch but are out of scope here. If anyone reports it,
 * the same pattern extends — just add another key + mirror call.
 */
const WORDWRAP_STORAGE_KEY = 'rise-word-wrap';

function readBootstrappedWordWrap(): WordWrap {
  try {
    const v = localStorage.getItem(WORDWRAP_STORAGE_KEY);
    return v === 'off' ? 'off' : 'on';
  } catch {
    // localStorage can throw in private/incognito profiles; fall back
    // to the historical default.
    return 'on';
  }
}

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
  /** Cycle editor preference: system → light → dark → system. */
  cycleEditorPreference: () => Promise<void>;
  /** Set the editor contrast (hard / medium / soft). */
  setEditorContrast: (contrast: EditorContrast) => Promise<void>;
  /** Set the source-editor word-wrap mode ('on' | 'off'). */
  setEditorWordWrap: (wrap: WordWrap) => Promise<void>;
  /** Toggle the source-editor word-wrap mode. */
  toggleEditorWordWrap: () => Promise<void>;
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
      editor: {
        preference: 'system',
        contrast: 'soft',
        resolved,
        // Read the wordWrap mirror synchronously so SourceEditor mounts
        // with the user's last-set value. theme.get() will overwrite
        // shortly after, but with the same value 99% of the time.
        wordWrap: readBootstrappedWordWrap(),
      },
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

    // ----- Editor zone: wordWrap mirror for next-launch no-flash -------
    // Lets the useState initializer above read the user's last value
    // synchronously instead of waiting on the theme.get() IPC and
    // briefly mounting Monaco with the wrong wordWrap. See
    // [RAISE-27](https://risepeople.atlassian.net/browse/RAISE-27).
    try {
      localStorage.setItem(WORDWRAP_STORAGE_KEY, next.editor.wordWrap);
    } catch {
      // Same private/incognito caveat as above; not fatal.
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
  //
  // Subscribe-then-fetch ordering to close the initial-state race
  // ([RAISE-20](https://risepeople.atlassian.net/browse/RAISE-20)). If
  // main pushes a `theme:updated` event between `theme.get()` being
  // dispatched and its response landing (e.g. the user toggles the OS
  // theme in the same tick the renderer attaches), the subscription
  // must be registered first so the live value isn't lost. The
  // `receivedFromSubscription` flag then prevents the now-stale
  // `theme.get()` reply from overwriting the fresh value.
  useEffect(() => {
    let cancelled = false;
    let receivedFromSubscription = false;
    const off = window.api.theme.onChange((next) => {
      receivedFromSubscription = true;
      apply(next);
    });
    void (async () => {
      const initial = await window.api.theme.get();
      if (cancelled || receivedFromSubscription) return;
      apply(initial);
    })();
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

  const cycleEditorPreference = useCallback(async () => {
    const order: ThemePreference[] = ['system', 'light', 'dark'];
    const idx = order.indexOf(state.editor.preference);
    const next = order[(idx + 1) % order.length] ?? 'system';
    await setEditorPreference(next);
  }, [state.editor.preference, setEditorPreference]);

  const setEditorContrast = useCallback(
    async (contrast: EditorContrast) => {
      const next = await window.api.theme.setEditor({ contrast });
      apply(next);
    },
    [apply],
  );

  const setEditorWordWrap = useCallback(
    async (wrap: WordWrap) => {
      const next = await window.api.theme.setEditor({ wordWrap: wrap });
      apply(next);
    },
    [apply],
  );

  const toggleEditorWordWrap = useCallback(async () => {
    // Resolved atomically in main against the persisted value — the
    // renderer doesn't pass an explicit target. Removes the
    // closure-stale-state race where two rapid presses could both
    // capture the same `state.editor.wordWrap` and end up at the same
    // final value instead of alternating. See `theme:toggle-editor-word-wrap`
    // in src/main/index.ts.
    const next = await window.api.theme.toggleEditorWordWrap();
    apply(next);
  }, [apply]);

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
    cycleEditorPreference,
    setEditorContrast,
    setEditorWordWrap,
    toggleEditorWordWrap,
  };
}
