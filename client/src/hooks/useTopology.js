/**
 * @fileoverview Hook that fetches and maintains the module/SIM topology.
 * Updates in real time via socket events.
 */

import { useState, useEffect } from 'react';
import { useSocket } from './useSocket';
import { fetchTopology } from '../services/apiService';
import { SERVER_EVENTS } from '../constants/socketEvents';

/**
 * @typedef {{ id: number, simCount: number }} Module
 */

/**
 * Provides the current topology and loading/error state.
 * @returns {{ modules: Module[], loading: boolean, error: string | null }}
 */
export function useTopology() {
  const { socket } = useSocket();
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    fetchTopology()
      .then((data) => {
        if (!cancelled && data && data.modules) {
          setModules(data.modules);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // 503 means the Arduino hasn't responded yet — stay in loading state.
        // The TOPOLOGY_UPDATE socket event will resolve it once the Arduino is ready.
        if (err.message === 'Topology not yet available') return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    /**
     * Handle topology update from server.
     * @param {{ modules: Module[] }} data
     */
    const onTopologyUpdate = (data) => {
      if (data && data.modules) {
        setModules(data.modules);
        setError(null);
        setLoading(false);
      }
    };

    socket.on(SERVER_EVENTS.TOPOLOGY_UPDATE, onTopologyUpdate);

    return () => {
      socket.off(SERVER_EVENTS.TOPOLOGY_UPDATE, onTopologyUpdate);
    };
  }, [socket]);

  return { modules, loading, error };
}
