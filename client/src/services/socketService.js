/**
 * @fileoverview Socket.io client singleton.
 * Provides a single shared connection to the server.
 */

import { io } from 'socket.io-client';
import { SOCKET_URL } from '../constants/config';

/** @type {import('socket.io-client').Socket | null} */
let socket = null;

/**
 * Get or create the singleton socket.io client instance.
 * @returns {import('socket.io-client').Socket}
 */
export function getSocket() {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      withCredentials: true,
    });
  }
  return socket;
}
