/**
 * @fileoverview Socket.io event name constants — mirrors server/src/constants/socketEvents.js.
 */

/** @enum {string} Events emitted by the client to the server */
export const CLIENT_EVENTS = {
  SIM_SELECT: 'sim:select',
  SIM_ANSWER: 'sim:answer',
  SIM_HANGUP: 'sim:hangup',
  SIM_DTMF: 'sim:dtmf',
  SIM_REQUEST_NUMBER: 'sim:request-number',
  SIM_DEQUEUE: 'sim:dequeue',
  /** Deselect a SIM that's currently the MUX-active one on its module:
   * stops any active data session / call on it and powers the radio down
   * (CFUN=0). Payload: { moduleId, simId }. */
  SIM_DESELECT: 'sim:deselect',
  /** Manual reconnect nudge (AT+COPS=0) for a selected SIM that lost the
   *  network. Payload: { moduleId, simId } */
  SIM_RECONNECT: 'sim:reconnect',
  /** Toggle the global data SIM. Payload: { moduleId, simId } (same pair toggles off). */
  DATA_SELECT: 'data:select',
  SERVER_RESTART: 'server:restart',
  /** Sent right after reconnect so the server can rebuild its per-socket
   *  clientSelections from the client's current state.
   *  Payload: { selections: Array<{ moduleId, simId }> } */
  SELECTIONS_REHYDRATE: 'selections:rehydrate',
};

/** @enum {string} Events emitted by the server to the client */
export const SERVER_EVENTS = {
  SIM_SMS: 'sim:sms',
  SIM_CALL_INCOMING: 'sim:call:incoming',
  SIM_CALL_ACTIVE: 'sim:call:active',
  SIM_CALL_ENDED: 'sim:call:ended',
  SIM_STATUS: 'sim:status',
  TOPOLOGY_UPDATE: 'topology:update',
  /** Emitted when the Arduino serial connection status changes.
   *  Payload: { path: string, label: string, connected: boolean } */
  SERIAL_STATUS: 'serial:status',
  SIM_NUMBER: 'sim:number',
  SIM_SMS_LIST: 'sim:sms:list',
  /** Per-module RNDIS driver state.
   *  Payload: { statuses: { [moduleId]: 'ok'|'missing'|'unknown' } } */
  RNDIS_STATUS: 'rndis:status',
  /** PCM audio chunk from a SimCom audio port. Payload: { moduleId, chunk: string (base64) } */
  AUDIO_CHUNK: 'audio:chunk',
  /** List of moduleIds with active audio ports. Payload: { moduleIds: number[] } */
  AUDIO_PORTS: 'audio:ports',
  SIM_SIGNAL: 'sim:signal',
  /** Serving radio access tech (LTE / WCDMA / GSM / etc.). Empty string clears it.
   *  Payload: { moduleId, simId, networkType: string }. */
  SIM_NETWORK_TYPE: 'sim:network_type',
  /** Server-side whisper.cpp transcript for an active call.
   *  Payload: { moduleId, simId, text: string } — full latest transcript. */
  SIM_TRANSCRIPT: 'sim:transcript',
  /** Call ended, clear the live transcript. Payload: { moduleId, simId } */
  SIM_TRANSCRIPT_DONE: 'sim:transcript:done',
  /** Server-side whisper.cpp config. Payload: { enabled: boolean } */
  TRANSCRIBE_STATUS: 'transcribe:status',
  SIM_STORE: 'sim:store',
  SIM_QUEUE: 'sim:queue',
  /** Global data SIM state. Payload: { moduleId: number|null, simId: number|null, status: 'off'|'connecting'|'active'|'error', ip: string|null } */
  DATA_STATE: 'data:state',
  /** Single server log line. Payload: { ts: number, level: 'info'|'warn'|'error', message: string } */
  SERVER_LOG: 'server:log',
  /** Buffered server log history sent once per socket on connect. Payload: { logs: Array } */
  SERVER_LOG_HISTORY: 'server:log:history',
  /** Server shutdown signal — drop all UI selections/queues immediately. */
  SELECTIONS_CLEAR: 'selections:clear',
  /** Initial selections snapshot on connect — restores the "selected" border
   *  for each module's MUX-active SIM after a refresh/reconnect.
   *  Payload: { selections: Array<{ moduleId, simId }> } */
  SELECTIONS_RESTORE: 'selections:restore',
};
