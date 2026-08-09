/**
 * @fileoverview Hook for real-time server log streaming.
 * Subscribes to SERVER_LOG_HISTORY (sent once per socket connect) and
 * SERVER_LOG (each new line). Keeps a bounded ring buffer client-side.
 *
 * Mount this at Dashboard level so the buffer survives modal open/close
 * — the connect-time history event fires before the modal's useEffect
 * would otherwise run.
 */

import { useEffect, useState } from 'react';
import { useSocket } from './useSocket';
import { SERVER_EVENTS } from '../constants/socketEvents';

const MAX_LINES = 500;

/** @typedef {{ ts: number, level: 'info'|'warn'|'error', message: string }} LogEntry */

/** @returns {LogEntry[]} */
export function useServerLogs() {
  const { socket } = useSocket();
  const [logs, setLogs] = useState(/** @type {LogEntry[]} */ ([]));

  useEffect(() => {
    const onHistory = ({ logs: history }) => {
      const trimmed = history.length > MAX_LINES ? history.slice(history.length - MAX_LINES) : history;
      setLogs(trimmed);
    };
    const onLine = (entry) => {
      setLogs((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
        next.push(entry);
        return next;
      });
    };
    socket.on(SERVER_EVENTS.SERVER_LOG_HISTORY, onHistory);
    socket.on(SERVER_EVENTS.SERVER_LOG, onLine);
    return () => {
      socket.off(SERVER_EVENTS.SERVER_LOG_HISTORY, onHistory);
      socket.off(SERVER_EVENTS.SERVER_LOG, onLine);
    };
  }, [socket]);

  return logs;
}
