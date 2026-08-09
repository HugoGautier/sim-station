/**
 * @fileoverview Manages SimCom USB COM ports (AT and Audio).
 *
 * AT ports  — opened with ReadlineParser for AT commands (AT+CPCMREG=1/0, etc.)
 * Audio ports — opened in raw binary mode; PCM data events are forwarded as
 *               base64 'audio:chunk' events to all socket clients.
 *
 * All audio ports are streamed simultaneously — no module mapping needed.
 * AT+CPCMREG=1 is broadcast to every AT port when any call becomes active.
 * AT+CPCMREG=0 is broadcast when the last call ends (reference-counted).
 *
 * PCM format: 8 kHz, 16-bit signed little-endian, mono.
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { EventEmitter } = require('events');
const { AT_COMMANDS } = require('../constants/atCommands');

/**
 * @typedef {{ path: string, label: string }} SimcomPortInfo
 */

/**
 * Build a stable per-module device key from a Windows pnpId by stripping
 * the per-interface MI_XX segment and the trailing 4-hex interface ordinal.
 * The result is the parent USB device address shared across all interfaces
 * of the same composite SIM7600, e.g.:
 *   USB\VID_1E0E&PID_9011&MI_02\7&A6F773E&0&0002 →
 *   usb\vid_1e0e&pid_9011\7&a6f773e&0
 * Lets us pair an AT port (MI_02) with its audio port (MI_05).
 * @param {string} pnpId
 * @returns {string}
 */
function deviceHubKey(pnpId) {
  if (!pnpId) return '';
  return String(pnpId).toLowerCase()
    .replace(/&mi_[0-9a-f]+/, '')
    .replace(/&[0-9a-f]+$/, '');
}

class SimcomService extends EventEmitter {
  constructor() {
    super();

    /**
     * Map of index → AT port path.
     * @type {Map<number, string>}
     */
    this._moduleAtPort = new Map();

    /**
     * Map of AT port path → open SerialPort instance.
     * @type {Map<string, SerialPort>}
     */
    this._atPorts = new Map();

    /**
     * Map of audio port path → open SerialPort instance.
     * @type {Map<string, SerialPort>}
     */
    this._audioPorts = new Map();

    /**
     * Set of moduleIds whose audio path is currently active. A chunk from an
     * audio port is forwarded only if its owning moduleId is in this set, and
     * AT+CPCMREG=1 is only sent to those modules. With more than one module
     * plugged in, this stops the call audio from being doubled by the other
     * module's idle PCM stream.
     * @type {Set<number>}
     */
    this._audioActiveModules = new Set();

    /**
     * Map of AT port path → RNDIS driver state ('ok' | 'missing' | 'unknown').
     * Populated by _checkRndisDriver after each port open / hot-plug, surfaced
     * to the dashboard so the user sees when a module needs a manual driver
     * install (and its SIMs get disabled until fixed).
     * @type {Map<string, 'ok'|'missing'|'unknown'>}
     */
    this._rndisStatus = new Map();

    /** Paths with an RNDIS check currently running (overlap guard). @type {Set<string>} */
    this._rndisCheckInflight = new Set();

    /** Interval handle for the periodic re-check of non-ok modules. @type {NodeJS.Timeout|null} */
    this._rndisWatchTimer = null;

    /**
     * Map of AT port path → USB device hub key (parent USB device address,
     * shared across MI_XX interfaces of the same physical SIM7600). Used to
     * pair an AT port with its audio port.
     * @type {Map<string, string>}
     */
    this._atPathHubKey = new Map();

    /**
     * Map of audio port path → USB device hub key. Mirror of _atPathHubKey
     * for audio interfaces.
     * @type {Map<string, string>}
     */
    this._audioPathHubKey = new Map();

    /**
     * Map of AT port path → IMEI string read at port open. Used by
     * reconcileModuleIds to match Arduino moduleIds against USB ports.
     * Initialized here (not just in initSimcomPorts) so the periodic scan
     * can run before init, or if init was never called.
     * @type {Map<string, string>}
     */
    this._pathToImei = new Map();

    /**
     * Mutex preventing concurrent scanAndSyncPorts calls from racing on
     * port open/close.
     * @type {boolean}
     */
    this._scanRunning = false;

    /**
     * The set of moduleIds the Arduino topology says we should have. Set by
     * reconcileModuleIds, used by _isComplete() to decide whether the USB
     * port scan needs to keep polling. Null until topology arrives.
     * @type {number[] | null}
     */
    this._expectedModuleIds = null;

    /**
     * setInterval handle for the USB plug-and-play scan, or null when the
     * scan is idle. Mirrors the Arduino's scheduleReconnect lifecycle:
     * runs only while something is missing, stops once complete, restarts
     * when a port closes or topology asks for more modules.
     * @type {NodeJS.Timeout | null}
     */
    this._scanTimer = null;

    /**
     * Polling cadence for the scan loop (ms). Configurable via setScanInterval.
     * @type {number}
     */
    this._scanIntervalMs = 5000;

    /**
     * Mutex preventing concurrent reconcileModuleIds runs. Reconcile is
     * triggered both by the topology event and by the scan tick — without
     * a guard, two parallel runs both query AT+CGSN for every moduleId
     * via the Arduino UART, which can confuse the response collector
     * (each call's listener sees both responses) and double the load.
     * @type {boolean}
     */
    this._reconcileRunning = false;

    /**
     * moduleIds for which we've subscribed call/registration URCs to the
     * USB AT port. Persists across hot-plug events so a brief disconnect
     * doesn't silence calls — on reconnect, reconcile re-applies the same
     * URC subscriptions to the new path. Cleared only when the user
     * explicitly toggles data off (via forgetUrcsForModule).
     * @type {Set<number>}
     */
    this._urcsActiveOn = new Set();

    /**
     * Last AT path each moduleId's URCs were applied on. Used to detect
     * "the path changed" cases after reconcile (USB replug, COM number
     * shuffled by Windows) so we re-apply rather than silently leaving
     * URCs bound to a closed handle.
     * @type {Map<number, string>}
     */
    this._urcsAppliedOn = new Map();
  }

  /**
   * Set the polling cadence for the USB scan loop. Takes effect on the next
   * start; if the loop is already running, it's restarted with the new value.
   * @param {number} ms
   */
  setScanInterval(ms) {
    this._scanIntervalMs = ms;
    if (this._scanTimer) {
      this._stopScanLoop();
      this._evaluateScanState();
    }
  }

  /**
   * Apply call/registration URC subscriptions to a module's current USB AT
   * port. Routes RING / +CLIP / +CREG / +CEREG to USB so socketHandler's
   * `at:line` bridge can forward them. Called from startDataSession (initial
   * arming) and from reconcile (re-arming after hot-plug).
   *
   *   CRC=1   — extended RING URCs (+CRING: VOICE) fire on this interface
   *   CLIP=1  — +CLIP caller-id with every RING
   *   CREG=2  — CS (voice) registration URCs with LAC/CI
   *   CEREG=2 — EPS (LTE) registration URCs, in case CSFB re-pages trigger a re-reg
   *   CMEE=2  — verbose error text so rejections aren't opaque
   *
   * Best-effort — individual command failures are logged but the method
   * continues. Records the applied path in `_urcsAppliedOn` so the post-
   * reconcile re-arm logic can detect path changes.
   * @param {number} moduleId
   * @returns {Promise<void>}
   * @private
   */
  async _applyUrcsForModule(moduleId) {
    const atPath = this._moduleAtPort.get(moduleId);
    if (!atPath) {
      console.warn(`[URC] module=${moduleId}: no AT path — skipping URC apply`);
      return;
    }
    const urcSetup = [
      ['CMEE=2', 'AT+CMEE=2\r\n'],
      ['CRC=1', 'AT+CRC=1\r\n'],
      ['CLIP=1', 'AT+CLIP=1\r\n'],
      ['CREG=2', 'AT+CREG=2\r\n'],
      ['CEREG=2', 'AT+CEREG=2\r\n'],
    ];
    for (const [label, cmd] of urcSetup) {
      try {
        const resp = await this.sendToAtPort(atPath, cmd, 3000);
        const ok = resp.some((l) => l === 'OK');
        console.log(`[URC] module=${moduleId} (${atPath}): ${label} → ${ok ? 'OK' : resp.join(' | ')}`);
      } catch (err) {
        console.warn(`[URC] module=${moduleId} (${atPath}): ${label} failed: ${err.message}`);
      }
    }
    this._urcsAppliedOn.set(moduleId, atPath);
  }

  /**
   * Forget that a moduleId had USB-side URCs subscribed. Call this when the
   * user explicitly toggles data off — it stops the post-reconcile re-arm
   * loop from re-applying URCs on subsequent hot-plugs. NOT to be called on
   * a USB disconnect: we keep the intent alive across re-plug so calls
   * keep ringing without manual re-toggle.
   * @param {number} moduleId
   */
  forgetUrcsForModule(moduleId) {
    this._urcsActiveOn.delete(moduleId);
    this._urcsAppliedOn.delete(moduleId);
  }

  /**
   * Whether the current open-port state matches what we expect.
   *
   * Three regimes:
   *   1. No topology yet (`_expectedModuleIds == null`): treat "any port open"
   *      as complete. The user's typical bring-up is "plug modules, then plug
   *      Arduino" — once a SimCom port shows up we idle until topology decides
   *      whether to ask for more.
   *   2. Empty topology (`_expectedModuleIds.length == 0`): vacuously complete.
   *   3. Non-empty topology: every expected moduleId must have a matched path
   *      that's still open in `_atPorts`.
   *
   * @returns {boolean}
   * @private
   */
  _isComplete() {
    if (this._expectedModuleIds == null) return this._atPorts.size > 0;
    return this._expectedModuleIds.every((mid) => {
      const p = this._moduleAtPort.get(mid);
      return p && this._atPorts.has(p);
    });
  }

  /**
   * Start the periodic scan loop if it isn't already running. Logs once on
   * transition idle→active so the console reflects state changes (and only
   * state changes — silent ticks otherwise).
   * @private
   */
  _ensureScanRunning() {
    if (this._scanTimer) return;
    console.log(`[SIMCOM] USB scan loop started (polling every ${this._scanIntervalMs}ms — modules incomplete)`);
    this._scanTimer = setInterval(() => {
      // Per-tick visibility log — mirrors the Arduino's "Scanning for Arduino..."
      // pattern. Only fires while the scan is active; once stable the loop
      // stops and the console goes quiet.
      //
      // Three regimes for the suffix:
      //   - some identified: name the unmapped moduleIds specifically.
      //   - none identified, modules still physically missing: show a count
      //     ("2 of 3 to plug in") since we can't yet say which is which.
      //   - all plugged but no IMEI matches: signal that identification is
      //     stuck (likely Arduino-UART AT+CGSN failing or IMEI mismatch).
      const expected = this._expectedModuleIds;
      if (!expected) {
        console.log('[SIMCOM] Scanning for modules...');
      } else {
        const mapped = expected.filter((mid) => {
          const p = this._moduleAtPort.get(mid);
          return p && this._atPorts.has(p);
        });
        const unmapped = expected.filter((mid) => !mapped.includes(mid));
        const remainingPhysical = Math.max(0, expected.length - this._atPorts.size);
        if (mapped.length > 0 && unmapped.length > 0) {
          console.log(`[SIMCOM] Scanning for modules... (waiting on moduleId(s): ${unmapped.join(', ')})`);
        } else if (remainingPhysical > 0) {
          console.log(`[SIMCOM] Scanning for modules... (${remainingPhysical} of ${expected.length} module(s) remaining to plug in)`);
        } else {
          console.log(`[SIMCOM] Scanning for modules... (all ${expected.length} plugged, awaiting IMEI match)`);
        }
      }
      this.scanAndSyncPorts(this._expectedModuleIds)
        .catch((err) => console.warn(`[SIMCOM] scan loop error: ${err.message}`))
        .finally(() => this._evaluateScanState());
    }, this._scanIntervalMs);
  }

  /**
   * Stop the periodic scan loop if it's running.
   * @private
   */
  _ensureScanStopped() {
    if (!this._scanTimer) return;
    console.log('[SIMCOM] USB scan loop stopped (all expected modules attached)');
    clearInterval(this._scanTimer);
    this._scanTimer = null;
  }

  /**
   * Re-evaluate whether the scan loop should be running based on current
   * open-port state vs expected. Called from every site that mutates the
   * relevant state: initSimcomPorts, reconcileModuleIds, port close handler,
   * and after each scan tick.
   * @private
   */
  _evaluateScanState() {
    if (this._isComplete()) this._ensureScanStopped();
    else this._ensureScanRunning();
  }

  /**
   * Open all detected AT and audio ports.
   * @param {SimcomPortInfo[]} atPorts
   * @param {SimcomPortInfo[]} audioPorts
   * @returns {Promise<void>}
   */
  async initSimcomPorts(atPorts, audioPorts) {
    this._moduleAtPort.clear();
    this._atPorts.clear();
    this._audioPorts.clear();
    this._pathToImei.clear();
    this._atPathHubKey.clear();
    this._audioPathHubKey.clear();

    // Provisional moduleId = enumeration order. Corrected later in
    // reconcileModuleIds() once Arduino topology + IMEIs are available.
    atPorts.forEach((info, idx) => {
      this._moduleAtPort.set(idx, info.path);
    });

    await Promise.all([
      ...atPorts.map((info, idx) =>
        this._openAtPort(info.path, idx, info.pnpId).catch((err) => {
          console.error(`[SIMCOM] Failed to open AT port ${info.path} (module=${idx}):`, err.message);
        })
      ),
      ...audioPorts.map((info) =>
        this._openAudioPort(info.path, info.pnpId).catch((err) => {
          console.error(`[SIMCOM] Failed to open audio port ${info.path}:`, err.message);
        })
      ),
    ]);

    // Read each modem's IMEI over USB so later reconciliation can match them
    // against the Arduino-side IMEIs (same hardware ID on both paths).
    for (const info of atPorts) {
      try {
        const resp = await this.sendToAtPort(info.path, 'AT+CGSN\r\n', 3000);
        const imei = this._extractImei(resp);
        if (imei) {
          this._pathToImei.set(info.path, imei);
          console.log(`[SIMCOM] ${info.path}: IMEI ${imei}`);
        } else {
          console.warn(`[SIMCOM] ${info.path}: could not parse IMEI from ${JSON.stringify(resp)}`);
        }
      } catch (err) {
        console.warn(`[SIMCOM] ${info.path}: IMEI read failed: ${err.message}`);
      }
    }

    // Cold-start equivalent of the hot-plug RNDIS-driver healer. If a module
    // was already plugged at server start, its USB enumeration happened
    // BEFORE we registered the hot-plug callback, so a stale "RNDIS driver
    // not bound" state from a previous Windows session (replug on another
    // port, driver replaced by Windows Update, etc.) would never get fixed
    // — leading to "no RNDIS adapter found" later when prepareRndisAdapter
    // runs, which silently breaks data activation. Fire-and-forget here:
    // ensureRndisDriver early-exits when the adapter is already bound, so
    // the cost is one PowerShell probe per module when everything is
    // healthy, and a real repair only when needed.
    if (process.platform === 'win32') {
      for (const info of atPorts) {
        this._checkRndisDriver(info.path);
      }
      // Start the periodic re-check so a manually-installed driver clears the
      // dashboard warning without a restart/replug. Idempotent.
      this._startRndisWatch();
    }

    // Decide whether the scan loop needs to start (e.g. zero ports detected
    // at boot, or fewer than topology will eventually ask for).
    this._evaluateScanState();
  }

  /**
   * Extract a 14-17 digit IMEI from AT+CGSN response lines.
   * @param {string[]} lines
   * @returns {string | null}
   * @private
   */
  _extractImei(lines) {
    for (const raw of lines) {
      const trimmed = String(raw).trim();
      // Bare-digit form (default AT+CGSN): "869123456789012"
      let m = trimmed.match(/^\d{14,17}$/);
      if (m) return m[0];
      // Quoted form some firmware variants emit: '+CGSN: "869123456789012"'
      // and the AT+CGSN=1 prefix form. Pull the first 14-17 digit run out.
      m = trimmed.match(/(\d{14,17})/);
      if (m && /CGSN/i.test(trimmed)) return m[1];
    }
    return null;
  }

  /**
   * Reconcile `_moduleAtPort` using IMEIs as the shared identifier between
   * the Arduino (UART-connected) and the PC (USB-connected). For each
   * moduleId reported by the Arduino, we query AT+CGSN via Arduino UART and
   * match against the USB-side IMEIs collected at port open.
   *
   * Called on every topology event — if modules are hot-plugged or the
   * Arduino re-enumerates, the mapping refreshes automatically.
   *
   * @param {number[]} moduleIds
   * @returns {Promise<void>}
   */
  async reconcileModuleIds(moduleIds) {
    // Remember the topology truth before any early-return: even if we can't
    // reconcile right now, the scan loop needs to know what to wait for.
    this._expectedModuleIds = Array.isArray(moduleIds) ? [...moduleIds] : null;

    // Mutex: a second reconcile while one is in flight just returns. The
    // first one's outcome will be reflected by the next _evaluateScanState
    // call (whoever gated me is also doing that).
    if (this._reconcileRunning) {
      console.log('[SIMCOM] reconcile: another run in flight — skipping');
      return;
    }
    this._reconcileRunning = true;

    try {
      if (!this._pathToImei || this._pathToImei.size === 0) {
        console.warn('[SIMCOM] reconcile: no USB-side IMEIs — skipping');
        return;
      }

      const { sendATAndCollect } = require('./atService');
      const arduinoImeis = new Map(); // moduleId → imei

      // Query each moduleId with a per-module retry. Arduino-UART AT+CGSN
      // is empirically flaky right after a USB plug/unplug event (URC bursts
      // on UART, SC16IS750 RX FIFO contention) — a single failure shouldn't
      // disqualify a moduleId from this reconcile pass. Two attempts with a
      // 500ms gap is enough to recover most transient races.
      for (const moduleId of moduleIds) {
        let imei = null;
        let lastResp = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const lines = await sendATAndCollect(moduleId, 'AT+CGSN\r\n', 7000);
            lastResp = lines;
            imei = this._extractImei(lines);
            if (imei) break;
          } catch (err) {
            lastErr = err;
          }
          if (attempt === 1) await new Promise((r) => setTimeout(r, 500));
        }
        if (imei) {
          arduinoImeis.set(moduleId, imei);
          console.log(`[SIMCOM] reconcile: module ${moduleId} IMEI (via Arduino) = ${imei}`);
        } else if (lastErr) {
          console.warn(`[SIMCOM] reconcile: module ${moduleId} IMEI query failed after 2 attempts: ${lastErr.message}`);
        } else {
          console.warn(`[SIMCOM] reconcile: module ${moduleId} IMEI parse failed after 2 attempts (last resp=${JSON.stringify(lastResp)})`);
        }
      }

      // MERGE into the existing map rather than rebuilding from scratch.
      // A transient Arduino-UART AT+CGSN failure on one moduleId must NOT
      // clobber a known-good mapping for a different moduleId we identified
      // in a previous run — otherwise hot-plug events ping-pong: the freshly
      // failing query overwrites yesterday's success and you end up only ever
      // resolving the most-recently-matched module.
      const updatedMap = new Map(this._moduleAtPort);
      for (const [moduleId, imei] of arduinoImeis) {
        let matchedPath = null;
        for (const [path, usbImei] of this._pathToImei) {
          if (usbImei === imei) { matchedPath = path; break; }
        }
        if (matchedPath) {
          if (updatedMap.get(moduleId) !== matchedPath) {
            console.log(`[SIMCOM] reconcile: moduleId ${moduleId} → ${matchedPath} (IMEI ${imei})`);
          }
          updatedMap.set(moduleId, matchedPath);
        } else {
          console.warn(`[SIMCOM] reconcile: no USB port has IMEI ${imei} for module ${moduleId}`);
        }
      }

      // Drop entries whose path is no longer open. Defensive: the close
      // handler already cleans up, but a parallel reconcile could otherwise
      // re-introduce a stale path from a partial previous run.
      for (const [moduleId, path] of [...updatedMap]) {
        if (!this._atPorts.has(path)) {
          updatedMap.delete(moduleId);
        }
      }

      this._moduleAtPort = updatedMap;

      // Re-apply URC subscriptions for any moduleId that's flagged data-active
      // and whose USB path differs from the one we last applied them to.
      // Covers the hot-plug case: module disconnected, came back on a new
      // (or same) COM port, and now needs RING/+CLIP/CREG re-routed to USB
      // so socketHandler's bridge stays alive without a manual data toggle.
      for (const moduleId of this._urcsActiveOn) {
        const currentPath = updatedMap.get(moduleId);
        const lastAppliedPath = this._urcsAppliedOn.get(moduleId);
        if (currentPath && currentPath !== lastAppliedPath) {
          console.log(`[URC] module=${moduleId}: path changed (${lastAppliedPath || 'none'} → ${currentPath}) — re-arming URC subs`);
          // Fire-and-forget: failures are logged inside _applyUrcsForModule,
          // and the next reconcile will retry if the path is still mismatched.
          this._applyUrcsForModule(moduleId).catch((err) => {
            console.warn(`[URC] module=${moduleId}: re-arm failed: ${err.message}`);
          });
        }
      }
    } finally {
      this._reconcileRunning = false;
      this._evaluateScanState();
    }
  }

  /**
   * Periodic plug-and-play scan: reconcile our open-port maps with what the
   * OS currently enumerates. Mirrors what `scheduleReconnect` does for the
   * Arduino in index.js — without this, USB modules plugged in after
   * server start (or replugged after a disconnect) are never seen.
   *
   * Behavior:
   *   - Ports that vanished from the OS → close handle (close handler clears
   *     `_atPorts` / `_pathToImei` / `_moduleAtPort` entries).
   *   - Ports that appeared → open AT (and audio if present), read IMEI.
   *   - If any AT port appeared and the caller passed `moduleIds`, re-run
   *     `reconcileModuleIds` so the IMEI↔moduleId map refreshes.
   *
   * Mutex via `_scanRunning` keeps concurrent ticks from racing on
   * detectSimcomPorts → open. Best-effort: never throws, scanned ports that
   * fail to open are simply logged and retried on the next tick.
   *
   * Note: a fresh module enumerated in PID 9001 (no audio) is NOT auto-switched
   * to 9011 here — that requires a reboot mid-runtime which would interleave
   * with anything in flight. Restart the server to re-run the boot-time PID
   * switch path.
   *
   * @param {number[] | null} moduleIds — current Arduino topology moduleIds, or null if not yet known
   * @returns {Promise<void>}
   */
  async scanAndSyncPorts(moduleIds = null) {
    if (this._scanRunning) return;
    this._scanRunning = true;
    try {
      const { detectSimcomPorts } = require('./portDetector');
      const { atPorts, audioPorts } = await detectSimcomPorts({ silent: true });

      const detectedAtPaths = new Set(atPorts.map((p) => p.path));
      const detectedAudioPaths = new Set(audioPorts.map((p) => p.path));

      // Close ports that vanished from the OS. The close handler clears
      // _atPorts / _pathToImei / _moduleAtPort. Wrap in try/catch since
      // close() can throw if Windows already invalidated the handle.
      for (const path of [...this._atPorts.keys()]) {
        if (!detectedAtPaths.has(path)) {
          console.log(`[SIMCOM] hot-unplug: AT port ${path} no longer enumerated — closing`);
          const port = this._atPorts.get(path);
          try { port && port.close(() => {}); } catch (_) {}
        }
      }
      for (const path of [...this._audioPorts.keys()]) {
        if (!detectedAudioPaths.has(path)) {
          console.log(`[SIMCOM] hot-unplug: audio port ${path} no longer enumerated — closing`);
          const port = this._audioPorts.get(path);
          try { port && port.close(() => {}); } catch (_) {}
        }
      }

      const newAtPorts = atPorts.filter((p) => !this._atPorts.has(p.path));
      const newAudioPorts = audioPorts.filter((p) => !this._audioPorts.has(p.path));

      if (newAtPorts.length === 0 && newAudioPorts.length === 0) return;

      // Open new AT ports first. Provisional moduleId is just the order in
      // which we discover them — reconcileModuleIds rebuilds the real map
      // below if we have topology IDs.
      for (const info of newAtPorts) {
        try {
          const provisionalId = this._moduleAtPort.size;
          await this._openAtPort(info.path, provisionalId, info.pnpId);
          console.log(`[SIMCOM] hot-plug: AT port ${info.path} opened`);
          // Make sure the matching RNDIS driver is bound. After an unplug/
          // replug, Windows sometimes lands the network interface under
          // "Other devices" without the driver applied. Fire-and-forget;
          // updates _rndisStatus + emits 'rndis:status' for the dashboard.
          this._checkRndisDriver(info.path);
        } catch (err) {
          console.error(`[SIMCOM] hot-plug: failed to open AT port ${info.path}: ${err.message}`);
        }
      }
      for (const info of newAudioPorts) {
        try {
          await this._openAudioPort(info.path, info.pnpId);
          console.log(`[SIMCOM] hot-plug: audio port ${info.path} opened`);
        } catch (err) {
          console.error(`[SIMCOM] hot-plug: failed to open audio port ${info.path}: ${err.message}`);
        }
      }

      // Read IMEI for ANY open AT port without one cached. Covers freshly
      // opened ports AND retries earlier failures (the SIM7600 can take a
      // beat to respond after USB enumeration — the first AT+CGSN often
      // times out, the second one a tick later succeeds). Without a retry
      // here, a missed IMEI is permanent and reconcile never finds the path.
      for (const path of [...this._atPorts.keys()]) {
        if (this._pathToImei.has(path)) continue;
        try {
          const resp = await this.sendToAtPort(path, 'AT+CGSN\r\n', 5000);
          const imei = this._extractImei(resp);
          if (imei) {
            this._pathToImei.set(path, imei);
            console.log(`[SIMCOM] ${path} IMEI ${imei}`);
          } else {
            console.warn(`[SIMCOM] ${path} IMEI parse failed (resp=${JSON.stringify(resp)}) — will retry next tick`);
          }
        } catch (err) {
          console.warn(`[SIMCOM] ${path} IMEI read failed: ${err.message} — will retry next tick`);
        }
      }

      // Re-reconcile every tick while we have topology and at least one
      // USB IMEI cached. Mandatory because Arduino-UART AT+CGSN queries can
      // also fail transiently — this retries them. The merge logic in
      // reconcileModuleIds keeps any previously-matched mapping intact, so
      // re-running here is safe even when only some moduleIds resolve.
      if (Array.isArray(moduleIds) && moduleIds.length > 0 && this._pathToImei.size > 0) {
        await this.reconcileModuleIds(moduleIds);
      }
    } catch (err) {
      console.warn(`[SIMCOM] scan failed: ${err.message}`);
    } finally {
      this._scanRunning = false;
    }
  }

  /**
   * Check USB PID mode on each AT port. If a module is in PID 9001 (no audio),
   * switch it to PID 9011 (with audio). The module reboots after the switch.
   * @returns {Promise<boolean>} true if any module was switched (needs re-detection)
   */
  async ensureUsbAudioMode() {
    let needsRedetect = false;

    for (const [moduleId, atPath] of this._moduleAtPort.entries()) {
      try {
        // Just read current PID. We used to probe AT+CUSBPIDSWITCH=? first
        // to dump every supported composition (~150-char list of 26 PIDs)
        // — useful exactly once for new hardware, pure log noise otherwise.
        const resp = await this.sendToAtPort(atPath, 'AT+CUSBPIDSWITCH?\r\n', 5000);
        const pidLine = resp.find((l) => l.includes('+CUSBPIDSWITCH:'));
        if (!pidLine) {
          console.warn(`[USB] module=${moduleId}: AT+CUSBPIDSWITCH not supported, skipping`);
          continue;
        }
        const pidMatch = pidLine.match(/\+CUSBPIDSWITCH:\s*(\d+)/);
        const currentPid = pidMatch ? pidMatch[1] : 'unknown';
        if (currentPid === '9011') continue; // already in audio+RNDIS mode, no log needed
        console.log(`[USB] module=${moduleId}: current PID=${currentPid}`);

        // Switch to PID 9011 (AT + Audio)
        console.log(`[USB] Module ${moduleId}: switching from PID ${currentPid} to 9011 (audio mode)...`);
        await this.sendToAtPort(atPath, 'AT+CUSBPIDSWITCH=9011,1,1\r\n', 5000);
        console.log(`[USB] Module ${moduleId}: switch command sent, module will reboot`);
        needsRedetect = true;
      } catch (err) {
        console.error(`[USB] Module ${moduleId} (${atPath}): error during PID check:`, err.message);
      }
    }

    if (needsRedetect) {
      // Close all ports before reboot
      console.log('[USB] Closing all SimCom ports before module reboot...');
      await this._closeAllPorts();
      console.log('[USB] Waiting for module reboot (up to 60s)...');
      // Module needs time to reboot and re-enumerate USB — poll until ports appear
      const { detectSimcomPorts } = require('./portDetector');
      for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const elapsed = (i + 1) * 5;
        const { atPorts } = await detectSimcomPorts({ silent: true });
        if (atPorts.length > 0) {
          console.log(`[USB] SimCom ports re-appeared after ${elapsed}s`);
          break;
        }
        console.log(`[USB] No ports yet after ${elapsed}s, retrying...`);
      }
    }

    return needsRedetect;
  }

  /**
   * Close all open AT and audio ports.
   * @returns {Promise<void>}
   * @private
   */
  async _closeAllPorts() {
    const closePromises = [];
    for (const [path, port] of this._atPorts) {
      closePromises.push(new Promise((resolve) => {
        port.close((err) => {
          if (err) console.warn(`[SIMCOM] Error closing AT port ${path}:`, err.message);
          resolve();
        });
      }));
    }
    for (const [path, port] of this._audioPorts) {
      closePromises.push(new Promise((resolve) => {
        port.close((err) => {
          if (err) console.warn(`[SIMCOM] Error closing audio port ${path}:`, err.message);
          resolve();
        });
      }));
    }
    await Promise.all(closePromises);
    this._atPorts.clear();
    this._audioPorts.clear();
    this._moduleAtPort.clear();
    this._atPathHubKey.clear();
    this._audioPathHubKey.clear();
  }

  /**
   * Open an AT port with ReadlineParser, emit 'at:line' events.
   * @param {string} portPath
   * @param {number} moduleId
   * @param {string} [pnpId] - Windows InstanceId; used to pair with audio port
   * @returns {Promise<void>}
   * @private
   */
  _openAtPort(portPath, moduleId, pnpId) {
    if (pnpId) this._atPathHubKey.set(portPath, deviceHubKey(pnpId));
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
      const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      parser.on('data', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        // Resolve moduleId at emit time — reconcileModuleIds may have remapped
        // since port open, and stale captured-at-open ids would misroute URCs.
        // No log here on purpose: the atService layer logs every line via
        // [AT:X] <<< already, and duplicating doubles the log volume.
        const mid = this.getModuleIdForPath(portPath);
        this.emit('at:line', { moduleId: mid, port: portPath, line: trimmed });
      });

      port.on('error', (err) => {
        console.error(`[SIMCOM] AT port ${portPath} error:`, err.message);
      });

      port.on('close', () => {
        console.warn(`[SIMCOM] AT port ${portPath} closed`);
        // Capture the moduleId BEFORE cleanup so we can announce which
        // module just disappeared. Listeners (e.g. socketHandler) need this
        // to react — for instance, to reset dataState if it was the
        // currently-active data SIM.
        let closedModuleId = null;
        for (const [mid, p] of this._moduleAtPort) {
          if (p === portPath) { closedModuleId = mid; break; }
        }

        this._atPorts.delete(portPath);
        // Clear any cached state keyed on this path so a later re-detection
        // re-reads IMEI and reconcileModuleIds doesn't return a closed path.
        this._pathToImei.delete(portPath);
        this._atPathHubKey.delete(portPath);
        this._rndisStatus.delete(portPath);
        if (closedModuleId !== null) this._moduleAtPort.delete(closedModuleId);

        // Becoming incomplete restarts the scan loop (Arduino-style: idle
        // when stable, polling when something is missing).
        this._evaluateScanState();

        // Public event for socketHandler & co. We do NOT clear _urcsActiveOn
        // here — the user may want the data session to come back on its own
        // when the module reconnects, in which case URCs need to re-arm.
        if (closedModuleId !== null) {
          this.emit('port:closed', { moduleId: closedModuleId, path: portPath });
        }
      });

      port.open((err) => {
        if (err) { reject(err); return; }
        this._atPorts.set(portPath, port);
        console.log(`[SIMCOM] AT port ${portPath} opened (module=${moduleId})`);
        resolve();
      });
    });
  }

  /**
   * Open an audio port in raw binary mode. Emits 'audio:chunk' with
   * base64-encoded PCM only when this port's owning moduleId is currently
   * active — otherwise the chunks of an idle module would be mixed into
   * the active call's stream and the user would hear doubled audio.
   * @param {string} portPath
   * @param {string} [pnpId] - Windows InstanceId; used to pair with AT port
   * @returns {Promise<void>}
   * @private
   */
  _openAudioPort(portPath, pnpId) {
    if (pnpId) this._audioPathHubKey.set(portPath, deviceHubKey(pnpId));
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });

      port.on('data', (chunk) => {
        const moduleId = this._moduleIdForAudioPath(portPath);
        if (moduleId == null || !this._audioActiveModules.has(moduleId)) return;
        this.emit('audio:chunk', { moduleId, chunk: chunk.toString('base64') });
      });

      port.on('error', (err) => {
        console.error(`[SIMCOM] Audio port ${portPath} error:`, err.message);
      });

      port.on('close', () => {
        console.warn(`[SIMCOM] Audio port ${portPath} closed`);
        this._audioPorts.delete(portPath);
        this._audioPathHubKey.delete(portPath);
      });

      port.open((err) => {
        if (err) { reject(err); return; }
        this._audioPorts.set(portPath, port);
        console.log(`[SIMCOM] Audio port ${portPath} opened`);
        resolve();
      });
    });
  }

  /**
   * Resolve which moduleId owns a given audio port. Pair via the USB hub
   * key (parent device address) shared between the AT and audio interfaces
   * of the same physical SIM7600.
   * @param {string} audioPath
   * @returns {number | null}
   * @private
   */
  _moduleIdForAudioPath(audioPath) {
    const hubKey = this._audioPathHubKey.get(audioPath);
    if (!hubKey) return null;
    for (const [moduleId, atPath] of this._moduleAtPort) {
      if (this._atPathHubKey.get(atPath) === hubKey) return moduleId;
    }
    return null;
  }

  /**
   * Resolve a moduleId's audio port path by AT-port hub-key matching.
   * @param {number} moduleId
   * @returns {string | null}
   * @private
   */
  _audioPathForModule(moduleId) {
    const atPath = this._moduleAtPort.get(moduleId);
    if (!atPath) return null;
    const hubKey = this._atPathHubKey.get(atPath);
    if (!hubKey) return null;
    for (const [audioPath, key] of this._audioPathHubKey) {
      if (key === hubKey) return audioPath;
    }
    return null;
  }

  /**
   * Send an AT command to a port and collect the response.
   * @param {string} portPath
   * @param {string} command
   * @param {number} [timeoutMs=3000]
   * @returns {Promise<string[]>}
   */
  sendToAtPort(portPath, command, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const port = this._atPorts.get(portPath);
      if (!port) {
        reject(new Error(`AT port ${portPath} is not open`));
        return;
      }

      const lines = [];
      let timer = null;

      const onLine = ({ port: p, line }) => {
        if (p !== portPath) return;
        lines.push(line);
        if (line === 'OK' || line.startsWith('ERROR') || line.startsWith('+CME ERROR')) {
          clearTimeout(timer);
          this.removeListener('at:line', onLine);
          resolve(lines);
        }
      };

      timer = setTimeout(() => {
        this.removeListener('at:line', onLine);
        resolve(lines);
      }, timeoutMs);

      this.on('at:line', onLine);

      port.write(command, (err) => {
        if (err) {
          clearTimeout(timer);
          this.removeListener('at:line', onLine);
          reject(err);
        }
      });
    });
  }

  /**
   * Get the AT port path currently associated with a module.
   * @param {number} moduleId
   * @returns {string | undefined}
   */
  getAtPathForModule(moduleId) {
    return this._moduleAtPort.get(moduleId);
  }

  /**
   * Reverse lookup: find the moduleId currently mapped to a given AT port path.
   * @param {string} path
   * @returns {number | null}
   */
  getModuleIdForPath(path) {
    for (const [mid, p] of this._moduleAtPort) {
      if (p === path) return mid;
    }
    return null;
  }

  /**
   * Run the RNDIS driver check for an AT port, store the result, and emit
   * 'rndis:status' so socketHandler can broadcast it. Fire-and-forget.
   * Guards against overlapping PowerShell probes for the same path.
   * @param {string} atPath
   * @private
   */
  _checkRndisDriver(atPath) {
    if (this._rndisCheckInflight.has(atPath)) return;
    this._rndisCheckInflight.add(atPath);
    const { ensureRndisDriver } = require('./windowsNetRoutes');
    ensureRndisDriver(atPath)
      .then((status) => {
        const prev = this._rndisStatus.get(atPath);
        this._rndisStatus.set(atPath, status);
        if (status === 'missing' && prev !== 'missing') {
          console.warn(`[NET] RNDIS driver MISSING for ${atPath} — module data disabled until manually installed`);
        }
        if (status === 'ok' && prev === 'missing') {
          console.log(`[NET] RNDIS driver now OK for ${atPath} — module re-enabled`);
        }
        // Emit on change, AND keep re-emitting while still missing, so a
        // client that connected late or reloaded the page reliably receives
        // the warning within one watcher cycle (~15s) without needing a
        // status transition to have occurred while it was watching.
        if (status !== prev || status === 'missing') {
          this.emit('rndis:status', { path: atPath, status });
        }
      })
      .catch(() => {})
      .finally(() => this._rndisCheckInflight.delete(atPath));
  }

  /**
   * Periodic watcher: every 15s re-check any open module whose RNDIS driver
   * isn't 'ok' yet. This makes the dashboard's "Driver missing" warning clear
   * itself automatically once the user installs the driver — no server restart
   * or replug needed. Healthy ('ok') modules are skipped, so when everything is
   * fine this costs only a Map scan (no PowerShell). Started once, lives for
   * the process lifetime.
   * @private
   */
  _startRndisWatch() {
    if (process.platform !== 'win32') return;
    if (this._rndisWatchTimer) return;
    this._rndisWatchTimer = setInterval(() => {
      for (const [, atPath] of this._moduleAtPort) {
        if (this._rndisStatus.get(atPath) !== 'ok') {
          this._checkRndisDriver(atPath);
        }
      }
    }, 15000);
  }

  /**
   * RNDIS driver state per moduleId, for the dashboard. Modules whose AT port
   * has no status yet report 'unknown'.
   * @returns {Record<number, 'ok'|'missing'|'unknown'>}
   */
  getRndisStatusByModule() {
    const out = {};
    for (const [moduleId, atPath] of this._moduleAtPort) {
      out[moduleId] = this._rndisStatus.get(atPath) || 'unknown';
    }
    return out;
  }

  /**
   * Start a 4G data session on a module. In PID 9011 the SIM7600 exposes RNDIS
   * and auto-dials on the host side; the host's RNDIS adapter carries the
   * traffic once the PDP context is activated by either the modem (auto-dial)
   * or the sequence below.
   *
   * Broad shape of this method:
   *   1. Probe current state (CFUN / CNMP=? / CNBP?)
   *   2. Cycle radio (CFUN=0 → CNBP → CNMP → CFUN=1) only if the target config
   *      differs from what the modem already has — avoids an unnecessary ~5s
   *      re-attach when the operator hasn't changed since last session.
   *   3. Poll CEREG (LTE/EPS) *and* CGREG (2G/3G PS) until one reports
   *      registered. CEREG is authoritative on LTE; CGREG on GSM/WCDMA.
   *   4. Wait 2s post-registration so the default EPS bearer settles — without
   *      this, CGACT fires while the bearer is still negotiating and returns
   *      `+CME ERROR: unknown` (CEER: "no cause") every time.
   *   5. Check if context 1 is already active with the correct APN — if yes,
   *      skip CGDCONT/CGACT and just read the IP. This is common because the
   *      modem auto-dials context 1 during LTE attach using the default APN.
   *   6. Otherwise: deactivate ctx1, rewrite CGDCONT + CGAUTH, activate. On
   *      `+CME ERROR: unknown` from CGACT, retry once via a CGATT=0/=1 cycle
   *      which is the documented escape hatch for "activate raced the attach".
   *
   * @param {number} moduleId
   * @param {import('../constants/operators').OperatorConfig} config
   * @returns {Promise<{ ip: string | null }>}
   */
  async startDataSession(moduleId, config) {
    const atPath = this._moduleAtPort.get(moduleId);
    if (!atPath) throw new Error(`no AT port for module ${moduleId}`);

    await this._ensureCfun1(atPath, moduleId);
    await this._logPreChangeProbes(atPath, moduleId);
    await this._applyBandsAndMode(atPath, moduleId, config);

    const { psStat, epsStat, rat } = await this._waitForRegistration(atPath, moduleId, config);
    console.log(`[DATA] module=${moduleId}: registered (EPS=${epsStat} PS=${psStat} RAT=${rat}) — settling 2s before CGACT`);
    await new Promise((r) => setTimeout(r, 2000));

    await this._ensureContext(atPath, moduleId, config);

    const ip = await this._readContextIp(atPath, moduleId);
    console.log(`[DATA] module=${moduleId}: session UP via RNDIS auto-dial (ip=${ip || 'unknown'})`);

    // Register the USB AT port as the URC sink for voice/call/registration
    // events. Tracked in _urcsActiveOn so a hot-plug disconnect → reconnect
    // re-applies the same subscriptions to the new path automatically (else
    // the user would have to toggle data off/on to re-arm the bridge).
    await this._applyUrcsForModule(moduleId);
    this._urcsActiveOn.add(moduleId);

    // Verify CEMODE actually took — if _applyBandsAndMode's CFUN=0 cycle was
    // skipped or the write was rejected, we attach PS-only and voice paging
    // silently breaks. Surface it loudly so the cause is visible in logs.
    try {
      const resp = await this.sendToAtPort(atPath, 'AT+CEMODE?\r\n', 3000);
      const line = resp.find((l) => l.includes('+CEMODE:'));
      const m = line && line.match(/\+CEMODE:\s*(\d+)/);
      const mode = m ? parseInt(m[1], 10) : null;
      const ok = mode === 2;
      console.log(`[DATA] module=${moduleId}: CEMODE check → ${line || resp.join(' | ')} ${ok ? '(CSFB ready)' : '(⚠ not combined attach — voice may fail)'}`);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CEMODE verify failed: ${err.message}`);
    }

    for (const cmd of config.postAttachCmds || []) {
      try {
        console.log(`[DATA] module=${moduleId}: postAttach ${cmd}`);
        await this.sendToAtPort(atPath, `${cmd}\r\n`, 5000);
      } catch (err) {
        console.warn(`[DATA] module=${moduleId}: postAttach "${cmd}" failed: ${err.message}`);
      }
    }

    await this._logServingCell(atPath, moduleId, 'CPSI');
    await this._verifyVoiceReachable(atPath, moduleId);

    // Two-step host networking handover. Step 1: PREPARE only — the active
    // module's RNDIS is brought up (Disable/Enable cycle, fresh DHCP, MTU
    // 1430 clamp) and every other RNDIS is disabled to avoid ARP
    // collisions on 192.168.225.0/24. The system default route is NOT
    // touched yet, so the host (and any Tailscale peer egressing through
    // it) keeps using WiFi until we've confirmed this bearer actually
    // works end-to-end. Sockets bound to the RNDIS source IP can already
    // reach 4G via localAddress routing — that's enough for the probes
    // below.
    const { prepareRndisAdapter, promoteRndisAdapter } = require('./windowsNetRoutes');
    try {
      await prepareRndisAdapter(atPath);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: prepareRndisAdapter failed: ${err.message}`);
    }

    // Probe ICMP egress to detect "zombie PDP": CGACT=1 with a valid CGNAT
    // IP, but the carrier-side session has expired and traffic gets dropped.
    // CFUN=4 → wait → CFUN=1 forces a clean re-attach with a fresh context.
    const cgnatIp = await this._verifyAndRecoverConnectivity(atPath, moduleId, config, ip);

    // Resolve the carrier-NAT-side public IP (what 8.8.8.8 sees us as).
    // The CGACT-reported IP is CGNAT (10.x.x.x). Returning both lets the
    // client distinguish "we know the egress IP" from "we have an IP but
    // it's just the CGNAT" — the latter must NOT be used for transit
    // comparison or the client will always conclude its own ipify result
    // differs and falsely report Local.
    const publicIp = await this._fetchPublicIp(atPath, moduleId);

    // Step 2: PROMOTE — bump InterfaceMetric=1 + replace 0.0.0.0/0 with
    // RouteMetric=0 so this RNDIS becomes the host's default route. Only
    // gated on the public-IP fetch succeeding (TCP+TLS+HTTP end-to-end is
    // the strictest test we have); skip it when the bearer didn't carry
    // real traffic. The session still reports as active with the CGNAT IP
    // — UI shows "Local" via the publicIp=null signal, host stays on
    // WiFi, peer's exit-node traffic stays on WiFi too.
    if (publicIp) {
      try {
        await promoteRndisAdapter(atPath);
      } catch (err) {
        console.warn(`[DATA] module=${moduleId}: promoteRndisAdapter failed: ${err.message}`);
      }
    } else {
      console.warn(`[DATA] module=${moduleId}: bearer not promoted to default route — public IP fetch never succeeded; host network stays on WiFi`);
    }

    return { ip: publicIp || cgnatIp, publicIp: publicIp || null };
  }

  /**
   * Resolve the carrier-side public IP by issuing an HTTPS GET to
   * api.ipify.org from the RNDIS source IP. Fully traverses the chain
   * (host → RNDIS → modem → 4G → internet) so a successful fetch also
   * doubles as a stronger connectivity signal than the bare TCP probe.
   *
   * Retries up to 3 times with a 1.5s gap between attempts — covers the
   * common case where the very first packet on a freshly-attached PDP
   * gets dropped, or ipify is briefly slow. Returns null only after all
   * attempts fail, so the caller can fall back cleanly.
   * @private
   */
  async _fetchPublicIp(atPath, moduleId) {
    const sourceIp = await this._getRndisSourceIp(atPath);
    if (!sourceIp) {
      console.warn(`[DATA] module=${moduleId}: cannot fetch public IP (no RNDIS source)`);
      return null;
    }
    // 4 attempts, exponential-ish gap: lets a brief radio fade pass before
    // we give up. With 15s per attempt + gaps, worst-case spend is ~70s —
    // still finite, and we run this off the hot path so the data session
    // can be marked active in the meantime.
    const MAX_ATTEMPTS = 4;
    const GAPS_MS = [2000, 3000, 5000];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ip = await this._fetchPublicIpOnce(sourceIp, moduleId, attempt);
      if (ip) return ip;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, GAPS_MS[attempt - 1]));
      }
    }
    console.warn(`[DATA] module=${moduleId}: public IP fetch failed after ${MAX_ATTEMPTS} attempts`);
    return null;
  }

  /**
   * Single ipify probe attempt. Returns the parsed IPv4 string on success,
   * null on any failure (timeout / network / unparseable body).
   * @param {string} sourceIp
   * @param {number} moduleId
   * @param {number} attempt - for log prefix only
   * @returns {Promise<string | null>}
   * @private
   */
  _fetchPublicIpOnce(sourceIp, moduleId, attempt) {
    return new Promise((resolve) => {
      const https = require('https');
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      // Cloudflare's `1.1.1.1/cdn-cgi/trace` returns a small text body with
      // `ip=X.X.X.X` on its own line. We connect to a literal IP — no DNS
      // round-trip needed. Both 1.1.1.1 and 1.0.0.1 are anycast, the carrier
      // path is short and resilient. Timeout is generous (15s) because at
      // -130 dBm RSRP the TLS handshake takes 3-8s of retransmissions; the
      // earlier 5s caught only the lucky packets and timed out the rest.
      // SNI = 'cloudflare-dns.com' (a real hostname) avoids Node's DEP0123
      // deprecation warning ("Setting the TLS ServerName to an IP address
      // is not permitted by RFC 6066"). Cloudflare's edge serves a cert at
      // 1.1.1.1 with BOTH 'cloudflare-dns.com' DNS-SAN and '1.1.1.1'
      // IP-SAN, so we keep cert validation against the literal IP we
      // connect to while satisfying the SNI hostname constraint.
      // Without explicit servername, Node auto-derives it from hostname
      // '1.1.1.1' and re-emits the same DEP0123 warning.
      const req = https.request(
        {
          hostname: '1.1.1.1',
          port: 443,
          path: '/cdn-cgi/trace',
          method: 'GET',
          localAddress: sourceIp,
          timeout: 15000,
          headers: { 'User-Agent': 'sim-station', 'Host': '1.1.1.1' },
          servername: 'cloudflare-dns.com',
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            const m = body.match(/^ip=([^\s]+)$/m);
            const ip = m && m[1];
            if (ip && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
              console.log(`[DATA] module=${moduleId}: public IP = ${ip} (attempt ${attempt})`);
              finish(ip);
            } else {
              console.warn(`[DATA] module=${moduleId}: trace unexpected body (attempt ${attempt}): ${JSON.stringify(body).slice(0, 80)}`);
              finish(null);
            }
          });
          res.on('error', () => finish(null));
        }
      );
      req.on('error', (err) => {
        console.warn(`[DATA] module=${moduleId}: public IP fetch failed (attempt ${attempt}): ${err.message}`);
        finish(null);
      });
      req.on('timeout', () => {
        req.destroy();
        console.warn(`[DATA] module=${moduleId}: public IP fetch timeout (attempt ${attempt}, 15s)`);
        finish(null);
      });
      req.end();
    });
  }

  /**
   * Probe end-to-end connectivity by opening a TCP socket from the RNDIS
   * adapter's IP toward 8.8.8.8:53 (DNS, almost always reachable).
   *
   * Why TCP at the OS level instead of AT-level ping:
   *   - SIM7600 firmware M22 rejects both AT+CPING and AT+CIPPING.
   *   - A TCP connect from Node, bound to the RNDIS host-side IPv4, traverses
   *     the entire chain we care about: Node → kernel → RNDIS adapter →
   *     USB → modem → 4G WAN → 8.8.8.8. If the connect succeeds, the data
   *     session is genuinely usable; if it times out / errors, something
   *     is broken (zombie PDP, RNDIS driver, DHCP, etc.).
   *
   * Returns true on a successful TCP handshake, false on timeout/error.
   * Returns true if we can't even resolve the RNDIS source IP — without
   * a source to bind, we'd be testing WiFi instead, which would always
   * succeed and trigger false negatives.
   * @private
   */
  async _verifyDataConnectivity(atPath, moduleId) {
    const sourceIp = await this._getRndisSourceIp(atPath);
    if (!sourceIp) {
      console.warn(`[DATA] module=${moduleId}: RNDIS source IP not resolvable — skipping connectivity check`);
      return true;
    }
    console.log(`[DATA] module=${moduleId}: connectivity probe — TCP from ${sourceIp} → 8.8.8.8:53`);

    const net = require('net');
    return await new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ok, msg) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) {}
        if (ok) {
          console.log(`[DATA] module=${moduleId}: connectivity OK (${msg})`);
        } else {
          console.warn(`[DATA] module=${moduleId}: connectivity FAILED (${msg}) — zombie PDP suspected`);
        }
        resolve(ok);
      };
      // 10s — covers a TCP SYN + 2 retransmissions (RTO doubles 1s/2s/4s).
      // Earlier 5s missed the 2nd retransmit, false-positiving the
      // "zombie PDP" branch on weak signal where the SYN does eventually
      // get through on a retry.
      const timer = setTimeout(() => finish(false, 'TCP connect timeout 10s'), 10000);

      socket.once('connect', () => { clearTimeout(timer); finish(true, 'TCP handshake succeeded'); });
      socket.once('error', (err) => { clearTimeout(timer); finish(false, `${err.code || ''} ${err.message}`.trim()); });

      try {
        socket.connect({ host: '8.8.8.8', port: 53, localAddress: sourceIp });
      } catch (err) {
        clearTimeout(timer);
        finish(false, `socket.connect threw: ${err.message}`);
      }
    });
  }

  /**
   * Resolve the host-side IPv4 of the RNDIS adapter paired with a given
   * AT port (same USB device, same instance hash). Reuses the same hash-
   * matching logic as prioritizeRndisAdapter so the source IP we bind to
   * always corresponds to the module we're testing.
   *
   * Returns null if the platform isn't Windows, the AT port can't be
   * located, the RNDIS adapter isn't found, or PowerShell errors out —
   * callers treat null as "skip the test".
   * @param {string} atPath
   * @returns {Promise<string | null>}
   * @private
   */
  async _getRndisSourceIp(atPath) {
    if (process.platform !== 'win32') return null;
    const safePort = String(atPath || '').replace(/[^A-Za-z0-9]/g, '');
    if (!safePort) return null;
    const ps = [
      `$atPort = '${safePort}';`,
      "$portPnp = Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match ('\\(' + $atPort + '\\)') } | Select-Object -First 1;",
      "if (-not $portPnp) { return }",
      "$tail = ($portPnp.InstanceId -split '\\\\')[-1];",
      "$activeHash = ($tail -replace '&[^&]+$', '').ToLower();",
      "$adapter = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'RNDIS|Remote NDIS' -or $_.PnPDeviceID -like '*VID_1E0E*' } | Where-Object { $tail2 = ($_.PnPDeviceID -split '\\\\')[-1]; ($tail2 -replace '&[^&]+$', '').ToLower() -eq $activeHash } | Select-Object -First 1;",
      "if (-not $adapter) { return }",
      "$ip = (Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress;",
      "if ($ip) { Write-Output $ip }",
    ].join(' ');
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { timeout: 10000 });
      const ip = (stdout || '').trim();
      return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
    } catch (err) {
      console.warn(`[DATA] RNDIS source IP query failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Force a clean radio cycle. CFUN=4 detaches the radio (releases the RAN
   * connection and any PDP contexts), CFUN=1 re-attaches with fresh
   * negotiation. Slower than CGACT=0/1 but works even when the modem
   * refuses to deactivate context 1 (locked by the RNDIS auto-dial),
   * which is exactly the case here.
   * @private
   */
  async _forceRadioCycle(atPath, moduleId) {
    try {
      console.log(`[DATA] module=${moduleId}: AT+CFUN=4 (radio off — zombie recovery)`);
      await this.sendToAtPort(atPath, 'AT+CFUN=4\r\n', 10000);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CFUN=4 during recovery failed: ${err.message}`);
    }
    // Let the modem fully release its RAN attachment.
    await new Promise((r) => setTimeout(r, 3000));
    try {
      console.log(`[DATA] module=${moduleId}: AT+CFUN=1 (radio on — completing recovery)`);
      await this.sendToAtPort(atPath, 'AT+CFUN=1\r\n', 15000);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CFUN=1 during recovery failed: ${err.message}`);
    }
  }

  /**
   * Run a connectivity probe; if it fails, force a radio cycle and redo
   * the registration + context activation, then re-probe. Returns the
   * (possibly new) IP after recovery, or the original IP if no recovery
   * was needed or if recovery failed.
   *
   * Bounded to ONE retry — if the second probe still fails, the issue is
   * almost certainly carrier-side (data plan, SIM provisioning) and more
   * radio cycles won't help.
   * @private
   */
  async _verifyAndRecoverConnectivity(atPath, moduleId, config, originalIp) {
    if (await this._verifyDataConnectivity(atPath, moduleId)) {
      return originalIp;
    }

    console.warn(`[DATA] module=${moduleId}: forcing zombie PDP recovery (CFUN=4/1 cycle)`);
    await this._forceRadioCycle(atPath, moduleId);

    try {
      await this._waitForRegistration(atPath, moduleId, config);
      await new Promise((r) => setTimeout(r, 2000));
      await this._ensureContext(atPath, moduleId, config);
      const newIp = await this._readContextIp(atPath, moduleId);
      console.log(`[DATA] module=${moduleId}: session re-established after recovery (ip=${newIp || 'unknown'})`);
      // URC subscriptions are dropped by the CFUN cycle — re-arm them so
      // call paging keeps working on USB.
      await this._applyUrcsForModule(moduleId);

      if (await this._verifyDataConnectivity(atPath, moduleId)) {
        console.log(`[DATA] module=${moduleId}: ICMP egress restored — recovery successful`);
        return newIp;
      }
      console.error(`[DATA] module=${moduleId}: data still not flowing after recovery — likely carrier/SIM issue`);
      return newIp;
    } catch (err) {
      console.error(`[DATA] module=${moduleId}: recovery attempt failed: ${err.message}`);
      return originalIp;
    }
  }

  /**
   * After a successful data attach, check that the SIM is also registered on
   * the CS domain (voice). On LTE that means the modem must have done a
   * combined EPS/IMSI attach (CEMODE=2), which registers the UE with both
   * the MME and the MSC so incoming voice calls can be paged via CSFB.
   *
   * AT+CREG? returns the CS registration state. stat∈{1,5} means the MSC
   * knows about the SIM; stat∈{0,2,4} means voice paging will fail and
   * calls go straight to voicemail while data is active.
   * @private
   */
  async _verifyVoiceReachable(atPath, moduleId) {
    try {
      const resp = await this.sendToAtPort(atPath, 'AT+CREG?\r\n', 3000);
      const line = resp.find((l) => l.includes('+CREG:'));
      const m = line && line.match(/\+CREG:\s*\d+,\s*(\d+)/);
      const stat = m ? parseInt(m[1], 10) : null;
      const ok = stat === 1 || stat === 5;
      const tag = ok ? 'voice reachable (CSFB ready)' : 'VOICE UNREACHABLE — calls will go to voicemail';
      console.log(`[DATA] module=${moduleId}: CS-registration → ${line || resp.join(' | ')} — ${tag}`);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CREG probe failed: ${err.message}`);
    }
  }

  /**
   * Verify the modem is in full functionality (CFUN=1). If it's in some other
   * mode (sleep/airplane/etc.), raise CFUN=1 — do not throw, since a modem
   * that's just been through a MUX switch or a startup cleanup can legitimately
   * be in CFUN=4 transiently.
   * @private
   */
  async _ensureCfun1(atPath, moduleId) {
    let cfunMode = null;
    try {
      const cfun = await this.sendToAtPort(atPath, 'AT+CFUN?\r\n', 3000);
      const line = cfun.find((l) => l.includes('+CFUN:'));
      const m = line && line.match(/\+CFUN:\s*(\d+)/);
      if (m) cfunMode = parseInt(m[1], 10);
      console.log(`[DATA] module=${moduleId}: CFUN → ${line || '(no response)'}`);
    } catch (_) {}
    if (cfunMode !== null && cfunMode !== 1) {
      console.log(`[DATA] module=${moduleId}: CFUN=${cfunMode} → raising to 1`);
      await this.sendToAtPort(atPath, 'AT+CFUN=1\r\n', 10000);
    }
  }

  /** @private */
  async _logPreChangeProbes(atPath, moduleId) {
    try {
      const cnmpSupp = await this.sendToAtPort(atPath, 'AT+CNMP=?\r\n', 3000);
      const line = cnmpSupp.find((l) => l.includes('+CNMP:'));
      console.log(`[DATA] module=${moduleId}: supported modes → ${line || cnmpSupp.join(' | ')}`);
    } catch (_) {}
    try {
      const cnbp = await this.sendToAtPort(atPath, 'AT+CNBP?\r\n', 3000);
      const line = cnbp.find((l) => l.includes('+CNBP:'));
      console.log(`[DATA] module=${moduleId}: band prefs → ${line || cnbp.join(' | ')}`);
    } catch (_) {}
    try {
      const cemode = await this.sendToAtPort(atPath, 'AT+CEMODE?\r\n', 3000);
      const line = cemode.find((l) => l.includes('+CEMODE:'));
      console.log(`[DATA] module=${moduleId}: EPS mode → ${line || cemode.join(' | ')} (2=CSFB data-centric)`);
    } catch (_) {}
  }

  /**
   * Apply CNBP (bands) and CNMP (network mode) from the operator config.
   * Requires the radio off (CFUN=0) or the commands are rejected. CFUN=1 is
   * always restored in the finally block.
   *
   * Skipped entirely when the config has no cnmp/cnbp fields set — allows
   * operator configs to opt out and leave the modem at its current prefs.
   * @private
   */
  async _applyBandsAndMode(atPath, moduleId, config) {
    const hasBands = config.cnbpGsmMask || config.cnbpWcdmaMask || config.cnbpLteMask;
    const hasMode = config.cnmp != null;
    if (!hasBands && !hasMode) return;

    try {
      console.log(`[DATA] module=${moduleId}: AT+CFUN=0 (radio off before band/mode change)`);
      await this.sendToAtPort(atPath, 'AT+CFUN=0\r\n', 10000);
      // Firmware rejects CNMP/CNBP for ~1s after CFUN=0 with ERROR and no
      // explanation. 1.5s empirically covers that window.
      await new Promise((r) => setTimeout(r, 1500));

      if (hasBands) {
        // Read current CNBP first: on newer SIM7600E-H firmware the WCDMA
        // field is 256-bit internally and writes are rejected unless every
        // field matches the firmware's exact width. Preserve the read values
        // for GSM/WCDMA (null in config) and only override the LTE field
        // when the operator config asks for widening. That keeps B20/B28 in
        // the LTE mask without fighting the firmware over WCDMA width.
        try {
          const readResp = await this.sendToAtPort(atPath, 'AT+CNBP?\r\n', 3000);
          const line = readResp.find((l) => l.includes('+CNBP:'));
          const m = line && line.match(/\+CNBP:\s*(0x[0-9A-Fa-f]+),(0x[0-9A-Fa-f]+),(0x[0-9A-Fa-f]+)/);
          if (!m) {
            console.warn(`[DATA] module=${moduleId}: CNBP? unparseable, skipping band write`);
          } else {
            const [, curGsm, curWcdma, curLte] = m;
            const gsm = config.cnbpGsmMask || curGsm;
            const wcdma = config.cnbpWcdmaMask || curWcdma;
            const lte = config.cnbpLteMask || curLte;
            if (gsm === curGsm && wcdma === curWcdma && lte === curLte) {
              console.log(`[DATA] module=${moduleId}: CNBP already matches config, skipping write`);
            } else {
              const cmd = `AT+CNBP=${gsm},${wcdma},${lte}`;
              console.log(`[DATA] module=${moduleId}: ${cmd}`);
              const resp = await this.sendToAtPort(atPath, `${cmd}\r\n`, 5000);
              if (!resp.some((l) => l === 'OK')) {
                console.warn(`[DATA] module=${moduleId}: CNBP rejected (${resp.join(' | ')}) — factory bands kept`);
              }
            }
          }
        } catch (err) {
          console.warn(`[DATA] module=${moduleId}: CNBP read+widen failed: ${err.message}`);
        }
      }

      // Force combined EPS/IMSI attach so the MSC registers the SIM alongside
      // the MME — without this the modem attaches PS-only on LTE and incoming
      // voice calls go straight to voicemail (no CSFB paging). CEMODE only
      // applies on the next attach, so set it while radio is off.
      try {
        console.log(`[DATA] module=${moduleId}: AT+CEMODE=2 (CSFB combined attach)`);
        const resp = await this.sendToAtPort(atPath, 'AT+CEMODE=2\r\n', 5000);
        if (!resp.some((l) => l === 'OK')) {
          console.warn(`[DATA] module=${moduleId}: CEMODE=2 rejected (${resp.join(' | ')}) — voice may be unreachable during data`);
        }
      } catch (err) {
        console.warn(`[DATA] module=${moduleId}: CEMODE=2 failed: ${err.message}`);
      }

      if (hasMode) {
        // Try configured CNMP, then 54 (GSM+WCDMA+LTE — 3G fallback for voice+data
        // via class A when LTE doesn't attach), then 2 (Auto — lets the firmware
        // pick). 59/60/63/67 are *not* fallbacks on E-H: they cover TDS-CDMA/CDMA
        // radios the variant doesn't have, so the firmware rejects the write.
        const tries = [config.cnmp, 54, 2].filter((v, i, a) => v != null && a.indexOf(v) === i);
        let applied = null;
        for (const mode of tries) {
          console.log(`[DATA] module=${moduleId}: AT+CNMP=${mode}`);
          const resp = await this.sendToAtPort(atPath, `AT+CNMP=${mode}\r\n`, 5000);
          if (resp.some((l) => l === 'OK')) { applied = mode; break; }
          console.warn(`[DATA] module=${moduleId}: CNMP=${mode} rejected (${resp.join(' | ')})`);
        }
        try {
          const check = await this.sendToAtPort(atPath, 'AT+CNMP?\r\n', 3000);
          const line = check.find((l) => l.includes('+CNMP:'));
          console.log(`[DATA] module=${moduleId}: current mode → ${line || check.join(' | ')} (applied=${applied})`);
        } catch (_) {}
      }
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: band/mode apply failed: ${err.message}`);
    } finally {
      try {
        console.log(`[DATA] module=${moduleId}: AT+CFUN=1 (radio on)`);
        await this.sendToAtPort(atPath, 'AT+CFUN=1\r\n', 10000);
      } catch (err) {
        console.warn(`[DATA] module=${moduleId}: CFUN=1 restore failed: ${err.message}`);
      }
    }
  }

  /**
   * Poll CEREG (EPS/LTE) and CGREG (PS/2G-3G) until a PS-capable RAT is
   * attached, then read CPSI to identify which RAT the modem is actually
   * camped on. If `config.requireNonGsm` is true (default) and the only
   * reachable RAT is GSM, throws — GSM (class B) can't serve voice + data
   * concurrently, so letting the caller proceed would silently block
   * incoming calls while the PDP context is live.
   *
   * Returns { psStat, epsStat, rat } where rat ∈ {'LTE','WCDMA','TDS','GSM'}.
   * Throws on denied (3) or on timeout.
   * @private
   */
  async _waitForRegistration(atPath, moduleId, config) {
    const REG_TIMEOUT_MS = 25000;
    const regStart = Date.now();
    let psStat = null;
    let epsStat = null;

    // Enable verbose CEREG so +CEREG: n,stat,... unsolicited fires on change.
    try { await this.sendToAtPort(atPath, 'AT+CEREG=2\r\n', 3000); } catch (_) {}

    while (Date.now() - regStart < REG_TIMEOUT_MS) {
      try {
        const cereg = await this.sendToAtPort(atPath, 'AT+CEREG?\r\n', 3000);
        const line = cereg.find((l) => l.includes('+CEREG:'));
        const m = line && line.match(/\+CEREG:\s*\d+,\s*(\d+)/);
        epsStat = m ? parseInt(m[1], 10) : null;
        if (line) console.log(`[DATA] module=${moduleId}: EPS-registration → ${line}`);
      } catch (_) {}
      try {
        const cgreg = await this.sendToAtPort(atPath, 'AT+CGREG?\r\n', 3000);
        const line = cgreg.find((l) => l.includes('+CGREG:'));
        const m = line && line.match(/\+CGREG:\s*\d+,\s*(\d+)/);
        psStat = m ? parseInt(m[1], 10) : null;
        if (line) console.log(`[DATA] module=${moduleId}: PS-registration → ${line}`);
      } catch (_) {}

      if ([1, 5].includes(epsStat) || [1, 5].includes(psStat)) {
        const rat = await this._readServingRat(atPath, moduleId);
        if (rat === 'GSM') {
          await this._diagnoseNoLte(atPath, moduleId);
          if (config && config.requireNonGsm === true) {
            throw new Error(
              `Only GSM is reachable — data refused (requireNonGsm=true). ` +
              `See CEER/CESQ diagnostics above for the LTE-attach cause.`
            );
          }
          console.warn(
            `[DATA] module=${moduleId}: ⚠ only GSM reachable — data will start ` +
            `but incoming voice calls may go to voicemail during active transfer ` +
            `(GSM class B). Set operator.requireNonGsm=true to refuse instead.`
          );
        }
        return { psStat, epsStat, rat };
      }
      if (epsStat === 3 || psStat === 3) {
        throw new Error(`Registration denied (EPS=${epsStat} PS=${psStat}) — SIM blocked or no data plan`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Module failed to register (EPS=${epsStat} PS=${psStat}) after ${REG_TIMEOUT_MS}ms — check coverage / CNBP / SIM plan`);
  }

  /**
   * Read AT+CPSI and return the RAT token the modem is camped on.
   * Known values: 'LTE', 'WCDMA', 'TDS-CDMA', 'GSM', or 'UNKNOWN'.
   * @private
   */
  async _readServingRat(atPath, moduleId) {
    try {
      const cpsi = await this.sendToAtPort(atPath, 'AT+CPSI?\r\n', 5000);
      const line = cpsi.find((l) => l.includes('+CPSI:'));
      if (!line) return 'UNKNOWN';
      const m = line.match(/\+CPSI:\s*([A-Z0-9-]+)/);
      const rat = m ? m[1].toUpperCase() : 'UNKNOWN';
      console.log(`[DATA] module=${moduleId}: serving RAT → ${rat} (${line})`);
      return rat;
    } catch {
      return 'UNKNOWN';
    }
  }

  /**
   * When LTE fails to attach and only GSM is reachable, surface the two
   * most useful diagnostics so the root cause is visible in the log:
   *
   *   - CEER: last NAS release/reject cause from the network. Cause "EPS
   *     services not allowed" (7) or "PLMN not allowed" (11) = SIM has no
   *     LTE/EPS profile (common on older Lycamobile FR SIMs). Cause "No
   *     suitable cells" (15) = band/RF, not SIM.
   *   - CESQ: RSRP/RSRQ for LTE. 255,255 = radio never heard any LTE cell
   *     (band mask wrong, or true no-LTE-coverage here). Other values show
   *     weak-but-present LTE.
   * @private
   */
  async _diagnoseNoLte(atPath, moduleId) {
    try {
      const ceer = await this.sendToAtPort(atPath, 'AT+CEER\r\n', 3000);
      const line = ceer.find((l) => l.includes('+CEER:')) || ceer.join(' | ');
      console.log(`[DATA] module=${moduleId}: CEER → ${line}`);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CEER probe failed: ${err.message}`);
    }
    try {
      const cesq = await this.sendToAtPort(atPath, 'AT+CESQ\r\n', 3000);
      const line = cesq.find((l) => l.includes('+CESQ:')) || cesq.join(' | ');
      console.log(`[DATA] module=${moduleId}: CESQ → ${line} (RSRP/RSRQ last two fields; 255=no LTE heard)`);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CESQ probe failed: ${err.message}`);
    }
  }

  /** @private */
  async _logServingCell(atPath, moduleId, tag) {
    try {
      const cpsi = await this.sendToAtPort(atPath, 'AT+CPSI?\r\n', 5000);
      const line = cpsi.find((l) => l.includes('+CPSI:'));
      console.log(`[DATA] module=${moduleId}: ${tag} → ${line || cpsi.join(' | ')}`);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: ${tag} query failed: ${err.message}`);
    }
  }

  /**
   * Ensure PDP context 1 is active with the configured APN.
   * If already active with a matching APN (common on LTE where the network
   * auto-creates the default EPS bearer at attach), this is a no-op.
   * Otherwise: deactivate → CGDCONT → CGAUTH → CGACT=1,1, with a one-shot
   * CGATT recovery if CGACT reports the canonical "unknown" error caused by
   * racing the attach.
   * @private
   */
  async _ensureContext(atPath, moduleId, config) {
    let ctx1Active = false;
    try {
      const cgact = await this.sendToAtPort(atPath, 'AT+CGACT?\r\n', 3000);
      ctx1Active = cgact.some((l) => /\+CGACT:\s*1,\s*1/.test(l));
    } catch (_) {}

    let existingApn = null;
    try {
      const cgd = await this.sendToAtPort(atPath, 'AT+CGDCONT?\r\n', 3000);
      const line = cgd.find((l) => /\+CGDCONT:\s*1,/.test(l));
      const m = line && line.match(/\+CGDCONT:\s*1,\s*"[^"]*"\s*,\s*"([^"]*)"/);
      if (m) existingApn = m[1];
    } catch (_) {}
    console.log(`[DATA] module=${moduleId}: ctx1 active=${ctx1Active} existingApn="${existingApn || ''}" targetApn="${config.apn}"`);

    if (ctx1Active && existingApn === config.apn) {
      // CGACT=1 alone is not proof the bearer actually has an IP — on some
      // MVNO+LTE paths the network accepts the activation request but never
      // allocates an address, leaving ctx1 in a zombie "active, no IP" state.
      // Check CGPADDR before trusting the "reuse" fast path; otherwise we
      // short-circuit and the caller later finds ip=unknown with no traffic.
      const existingIp = await this._readContextIp(atPath, moduleId);
      if (existingIp && existingIp !== '0.0.0.0') {
        console.log(`[DATA] module=${moduleId}: context 1 already up with correct APN and IP ${existingIp} — reusing`);
        return;
      }
      console.warn(`[DATA] module=${moduleId}: ctx1 marked active but IP is empty ("${existingIp || ''}") — forcing re-activation`);
    }

    if (ctx1Active) {
      try {
        console.log(`[DATA] module=${moduleId}: AT+CGACT=0,1 (release before APN rewrite)`);
        await this.sendToAtPort(atPath, 'AT+CGACT=0,1\r\n', 10000);
      } catch (err) {
        console.warn(`[DATA] module=${moduleId}: CGACT=0 failed: ${err.message}`);
      }
    }

    const pdp = config.pdpType || 'IP';
    const cgdcont = `AT+CGDCONT=1,"${pdp}","${config.apn}"`;
    console.log(`[DATA] module=${moduleId}: ${cgdcont}`);
    const cgdResp = await this.sendToAtPort(atPath, `${cgdcont}\r\n`, 5000);
    if (!cgdResp.some((l) => l === 'OK')) {
      throw new Error(`CGDCONT failed: ${cgdResp.join(' | ')}`);
    }

    if (config.authUser) {
      const safeUser = config.authUser.replace(/"/g, '\\"');
      const safePass = (config.authPass || '').replace(/"/g, '\\"');
      console.log(`[DATA] module=${moduleId}: AT+CGAUTH=1,${config.authType},"${safeUser}","***"`);
      const authResp = await this.sendToAtPort(
        atPath,
        `AT+CGAUTH=1,${config.authType},"${safeUser}","${safePass}"\r\n`,
        5000
      );
      if (!authResp.some((l) => l === 'OK')) {
        console.warn(`[DATA] module=${moduleId}: CGAUTH response: ${authResp.join(' | ')}`);
      }
    }

    let ok = await this._attemptCgact(atPath, moduleId);
    if (ok) return;

    // CGACT rejected. +CME ERROR: unknown with empty CEER = modem raced the
    // attach or the default EPS bearer is in a half-state. Documented escape:
    // force a PS detach and re-attach, which re-negotiates the bearer cleanly.
    let cause = 'unknown';
    try {
      const ceer = await this.sendToAtPort(atPath, 'AT+CEER\r\n', 3000);
      const line = ceer.find((l) => l.includes('+CEER:'));
      if (line) cause = line.replace('+CEER:', '').trim();
    } catch (_) {}
    console.log(`[DATA] module=${moduleId}: CGACT failed (CEER: ${cause}) — retry via CGATT cycle`);
    try { await this.sendToAtPort(atPath, 'AT+CGATT=0\r\n', 15000); } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
    try { await this.sendToAtPort(atPath, 'AT+CGATT=1\r\n', 15000); } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));

    ok = await this._attemptCgact(atPath, moduleId);
    if (!ok) {
      throw new Error(`CGACT=1,1 failed after CGATT recovery — CEER: ${cause} — APN="${config.apn}"`);
    }
  }

  /** @private */
  async _attemptCgact(atPath, moduleId) {
    console.log(`[DATA] module=${moduleId}: AT+CGACT=1,1`);
    const resp = await this.sendToAtPort(atPath, 'AT+CGACT=1,1\r\n', 30000);
    return resp.some((l) => l === 'OK');
  }

  /** @private */
  async _readContextIp(atPath, moduleId) {
    try {
      const ipResp = await this.sendToAtPort(atPath, 'AT+CGPADDR=1\r\n', 3000);
      const line = ipResp.find((l) => l.startsWith('+CGPADDR:'));
      const m = line && line.match(/\+CGPADDR:\s*\d+,"?([^",]+)"?/);
      if (m) return m[1];
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CGPADDR query failed: ${err.message}`);
    }
    return null;
  }

  /**
   * Log identifying info for every detected module (model, firmware, CSFB
   * mode). Useful at startup to correlate behavior with firmware variant and
   * to confirm CSFB is enabled (CEMODE=2). Best-effort — never throws.
   * @returns {Promise<void>}
   */
  async logModuleInfo() {
    for (const [moduleId, atPath] of this._moduleAtPort.entries()) {
      let model = '?', firmware = '?', cemode = '?';
      try {
        const ati = await this.sendToAtPort(atPath, 'AT+SIMCOMATI\r\n', 5000);
        for (const l of ati) {
          const t = l.trim();
          if (t.startsWith('Model:')) model = t.slice(6).trim();
          else if (t.startsWith('Revision:')) firmware = t.slice(9).trim();
        }
      } catch (err) {
        console.warn(`[MODULE ${moduleId}] SIMCOMATI failed: ${err.message}`);
      }
      try {
        const resp = await this.sendToAtPort(atPath, 'AT+CEMODE?\r\n', 3000);
        const m = resp.find((l) => l.includes('+CEMODE:'))?.match(/\+CEMODE:\s*(\d+)/);
        if (m) cemode = m[1];
      } catch (_) {}
      console.log(`[MODULE ${moduleId}] ${model} fw=${firmware} CEMODE=${cemode}${cemode === '2' ? ' (CSFB ready)' : ''}`);
    }
  }

  /**
   * Deactivate PDP context 1 on every detected module. Used at startup to
   * clear any stale session that survived an uncleanly-terminated previous
   * run (PC crash, kill -9, power loss). Best-effort — errors are logged
   * but don't block startup.
   * @returns {Promise<void>}
   */
  async clearAllDataSessions() {
    for (const [moduleId, atPath] of this._moduleAtPort.entries()) {
      try {
        const cgact = await this.sendToAtPort(atPath, 'AT+CGACT?\r\n', 3000);
        const active = cgact.some((l) => /\+CGACT:\s*1,\s*1/.test(l));
        if (!active) continue; // common case, silent
        // CGACT=0 typically returns ERROR when ctx1 is locked by RNDIS
        // auto-dial — that's expected and not actionable. Just note the
        // attempt result so the log explains what happened.
        const resp = await this.sendToAtPort(atPath, 'AT+CGACT=0,1\r\n', 10000);
        const ok = resp.some((l) => l === 'OK');
        console.log(`[STARTUP] module=${moduleId}: stale PDP ctx — ${ok ? 'cleared' : 'kept (locked by RNDIS auto-dial)'}`);
      } catch (err) {
        console.warn(`[STARTUP] module=${moduleId}: data clear failed: ${err.message}`);
      }
    }
  }

  /**
   * Stop the current 4G data session on a module by deactivating PDP context 1.
   * The RNDIS interface stays enumerated on the host but carries no traffic.
   * @param {number} moduleId
   * @returns {Promise<void>}
   */
  async stopDataSession(moduleId) {
    const atPath = this._moduleAtPort.get(moduleId);
    if (!atPath) return;
    try {
      console.log(`[DATA] module=${moduleId}: AT+CGACT=0,1`);
      await this.sendToAtPort(atPath, 'AT+CGACT=0,1\r\n', 10000);
    } catch (err) {
      console.warn(`[DATA] module=${moduleId}: CGACT=0 failed: ${err.message}`);
    }
  }

  /**
   * Activate audio for a single module: route to USB, set gain, enable PCM
   * streaming. Only this module's AT+CPCMREG=1 is sent — the other modules
   * stay quiet, so their idle PCM streams don't double the call audio.
   * Idempotent per module.
   * @param {number} moduleId
   * @returns {Promise<void>}
   */
  async activateAudio(moduleId) {
    if (moduleId == null) {
      console.error('[AUDIO] activateAudio: missing moduleId');
      return;
    }
    if (this._audioActiveModules.has(moduleId)) {
      console.log(`[AUDIO] activateAudio: module=${moduleId} already active`);
      return;
    }
    const atPath = this._moduleAtPort.get(moduleId);
    if (!atPath) {
      console.error(`[AUDIO] activateAudio: no AT port for module=${moduleId}`);
      return;
    }

    this._audioActiveModules.add(moduleId);

    // Brief wait for modem audio subsystem to stabilise after VOICE CALL: BEGIN
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      // Route audio to USB, set max volume and gain
      await this.sendToAtPort(atPath, 'AT+CSDVC=3\r\n');
      await this.sendToAtPort(atPath, 'AT+CLVL=5\r\n');
      await this.sendToAtPort(atPath, 'AT+COUTGAIN=4\r\n');
      await this.sendToAtPort(atPath, 'AT+CMICGAIN=4\r\n');

      const cpcmResp = await this.sendToAtPort(atPath, AT_COMMANDS.CPCMREG_ON);
      if (cpcmResp.some((l) => l === 'OK')) {
        console.log(`[AUDIO] CPCMREG=1 SUCCESS on ${atPath} (module=${moduleId})`);
      } else {
        console.error(`[AUDIO] CPCMREG=1 FAILED on ${atPath} (module=${moduleId})`);
      }
    } catch (err) {
      console.error(`[AUDIO] activateAudio error on ${atPath}:`, err.message);
    }
  }

  /**
   * Deactivate audio for a single module: AT+CPCMREG=0 and remove from the
   * active set so its audio port stops emitting chunks.
   * @param {number} moduleId
   * @returns {Promise<void>}
   */
  async deactivateAudio(moduleId) {
    if (moduleId == null) {
      console.error('[AUDIO] deactivateAudio: missing moduleId');
      return;
    }
    if (!this._audioActiveModules.has(moduleId)) return;
    this._audioActiveModules.delete(moduleId);

    const atPath = this._moduleAtPort.get(moduleId);
    if (!atPath) return;
    try {
      await this.sendToAtPort(atPath, AT_COMMANDS.CPCMREG_OFF);
      console.log(`[AUDIO] AT+CPCMREG=0 sent on ${atPath} (module=${moduleId})`);
    } catch (err) {
      console.error(`[AUDIO] CPCMREG_OFF error on ${atPath}:`, err.message);
    }
  }
}

/** Singleton instance */
const simcomService = new SimcomService();

module.exports = { simcomService };
