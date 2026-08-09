/**
 * @fileoverview Hook for the global data-SIM state.
 *
 * At most one SIM is used as the 4G internet connection across all modules.
 * The server owns the state; the client listens to DATA_STATE and emits
 * DATA_SELECT to toggle.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './useSocket';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../constants/socketEvents';

/**
 * @typedef {{ moduleId: number|null, simId: number|null, status: 'off'|'connecting'|'active'|'error', ip?: string|null, publicIp?: string|null }} DataState
 * @typedef {'cellular' | 'local' | 'unknown' | null} Transit
 */

/** @returns {{ dataState: DataState, transit: Transit, toggleData: (moduleId: number, simId: number) => void, isDataSim: (moduleId: number, simId: number) => boolean }} */
export function useDataSim() {
  const { socket } = useSocket();
  const [dataState, setDataState] = useState(
    /** @type {DataState} */ ({ moduleId: null, simId: null, status: 'off', ip: null, publicIp: null })
  );

  /**
   * Once the server reports a verified public IP, the client checks its
   * OWN egress IP. Match → 'cellular' (client routes through host's 4G).
   * Different → 'local' (client uses its own connection). 'unknown' when
   * the server couldn't verify the public IP (we'd compare against the
   * CGNAT 10.x.x.x and falsely conclude 'local'). null while a check is
   * in flight (keeps the pill in pending state).
   * @type {[Transit, React.Dispatch<React.SetStateAction<Transit>>]}
   */
  const [transit, setTransit] = useState(null);

  useEffect(() => {
    const onState = (payload) => setDataState(payload);
    const onClear = () => setDataState({ moduleId: null, simId: null, status: 'off', ip: null, publicIp: null });
    socket.on(SERVER_EVENTS.DATA_STATE, onState);
    socket.on(SERVER_EVENTS.SELECTIONS_CLEAR, onClear);
    return () => {
      socket.off(SERVER_EVENTS.DATA_STATE, onState);
      socket.off(SERVER_EVENTS.SELECTIONS_CLEAR, onClear);
    };
  }, [socket]);

  useEffect(() => {
    if (dataState.status !== 'active') {
      setTransit(null);
      return;
    }
    if (!dataState.publicIp) {
      // Server fell back to the CGNAT IP — comparing it against the client's
      // ipify result would always mismatch and falsely conclude 'local'.
      // Mark the verdict as unknown so the pill drops the pending state but
      // shows no Cellular/Local suffix.
      setTransit('unknown');
      return;
    }
    const controller = new AbortController();
    setTransit(null); // pending while we run the check

    // Retry up to 3 times with 1.5s gap. Same shape as the server-side
    // _fetchPublicIp retry loop — covers transient ipify slowness or a
    // brief client-side network hiccup so we don't false-positive 'unknown'.
    const MAX_ATTEMPTS = 3;
    let cancelled = false;

    const runOnce = () => fetch('https://api.ipify.org?format=json', { signal: controller.signal })
      .then((r) => r.json())
      .then(({ ip }) => ip);

    (async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const ip = await runOnce();
          if (cancelled || controller.signal.aborted) return;
          setTransit(ip === dataState.publicIp ? 'cellular' : 'local');
          return;
        } catch {
          if (cancelled || controller.signal.aborted) return;
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      }
      if (!cancelled && !controller.signal.aborted) setTransit('unknown');
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [dataState.status, dataState.publicIp]);

  const toggleData = useCallback(
    (moduleId, simId) => {
      socket.emit(CLIENT_EVENTS.DATA_SELECT, { moduleId, simId });
    },
    [socket]
  );

  const isDataSim = useCallback(
    (moduleId, simId) =>
      dataState.moduleId === moduleId &&
      dataState.simId === simId &&
      dataState.status !== 'off',
    [dataState]
  );

  return { dataState, transit, toggleData, isDataSim };
}
