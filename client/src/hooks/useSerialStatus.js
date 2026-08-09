/**
 * @fileoverview Hook that tracks Arduino serial connection status via socket events.
 * Status: 'disconnected' | 'initializing' | 'ready'
 */

import { useState, useEffect } from 'react';
import { useSocket } from './useSocket';
import { SERVER_EVENTS } from '../constants/socketEvents';

/**
 * @returns {{ serialStatus: 'disconnected'|'initializing'|'ready', serialPath: string, serialLabel: string }}
 */
export function useSerialStatus() {
  const { socket } = useSocket();
  const [state, setState] = useState({ status: 'disconnected', path: '', label: '' });

  useEffect(() => {
    const onSerialStatus = (data) => {
      setState({
        status: data.status || (data.connected ? 'ready' : 'disconnected'),
        path: data.path || '',
        label: data.label || '',
      });
    };

    socket.on(SERVER_EVENTS.SERIAL_STATUS, onSerialStatus);
    return () => socket.off(SERVER_EVENTS.SERIAL_STATUS, onSerialStatus);
  }, [socket]);

  return {
    serialStatus: state.status,
    serialPath: state.path,
    serialLabel: state.label,
  };
}
