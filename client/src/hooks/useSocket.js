/**
 * @fileoverview Hook that returns the singleton socket.io client instance
 * and tracks connection state.
 */

import { useState, useEffect, useRef } from 'react';
import { getSocket } from '../services/socketService';

/**
 * Provides the shared socket.io client and its connection status.
 * @returns {{ socket: import('socket.io-client').Socket, isConnected: boolean }}
 */
export function useSocket() {
  const socketRef = useRef(getSocket());
  const [isConnected, setIsConnected] = useState(socketRef.current.connected);

  useEffect(() => {
    const socket = socketRef.current;

    /** @param {void} _ */
    const onConnect = () => setIsConnected(true);
    /** @param {void} _ */
    const onDisconnect = () => setIsConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return { socket: socketRef.current, isConnected };
}
