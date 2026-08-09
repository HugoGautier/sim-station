/**
 * @fileoverview Server entry point.
 * Wires together Express, socket.io, and the serial connection to Arduino.
 */

// Must load before any module that logs so startup lines reach the buffer.
require('./services/logStream');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const { CONFIG } = require('./constants/config');
const { serialService } = require('./services/serialService');
const { detectArduinoPort, detectSimcomPorts } = require('./services/portDetector');
const { simcomService } = require('./services/simcomService');
const { router } = require('./api/routes');
const { initSocketHandler, broadcastTopology, broadcastSerialStatus, gracefulShutdown, resyncSelections, broadcastRndisStatus } = require('./socket/socketHandler');
const { authMiddleware, socketAuthMiddleware } = require('./auth');
const simStore = require('./services/simStore');
const { restoreRndisAdapters } = require('./services/windowsNetRoutes');
const { enableExitNode } = require('./services/tailscaleExit');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CONFIG.CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

/**
 * Current topology received from Arduino.
 * @type {{ modules: Array<{ id: number, simCount: number }> } | null}
 */
let currentTopology = null;

/**
 * Current serial connection status.
 * Initialized to disconnected; updated on every open/close event.
 * @type {{ path: string, label: string, connected: boolean }}
 */
let currentSerialStatus = { path: '', label: '', connected: false, status: 'disconnected' };

/**
 * Timer handle for the reconnection polling loop, or null when inactive.
 * @type {NodeJS.Timeout | null}
 */
let reconnectTimer = null;


app.use(cors({ origin: CONFIG.CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Required for SharedArrayBuffer (vosk-browser client-side speech recognition)
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(authMiddleware);

/**
 * Make topology and serial status available to route handlers.
 */
app.set('topology', null);
app.set('serialStatus', currentSerialStatus);

app.use(router);

/**
 * Serve Vosk model files for the client-side speech-recognition fallback.
 */
const modelsDir = path.join(__dirname, '..', 'models');
app.use('/models', express.static(modelsDir));

/**
 * Serve static client build in production.
 */
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    next();
    return;
  }
  res.sendFile(path.join(clientDist, 'index.html'));
});

/**
 * Initialize the socket handler with topology and serial status getters.
 */
io.use(socketAuthMiddleware);
initSocketHandler(io, () => currentTopology, () => currentSerialStatus);

/**
 * Update serial status, persist to app state, and broadcast to all clients.
 * @param {{ path?: string, label?: string, connected?: boolean }} patch
 */
function updateSerialStatus(patch) {
  currentSerialStatus = { ...currentSerialStatus, ...patch };
  app.set('serialStatus', currentSerialStatus);
  broadcastSerialStatus(currentSerialStatus);
}

/**
 * Stop the active reconnection loop, if any.
 */
function stopReconnect() {
  if (reconnectTimer !== null) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Start polling for an Arduino after the port is lost.
 * Stops automatically once a connection is re-established.
 */
function scheduleReconnect() {
  stopReconnect();
  console.log(`Serial port lost — retrying every ${CONFIG.SERIAL_RECONNECT_INTERVAL_MS}ms...`);

  reconnectTimer = setInterval(async () => {
    try {
      const resolved = await resolveSerialPort();
      if (!resolved) return;

      stopReconnect();
      // Persist path and label before opening so the 'open' event's
      // updateSerialStatus({ connected: true }) merges onto correct values,
      // even if the Arduino reconnected on a different port number.
      updateSerialStatus({ path: resolved.path, label: resolved.label, connected: false });
      await serialService.open(resolved.path);
      // open event handler will call updateSerialStatus({ connected: true })
    } catch {
      // keep retrying silently — the open event handles success logging
    }
  }, CONFIG.SERIAL_RECONNECT_INTERVAL_MS);
}

/**
 * Handle topology received from Arduino.
 */
serialService.on('topology', async (topology) => {
  currentTopology = topology;
  app.set('topology', topology);
  const summary = (topology.modules || []).map((m) => `${m.id}:${m.simCount}sims`).join(' ');
  console.log(`Topology: ${(topology.modules || []).length} module(s) — ${summary}`);
  broadcastTopology(topology);
  simStore.ensureFromTopology(topology);
  // Match Arduino moduleIds with the right USB COM ports by IMEI. Must run
  // before any AT-via-USB call so it hits the correct modem.
  // simcomService stores the expected list internally and (re)starts its
  // own USB scan loop if any module is missing.
  const moduleIds = (topology.modules || []).map((m) => m.id);
  await simcomService.reconcileModuleIds(moduleIds);
  updateSerialStatus({ status: 'ready' });
  // Re-broadcast RNDIS driver status now that moduleId↔atPort is reconciled,
  // so the dashboard maps any 'missing' driver to the correct module.
  broadcastRndisStatus();
  // Re-apply the previously-selected SIM per module. No-op on cold start;
  // on an Arduino reconnect (USB glitch) this re-runs the full select so the
  // MUX lands on the right SIM and SMS/call URCs are routed again. Fire-and-
  // forget — the selects run through the per-module queue.
  resyncSelections().catch((err) => console.warn(`[SIM] resync failed: ${err.message}`));
});

serialService.on('error', (err) => {
  console.error('Serial error:', err.message);
});

serialService.on('open', () => {
  console.log(`Serial port ${serialService.getPortPath()} opened at ${CONFIG.BAUD_RATE} baud`);
  updateSerialStatus({ connected: true, status: 'initializing' });
});

serialService.on('close', () => {
  console.log('Serial port closed');
  updateSerialStatus({ connected: false, status: 'disconnected' });
  scheduleReconnect();
});

/**
 * @typedef {{ path: string, label: string }} ResolvedPort
 */

/**
 * Detect the first Arduino-compatible serial port.
 * @returns {Promise<ResolvedPort | null>}
 */
async function resolveSerialPort() {
  console.log('Scanning for Arduino...');
  const detected = await detectArduinoPort();

  if (detected) {
    console.log(`Detected: ${detected.label} on ${detected.path}`);
    return { path: detected.path, label: detected.label };
  }

  console.log('No Arduino found on any port.');
  return null;
}

/**
 * Start the server: detect serial port, open connection, then listen on HTTP.
 */
async function start() {
  simcomService.setScanInterval(CONFIG.SERIAL_RECONNECT_INTERVAL_MS);

  let { atPorts, audioPorts } = await detectSimcomPorts();
  await simcomService.initSimcomPorts(atPorts, audioPorts);

  // Advertise as Tailscale exit-node for the lifetime of the server. The
  // remote PC has no internet of its own, it always wants to egress through
  // this host — over WiFi when no SIM data is active, automatically over
  // 4G once a SIM data session has been verified end-to-end and promoted
  // to the host's default route (see promoteRndisAdapter in startDataSession).
  //
  // Plain enable, NO off→on cycle. Cycling pushes a brief "node no longer
  // advertises exit-node" netmap to peers — modern Tailscale's policy on
  // that is to BLOCK rather than fallback, so during the 1.5s window the
  // remote PC saw "cannot reach exit node, connection blocked" and stayed
  // stuck until its next coord-server poll (sometimes 30-60s later). The
  // hypothetical "stale netmap" case the cycle was protecting against is
  // rare; the cycle's collateral was hitting us every boot.
  enableExitNode().catch(() => {});

  // Check USB PID mode — switch to 9011 (audio) if needed
  const needsRedetect = await simcomService.ensureUsbAudioMode();
  if (needsRedetect) {
    console.log('[STARTUP] Module rebooted — re-detecting SimCom ports...');
    ({ atPorts, audioPorts } = await detectSimcomPorts());
    await simcomService.initSimcomPorts(atPorts, audioPorts);
    // Verify the switch worked
    const stillNeeds = await simcomService.ensureUsbAudioMode();
    if (stillNeeds) {
      console.error('[STARTUP] USB PID switch failed — audio will not work');
    } else {
      console.log('[STARTUP] USB audio mode confirmed');
    }
  }

  // One-shot module identification (SIMCOMATI + CEMODE) to confirm variant
  // and CSFB mode at startup — useful when debugging LTE/voice regressions.
  await simcomService.logModuleInfo();

  // Clear any stale PDP context left behind by an uncleanly-terminated
  // previous run. Runs after ports are stable (post-reboot if we switched
  // USB PIDs) so the AT commands reach the final module.
  await simcomService.clearAllDataSessions();

  // Re-park RNDIS adapters once ports have stabilised. The USB PID switch
  // above re-enumerates the interfaces, so adapters that appeared after the
  // early call above would otherwise keep Windows' auto-computed metric.
  await restoreRndisAdapters();

  try {
    const resolved = await resolveSerialPort();
    if (resolved) {
      updateSerialStatus({ path: resolved.path, label: resolved.label, connected: false });
      await serialService.open(resolved.path);
    } else {
      console.log('Server will start without serial connection. Plug in Arduino and restart.');
      scheduleReconnect();
    }
  } catch (err) {
    console.error(`Failed to open serial port ${serialService.getPortPath()}:`, err.message);
    console.log('Server will start without serial connection. Reconnect attempts will begin automatically.');
    scheduleReconnect();
  }

  server.listen(CONFIG.PORT, () => {
    console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  });

  // Late-enumerating RNDIS adapters (slow USB re-binding) won't be visible
  // to the boot-time restoreRndisAdapters call above. Single delayed retry
  // catches them. Fire-and-forget — a failure here just leaves the metric
  // unchanged, which the data-toggle path will fix later anyway.
  setTimeout(() => restoreRndisAdapters().catch(() => {}), 5000);
}

/**
 * Run gracefulShutdown then exit. Registered on SIGINT, SIGTERM, SIGHUP so
 * Ctrl+C in the terminal, `kill <pid>`, and Windows console-close events all
 * go through the same cleanup path as the SERVER_RESTART button.
 * @param {string} reason
 */
async function shutdownAndExit(reason) {
  console.log(`[SHUTDOWN] triggered by ${reason}`);
  try {
    await gracefulShutdown();
  } catch (err) {
    console.error(`[SHUTDOWN] error: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdownAndExit('SIGINT'));
process.on('SIGTERM', () => shutdownAndExit('SIGTERM'));
process.on('SIGHUP', () => shutdownAndExit('SIGHUP'));

start();
