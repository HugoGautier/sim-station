/**
 * @fileoverview Socket.io server-side event handling.
 * Manages per-client SIM selection tracking and real-time event routing.
 */

const { CLIENT_EVENTS, SERVER_EVENTS } = require('../constants/socketEvents');
const simService = require('../services/simService');
const { muxService } = require('../services/muxService');
const { serialService } = require('../services/serialService');
const { simcomService } = require('../services/simcomService');
const { transcribeService } = require('../services/transcribeService');
const { restoreRndisAdapters } = require('../services/windowsNetRoutes');
const { sendATAndCollect } = require('../services/atService');
const { getUssdCode, getOperatorConfig } = require('../constants/operators');
const simStore = require('../services/simStore');
const logStream = require('../services/logStream');

/**
 * Per-socket SIM selection state.
 * Maps socket.id -> Map<moduleId, simId>
 * @type {Map<string, Map<number, number>>}
 */
const clientSelections = new Map();

/**
 * Per-module lock: true while a sim:select is executing for that module.
 * Prevents concurrent selection operations on the same UART.
 * @type {Map<number, boolean>}
 */
const moduleSelectRunning = new Map();

/**
 * Per-module: which simId is currently being activated.
 * @type {Map<number, number>}
 */
const moduleActiveSim = new Map();

/**
 * Per-module FIFO queue: all sim:select requests that arrive while the module
 * is busy are appended. Duplicates (same simId) are skipped.
 * Processed in order after the running operation ends.
 * @type {Map<number, Array<{ socket: import('socket.io').Socket, moduleId: number, simId: number }>>}
 */
const modulePendingSelect = new Map();

/**
 * Per-module promise resolving when an in-flight deselect completes. A
 * sim:select that arrives during a deselect (e.g. user clicks "select"
 * 1s after clicking "deselect" — CHUP + CFUN=0 takes ~2.5s) awaits on
 * this before starting its own MUX flow. Without the await, the select
 * races the deselect's clearSimData/clearSelected and leaves the module
 * in an inconsistent "violet UI but radio off and status=unknown" state.
 * @type {Map<number, Promise<void>>}
 */
const moduleDeselectInflight = new Map();

/**
 * Server-side memory of the last SIM successfully selected per module,
 * independent of any socket. Survives socket reconnects AND Arduino serial
 * reconnects. When the Arduino re-enumerates (USB glitch), the MUX hardware
 * resets to SIM 0 and muxService clears its cache, so URCs (SMS/calls) would
 * silently drop for the SIM the UI still shows as active. resyncSelections()
 * re-runs the full select for each entry here after a reconnect.
 * @type {Map<number, number>}
 */
const lastSelectedSim = new Map();

/**
 * Reference to the socket.io server for broadcasting.
 * @type {import('socket.io').Server | null}
 */
let ioServer = null;

/**
 * Global data-SIM state — single SIM globally used for 4G internet.
 * status transitions: off → connecting → active (or error).
 * `ip` is populated once the RmNet call is up — the carrier-NAT public IP
 * if we managed to fetch it, otherwise the modem's CGNAT IP for display.
 * `publicIp` is non-null only when the public-IP fetch succeeded; the
 * client uses it (not `ip`) to compare with its own egress, since CGNAT
 * IPs would always mismatch the client's view and falsely report Local.
 * @type {{ moduleId: number|null, simId: number|null, status: 'off'|'connecting'|'active'|'error', ip: string|null, publicIp: string|null }}
 */
let dataState = { moduleId: null, simId: null, status: 'off', ip: null, publicIp: null };

function broadcastDataState() {
  if (ioServer) ioServer.emit(SERVER_EVENTS.DATA_STATE, dataState);
}

/**
 * Guard against double-execution: SIGINT + SERVER_RESTART may both fire in
 * quick succession, and PowerShell invocations aren't cheap.
 * @type {boolean}
 */
let shuttingDown = false;

/**
 * Clean shutdown: deactivate any active data session and restore default
 * routing so the host reverts to WiFi/Ethernet. Idempotent.
 * Safe to call from signal handlers and from the SERVER_RESTART socket event.
 * @returns {Promise<void>}
 */
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[SHUTDOWN] cleanup starting...');
  try {
    // Tell clients to drop their per-socket UI selections first — before any
    // potentially slow cleanup work (stopDataSession, restoreRndisAdapters).
    // Without this the dashboard keeps showing the previously-selected SIM as
    // active with "unknown" status until the user manually refreshes.
    if (ioServer) ioServer.emit(SERVER_EVENTS.SELECTIONS_CLEAR);
    clientSelections.clear();
    moduleActiveSim.clear();
    moduleSelectRunning.clear();
    modulePendingSelect.clear();

    const hadDataSession = dataState.moduleId !== null && dataState.status !== 'off';
    const dataMid = dataState.moduleId;
    if (hadDataSession) {
      dataState = { moduleId: null, simId: null, status: 'off', ip: null, publicIp: null };
      broadcastDataState();
    }

    // Restore host-side networking BEFORE the slow modem AT teardown. If the
    // modem hangs (or the user double-Ctrl+C's), at least the OS reverts to
    // WiFi instead of being stuck on a dead RNDIS metric=1 default route.
    // We deliberately KEEP the Tailscale exit-node advertisement on. The
    // tailscaled daemon is independent of this server, and the remote PC
    // is configured with --exit-node=<this-host> so it relies on the
    // advertisement existing — withdrawing it (per the modern Tailscale
    // "blocked when exit-node is gone" policy) would knock the peer
    // offline rather than letting it fall back. Host stays an exit-node
    // for the WiFi/Ethernet path even when the dashboard is off.
    await restoreRndisAdapters().catch(() => {});

    // Modem-side data teardown last. Best-effort: even if it hangs, we've
    // already restored host routing above, so the user's network is fine.
    if (hadDataSession) {
      await simcomService.stopDataSession(dataMid).catch((err) =>
        console.warn(`[SHUTDOWN] stopDataSession: ${err.message}`)
      );
    }
  } finally {
    console.log('[SHUTDOWN] cleanup done');
    // Flush the on-disk debug log so the file is intact when the process
    // exits. Done last so this final line ends up in the file too.
    await logStream.closeFile().catch(() => {});
  }
}

/** @type {(() => { status?: string }) | null} */
let _getSerialStatus = null;

/**
 * Per-module pending SMS body — when +CMT arrives, next line is the body.
 * @type {Map<number, { moduleId: number, simId: number, sms: { index: number, status: string, sender: string, timestamp: string, body: string } }>}
 */
const pendingSmsHeaders = new Map();

/**
 * Initialize socket.io event handlers and serial-to-socket bridging.
 * @param {import('socket.io').Server} io
 * @param {() => object | null} getTopology - Function to retrieve current topology
 * @param {() => { path: string, label: string, connected: boolean } | null} getSerialStatus - Function to retrieve current serial status
 */
function initSocketHandler(io, getTopology, getSerialStatus) {
  ioServer = io;
  _getSerialStatus = getSerialStatus;

  setupSerialBridge();
  setupMuxBridge();
  setupSimcomBridge();
  setupTranscribeBridge();
  setupLogStreamBridge();
  startSignalPolling(getTopology);
  startNoServiceRetry(getTopology);

  io.on('connection', (socket) => {
    clientSelections.set(socket.id, new Map());

    const serialStatus = getSerialStatus();
    if (serialStatus) {
      socket.emit(SERVER_EVENTS.SERIAL_STATUS, serialStatus);
    }

    const topology = getTopology();
    if (topology) {
      socket.emit(SERVER_EVENTS.TOPOLOGY_UPDATE, topology);
    }

    sendCurrentStates(socket, getTopology);

    socket.emit(SERVER_EVENTS.SIM_STORE, { store: simStore.getAll() });
    socket.emit(SERVER_EVENTS.DATA_STATE, dataState);
    socket.emit(SERVER_EVENTS.SERVER_LOG_HISTORY, { logs: logStream.getBuffer() });
    socket.emit(SERVER_EVENTS.TRANSCRIBE_STATUS, { enabled: transcribeService.isEnabled() });
    socket.emit(SERVER_EVENTS.RNDIS_STATUS, { statuses: simcomService.getRndisStatusByModule() });

    // Snapshot of what the MUX is actually on right now. The new socket
    // doesn't know which SIMs are "selected" until we tell it — without
    // this, a page refresh leaves every card with no purple border even
    // though the modem is still on a real SIM (see also the executeSimSelect
    // fast path that handles the case where the user re-clicks an already
    // MUX-active SIM after refresh).
    const muxSelections = muxService.getAllSelected();
    const selectionList = Object.entries(muxSelections).map(([moduleId, simId]) => ({
      moduleId: Number(moduleId),
      simId,
    }));
    if (selectionList.length > 0) {
      socket.emit(SERVER_EVENTS.SELECTIONS_RESTORE, { selections: selectionList });
      // Also mirror them into the server-side per-socket map so
      // emitToSelectedClients starts routing events to this socket
      // immediately. The client's rehydrate event (below) reinforces this.
      const sel = clientSelections.get(socket.id);
      if (sel) {
        for (const { moduleId, simId } of selectionList) sel.set(moduleId, simId);
      }
    }

    socket.on(CLIENT_EVENTS.SIM_SELECT, (payload) => {
      handleSimSelect(socket, payload);
    });

    socket.on(CLIENT_EVENTS.SIM_ANSWER, async (payload) => {
      await handleSimAnswer(socket, payload);
    });

    socket.on(CLIENT_EVENTS.SIM_HANGUP, async (payload) => {
      await handleSimHangup(socket, payload);
    });

    socket.on(CLIENT_EVENTS.SIM_DTMF, async (payload) => {
      await handleSimDtmf(socket, payload);
    });

    socket.on(CLIENT_EVENTS.SIM_REQUEST_NUMBER, async (payload) => {
      await handleSimRequestNumber(socket, payload);
    });

    socket.on(CLIENT_EVENTS.SIM_DEQUEUE, ({ moduleId, simId }) => {
      const queue = modulePendingSelect.get(moduleId);
      if (!queue) return;
      const idx = queue.findIndex((p) => p.simId === simId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        if (queue.length === 0) modulePendingSelect.delete(moduleId);
        broadcastQueue(moduleId);
      }
    });

    socket.on(CLIENT_EVENTS.SIM_DESELECT, ({ moduleId, simId }) => {
      handleSimDeselect(socket, moduleId, simId).catch((err) =>
        console.error(`[SIM] handleSimDeselect unhandled: ${err.message}`)
      );
    });

    socket.on(CLIENT_EVENTS.SIM_RECONNECT, ({ moduleId, simId }) => {
      handleSimReconnect(moduleId, simId).catch((err) =>
        console.error(`[SIM] handleSimReconnect unhandled: ${err.message}`)
      );
    });

    socket.on(CLIENT_EVENTS.DATA_SELECT, ({ moduleId, simId }) => {
      handleDataSelect(moduleId, simId).catch((err) =>
        console.error(`[DATA] handleDataSelect unhandled: ${err.message}`)
      );
    });

    socket.on(CLIENT_EVENTS.SELECTIONS_REHYDRATE, ({ selections } = {}) => {
      // Two purposes:
      //   1. Merge the client's current UI selections into the per-socket
      //      clientSelections map (covers socket.io reconnect — new socket.id
      //      starts with empty map, but the client may still have selections
      //      from before the disconnect).
      //   2. Reply with SELECTIONS_RESTORE so the client's React listener
      //      (mounted in a useEffect, possibly AFTER the initial on-connect
      //      emit raced past it) sees the MUX-active SIMs. This is the only
      //      reliable delivery path because socket.io drops events that
      //      arrive before their listener is attached.
      const sel = clientSelections.get(socket.id);
      if (sel && Array.isArray(selections)) {
        for (const { moduleId, simId } of selections) {
          if (typeof moduleId === 'number' && typeof simId === 'number') {
            sel.set(moduleId, simId);
          }
        }
      }
      const muxSelections = muxService.getAllSelected();
      const selectionList = Object.entries(muxSelections).map(([moduleId, simId]) => ({
        moduleId: Number(moduleId),
        simId,
      }));
      // Mirror the MUX truth into clientSelections so emitToSelectedClients
      // routes events for these SIMs to this socket.
      if (sel) {
        for (const { moduleId, simId } of selectionList) sel.set(moduleId, simId);
      }
      // Always reply — even an empty list lets the client know "no MUX-active
      // SIM on the server side, clear any stale optimistic state".
      socket.emit(SERVER_EVENTS.SELECTIONS_RESTORE, { selections: selectionList });
    });

    socket.on(CLIENT_EVENTS.SERVER_RESTART, async () => {
      console.log('[SERVER] Restart requested by client');
      try {
        await gracefulShutdown();
      } catch (err) {
        console.error(`[SHUTDOWN] error during restart cleanup: ${err.message}`);
      }
      process.exit(0);
    });

    socket.on('disconnect', () => {
      clientSelections.delete(socket.id);
      // Remove this socket's entries from all pending queues.
      for (const [moduleId, queue] of modulePendingSelect) {
        const filtered = queue.filter((p) => p.socket.id !== socket.id);
        if (filtered.length === 0) {
          modulePendingSelect.delete(moduleId);
        } else {
          modulePendingSelect.set(moduleId, filtered);
        }
      }
    });
  });
}

/**
 * Send current states of all SIMs to a newly connected socket.
 * @param {import('socket.io').Socket} socket
 * @param {() => object | null} getTopology
 */
function sendCurrentStates(socket, getTopology) {
  const topology = getTopology();
  if (!topology || !topology.modules) return;

  for (const mod of topology.modules) {
    for (let simId = 0; simId < mod.simCount; simId++) {
      const status = simService.getStatus(mod.id, simId);
      const operator = simService.getOperator(mod.id, simId);
      const phoneNumber = simService.getPhoneNumber(mod.id, simId);
      const callState = simService.getCallState(mod.id, simId);
      socket.emit(SERVER_EVENTS.SIM_STATUS, {
        moduleId: mod.id,
        simId,
        status,
        operator,
      });
      if (phoneNumber) {
        socket.emit(SERVER_EVENTS.SIM_NUMBER, { moduleId: mod.id, simId, phoneNumber });
      }
      const rssi = simService.getCachedSignal(mod.id, simId);
      if (rssi !== 99) {
        socket.emit(SERVER_EVENTS.SIM_SIGNAL, { moduleId: mod.id, simId, rssi });
      }
      const networkType = simService.getCachedNetworkType(mod.id, simId);
      if (networkType) {
        socket.emit(SERVER_EVENTS.SIM_NETWORK_TYPE, { moduleId: mod.id, simId, networkType });
      }
      const stored = simService.getStoredMessages(mod.id, simId);
      if (stored.length > 0) {
        socket.emit(SERVER_EVENTS.SIM_SMS_LIST, { moduleId: mod.id, simId, messages: stored });
      }
      if (callState.state === 'incoming') {
        socket.emit(SERVER_EVENTS.SIM_CALL_INCOMING, {
          moduleId: mod.id,
          simId,
          callerNumber: callState.callerNumber,
        });
      } else if (callState.state === 'active') {
        socket.emit(SERVER_EVENTS.SIM_CALL_ACTIVE, {
          moduleId: mod.id,
          simId,
          startTime: callState.startTime,
        });
      }
    }
  }
}

/**
 * Bridge muxService switch lifecycle events to socket SIM_STATUS updates.
 * Clients receive intermediate states ('switching', 'searching') so the UI
 * can show progress during the full CFUN=0 → MUX → CFUN=1 → poll sequence.
 */
function setupMuxBridge() {
  // The departing SIM is no longer "selected" on any client at this point,
  // so emitToSelectedClients would not reach anyone. Broadcast to all — each
  // SimCard filters by moduleId+simId client-side via useSimData.
  muxService.on('switch:departed', ({ moduleId, simId }) => {
    simService.setStatus(moduleId, simId, 'unknown');
    simService.clearSimData(moduleId, simId); // wipes signal/networkType cache too
    if (ioServer) {
      ioServer.emit(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status: 'unknown' });
      ioServer.emit(SERVER_EVENTS.SIM_NETWORK_TYPE, { moduleId, simId, networkType: '' });
    }
  });

  muxService.on('switch:start', ({ moduleId, simId }) => {
    broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status: 'switching' });
  });

  muxService.on('switch:searching', ({ moduleId, simId }) => {
    broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status: 'searching' });
  });

  muxService.on('switch:registered', ({ moduleId, simId, status, operator }) => {
    simService.setStatus(moduleId, simId, status);
    simService.setOperator(moduleId, simId, operator || '');
    simStore.setSimInfo(moduleId, simId, { operator: operator || '' });
    broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status, operator: operator || '' });
  });

  muxService.on('switch:timeout', ({ moduleId, simId }) => {
    simService.setStatus(moduleId, simId, 'error');
    broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status: 'error' });
  });
}

/**
 * Bridge simcomService audio:chunk events to all connected socket clients.
 */
function setupSimcomBridge() {
  simcomService.on('audio:chunk', ({ moduleId, chunk }) => {
    if (ioServer) {
      ioServer.emit(SERVER_EVENTS.AUDIO_CHUNK, { moduleId, chunk });
    }
  });
  // Re-broadcast the full per-module RNDIS driver map on any change.
  simcomService.on('rndis:status', () => broadcastRndisStatus());
}

/**
 * Broadcast the current per-module RNDIS driver status to all clients.
 * Computed fresh from simcomService so moduleIds reflect the post-reconcile
 * mapping. Safe no-op before ioServer is set.
 */
function broadcastRndisStatus() {
  if (!ioServer) return;
  const statuses = simcomService.getRndisStatusByModule();
  console.log(`[NET] broadcast RNDIS_STATUS → ${JSON.stringify(statuses)} (clients=${ioServer.sockets.sockets.size})`);
  ioServer.emit(SERVER_EVENTS.RNDIS_STATUS, { statuses });
}

/**
 * Bridge transcribeService transcripts to all connected clients. Self-
 * disables when whisper.cpp isn't configured — the client then sees no
 * SIM_TRANSCRIPT events and its in-browser Vosk fallback kicks in.
 */
function setupTranscribeBridge() {
  transcribeService.on('transcript', ({ moduleId, simId, text }) => {
    if (ioServer) ioServer.emit(SERVER_EVENTS.SIM_TRANSCRIPT, { moduleId, simId, text });
  });
  transcribeService.on('done', ({ moduleId, simId }) => {
    if (ioServer) ioServer.emit(SERVER_EVENTS.SIM_TRANSCRIPT_DONE, { moduleId, simId });
  });
}

/**
 * Bridge captured console lines from logStream to all connected clients.
 * Listener never logs itself — doing so would recurse through logStream.
 */
function setupLogStreamBridge() {
  logStream.on('log', (entry) => {
    if (ioServer) ioServer.emit(SERVER_EVENTS.SERVER_LOG, entry);
  });
}

/**
 * Bridge serial module-tagged AT lines to socket events.
 * Each module's lines are processed independently, enabling parallel AT ops.
 */
function setupSerialBridge() {
  serialService.on('module_line', ({ moduleId, content }) => {
    const pending = pendingSmsHeaders.get(moduleId);
    if (pending) {
      const { simId, sms } = pending;
      sms.body = simService.decodeUcs2(content.trim());
      simService.addSmsToStore(moduleId, simId, sms);
      simStore.addMessage(moduleId, simId, sms);
      emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_SMS, {
        moduleId,
        simId,
        message: sms,
      });
      pendingSmsHeaders.delete(moduleId);
      return;
    }

    const simId = muxService.getSelectedSim(moduleId);
    if (simId === undefined) return;

    const event = simService.processUnsolicitedLine(content, moduleId, simId);
    if (event) routeSimEvent(event);
  });

  // Bridge call-only URCs from the SIM7600 USB AT port. On LTE+CSFB the
  // paging indication fires on the USB interface (colocated with audio),
  // so without this RING/+CLIP never reach the dashboard while data is
  // active. Restricted to call URCs because SMS URCs (+CMT/+CMTI) also
  // arrive on UART — forwarding both would create duplicates.
  // RING/CLIP dedupe themselves via the call-state store.
  simcomService.on('at:line', ({ moduleId, line }) => {
    if (moduleId == null) return;
    const isCallUrc =
      line.includes('RING') ||
      line.includes('+CLIP:') ||
      line.includes('NO CARRIER');
    if (!isCallUrc) return;
    const simId = muxService.getSelectedSim(moduleId);
    if (simId === undefined) return;
    const event = simService.processUnsolicitedLine(line, moduleId, simId);
    if (event) routeSimEvent(event);
  });

  // Hot-unplug of a USB AT port: if it was the data-active module, the
  // RNDIS adapter is gone and the IP it served is dead. Reset dataState
  // so the UI doesn't keep showing "active" with a phantom IP, and roll
  // back the host networking changes (RNDIS metric demotion + Tailscale
  // exit-node advertisement). We do NOT call forgetUrcsForModule —
  // simcomService keeps the URC arming intent alive so calls keep ringing
  // on USB when the module reconnects.
  simcomService.on('port:closed', ({ moduleId }) => {
    if (dataState.moduleId !== moduleId || dataState.status === 'off') return;
    console.warn(`[DATA] module=${moduleId} disconnected — resetting data state`);
    dataState = { moduleId: null, simId: null, status: 'off', ip: null, publicIp: null };
    broadcastDataState();
    // Demote the gone-away RNDIS but keep the exit-node advertisement on —
    // the remote peer needs to keep egressing through this host's WiFi
    // (or a different SIM if one is later activated).
    restoreRndisAdapters().catch(() => {});
  });
}

/**
 * Per-SIM timer that detects "caller hung up before pickup". The SIM7600
 * doesn't always emit NO CARRIER in that scenario — it just stops sending
 * RING/+CLIP. Each incoming RING (re)arms the timer; if it fires before a
 * NO CARRIER or a successful answer, we synthesise a call:ended ourselves.
 * @type {Map<string, NodeJS.Timeout>}
 */
const incomingCallTimeouts = new Map();

/** ms of silence after the last RING before we declare the caller hung up. */
const INCOMING_CALL_TIMEOUT_MS = 30_000;

/**
 * Arm (or re-arm) the per-SIM "caller hung up" detection timer. Called on
 * the first call:incoming AND on every subsequent call:ringing heartbeat.
 * @param {number} moduleId
 * @param {number} simId
 */
function armIncomingTimeout(moduleId, simId) {
  const key = `${moduleId}:${simId}`;
  const existing = incomingCallTimeouts.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    incomingCallTimeouts.delete(key);
    console.log(`[CALL] module=${moduleId} sim=${simId}: incoming timed out — assuming caller hung up before pickup`);
    simService.resetCallState(moduleId, simId);
    emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_CALL_ENDED, { moduleId, simId });
  }, INCOMING_CALL_TIMEOUT_MS);
  incomingCallTimeouts.set(key, timer);
}

/**
 * Clear the per-SIM incoming-call timer. Called on real NO CARRIER, on
 * successful answer (call goes active), and on shutdown / SELECTIONS_CLEAR.
 * @param {number} moduleId
 * @param {number} simId
 */
function clearIncomingTimeout(moduleId, simId) {
  const key = `${moduleId}:${simId}`;
  const t = incomingCallTimeouts.get(key);
  if (t) {
    clearTimeout(t);
    incomingCallTimeouts.delete(key);
  }
}

/**
 * Route a parsed SIM event to the appropriate socket emission.
 * @param {{ type: string, moduleId: number, simId: number, data: any }} event
 */
function routeSimEvent(event) {
  const { type, moduleId, simId, data } = event;

  switch (type) {
    case 'call:incoming':
      armIncomingTimeout(moduleId, simId);
      emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_CALL_INCOMING, {
        moduleId,
        simId,
        callerNumber: data.callerNumber,
      });
      break;

    case 'call:ringing':
      // Heartbeat — modem repeated RING/CLIP while we were already in
      // 'incoming'. Reset the hang-up-detection timer so it only fires
      // once RINGs actually stop arriving.
      armIncomingTimeout(moduleId, simId);
      break;

    case 'call:ended':
      clearIncomingTimeout(moduleId, simId);
      emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_CALL_ENDED, {
        moduleId,
        simId,
      });
      simcomService.deactivateAudio(moduleId).catch((err) => {
        console.error('[AUDIO] deactivateAudio error:', err.message);
      });
      transcribeService.endCall(moduleId);
      break;

    case 'sms:header':
      pendingSmsHeaders.set(moduleId, { moduleId, simId, sms: data });
      break;

    case 'sms:stored':
      simService.readSms(moduleId, simId, data.index).then((sms) => {
        if (sms) {
          simStore.addMessage(moduleId, simId, sms);
          emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_SMS, { moduleId, simId, message: sms });
        }
      }).catch((err) => console.error(`[SMS] readSms error:`, err.message));
      break;

    case 'status':
      // While the muxService is actively polling registration on this
      // module, the modem cycles through transient CREG states (0 → 2 → 3
      // → 5) and the +CREG: 3 URC briefly turns status into 'error'.
      // Suppressing those during the active select stops the SIM card
      // from flashing red for a state that's about to resolve cleanly —
      // the final outcome is propagated by executeSimSelect's own
      // socket.emit at the end of switch:registered.
      if (moduleSelectRunning.get(moduleId)) break;
      broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status: data.status });
      break;

    case 'phone:number': {
      simStore.setSimInfo(moduleId, simId, { phoneNumber: data.phoneNumber });
      broadcastSimEvent(SERVER_EVENTS.SIM_NUMBER, { moduleId, simId, phoneNumber: data.phoneNumber });
      break;
    }
  }
}

/**
 * Emit an event only to clients who have the given SIM selected.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} eventName
 * @param {object} payload
 */
function emitToSelectedClients(moduleId, simId, eventName, payload) {
  if (!ioServer) return;
  for (const [socketId, selections] of clientSelections) {
    if (selections.get(moduleId) === simId) {
      const socket = ioServer.sockets.sockets.get(socketId);
      if (socket) socket.emit(eventName, payload);
    }
  }
}

/**
 * Broadcast a SIM-scoped event to ALL connected clients. Use for stateful
 * per-SIM info (status, signal, network type, phone number) that any tab
 * should see updated regardless of which SIM they have "selected" — the
 * client-side useSimData hook already filters by moduleId+simId, so this
 * only widens reach, never confuses receivers.
 * Reserve `emitToSelectedClients` for genuinely private per-socket events.
 * @param {string} eventName
 * @param {object} payload
 */
function broadcastSimEvent(eventName, payload) {
  if (!ioServer) return;
  ioServer.emit(eventName, payload);
}

/**
 * Handle sim:select event from a client.
 * Implements "latest wins" per module: if a selection is already running for
 * this module, the new request replaces any previously queued pending select.
 * Only two executions ever occur per burst of clicks — the one already running
 * and the very last click.
 * @param {import('socket.io').Socket} socket
 * @param {{ moduleId: number, simId: number }} payload
 */
async function handleSimSelect(socket, { moduleId, simId }) {
  // If a deselect is currently tearing down this module (CHUP + CFUN=0,
  // ~2.5s), wait for it to finish before starting the new select.
  // Otherwise the two race on muxService's cache and `simService`'s store,
  // and the user ends up with a visually-selected SIM whose radio is off
  // and whose status is stuck at 'unknown'.
  const inflightDeselect = moduleDeselectInflight.get(moduleId);
  if (inflightDeselect) {
    await inflightDeselect.catch(() => {});
  }

  if (moduleSelectRunning.get(moduleId)) {
    const queue = modulePendingSelect.get(moduleId) || [];
    // Skip if this simId is already queued
    if (!queue.some((p) => p.simId === simId)) {
      queue.push({ socket, moduleId, simId });
      modulePendingSelect.set(moduleId, queue);
    }
    broadcastQueue(moduleId);
    return;
  }
  executeSimSelect(socket, moduleId, simId);
}

/**
 * Broadcast the current queue state for a module to all clients.
 * @param {number} moduleId
 */
function broadcastQueue(moduleId) {
  if (!ioServer) return;
  const activating = moduleSelectRunning.get(moduleId) ? (moduleActiveSim.get(moduleId) ?? null) : null;
  const queue = modulePendingSelect.get(moduleId) || [];
  ioServer.emit(SERVER_EVENTS.SIM_QUEUE, {
    moduleId,
    activating,
    queued: queue.map((p) => p.simId),
  });
}

/**
 * Execute a SIM selection: switch MUX, query registration, emit result.
 * On completion, runs the pending select (if any) for this module.
 * @param {import('socket.io').Socket} socket
 * @param {number} moduleId
 * @param {number} simId
 */
async function executeSimSelect(socket, moduleId, simId) {
  // Emit helper: to a single socket for a user-initiated select, or to all
  // clients when triggered without a socket (resyncSelections after an
  // Arduino reconnect). useSimData filters by moduleId+simId either way.
  const emit = (event, payload) => {
    if (socket) socket.emit(event, payload);
    else broadcastSimEvent(event, payload);
  };

  // Fast path: this SIM is ALREADY the MUX-active one (typical after a
  // page refresh — the user re-clicks the card to "find" it, but the
  // modem is already on the right line). Don't run the heavy MUX flow
  // and don't wipe cached state — just register this socket as a
  // selecter and re-emit the current status/operator/phone/signal to
  // it. Without this the old code path called clearSimData (which wiped
  // statusStore) and then short-circuited inside muxService, returning
  // 'unknown' to the UI even though the SIM was perfectly registered.
  if (muxService.getSelectedSim(moduleId) === simId) {
    const selections = socket ? clientSelections.get(socket.id) : null;
    if (selections) selections.set(moduleId, simId);
    lastSelectedSim.set(moduleId, simId);
    const status = simService.getStatus(moduleId, simId);
    const operator = simService.getOperator(moduleId, simId);
    const phoneNumber = simService.getPhoneNumber(moduleId, simId);
    emit(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status, operator });
    if (phoneNumber) {
      emit(SERVER_EVENTS.SIM_NUMBER, { moduleId, simId, phoneNumber });
    }
    const rssi = simService.getCachedSignal(moduleId, simId);
    if (rssi !== 99) emit(SERVER_EVENTS.SIM_SIGNAL, { moduleId, simId, rssi });
    const networkType = simService.getCachedNetworkType(moduleId, simId);
    if (networkType) emit(SERVER_EVENTS.SIM_NETWORK_TYPE, { moduleId, simId, networkType });
    return;
  }

  // If the data SIM lives on this module and we're switching away from it,
  // the physical MUX path is about to break — stop the RmNet call and reset
  // state before the switch so the UI reflects reality.
  if (dataState.moduleId === moduleId && dataState.simId !== simId && dataState.status !== 'off') {
    dataState = { moduleId: null, simId: null, status: 'off', ip: null, publicIp: null };
    broadcastDataState();
    simcomService.stopDataSession(moduleId).catch((err) =>
      console.warn(`[DATA] stopDataSession on MUX switch: ${err.message}`)
    );
    restoreRndisAdapters().catch(() => {});
  }
  moduleSelectRunning.set(moduleId, true);
  moduleActiveSim.set(moduleId, simId);
  broadcastQueue(moduleId);
  try {
    const selections = socket ? clientSelections.get(socket.id) : null;
    if (selections) {
      selections.set(moduleId, simId);
    }
    // Clear in-memory data so post-registration queries always re-run
    // (physical SIM may have been swapped). Persistent store + client
    // keep showing old data until fresh data overwrites it.
    simService.clearSimData(moduleId, simId);
    const status = await simService.switchSim(moduleId, simId);
    // Remember this as the module's desired SIM so resyncSelections can
    // re-apply it after an Arduino reconnect resets the MUX hardware.
    lastSelectedSim.set(moduleId, simId);
    const operator = simService.getOperator(moduleId, simId);
    const phoneNumber = simService.getPhoneNumber(moduleId, simId);
    if (operator) simStore.setSimInfo(moduleId, simId, { operator });
    emit(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status, operator });
    if (phoneNumber) {
      simStore.setSimInfo(moduleId, simId, { phoneNumber });
      emit(SERVER_EVENTS.SIM_NUMBER, { moduleId, simId, phoneNumber });
    }
    if (status === 'registered' || status === 'roaming') {
      // Run all post-registration queries in parallel, await all before
      // releasing the module queue to the next pending select.
      const tasks = [];

      // SMS — always emit the list, even when empty. Without this, switching
      // to a SIM with zero SMS leaves the previous SIM's messages visible on
      // the client (the React state has nothing to clear it with).
      tasks.push(
        simService.getSms(moduleId, simId)
          .then((messages) => {
            simStore.setMessages(moduleId, simId, messages);
            broadcastSimEvent(SERVER_EVENTS.SIM_SMS_LIST, { moduleId, simId, messages });
          })
          .catch((err) => console.error(`[SOCKET] getSms error for ${moduleId}:${simId}:`, err.message))
      );

      // Signal
      tasks.push(
        simService.getSignal(moduleId, simId)
          .then((rssi) => {
            broadcastSimEvent(SERVER_EVENTS.SIM_SIGNAL, { moduleId, simId, rssi });
          })
          .catch((err) => console.error(`[SOCKET] signal error for ${moduleId}:${simId}:`, err.message))
      );

      // Phone number via USSD — only if not already known
      if (!phoneNumber && operator) {
        const ussdCode = getUssdCode(operator);
        if (ussdCode) {
          tasks.push(
            simService.queryPhoneNumber(moduleId, simId, ussdCode)
              .then((number) => {
                if (number) {
                  simStore.setSimInfo(moduleId, simId, { phoneNumber: number });
                  broadcastSimEvent(SERVER_EVENTS.SIM_NUMBER, { moduleId, simId, phoneNumber: number });
                }
              })
              .catch((err) => console.error(`[SOCKET] USSD error for ${moduleId}:${simId}:`, err.message))
          );
        }
      }

      await Promise.all(tasks);
    }
  } catch (err) {
    // Classify the failure so the card shows a meaningful state:
    //  - no_sim    : slot empty / card absent (CPIN not inserted)
    //  - sim_error : card present but the modem can't talk to it (CPIN: SIM
    //                failure) → bad contact in this slot
    //  - error     : everything else (e.g. registration timeout / network)
    const msg = err.message || '';
    let status = 'error';
    if (/not inserted|SIM_NOT_INSERTED|sim absent/i.test(msg)) status = 'no_sim';
    else if (/SIM_FAILURE|sim failure/i.test(msg)) status = 'sim_error';
    emit(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status, error: msg });
  } finally {
    moduleSelectRunning.set(moduleId, false);
    moduleActiveSim.delete(moduleId);
    const queue = modulePendingSelect.get(moduleId);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) modulePendingSelect.delete(moduleId);
      setImmediate(() => executeSimSelect(next.socket, next.moduleId, next.simId));
    } else {
      broadcastQueue(moduleId);
    }
  }
}

/**
 * Handle sim:answer event from a client.
 * @param {import('socket.io').Socket} socket
 * @param {{ moduleId: number, simId: number }} payload
 */
async function handleSimAnswer(socket, { moduleId, simId }) {
  try {
    const success = await simService.answerCall(moduleId, simId);
    if (success) {
      // Call now active — stop watching for "caller hung up before pickup".
      clearIncomingTimeout(moduleId, simId);
      emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_CALL_ACTIVE, {
        moduleId,
        simId,
        startTime: Date.now(),
      });
      simcomService.activateAudio(moduleId).catch((err) => {
        console.error('[AUDIO] activateAudio error:', err.message);
      });
      transcribeService.startCall(moduleId, simId);
    } else {
      // ATA failed — most likely the caller hung up between the click and
      // the modem processing the answer. Tell the UI the call is over so
      // the "in call" icon goes back to idle and the user can move on.
      console.log(`[CALL] module=${moduleId} sim=${simId}: answer failed (no call to answer?), forcing call:ended`);
      clearIncomingTimeout(moduleId, simId);
      simService.resetCallState(moduleId, simId);
      emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_CALL_ENDED, { moduleId, simId });
    }
  } catch (err) {
    socket.emit(SERVER_EVENTS.SIM_STATUS, {
      moduleId,
      simId,
      status: 'error',
      error: err.message,
    });
  }
}

/**
 * Handle sim:deselect event — user clicked the already-selected SIM to
 * release it. We tear down anything live on it (data session, ongoing
 * call), then power the radio down with CFUN=0. The MUX itself stays on
 * the same channel — the next sim:select will MUX-switch as usual.
 * @param {import('socket.io').Socket} socket
 * @param {number} moduleId
 * @param {number} simId
 */
async function handleSimDeselect(socket, moduleId, simId) {
  // Refuse to deselect a SIM that's not the one currently MUX-active —
  // we'd otherwise CFUN=0 a different SIM than the user thought they
  // were releasing.
  const currentSim = muxService.getSelectedSim(moduleId);
  if (currentSim !== simId) {
    console.warn(`[SIM] deselect refused: module=${moduleId} sim=${simId} not MUX-active (currentSim=${currentSim})`);
    return;
  }
  if (moduleSelectRunning.get(moduleId)) {
    console.warn(`[SIM] deselect refused: module=${moduleId} a select is in flight`);
    return;
  }

  // Publish an in-flight promise so a racing sim:select on the same
  // module awaits this deselect instead of running in parallel and
  // racing on muxService cache state. We resolve in finally to make
  // sure the lock releases even on throw.
  let resolveInflight;
  const inflight = new Promise((resolve) => { resolveInflight = resolve; });
  moduleDeselectInflight.set(moduleId, inflight);

  try {

  console.log(`[SIM] deselect → module=${moduleId} sim=${simId}`);

  // Drop the server-side UI mirror so emitToSelectedClients stops routing
  // SIM events for this module to this socket — the user dropped it on
  // their end, the server's view should match. Without this, this socket
  // keeps receiving stale SIM_SIGNAL / SIM_STATUS / SIM_NUMBER updates
  // until disconnect.
  clientSelections.get(socket.id)?.delete(moduleId);

  // 1. Tear down a data session if this SIM is currently the data SIM.
  if (dataState.moduleId === moduleId && dataState.simId === simId && dataState.status !== 'off') {
    dataState = { moduleId: null, simId: null, status: 'off', ip: null, publicIp: null };
    broadcastDataState();
    try {
      await simcomService.stopDataSession(moduleId);
    } catch (err) {
      console.warn(`[SIM] deselect stopDataSession: ${err.message}`);
    }
    simcomService.forgetUrcsForModule(moduleId);
    restoreRndisAdapters().catch(() => {});
  }

  // 2. Cancel an incoming/active call if any. Best-effort: CHUP is harmless
  // even when there's no call.
  clearIncomingTimeout(moduleId, simId);
  try {
    await simService.hangupCall(moduleId, simId);
  } catch (err) {
    console.warn(`[SIM] deselect hangup: ${err.message}`);
  }
  emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_CALL_ENDED, { moduleId, simId });

  // 3. Power the radio down. powerOffRadio routes through the per-module
  // selectAndRun queue, so it can't race a concurrent sim:select that
  // would otherwise be mid-MUX-switch when CFUN=0 lands.
  try {
    await simService.powerOffRadio(moduleId, simId);
  } catch (err) {
    console.warn(`[SIM] deselect CFUN=0 failed: ${err.message}`);
  }

  // 4. Reset cached state so the UI doesn't keep showing roaming/operator/signal
  // for a SIM whose radio is off.
  simService.clearSimData(moduleId, simId);
  simService.resetCallState(moduleId, simId);
  // Drop the MUX selection cache. The radio is now off (CFUN=0). If we
  // leave the cache pointing at this SIM, a re-select short-circuits in
  // _doSelectSim (and in our executeSimSelect fast path) and never sends
  // CFUN=1 → the radio stays off forever and the dashboard sticks at
  // "Unknown". Clearing forces the full select sequence to re-run.
  muxService.clearSelected(moduleId);
  // Forget the desired SIM so a later Arduino reconnect doesn't resurrect a
  // SIM the user explicitly released.
  lastSelectedSim.delete(moduleId);
  broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status: 'unknown' });
  // Empty networkType clears the chip on the client (in sync with the
  // disappearance of the signal bars when status flips to unknown).
  ioServer && ioServer.emit(SERVER_EVENTS.SIM_NETWORK_TYPE, {
    moduleId, simId, networkType: '',
  });

  } finally {
    moduleDeselectInflight.delete(moduleId);
    resolveInflight();
  }
}

/**
 * Handle sim:hangup event from a client.
 * @param {import('socket.io').Socket} socket
 * @param {{ moduleId: number, simId: number }} payload
 */
async function handleSimHangup(socket, { moduleId, simId }) {
  try {
    const success = await simService.hangupCall(moduleId, simId);
    if (success) {
      emitToSelectedClients(moduleId, simId, SERVER_EVENTS.SIM_CALL_ENDED, {
        moduleId,
        simId,
      });
      simcomService.deactivateAudio(moduleId).catch((err) => {
        console.error('[AUDIO] deactivateAudio error:', err.message);
      });
      transcribeService.endCall(moduleId);
    }
  } catch (err) {
    socket.emit(SERVER_EVENTS.SIM_STATUS, {
      moduleId,
      simId,
      status: 'error',
      error: err.message,
    });
  }
}

/**
 * Handle sim:dtmf event from a client.
 * @param {import('socket.io').Socket} socket
 * @param {{ moduleId: number, simId: number, digit: string }} payload
 */
async function handleSimDtmf(socket, { moduleId, simId, digit }) {
  try {
    await simService.sendDtmf(moduleId, simId, digit);
  } catch (err) {
    socket.emit(SERVER_EVENTS.SIM_STATUS, {
      moduleId,
      simId,
      status: 'error',
      error: err.message,
    });
  }
}

/**
 * Handle sim:request-number — send USSD code, emit result if found synchronously.
 * The unsolicited path in processUnsolicitedLine handles the async case.
 * @param {import('socket.io').Socket} socket
 * @param {{ moduleId: number, simId: number, ussdCode: string }} payload
 */
async function handleSimRequestNumber(_socket, { moduleId, simId, ussdCode }) {
  try {
    const phoneNumber = await simService.queryPhoneNumber(moduleId, simId, ussdCode);
    if (phoneNumber) {
      simStore.setSimInfo(moduleId, simId, { phoneNumber });
      broadcastSimEvent(SERVER_EVENTS.SIM_NUMBER, { moduleId, simId, phoneNumber });
    }
  } catch (err) {
    console.error(`[SOCKET] sim:request-number error for ${moduleId}:${simId}:`, err.message);
  }
}

/**
 * Handle data:select — toggle the global data SIM.
 * Exclusive: selecting a new pair overrides any previous one. Selecting the
 * same pair turns it off. This is a UI-only stub until RNDIS is wired.
 * @param {number} moduleId
 * @param {number} simId
 */
async function handleDataSelect(moduleId, simId) {
  console.log(`[DATA] request: module=${moduleId} sim=${simId} (current: ${JSON.stringify(dataState)})`);
  const isSame = dataState.moduleId === moduleId && dataState.simId === simId;

  // Toggle off when clicking the already-active data SIM.
  if (isSame && dataState.status !== 'off') {
    const prev = { moduleId: dataState.moduleId, simId: dataState.simId };
    dataState = { moduleId: null, simId: null, status: 'off', ip: null, publicIp: null };
    broadcastDataState();
    try {
      await simcomService.stopDataSession(prev.moduleId);
      console.log(`[DATA] toggled off (module=${prev.moduleId} sim=${prev.simId})`);
    } catch (err) {
      console.warn(`[DATA] stopDataSession error: ${err.message}`);
    }
    // User-initiated off: forget the URC arming intent so we don't re-arm
    // on subsequent hot-plugs. (Disconnect-induced off does NOT call this —
    // we want URCs to come back automatically when the module reconnects.)
    simcomService.forgetUrcsForModule(prev.moduleId);
    restoreRndisAdapters().catch(() => {});
    return;
  }

  // If switching from another active data SIM, tear it down first.
  const hadPrev = dataState.moduleId !== null && dataState.status !== 'off';
  const prevModule = hadPrev ? dataState.moduleId : null;

  // Server-side guards — mirror the UI gate. Client-side orchestration via
  // pendingDataRequests is responsible for chaining SIM_SELECT → wait for
  // 'registered' → DATA_SELECT, so by the time we get here both should be
  // true. Refuse otherwise rather than racing a SIM select on the server.
  const currentSim = muxService.getSelectedSim(moduleId);
  if (currentSim !== simId || moduleSelectRunning.get(moduleId)) {
    console.warn(`[DATA] refused: module=${moduleId} sim=${simId} not currently active on MUX (currentSim=${currentSim}, running=${!!moduleSelectRunning.get(moduleId)})`);
    return;
  }
  const simStatus = simService.getStatus(moduleId, simId);
  if (simStatus !== 'registered' && simStatus !== 'roaming') {
    console.warn(`[DATA] refused: module=${moduleId} sim=${simId} not registered (status=${simStatus})`);
    return;
  }

  dataState = { moduleId, simId, status: 'connecting', ip: null, publicIp: null };
  console.log(`[DATA] connecting → module=${moduleId} sim=${simId}`);
  broadcastDataState();

  if (hadPrev && prevModule !== moduleId) {
    try {
      await simcomService.stopDataSession(prevModule);
    } catch (err) {
      console.warn(`[DATA] stopDataSession on previous module=${prevModule}: ${err.message}`);
    }
  }

  try {
    const operator = simService.getOperator(moduleId, simId) || '';
    const config = getOperatorConfig(operator);
    console.log(`[DATA] module=${moduleId} operator="${operator}" apn="${config.apn}" auth=${config.authUser ? `${config.authUser}/type=${config.authType}` : 'none'} cnmp=${config.cnmp}`);
    const { ip, publicIp } = await simcomService.startDataSession(moduleId, config);

    // Verify the request wasn't cancelled/overridden while we were connecting.
    if (dataState.moduleId !== moduleId || dataState.simId !== simId || dataState.status !== 'connecting') {
      console.log(`[DATA] session up but state changed — tearing down`);
      await simcomService.stopDataSession(moduleId).catch(() => {});
      return;
    }
    dataState = { moduleId, simId, status: 'active', ip, publicIp: publicIp || null };
    console.log(`[DATA] active → module=${moduleId} sim=${simId} ip=${ip || 'unknown'}`);
    broadcastDataState();
    // RNDIS prioritization (and inactive-RNDIS disable) is now done inside
    // startDataSession before the connectivity probe — that's required for
    // the probe's source-bound TCP connect to reach the right interface.
  } catch (err) {
    console.error(`[DATA] failed: ${err.message}`);
    dataState = { moduleId, simId, status: 'error', ip: null, publicIp: null };
    broadcastDataState();
    // Best-effort cleanup
    await simcomService.stopDataSession(moduleId).catch(() => {});
    restoreRndisAdapters().catch(() => {});
    // Drop back to off after a short delay so the user sees the error.
    setTimeout(() => {
      if (dataState.moduleId === moduleId && dataState.simId === simId && dataState.status === 'error') {
        dataState = { moduleId: null, simId: null, status: 'off', ip: null, publicIp: null };
        broadcastDataState();
      }
    }, 3000);
  }
}

/**
 * Poll signal quality (AT+CSQ) for all selected SIMs every 10s.
 * Each module is queried in parallel via its own selectAndRun queue,
 * so modules don't block each other and the poll waits its turn behind
 * any in-flight operation on the same module.
 * @param {() => object | null} getTopology
 */
function startSignalPolling(getTopology) {
  setInterval(() => {
    const status = _getSerialStatus && _getSerialStatus();
    if (!status || status.status !== 'ready') return;
    if (!ioServer || ioServer.sockets.sockets.size === 0) return;

    const topology = getTopology();
    if (!topology || !topology.modules) return;

    for (const mod of topology.modules) {
      const simId = muxService.getSelectedSim(mod.id);
      if (simId === undefined) continue;
      const simStatus = simService.getStatus(mod.id, simId);
      if (simStatus !== 'registered' && simStatus !== 'roaming') continue;

      simService.getSignal(mod.id, simId)
        .then((rssi) => {
          broadcastSimEvent(SERVER_EVENTS.SIM_SIGNAL, { moduleId: mod.id, simId, rssi });
        })
        .catch((err) => {
          console.error(`[SIGNAL] poll error for ${mod.id}:${simId}:`, err.message);
        });

      // Serving RAT (LTE/WCDMA/GSM) alongside signal. Cheap AT call (CPSI),
      // changes rarely so the 10s cadence is plenty. Only emit if the value
      // actually changed since last poll — avoids redundant socket traffic.
      const prevRat = simService.getCachedNetworkType(mod.id, simId);
      simService.getNetworkType(mod.id, simId)
        .then((rat) => {
          if (rat !== prevRat) {
            broadcastSimEvent(SERVER_EVENTS.SIM_NETWORK_TYPE, { moduleId: mod.id, simId, networkType: rat });
          }
          // Registration-loss detection. CPSI reporting NO SERVICE on a SIM
          // we still think is registered means the radio is camped on no
          // cell — physical SIM pulled, out of coverage, or signal lost. The
          // +CREG=0 URC that would normally signal this is deliberately
          // suppressed by processUnsolicitedLine (it refuses to let a single
          // 'unknown' overwrite a confirmed 'registered', to avoid flicker),
          // so without this the card stays a stale green "Registered" forever.
          // Flip to 'unknown' → the client shows "No network", and the 30s
          // no-service retry / manual Reconnect button take over recovery.
          if (rat === 'NO SERVICE') {
            const cur = simService.getStatus(mod.id, simId);
            if (cur === 'registered' || cur === 'roaming') {
              console.log(`[NO-SERVICE] module=${mod.id} sim=${simId}: CPSI NO SERVICE while ${cur} — flipping to unknown`);
              simService.setStatus(mod.id, simId, 'unknown');
              broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, {
                moduleId: mod.id, simId, status: 'unknown',
                operator: simService.getOperator(mod.id, simId),
              });
            }
          }
        })
        .catch((err) => {
          console.error(`[NET-TYPE] poll error for ${mod.id}:${simId}:`, err.message);
        });
    }
  }, 10000);
}

/**
 * Per-module last time we issued an AT+COPS=0 nudge to recover from a
 * "lost service" episode. Used by startNoServiceRetry to back off so we
 * don't hammer the modem when the area genuinely has no coverage.
 * @type {Map<number, number>}
 */
const lastNoServiceNudge = new Map();

/**
 * Lightweight reconnection nudge: every 30 seconds, scan the MUX-selected
 * SIM of each module. If it's in 'unknown' or 'error' state AND we have
 * a cached operator (proves it WAS registered before — distinguishes "just
 * lost coverage" from "never selected"), issue `AT+COPS=0` to force the
 * modem to redo automatic operator selection. This re-tries the attach
 * without going through the full CFUN=0 → MUX → CFUN=1 → poll dance.
 *
 * Throttled to one nudge per module per 60s — if the area genuinely has
 * no coverage, the modem already retries continuously on its own; our
 * nudge just hurries it along after a transient drop.
 * @param {() => object | null} getTopology
 */
function startNoServiceRetry(getTopology) {
  setInterval(() => {
    const status = _getSerialStatus && _getSerialStatus();
    if (!status || status.status !== 'ready') return;

    const topology = getTopology();
    if (!topology || !topology.modules) return;

    const now = Date.now();
    for (const mod of topology.modules) {
      const simId = muxService.getSelectedSim(mod.id);
      if (simId === undefined) continue;
      if (moduleSelectRunning.get(mod.id)) continue; // don't fight an in-flight select
      const simStatus = simService.getStatus(mod.id, simId);
      if (simStatus !== 'unknown' && simStatus !== 'error') continue;
      // Was the SIM previously registered? Operator only sticks after a
      // successful registration; absence here means the SIM was never
      // attached, and a COPS nudge wouldn't help.
      const operator = simService.getOperator(mod.id, simId);
      if (!operator) continue;
      const last = lastNoServiceNudge.get(mod.id) || 0;
      if (now - last < 60000) continue;

      lastNoServiceNudge.set(mod.id, now);
      console.log(`[NO-SERVICE] module=${mod.id} sim=${simId}: nudging AT+COPS=0 (last operator=${operator})`);
      // Fire-and-forget. The modem replies asynchronously via +CREG URC,
      // which the existing serial bridge already turns into a status
      // update — we don't care about the AT response here.
      sendATAndCollect(mod.id, 'AT+COPS=0\r\n').catch((err) =>
        console.warn(`[NO-SERVICE] module=${mod.id}: COPS=0 failed: ${err.message}`)
      );
    }
  }, 30000);
}

/**
 * Manual "reconnect" triggered by the user on a No-network card. Forces the
 * modem to redo automatic operator selection (AT+COPS=0) immediately, instead
 * of waiting for the 30s auto-retry tick. Gives instant feedback by flipping
 * the card to 'searching' while the modem re-scans, then re-reads CREG.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<void>}
 */
async function handleSimReconnect(moduleId, simId) {
  if (muxService.getSelectedSim(moduleId) !== simId) {
    console.warn(`[RECONNECT] refused: module=${moduleId} sim=${simId} not MUX-active`);
    return;
  }
  if (moduleSelectRunning.get(moduleId)) {
    console.warn(`[RECONNECT] refused: module=${moduleId} a select is in flight`);
    return;
  }
  console.log(`[RECONNECT] module=${moduleId} sim=${simId}: manual AT+COPS=0`);
  // Reset the auto-retry throttle so it doesn't immediately fire on top of us.
  lastNoServiceNudge.set(moduleId, Date.now());
  // Immediate UI feedback — the operator re-scan takes a few seconds.
  broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, { moduleId, simId, status: 'searching' });
  try {
    await sendATAndCollect(moduleId, 'AT+COPS=0\r\n', 20000);
  } catch (err) {
    console.warn(`[RECONNECT] module=${moduleId}: COPS=0 failed: ${err.message}`);
  }
  // Re-read registration so the card resolves to its real state even if no
  // +CREG URC fired during the scan.
  try {
    const status = await simService.checkRegistration(moduleId, simId);
    broadcastSimEvent(SERVER_EVENTS.SIM_STATUS, {
      moduleId, simId, status, operator: simService.getOperator(moduleId, simId),
    });
  } catch (err) {
    console.warn(`[RECONNECT] module=${moduleId}: CREG re-check failed: ${err.message}`);
  }
}

/**
 * Broadcast a topology update to all connected clients.
 * @param {object} topology
 */
function broadcastTopology(topology) {
  if (ioServer) {
    ioServer.emit(SERVER_EVENTS.TOPOLOGY_UPDATE, topology);
  }
}

/**
 * Broadcast a serial connection status change to all connected clients.
 * @param {{ path: string, label: string, connected: boolean }} status
 */
function broadcastSerialStatus(status) {
  if (ioServer) {
    ioServer.emit(SERVER_EVENTS.SERIAL_STATUS, status);
  }
}

/**
 * Re-apply the desired SIM selection for each module after an Arduino
 * reconnect. The Arduino resets the MUX to SIM 0 on re-enumeration and
 * muxService clears its cache on 'open', so without this the modem sits on
 * the wrong SIM while the UI still shows the old one as registered — and all
 * SMS/call URCs are silently dropped (getSelectedSim returns undefined or the
 * wrong SIM). Called by index.js once topology is reconciled after reconnect.
 *
 * No-op on cold start (lastSelectedSim is empty until the user selects). Each
 * entry whose MUX is already correct is skipped, so repeated topology events
 * (the Arduino retries) don't re-trigger selects once they've completed.
 * @returns {Promise<void>}
 */
async function resyncSelections() {
  for (const [moduleId, simId] of lastSelectedSim) {
    if (muxService.getSelectedSim(moduleId) === simId) continue; // already correct
    if (moduleSelectRunning.get(moduleId)) continue;             // a select is already running
    console.log(`[SIM] resync after reconnect → module=${moduleId} sim=${simId}`);
    // Route through handleSimSelect (null socket = broadcast) so it respects
    // the per-module queue and in-flight-deselect guard.
    await handleSimSelect(null, { moduleId, simId }).catch((err) =>
      console.warn(`[SIM] resync module=${moduleId}: ${err.message}`)
    );
  }
}

module.exports = { initSocketHandler, broadcastTopology, broadcastSerialStatus, gracefulShutdown, resyncSelections, broadcastRndisStatus };
