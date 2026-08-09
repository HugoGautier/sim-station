/**
 * @fileoverview REST API client — one function per endpoint.
 * All fetch calls go through this service.
 */

import { API_BASE_URL, API_TIMEOUT_MS } from '../constants/config';

/**
 * Perform a fetch with timeout via AbortController.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, credentials: 'include' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the module/SIM topology.
 * @returns {Promise<{ modules: Array<{ id: number, simCount: number }> }>}
 */
export function fetchTopology() {
  return fetchWithTimeout(`${API_BASE_URL}/api/topology`);
}

/**
 * Fetch SMS messages for a specific SIM.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<{ moduleId: number, simId: number, messages: Array }>}
 */
export function fetchMessages(moduleId, simId) {
  return fetchWithTimeout(`${API_BASE_URL}/api/sim/${moduleId}/${simId}/messages`);
}

/**
 * Select a SIM on the MUX via REST.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<{ success: boolean }>}
 */
export function selectSim(moduleId, simId) {
  return fetchWithTimeout(`${API_BASE_URL}/api/sim/${moduleId}/${simId}/select`, {
    method: 'POST',
  });
}

/**
 * Answer an incoming call via REST.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<{ success: boolean }>}
 */
export function answerCall(moduleId, simId) {
  return fetchWithTimeout(`${API_BASE_URL}/api/sim/${moduleId}/${simId}/answer`, {
    method: 'POST',
  });
}

/**
 * Hang up a call via REST.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<{ success: boolean }>}
 */
export function hangupCall(moduleId, simId) {
  return fetchWithTimeout(`${API_BASE_URL}/api/sim/${moduleId}/${simId}/hangup`, {
    method: 'POST',
  });
}

/**
 * Send a DTMF digit via REST.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} digit
 * @returns {Promise<{ success: boolean }>}
 */
/**
 * Fetch system info (topology breakdown, COM ports, serial status).
 */
export function fetchSystemInfo() {
  return fetchWithTimeout(`${API_BASE_URL}/api/system/info`);
}

export function sendDtmf(moduleId, simId, digit) {
  return fetchWithTimeout(`${API_BASE_URL}/api/sim/${moduleId}/${simId}/dtmf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ digit }),
  });
}
