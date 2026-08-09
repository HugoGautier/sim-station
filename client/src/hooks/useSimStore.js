/**
 * @fileoverview Hook that captures the persistent SIM store sent on socket connect.
 * Must be mounted early (in Dashboard) so it captures the initial payload.
 */

import { useState, useEffect } from 'react';
import { useSocket } from './useSocket';
import { SERVER_EVENTS } from '../constants/socketEvents';

/**
 * @typedef {{ operator: string, phoneNumber: string, messages: Array }} SimEntry
 */

/**
 * Provides the persistent SIM store and a per-SIM getter.
 * @returns {{ getSimInfo: (moduleId: number, simId: number) => SimEntry }}
 */
export function useSimStore() {
  const { socket } = useSocket();
  const [store, setStore] = useState({});

  useEffect(() => {
    const onStore = (data) => {
      if (data.store) setStore(data.store);
    };
    socket.on(SERVER_EVENTS.SIM_STORE, onStore);
    return () => socket.off(SERVER_EVENTS.SIM_STORE, onStore);
  }, [socket]);

  const getSimInfo = (moduleId, simId) =>
    store[`${moduleId}:${simId}`] || { operator: '', phoneNumber: '', messages: [] };

  return { getSimInfo };
}
