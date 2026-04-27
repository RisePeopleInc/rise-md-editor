import { useCallback, useEffect, useState } from 'react';
import type { UpdateState } from '../env';

/**
 * Single source of truth for auto-update state in the renderer:
 *   - reads main's last-known UpdateState on mount (covers the case
 *     where an update was found before the renderer attached)
 *   - subscribes to live transitions from main
 *   - exposes `install()` for the "Restart to update" button
 */
export function useUpdateState(): UpdateState & { install: () => void } {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const initial = await window.api.update.getState();
      if (cancelled) return;
      setState(initial);
    })();
    const off = window.api.update.onStateChange((next) => setState(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const install = useCallback(() => window.api.update.install(), []);

  return { ...state, install };
}
