import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { ResolvedTheme, ThemePreference, ThemeState } from '../env';
import {
  GRUVBOX_DARK_ID,
  GRUVBOX_LIGHT_ID,
  registerGruvboxThemes,
} from '../monaco-themes';

/**
 * Storage key used by the bootstrap script in `index.html` so the next
 * launch can apply the data-theme attribute synchronously, before any
 * paint, avoiding the light-flash-then-dark transition.
 *
 * Stores the *resolved* value (light/dark) rather than the preference,
 * because that's what the bootstrap needs to set on the document. Main
 * is still the source of truth for the preference itself.
 */
const BOOT_STORAGE_KEY = 'rise-theme';

interface UseThemeStateResult extends ThemeState {
  /** Set the explicit preference. */
  setPreference: (pref: ThemePreference) => Promise<void>;
  /** Cycle: system → light → dark → system. Bound to Cmd+Shift+T. */
  cycle: () => Promise<void>;
}

/**
 * Single source of truth for theme state in the renderer:
 *   - reads main's preference + resolved value on mount
 *   - subscribes to main's `theme:updated` events (covers both explicit
 *     user changes and OS-level appearance flips when pref==='system')
 *   - writes the resolved value to `data-theme` on `<html>`
 *   - re-registers Gruvbox themes when resolved flips (so any new
 *     Monaco editors mount with the right palette and existing ones
 *     pick up the swap via `monaco.editor.setTheme`)
 *   - mirrors the resolved value to localStorage so the next launch's
 *     bootstrap script can apply the right theme synchronously
 */
export function useThemeState(): UseThemeStateResult {
  const [state, setState] = useState<ThemeState>(() => {
    // Read the bootstrap-set attribute as our optimistic initial value
    // so the first React render matches the DOM the bootstrap already
    // wrote. Main will overwrite this once `theme:get` resolves.
    const attr = document.documentElement.getAttribute('data-theme');
    const resolved: ResolvedTheme = attr === 'dark' ? 'dark' : 'light';
    return { preference: 'system', resolved };
  });

  const lastResolvedRef = useRef<ResolvedTheme>(state.resolved);

  // Track whether the first apply has run. The very first apply MUST
  // re-register Gruvbox even if the resolved value matches the
  // optimistic initial state, because monaco-setup's pre-registration
  // happens before our CSS file finishes parsing — `getComputedStyle`
  // returns empty for `--gruvbox-*` and the fallback paints the editor
  // bright magenta. Re-running here (after CSS is loaded; React effects
  // run post-paint) gives Monaco the real palette.
  const initialAppliedRef = useRef(false);

  const apply = useCallback((next: ThemeState) => {
    setState(next);
    document.documentElement.setAttribute('data-theme', next.resolved);
    try {
      localStorage.setItem(BOOT_STORAGE_KEY, next.resolved);
    } catch {
      // localStorage can throw in private/incognito profiles; not fatal.
    }

    const resolvedChanged = lastResolvedRef.current !== next.resolved;
    const firstApply = !initialAppliedRef.current;
    if (resolvedChanged || firstApply) {
      lastResolvedRef.current = next.resolved;
      initialAppliedRef.current = true;
      // Re-snapshot the palette from the now-loaded CSS variables and
      // push the right theme to every existing Monaco editor.
      registerGruvboxThemes();
      monaco.editor.setTheme(
        next.resolved === 'dark' ? GRUVBOX_DARK_ID : GRUVBOX_LIGHT_ID,
      );
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

  const setPreference = useCallback(async (pref: ThemePreference) => {
    const next = await window.api.theme.set(pref);
    apply(next);
  }, [apply]);

  const cycle = useCallback(async () => {
    const order: ThemePreference[] = ['system', 'light', 'dark'];
    const idx = order.indexOf(state.preference);
    const next = order[(idx + 1) % order.length] ?? 'system';
    await setPreference(next);
  }, [state.preference, setPreference]);

  return {
    preference: state.preference,
    resolved: state.resolved,
    setPreference,
    cycle,
  };
}
