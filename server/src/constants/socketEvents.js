/**
 * @fileoverview All socket.io event name strings.
 * Shared naming convention between server and client.
 */

/** @enum {string} Events emitted by the client, handled by the server */
const CLIENT_EVENTS = {
  SIM_SELECT: 'sim:select',
  SIM_ANSWER: 'sim:answer',
  SIM_HANGUP: 'sim:hangup',
  SIM_DTMF: 'sim:dtmf',
  /** Request own phone number via USSD. Payload: { moduleId, simId, ussdCode } */
  SIM_REQUEST_NUMBER: 'sim:request-number',
  /** Remove a SIM from the module queue. Payload: { moduleId, simId } */
  SIM_DEQUEUE: 'sim:dequeue',
  /** Deselect the currently MUX-active SIM on a module: stop data/call,
   * power the radio down (CFUN=0), reset cached state. Payload: { moduleId, simId } */
  SIM_DESELECT: 'sim:deselect',
  /** Manual reconnect nudge for a selected-but-off-network SIM: force the
   * modem to redo automatic operator selection (AT+COPS=0). Payload: { moduleId, simId } */
  SIM_RECONNECT: 'sim:reconnect',
  /** Toggle the global data SIM. Payload: { moduleId, simId } (same pair toggles off). */
  DATA_SELECT: 'data:select',
  /** Request server restart. No payload. */
  SERVER_RESTART: 'server:restart',
  /** Sent by the client right after (re)connecting so the server can repopulate
   *  its per-socket clientSelections map — survives socket.io reconnect (which
   *  assigns a new socket.id and loses the previous selection routing).
   *  Payload: { selections: Array<{ moduleId, simId }> } */
  SELECTIONS_REHYDRATE: 'selections:rehydrate',
};

/** @enum {string} Events emitted by the server, handled by the client */
const SERVER_EVENTS = {
  SIM_SMS: 'sim:sms',
  SIM_CALL_INCOMING: 'sim:call:incoming',
  SIM_CALL_ACTIVE: 'sim:call:active',
  SIM_CALL_ENDED: 'sim:call:ended',
  SIM_STATUS: 'sim:status',
  TOPOLOGY_UPDATE: 'topology:update',
  /** Emitted when the Arduino serial connection status changes.
   *  Payload: { path: string, label: string, connected: boolean } */
  SERIAL_STATUS: 'serial:status',
  /** Own phone number retrieved via USSD. Payload: { moduleId, simId, phoneNumber } */
  SIM_NUMBER: 'sim:number',
  /** Full SMS list for a SIM. Payload: { moduleId, simId, messages } */
  SIM_SMS_LIST: 'sim:sms:list',
  /** PCM audio chunk from a SimCom audio port. Payload: { moduleId, chunk: string (base64) } */
  AUDIO_CHUNK: 'audio:chunk',
  /** List of moduleIds with active audio ports. Payload: { moduleIds: number[] } */
  AUDIO_PORTS: 'audio:ports',
  /** Signal quality for a SIM. Payload: { moduleId, simId, rssi: number } */
  SIM_SIGNAL: 'sim:signal',
  /** Serving radio access tech for a SIM (LTE / WCDMA / GSM / NO SERVICE / '').
   *  Empty string means "clear the displayed type" — sent on deselect /
   *  status→unknown so the chip disappears in sync with the signal bars.
   *  Payload: { moduleId, simId, networkType: string } */
  SIM_NETWORK_TYPE: 'sim:network_type',
  /** Server-side whisper.cpp transcript for an active call on this module.
   *  Payload: { moduleId, simId, text: string } — full latest transcript. */
  SIM_TRANSCRIPT: 'sim:transcript',
  /** Call ended → stop showing the live transcript. Payload: { moduleId, simId } */
  SIM_TRANSCRIPT_DONE: 'sim:transcript:done',
  /** Whether server-side whisper.cpp transcription is configured. Sent on
   *  connect. When false the client uses its in-browser Vosk fallback.
   *  Payload: { enabled: boolean } */
  TRANSCRIBE_STATUS: 'transcribe:status',
  /** Per-module RNDIS driver state. 'missing' = the module's network adapter
   *  driver isn't installed → data won't work and the dashboard disables its
   *  SIMs until fixed. Sent on connect, on every change, and after reconcile.
   *  Payload: { statuses: { [moduleId]: 'ok'|'missing'|'unknown' } } */
  RNDIS_STATUS: 'rndis:status',
  /** Persistent per-SIM store (operator, phoneNumber, messages). Sent on connect. */
  SIM_STORE: 'sim:store',
  /** SIM select queue status. Payload: { moduleId, activating: simId|null, queued: simId[] } */
  SIM_QUEUE: 'sim:queue',
  /** Global data SIM state. Payload: { moduleId: number|null, simId: number|null, status: 'off'|'connecting'|'active'|'error', ip: string|null } */
  DATA_STATE: 'data:state',
  /** Single server log line. Payload: { ts: number, level: 'info'|'warn'|'error', message: string } */
  SERVER_LOG: 'server:log',
  /** Buffered server log history sent once per socket on connect. Payload: { logs: Array } */
  SERVER_LOG_HISTORY: 'server:log:history',
  /** Server is shutting down — clients should drop all per-socket UI state
   *  (SIM selection highlights, queues, etc.) so the dashboard doesn't keep
   *  showing stale selection after the backend resets MUX/data sessions. */
  SELECTIONS_CLEAR: 'selections:clear',
  /** Initial snapshot of MUX-active SIMs per module, sent on connect.
   *  Lets the client restore the purple "selected" border for each module
   *  after a refresh/reconnect (otherwise the UI starts empty while the
   *  modem is still on a real SIM). Payload: { selections: Array<{ moduleId, simId }> } */
  SELECTIONS_RESTORE: 'selections:restore',
};

module.exports = { CLIENT_EVENTS, SERVER_EVENTS };
