/**
 * @fileoverview Client-side configuration constants.
 */

/** Base URL for REST API calls (empty = same origin, used in production) */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

/** Socket.io connection URL (empty = same origin, used in production) */
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || '';

/** Timeout (ms) for API fetch calls */
export const API_TIMEOUT_MS = 10000;
