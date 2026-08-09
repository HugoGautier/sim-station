/**
 * @fileoverview Manages MUX switching and the full SIM switch sequence for
 * SIM7600X modules.
 *
 * Switching between SIM cards requires more than toggling GPIO pins:
 *   1. AT+CFUN=0  — power off radio (prevents SIM hot-swap corruption)
 *   2. MUX switch — send hardware command to Arduino, wait for MUX_OK
 *   3. 500ms settle — let the analog MUX hardware stabilise
 *   4. AT+CFUN=1  — power on radio with new SIM
 *   5. Poll CREG/CEREG — wait up to 60s for network registration
 *
 * All operations are serialized through a per-module async queue via
 * selectAndRun(), guaranteeing no concurrent UART access.
 *
 * Emitted events (for socketHandler to forward to clients):
 *   switch:start      { moduleId, simId }
 *   switch:radio-off  { moduleId, simId }
 *   switch:mux-ok     { moduleId, simId }
 *   switch:radio-on   { moduleId, simId }
 *   switch:searching  { moduleId, simId }
 *   switch:registered { moduleId, simId, status }
 *   switch:timeout    { moduleId, simId }
 */

const { EventEmitter } = require('events');
const { serialService } = require('./serialService');
const { sendATAndCollect } = require('./atService');
const { buildMuxCommand } = require('../constants/serialProtocol');
const { AT_COMMANDS, AT_RESPONSE_PATTERNS } = require('../constants/atCommands');
const { CONFIG } = require('../constants/config');

class MuxService extends EventEmitter {
  constructor() {
    super();

    /**
     * Currently selected SIM per module.
     * @type {Map<number, number>}
     */
    this._selectedSim = new Map();

    /**
     * Per-module monotonic counter, bumped on every real MUX switch and on
     * deselect. Used by async URC consumers (USSD reply, etc.) to detect
     * "the physical SIM rotated since I issued my request" and discard a
     * stale reply instead of mis-attributing it to the now-active SIM.
     * @type {Map<number, number>}
     */
    this._switchGen = new Map();

    /**
     * Per-module promise chain acting as a serialization queue.
     * @type {Map<number, Promise<void>>}
     */
    this._queues = new Map();

    this._bindSerialEvents();
  }

  /** @private */
  _bindSerialEvents() {
    serialService.on('mux_ok', ({ moduleId, simId }) => {
      this._selectedSim.set(moduleId, simId);
      this._switchGen.set(moduleId, (this._switchGen.get(moduleId) || 0) + 1);
      this.emit('mux:switched', { moduleId, simId });
    });

    // Arduino resets MUX to default on every power cycle / reconnect.
    // Clear cached selection and queues so the next selectAndRun re-sends
    // the MUX command rather than relying on a stale cache hit.
    serialService.on('open', () => {
      this._selectedSim.clear();
      this._queues.clear();
    });
  }

  /**
   * Enqueue a MUX switch + operation on the per-module serial queue.
   * The full SIM switch sequence (CFUN=0 → MUX → CFUN=1 → poll) runs first;
   * fn executes only after the SIM is confirmed registered (or throws on timeout).
   *
   * @param {number} moduleId
   * @param {number} simId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  selectAndRun(moduleId, simId, fn) {
    const tail = this._queues.get(moduleId) ?? Promise.resolve();
    const next = tail.then(() => this._doSelectSim(moduleId, simId)).then(fn);
    this._queues.set(moduleId, next.catch(() => {}));
    return next;
  }

  /**
   * Run the full SIM switch sequence if the requested SIM differs from the
   * currently selected one. Short-circuits instantly on cache hit.
   *
   * @param {number} moduleId
   * @param {number} simId
   * @returns {Promise<void>}
   * @private
   */
  async _doSelectSim(moduleId, simId) {
    // Silent fast path — selectAndRun is called on every signal poll cycle
    // (every 10s) so logging "cache hit" each time would drown the rest.
    if (this._selectedSim.get(moduleId) === simId) return;

    // Notify about the SIM being left before the radio goes off.
    // Its status is now unknown — it is physically disconnected from the radio.
    const prevSimId = this._selectedSim.get(moduleId);
    if (prevSimId !== undefined) {
      console.log(`[MUX] module=${moduleId} sim=${prevSimId} — departing (switching to sim=${simId})`);
      this.emit('switch:departed', { moduleId, simId: prevSimId });
    }

    console.log(`[MUX] module=${moduleId} sim=${simId} — starting switch sequence`);
    this.emit('switch:start', { moduleId, simId });

    // Step 1 — Hang up any active or ringing call (result ignored — no call may be active)
    console.log(`[MUX] module=${moduleId} — AT+CHUP (hang up before switch)`);
    try {
      await sendATAndCollect(moduleId, AT_COMMANDS.CHUP, CONFIG.CHUP_TIMEOUT_MS);
    } catch (_) {
      // Ignore — expected when no call is in progress
    }
    console.log(`[MUX] module=${moduleId} — AT+CHUP done`);

    // Step 2 — Radio off (prevents SIM hot-swap corruption on SIM7600X)
    console.log(`[MUX] module=${moduleId} — AT+CFUN=0 (radio off)`);
    await sendATAndCollect(moduleId, AT_COMMANDS.CFUN_OFF, CONFIG.CFUN0_TIMEOUT_MS);
    console.log(`[MUX] module=${moduleId} — radio off confirmed`);
    this.emit('switch:radio-off', { moduleId, simId });

    // Step 3 — Physical MUX switch
    await this._sendMuxCommand(moduleId, simId);
    this.emit('switch:mux-ok', { moduleId, simId });

    // Step 4 — Hardware settle time (analog MUX needs time to stabilise)
    await new Promise((resolve) => setTimeout(resolve, CONFIG.MUX_SETTLE_MS));

    // Step 5 — Radio on with new SIM. Some SIM cards need extra time to
    // power up after a MUX switch and respond to the first CFUN=1 with
    // `+CME ERROR: SIM busy`. We detect that and retry once after a 3s
    // settle — without the retry the SIM never registers and the whole
    // switch times out 60s later (and the user sees a SIM that "won't
    // activate" with no obvious cause in the dashboard).
    console.log(`[MUX] module=${moduleId} — AT+CFUN=1 (radio on)`);
    let cfunResp = await sendATAndCollect(moduleId, AT_COMMANDS.CFUN_ON, CONFIG.CFUN1_TIMEOUT_MS);
    if (cfunResp.some((l) => /SIM busy/i.test(l))) {
      console.warn(`[MUX] module=${moduleId} — CFUN=1 returned "SIM busy" — settling 3s and retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      cfunResp = await sendATAndCollect(moduleId, AT_COMMANDS.CFUN_ON, CONFIG.CFUN1_TIMEOUT_MS);
      if (cfunResp.some((l) => /SIM busy/i.test(l))) {
        console.warn(`[MUX] module=${moduleId} — CFUN=1 still "SIM busy" after retry, proceeding anyway`);
      }
    }
    console.log(`[MUX] module=${moduleId} — radio on confirmed`);
    this.emit('switch:radio-on', { moduleId, simId });

    // Step 5b — Wait for the SIM to actually finish initialising before we
    // try anything else. This is THE fix for "I swapped the physical SIM and
    // it just polls registration until timeout": CFUN=1 can return OK while
    // the freshly-powered (swapped) SIM is still booting internally; firing
    // CNMP/CREG/CMGF at it then races the init and the SIM never registers
    // (or registers but the SMS/call URCs we arm in step 7 don't take effect
    // because the SIM subsystem wasn't ready). Polling AT+CPIN? until READY
    // closes that race. A genuinely absent SIM (NOT INSERTED) throws here so
    // the UI shows an error in ~1s instead of a 60s registration timeout.
    await this._waitForSimReady(moduleId);

    // Force GSM-only (no 3G/LTE) — voice calls reliably work on 2G with
    // Lycamobile/Bouygues on this firmware revision. CNMP=51 (GSM+WCDMA)
    // was tried but caused regression: outgoing/incoming calls stopped
    // working when the modem ended up camped on WCDMA, despite WCDMA
    // supporting CS voice in theory. Reverted to GSM-only as the proven
    // setup for this hardware + operator pair.
    await sendATAndCollect(moduleId, 'AT+CNMP=13\r\n').catch(() => {});

    // CREG must be enabled before polling — other notifications wait until SIM ready.
    await sendATAndCollect(moduleId, AT_COMMANDS.ENABLE_CREG);   // +CREG unsolicited

    // Step 6 — Poll until registered (or timeout)
    await this._waitForRegistration(moduleId, simId);

    // Settle delay — +CREG=1 fires when the network attach completes, but the
    // SIM's SMS storage + phone book init may still be in flight. Short
    // overshoot before the URC-arming burst below.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Step 7 — Arm SMS/call notification URCs. RESILIENT: each command is
    // retried once on timeout (SIM busy), and a failure on one DOES NOT skip
    // the others. Previously these were four bare awaits — a single CMGF or
    // CNMI timeout aborted the whole sequence, leaving CLIP (caller ID) and
    // CNMI (+CMTI new-SMS push) unarmed, so the SIM registered but no calls
    // or SMS ever surfaced. CSCS="UTF-8" answers ERROR on this firmware
    // (unsupported); that's fine — it counts as "answered", we move on.
    const urcSetup = [
      ['CMGF=1', AT_COMMANDS.SMS_TEXT_MODE],
      ['CSCS', AT_COMMANDS.CHARSET_UTF8],
      ['CNMI', AT_COMMANDS.ENABLE_CNMI],
      ['CLIP', AT_COMMANDS.ENABLE_CLIP],
    ];
    for (const [label, cmd] of urcSetup) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await sendATAndCollect(moduleId, cmd, 4000);
          break; // got a response (OK or ERROR) — this command is done
        } catch (err) {
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 800)); // SIM busy — settle, retry
            continue;
          }
          console.warn(`[MUX] module=${moduleId} — ${label} timed out twice; URC arming may be incomplete`);
        }
      }
    }
  }

  /**
   * Poll AT+CPIN? until the SIM reports READY. Returns true on READY, throws
   * on a definitively-absent SIM, returns false if it never reaches READY
   * within the deadline (caller proceeds best-effort).
   * @param {number} moduleId
   * @returns {Promise<boolean>}
   * @private
   */
  async _waitForSimReady(moduleId) {
    const deadline = Date.now() + 10000;
    let last = '';
    while (Date.now() < deadline) {
      let lines;
      try {
        lines = await sendATAndCollect(moduleId, AT_COMMANDS.SIM_STATUS, 3000); // AT+CPIN?
      } catch (_) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      last = lines.join(' | ');
      if (lines.some((l) => /\+CPIN:\s*READY/i.test(l))) {
        console.log(`[MUX] module=${moduleId} — SIM ready (CPIN: READY)`);
        return true;
      }
      // Absent / failed SIM: surface fast instead of waiting out a 60s
      // registration timeout. CME 10 = not inserted, 13 = SIM failure.
      if (lines.some((l) => /NOT INSERTED|CME ERROR:\s*1[03]\b|SIM (?:not inserted|failure|absent)/i.test(l))) {
        console.warn(`[MUX] module=${moduleId} — SIM not ready/absent: ${last}`);
        throw new Error('SIM not inserted or failed');
      }
      // SIM busy / not ready yet (e.g. "+CME ERROR: SIM busy", "+CPIN: NOT READY")
      await new Promise((r) => setTimeout(r, 500));
    }
    console.warn(`[MUX] module=${moduleId} — SIM not READY after 10s (last: ${last}); proceeding best-effort`);
    return false;
  }

  /**
   * Send the MUX select command to Arduino and wait for MUX_OK confirmation.
   * @param {number} moduleId
   * @param {number} simId
   * @returns {Promise<void>}
   * @private
   */
  _sendMuxCommand(moduleId, simId) {
    return new Promise((resolve, reject) => {
      const command = buildMuxCommand(moduleId, simId);
      /** @type {ReturnType<typeof setTimeout>} */
      let timer;

      const onMuxOk = (result) => {
        if (result.moduleId === moduleId && result.simId === simId) {
          clearTimeout(timer);
          serialService.removeListener('mux_ok', onMuxOk);
          console.log(`[MUX] module=${moduleId} sim=${simId} — MUX_OK received`);
          resolve();
        }
      };

      serialService.on('mux_ok', onMuxOk);

      timer = setTimeout(() => {
        serialService.removeListener('mux_ok', onMuxOk);
        console.error(`[MUX] module=${moduleId} sim=${simId} — TIMEOUT waiting for MUX_OK`);
        reject(new Error(`MUX switch timeout for module ${moduleId} sim ${simId}`));
      }, CONFIG.MUX_TIMEOUT_MS);

      console.log(`[MUX] module=${moduleId} sim=${simId} — sending MUX command`);
      serialService.sendRaw(command).catch((err) => {
        clearTimeout(timer);
        serialService.removeListener('mux_ok', onMuxOk);
        reject(err);
      });
    });
  }

  /**
   * Poll AT+CREG? every REGISTRATION_POLL_INTERVAL_MS until the SIM registers
   * on the GSM circuit-switched network (stat=1 or stat=5), or until
   * REGISTRATION_TIMEOUT_MS elapses.
   *
   * @param {number} moduleId
   * @param {number} simId
   * @returns {Promise<void>} Resolves when registered; rejects on timeout.
   * @private
   */
  async _waitForRegistration(moduleId, simId) {
    const deadline = Date.now() + CONFIG.REGISTRATION_TIMEOUT_MS;

    while (Date.now() < deadline) {
      this.emit('switch:searching', { moduleId, simId });
      console.log(`[MUX] module=${moduleId} sim=${simId} — polling registration...`);

      const lines = await sendATAndCollect(moduleId, AT_COMMANDS.CHECK_REGISTRATION);

      const registered = lines.some((line) => {
        if (line.includes(AT_RESPONSE_PATTERNS.CREG_PREFIX)) {
          const match = line.match(/:\s*(?:\d+,\s*)?(\d+)/);
          if (match) {
            const stat = parseInt(match[1], 10);
            return stat === 1 || stat === 5;
          }
        }
        return false;
      });

      if (registered) {
        const status = lines.some((line) => {
          const match = line.match(/:\s*(?:\d+,\s*)?(\d+)/);
          return match && parseInt(match[1], 10) === 5;
        }) ? 'roaming' : 'registered';
        const operator = await this._queryOperator(moduleId);
        console.log(`[MUX] module=${moduleId} sim=${simId} — ${status} (${operator || 'unknown operator'})`);
        this.emit('switch:registered', { moduleId, simId, status, operator });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, CONFIG.REGISTRATION_POLL_INTERVAL_MS));
    }

    console.error(`[MUX] module=${moduleId} sim=${simId} — registration timeout`);
    const { simUnreadable } = await this._diagnoseRegFailure(moduleId, simId);
    if (simUnreadable) {
      // The modem can't talk to the card (CPIN: SIM failure / not inserted) —
      // a bad contact in this slot, not a network problem. Throw a marked
      // error so the dashboard shows "SIM error" instead of a generic "Error",
      // and skip switch:timeout (which would flash 'error' first).
      throw new Error(`SIM_FAILURE: modem cannot communicate with the card in module ${moduleId} sim ${simId} (bad slot contact)`);
    }
    this.emit('switch:timeout', { moduleId, simId });
    throw new Error(`Registration timeout for module ${moduleId} sim ${simId}`);
  }

  /**
   * On a registration failure, query the modem for the reason so the log can
   * distinguish a SIM/account problem from a coverage problem:
   *   - AT+CEER → last network reject cause (e.g. "IMSI unknown in HLR",
   *     "PLMN not allowed", "roaming not allowed" → dead/barred/unprovisioned
   *     SIM; "No suitable cells"/"network failure" → coverage).
   *   - AT+CPIN? → SIM presence/ready (NOT INSERTED/SIM failure → bad card).
   *   - AT+CSQ → signal, to rule coverage in/out.
   * Best-effort; never throws.
   * @param {number} moduleId
   * @param {number} simId
   * @returns {Promise<{ simUnreadable: boolean }>} simUnreadable = the modem
   *   couldn't read the SIM (CPIN: SIM failure / not inserted) — a slot/contact
   *   issue rather than a network one.
   * @private
   */
  async _diagnoseRegFailure(moduleId, simId) {
    const probe = async (cmd) => {
      try {
        const lines = await sendATAndCollect(moduleId, cmd, 4000);
        return lines.filter((l) => l && l !== 'OK' && l !== cmd.trim()).join(' ');
      } catch (err) {
        return `(${err.message})`;
      }
    };
    const ceer = await probe('AT+CEER\r\n');
    const cpin = await probe('AT+CPIN?\r\n');
    const csq = await probe('AT+CSQ\r\n');
    const simUnreadable = /SIM failure|not inserted|not ready|SIM busy|CME ERROR:\s*1[0-3]\b/i.test(cpin);
    console.warn(
      `[MUX] module=${moduleId} sim=${simId} — reg-fail diagnosis: ` +
      `CEER=[${ceer}] CPIN=[${cpin}] CSQ=[${csq}]. ` +
      (simUnreadable
        ? `→ SIM unreadable (CPIN error) = bad card/contact in this slot, NOT the network.`
        : `If CEER shows IMSI/PLMN/roaming-not-allowed → SIM not provisioned/barred (network rejects it); ` +
          `if signal is strong but it still won't attach, the card/account is the cause, not coverage.`)
    );
    return { simUnreadable };
  }

  /**
   * Query the current network operator name via AT+COPS?.
   * Returns the long alphanumeric operator string, or empty string if unavailable.
   * @returns {Promise<string>}
   * @private
   */
  async _queryOperator(moduleId) {
    try {
      const lines = await sendATAndCollect(moduleId, AT_COMMANDS.GET_OPERATOR);
      for (const line of lines) {
        if (line.includes(AT_RESPONSE_PATTERNS.COPS_PREFIX)) {
          // +COPS: <mode>,<format>,"<oper>"[,<AcT>]
          const match = line.match(/\+COPS:\s*\d+,\d+,"([^"]*)"/);
          if (match) return match[1];
        }
      }
    } catch (_) {
      // Non-fatal — operator name is informational only
    }
    return '';
  }

  /**
   * Enqueue a SIM selection with no subsequent operation.
   * @param {number} moduleId
   * @param {number} simId
   * @returns {Promise<void>}
   */
  selectSim(moduleId, simId) {
    return this.selectAndRun(moduleId, simId, () => Promise.resolve());
  }

  /**
   * @param {number} moduleId
   * @returns {number | undefined}
   */
  getSelectedSim(moduleId) {
    return this._selectedSim.get(moduleId);
  }

  /**
   * Drop the cached MUX selection for a module. Call this when the radio
   * has been powered off (deselect / CFUN=0) so the next selectSim doesn't
   * short-circuit on the stale cache hit and skip the CFUN=1 + registration
   * polling — without this, deselect → re-select on the same SIM leaves the
   * radio off forever and the dashboard stuck at "Unknown".
   * @param {number} moduleId
   */
  clearSelected(moduleId) {
    this._selectedSim.delete(moduleId);
    this._switchGen.set(moduleId, (this._switchGen.get(moduleId) || 0) + 1);
  }

  /**
   * Current switch generation for a module. Increments on every MUX switch
   * and deselect. An async consumer captures this when it issues a request
   * and re-checks it when the reply lands — a mismatch means the SIM rotated
   * meanwhile and the reply is stale.
   * @param {number} moduleId
   * @returns {number}
   */
  getSwitchGeneration(moduleId) {
    return this._switchGen.get(moduleId) || 0;
  }

  /**
   * @returns {Object<string, number>}
   */
  getAllSelected() {
    const result = {};
    for (const [moduleId, simId] of this._selectedSim) {
      result[moduleId] = simId;
    }
    return result;
  }
}

const muxService = new MuxService();
module.exports = { muxService };
