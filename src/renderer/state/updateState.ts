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
    // Subscribe-then-fetch ordering to close the initial-state race
    // ([RAISE-20](https://risepeople.atlassian.net/browse/RAISE-20)). If
    // we did getState() first and registered the subscription on its
    // resolution, a state push from main between the IPC send and its
    // response would be dropped — and even after, ordering matters:
    // with the subscription registered first, a push that lands mid-init
    // (e.g. main flips `idle` → `downloading` while `getState()` is in
    // flight) gets applied via `setState`, and we must not let the
    // stale `getState` reply overwrite it. `receivedFromSubscription`
    // is that guard: once a live event has populated state, we discard
    // the initial fetch.
    let cancelled = false;
    let receivedFromSubscription = false;
    const off = window.api.update.onStateChange((next) => {
      receivedFromSubscription = true;
      setState(next);
    });
    void (async () => {
      const initial = await window.api.update.getState();
      if (cancelled || receivedFromSubscription) return;
      setState(initial);
    })();
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const install = useCallback(() => window.api.update.install(), []);

  return { ...state, install };
}
