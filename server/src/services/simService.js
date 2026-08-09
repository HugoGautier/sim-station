/**
 * @fileoverview High-level SIM card operations — registration checks, SMS retrieval,
 * call control, and DTMF. Each function first selects the correct SIM via muxService,
 * then sends the appropriate AT command via serialService, and returns parsed results.
 */

const { muxService } = require('./muxService');
const { sendATAndCollect, isAtBusy } = require('./atService');
const { AT_COMMANDS, AT_RESPONSE_PATTERNS } = require('../constants/atCommands');
const { CONFIG } = require('../constants/config');

/** @type {((moduleId: number, simId: number, phoneNumber: string) => void) | null} */
let _onNewPhone = null;

/**
 * Register a callback fired exactly once per new phone number stored.
 * @param {(moduleId: number, simId: number, phoneNumber: string) => void} fn
 */
function onPhoneNumber(fn) {
  _onNewPhone = fn;
}

/**
 * Store a phone number and fire the callback if the number is new.
 * Single write-path — every code path that discovers a number calls this.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} normalized
 */
function storePhone(moduleId, simId, normalized) {
  const key = simKey(moduleId, simId);
  const prev = phoneNumberStore.get(key);
  phoneNumberStore.set(key, normalized);
  if (prev !== normalized && _onNewPhone) {
    _onNewPhone(moduleId, simId, normalized);
  }
}

/**
 * Strip country code from a phone number → "601020304".
 * @param {string} raw
 * @returns {string}
 */
function normalizePhone(raw) {
  let n = raw.replace(/\s+/g, '');
  n = n.replace(/^\+/, '');
  n = n.replace(/^00/, '');
  // Strip country code (e.g. 33) if number is too long for local format
  if (n.length > 9 && /^33[1-9]/.test(n)) {
    n = n.slice(2);
  }
  n = n.replace(/^0/, '');
  return n;
}

/**
 * In-memory SMS storage per SIM, keyed by "moduleId:simId".
 * @type {Map<string, Array<{ index: number, status: string, sender: string, timestamp: string, body: string }>>}
 */
const smsStore = new Map();

/**
 * Call state per SIM, keyed by "moduleId:simId".
 * @type {Map<string, { state: 'idle' | 'incoming' | 'active', callerNumber: string, startTime: number | null }>}
 */
const callStateStore = new Map();

/**
 * Registration status per SIM, keyed by "moduleId:simId".
 * @type {Map<string, 'unknown' | 'searching' | 'registered' | 'roaming' | 'error'>}
 */
const statusStore = new Map();

/**
 * Rolling history of registration-status transitions per SIM, keyed by
 * "moduleId:simId" → array of { t: epochMs, status }. Used to detect an
 * UNSTABLE registration: a SIM rapidly flipping home↔roaming (CREG 1↔5)
 * or in/out of registered. This matters because while the modem is
 * re-running location updates on every flip, the network's VLR↔HLR paging
 * binding is briefly stale — an incoming call/SMS (MT) that lands in one of
 * those windows is silently dropped by the network and never reaches the
 * modem (no RING / no +CMTI). A SIM that SETTLES to a stable 'registered'
 * receives MT reliably; one that keeps oscillating drops MT intermittently.
 * This is the observed cause of "registers fine but no incoming calls/SMS".
 * @type {Map<string, Array<{ t: number, status: string }>>}
 */
const regHistoryStore = new Map();

/** Rolling window over which registration flips are counted. */
const REG_FLIP_WINDOW_MS = 60000;
/** Flips within the window at/above which a registration is deemed unstable. */
const REG_UNSTABLE_FLIPS = 4;

/**
 * Network operator name per SIM, keyed by "moduleId:simId".
 * @type {Map<string, string>}
 */
const operatorStore = new Map();

/**
 * Own phone number per SIM (retrieved via USSD), keyed by "moduleId:simId".
 * @type {Map<string, string>}
 */
const phoneNumberStore = new Map();

/**
 * Build a composite key for per-SIM storage.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {string}
 */
function simKey(moduleId, simId) {
  return `${moduleId}:${simId}`;
}

/**
 * Select the correct SIM via the serialized queue, wait for MUX stabilization,
 * then send a single AT command and collect its response.
 * Routing through muxService.selectAndRun() ensures no two operations on the
 * same module ever overlap on the UART.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} command - AT command string
 * @returns {Promise<string[]>}
 */
function selectAndSend(moduleId, simId, command, timeoutMs) {
  return muxService.selectAndRun(moduleId, simId, async () => {
    await new Promise((resolve) => setTimeout(resolve, CONFIG.POST_MUX_DELAY_MS));
    return sendATAndCollect(moduleId, command, timeoutMs);
  });
}

/**
 * Parse +CREG response lines into a registration status string.
 * Handles both query format (+CREG: <n>,<stat>) and unsolicited format (+CREG: <stat>).
 * stat=1 → registered, stat=5 → roaming, stat=2 → searching, stat=3 → error.
 *
 * @param {string[]} lines
 * @returns {'unknown' | 'searching' | 'registered' | 'roaming' | 'error'}
 */
function parseRegistrationStatus(lines) {
  for (const line of lines) {
    if (line.includes(AT_RESPONSE_PATTERNS.CREG_PREFIX)) {
      const match = line.match(/:\s*(?:\d+,\s*)?(\d+)/);
      if (match) {
        const stat = parseInt(match[1], 10);
        switch (stat) {
          case 1: console.log(`[SIM] +CREG stat=1 → registered`); return 'registered';
          case 5: console.log(`[SIM] +CREG stat=5 → roaming`);    return 'roaming';
          case 2: console.log(`[SIM] +CREG stat=2 → searching`);  return 'searching';
          case 3: console.log(`[SIM] +CREG stat=3 → error`);      return 'error';
          default: console.log(`[SIM] +CREG stat=${stat} → unknown`); return 'unknown';
        }
      }
    }
  }
  console.warn('[SIM] parseRegistrationStatus: no +CREG line found in:', lines);
  return 'unknown';
}

/**
 * Extract the SMS body from a CMGR response, starting at the line right
 * after the +CMGR header and stopping at the OK / ERROR terminator (or a
 * fresh +CMGR if multiple are concatenated). Multi-line bodies — common
 * for WhatsApp / banking codes that pad with blank lines — are joined
 * with `\n`. Trailing blank lines emitted right before OK are trimmed.
 *
 * @param {string[]} lines
 * @param {number} headerIdx - index of the +CMGR header line
 * @returns {string}
 */
function extractSmsBody(lines, headerIdx) {
  const body = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === 'OK' || l.startsWith('ERROR') || l.startsWith('+CMS ERROR') || l.includes(AT_RESPONSE_PATTERNS.CMGR_PREFIX)) {
      break;
    }
    body.push(l);
  }
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  return body.join('\n');
}

/**
 * Detect and decode UCS2/UTF-16BE hex-encoded SMS bodies.
 * Strips non-hex characters first to handle serial corruption,
 * then decodes if the cleaned string looks like valid UCS2.
 * @param {string} body
 * @returns {string}
 */
function decodeUcs2(body) {
  // Strip non-hex characters (spaces, garbage from serial noise)
  let cleaned = body.replace(/[^0-9A-Fa-f]/g, '');
  // Need at least 8 hex chars (2 UCS2 characters)
  if (cleaned.length < 8) return body;
  // Truncate to multiple of 4 if serial noise added/dropped a char
  if (cleaned.length % 4 !== 0) {
    cleaned = cleaned.substring(0, cleaned.length - (cleaned.length % 4));
    if (cleaned.length < 8) return body;
  }

  // Heuristic 1: check if first few codepoints start with 00 (Basic Latin/Latin-1)
  const sample = Math.min(4, cleaned.length / 4);
  let latinCount = 0;
  for (let i = 0; i < sample; i++) {
    if (cleaned.substring(i * 4, i * 4 + 2) === '00') latinCount++;
  }

  if (latinCount < sample / 2) return body;

  let decoded = '';
  for (let i = 0; i < cleaned.length; i += 4) {
    const code = parseInt(cleaned.substring(i, i + 4), 16);
    if (code === 0) continue; // skip null chars from corruption
    decoded += String.fromCharCode(code);
  }
  return decoded;
}


/**
 * Check GSM network registration status for a SIM via AT+CREG?.
 * SMS delivery requires only circuit-switched (GSM) registration — AT+CEREG
 * (LTE/EPS) is not needed and is omitted.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<'unknown' | 'searching' | 'registered' | 'roaming' | 'error'>}
 */
async function checkRegistration(moduleId, simId) {
  const lines = await muxService.selectAndRun(moduleId, simId, async () => {
    await new Promise((resolve) => setTimeout(resolve, CONFIG.POST_MUX_DELAY_MS));
    return sendATAndCollect(moduleId, AT_COMMANDS.CHECK_REGISTRATION);
  });
  const status = parseRegistrationStatus(lines);
  statusStore.set(simKey(moduleId, simId), status);
  return status;
}

/**
 * Retrieve all SMS messages stored on a SIM.
 * SMS_TEXT_MODE and LIST_ALL_SMS run inside one selectAndRun slot so no
 * concurrent operation can switch the MUX between the two AT commands.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<Array<{ index: number, status: string, sender: string, timestamp: string, body: string }>>}
 */
async function getSms(moduleId, simId) {
  const messages = await muxService.selectAndRun(moduleId, simId, async () => {
    await new Promise((resolve) => setTimeout(resolve, CONFIG.POST_MUX_DELAY_MS));
    await sendATAndCollect(moduleId, AT_COMMANDS.SMS_TEXT_MODE);
    await sendATAndCollect(moduleId, AT_COMMANDS.CHARSET_UTF8);

    // Get storage capacity via AT+CPMS? to know how many slots to scan.
    // Response: +CPMS: "SM",used,total,"SM",used,total,"SM",used,total
    let maxIndex = 30; // fallback
    try {
      const cpmsLines = await sendATAndCollect(moduleId, AT_COMMANDS.CHECK_SMS_STORAGE);
      for (const l of cpmsLines) {
        if (l.includes(AT_RESPONSE_PATTERNS.CPMS_PREFIX)) {
          const m = l.match(/\+CPMS:\s*"[^"]*",(\d+),(\d+)/);
          if (m) {
            const used = parseInt(m[1], 10);
            const total = parseInt(m[2], 10);
            maxIndex = total;
            console.log(`[SMS] Storage: ${used}/${total} slots used`);
            if (used === 0) return [];
          }
        }
      }
    } catch (_) { /* use fallback */ }

    // Read SMS one by one — each AT+CMGR is small and fast, no buffer overflow.
    const fetched = [];
    for (let idx = 0; idx <= maxIndex; idx++) {
      try {
        const lines = await sendATAndCollect(moduleId, `${AT_COMMANDS.READ_SMS_PREFIX}${idx}\r\n`);
        // Empty slot returns just OK or ERROR — skip
        const headerLine = lines.find((l) => l.includes(AT_RESPONSE_PATTERNS.CMGR_PREFIX));
        if (!headerLine) continue;

        const meta = headerLine.match(/\+CMGR:\s*"([^"]*)","([^"]*)","[^"]*","([^"]*)"/);
        const headerIdx = lines.indexOf(headerLine);
        const rawBody = extractSmsBody(lines, headerIdx);

        fetched.push({
          index: idx,
          status: meta ? meta[1] : 'REC READ',
          sender: meta ? decodeUcs2(meta[2]) : '',
          timestamp: meta ? meta[3] : '',
          body: decodeUcs2(rawBody),
        });
      } catch (_) {
        // Timeout on a single read — skip this index
      }
    }
    return fetched;
  });

  const key = simKey(moduleId, simId);
  const existing = smsStore.get(key) || [];
  const existingIndices = new Set(existing.map((m) => m.index));
  for (const msg of messages) {
    if (!existingIndices.has(msg.index)) {
      existing.push(msg);
    }
  }
  if (existing.length > CONFIG.MAX_SMS_HISTORY) {
    existing.splice(0, existing.length - CONFIG.MAX_SMS_HISTORY);
  }
  smsStore.set(key, existing);

  // Keep only the 10 most recent SMS on the SIM to prevent +SMS FULL
  const SIM_KEEP = 10;
  if (messages.length > SIM_KEEP) {
    const toDelete = messages.slice(0, messages.length - SIM_KEEP);
    await muxService.selectAndRun(moduleId, simId, async () => {
      for (const msg of toDelete) {
        await sendATAndCollect(moduleId, `AT+CMGD=${msg.index}\r\n`);
      }
      console.log(`[SMS] Cleaned ${toDelete.length} old SMS from SIM storage (kept ${SIM_KEEP})`);
    });
  }

  return existing;
}

/**
 * Answer an incoming call on a SIM.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<boolean>} true if answered successfully
 */
async function answerCall(moduleId, simId) {
  // ATA can take 10-20s on LTE/CSFB while the voice channel is being set up.
  // Default 5s timeout would routinely fire before the modem replies — give
  // it a generous 30s. We also swallow any thrown timeout: returning false
  // lets the caller (handleSimAnswer) report "answer failed" without
  // propagating an exception that would bubble up as a SIM_STATUS error
  // and bleed onto the SIM card UI.
  let lines;
  try {
    lines = await selectAndSend(moduleId, simId, AT_COMMANDS.ANSWER_CALL, 30000);
  } catch (err) {
    console.warn(`[CALL] module=${moduleId} sim=${simId}: ATA timed out — ${err.message}`);
    return false;
  }
  const success = lines.some((l) => l.includes(AT_RESPONSE_PATTERNS.OK));
  if (success) {
    const key = simKey(moduleId, simId);
    const current = callStateStore.get(key) || { state: 'idle', callerNumber: '', startTime: null };
    callStateStore.set(key, { ...current, state: 'active', startTime: Date.now() });
  }
  return success;
}

/**
 * Hang up the current call on a SIM.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<boolean>} true if hung up successfully
 */
async function hangupCall(moduleId, simId) {
  const lines = await selectAndSend(moduleId, simId, AT_COMMANDS.CHUP);
  const success = lines.some((l) => l.includes(AT_RESPONSE_PATTERNS.OK));
  if (success) {
    const key = simKey(moduleId, simId);
    callStateStore.set(key, { state: 'idle', callerNumber: '', startTime: null });
  }
  return success;
}

/**
 * Power down the radio for a module via AT+CFUN=0. Used when the user
 * deselects the currently-active SIM — the MUX channel stays put but the
 * radio stops, so calls/SMS won't fire and the dashboard's status display
 * isn't lying about a SIM being "registered".
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<boolean>}
 */
async function powerOffRadio(moduleId, simId) {
  const lines = await selectAndSend(moduleId, simId, AT_COMMANDS.CFUN_OFF, CONFIG.CFUN0_TIMEOUT_MS);
  return lines.some((l) => l.includes(AT_RESPONSE_PATTERNS.OK));
}

/**
 * Send a DTMF digit during an active call.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} digit - Single character: 0-9, *, #
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendDtmf(moduleId, simId, digit) {
  // Quote the digit. SIM7600 firmware LE20B04 (and likely other revisions)
  // rejects the bare-token form `AT+VTS=0` with ERROR even though the
  // SIMCom AT manual documents it without quotes — observed in logs as
  // immediate (~13 ms) ERROR replies on every DTMF keypress. Quoted form
  // `AT+VTS="0"` is accepted by both strict and lenient revisions.
  const command = `${AT_COMMANDS.DTMF_PREFIX}"${digit}"\r\n`;
  const lines = await selectAndSend(moduleId, simId, command);
  return lines.some((l) => l.includes(AT_RESPONSE_PATTERNS.OK));
}

/**
 * Get stored SMS messages for a SIM (from memory, no AT command).
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Array<{ index: number, status: string, sender: string, timestamp: string, body: string }>}
 */
function getStoredMessages(moduleId, simId) {
  return smsStore.get(simKey(moduleId, simId)) || [];
}

/**
 * Get call state for a SIM.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {{ state: 'idle' | 'incoming' | 'active', callerNumber: string, startTime: number | null }}
 */
function getCallState(moduleId, simId) {
  return callStateStore.get(simKey(moduleId, simId)) || { state: 'idle', callerNumber: '', startTime: null };
}

/**
 * Force-reset a SIM's call state to idle. Used by the socket layer when its
 * incoming-call timeout fires (the modem stopped sending RING but never
 * emitted NO CARRIER, so we infer the caller hung up before pickup).
 * @param {number} moduleId
 * @param {number} simId
 */
function resetCallState(moduleId, simId) {
  callStateStore.set(simKey(moduleId, simId), { state: 'idle', callerNumber: '', startTime: null });
}

/**
 * Get registration status for a SIM (from memory).
 * @param {number} moduleId
 * @param {number} simId
 * @returns {'unknown' | 'searching' | 'registered' | 'roaming' | 'error'}
 */
function getStatus(moduleId, simId) {
  return statusStore.get(simKey(moduleId, simId)) || 'unknown';
}

/**
 * Set registration status for a SIM directly (used by socketHandler to
 * persist status from muxService switch:registered events).
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} status
 */
function setStatus(moduleId, simId, status) {
  statusStore.set(simKey(moduleId, simId), status);
}

/**
 * Record a registration-status transition and report whether the SIM is
 * now oscillating. Called on every confirmed +CREG state change. Prunes the
 * rolling history to REG_FLIP_WINDOW_MS and counts how many transitions fell
 * inside it. The first transition after a (re)selection is NOT a flip — only
 * changes that land while the SIM should already be settled count.
 * @param {string} key
 * @param {string} status
 * @returns {{ flips: number, unstable: boolean }}
 */
function recordRegEvent(key, status) {
  const now = Date.now();
  const hist = (regHistoryStore.get(key) || []).filter((e) => now - e.t < REG_FLIP_WINDOW_MS);
  hist.push({ t: now, status });
  regHistoryStore.set(key, hist);
  // flips = number of transitions in-window beyond the first (a settled SIM
  // contributes one entry and zero flips; an oscillating one accumulates).
  const flips = Math.max(0, hist.length - 1);
  return { flips, unstable: flips >= REG_UNSTABLE_FLIPS };
}

/**
 * Registration-stability snapshot for a SIM: how many CREG transitions
 * happened in the last REG_FLIP_WINDOW_MS and whether that crosses the
 * "unstable" threshold. An unstable registration is the prime suspect when
 * a SIM registers but receives no incoming calls/SMS (MT dropped by the
 * network during repeated location updates).
 * @param {number} moduleId
 * @param {number} simId
 * @returns {{ flips: number, unstable: boolean }}
 */
function getRegStability(moduleId, simId) {
  const now = Date.now();
  const hist = (regHistoryStore.get(simKey(moduleId, simId)) || []).filter((e) => now - e.t < REG_FLIP_WINDOW_MS);
  const flips = Math.max(0, hist.length - 1);
  return { flips, unstable: flips >= REG_UNSTABLE_FLIPS };
}

/**
 * Get operator name for a SIM (from memory).
 * @param {number} moduleId
 * @param {number} simId
 * @returns {string}
 */
function getOperator(moduleId, simId) {
  return operatorStore.get(simKey(moduleId, simId)) || '';
}

/**
 * Set operator name for a SIM.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} operator
 */
function setOperator(moduleId, simId, operator) {
  operatorStore.set(simKey(moduleId, simId), operator);
}

/**
 * Extract a phone number from a raw +CUSD response line.
 * Returns the first phone-number-like sequence found in the message body,
 * or the full message body if no number pattern matches.
 * @param {string} line  e.g. +CUSD: 0,"Your number is +33612345678",15
 * @returns {string} extracted phone number, or '' if line doesn't match
 */
function parseUssdPhoneNumber(line) {
  // Only accept CUSD code 0 (valid response) — codes 2/4/5 are errors/timeouts
  const cusdMatch = line.match(/\+CUSD:\s*(\d+),"([^"]*)"/);
  if (!cusdMatch) return '';
  const code = parseInt(cusdMatch[1], 10);
  if (code !== 0) {
    console.log(`[SIM] +CUSD code=${code}, ignoring (not a valid response)`);
    return '';
  }
  let message = cusdMatch[2].trim();
  // Decode UCS2 if needed
  message = decodeUcs2(message);
  const phoneMatch = message.match(/\+?\d[\d ]{5,}\d/);
  return phoneMatch ? phoneMatch[0].replace(/\s/g, '') : '';
}

/**
 * Get own phone number for a SIM (from memory).
 * @param {number} moduleId
 * @param {number} simId
 * @returns {string}
 */
function getPhoneNumber(moduleId, simId) {
  return phoneNumberStore.get(simKey(moduleId, simId)) || '';
}


/**
 * Send a USSD request to retrieve the SIM's own phone number.
 * Parses the +CUSD response synchronously if it arrives before OK,
 * otherwise the unsolicited path in processUnsolicitedLine handles it.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} ussdCode  e.g. '#132*'
 * @returns {Promise<string>} extracted phone number, or '' if not found synchronously
 */
/**
 * Fetch a single SMS by index from the modem and store it.
 * @param {number} moduleId
 * @param {number} simId
 * @param {number} index
 * @returns {Promise<object|null>} the SMS object, or null if not parseable
 */
async function readSms(moduleId, simId, index) {
  const command = `${AT_COMMANDS.READ_SMS_PREFIX}${index}\r\n`;
  const lines = await selectAndSend(moduleId, simId, command);
  let sms = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(AT_RESPONSE_PATTERNS.CMGR_PREFIX)) {
      // +CMGR: "REC UNREAD","<sender>","","<timestamp>"
      const meta = lines[i].match(/\+CMGR:\s*"[^"]*","([^"]*)","[^"]*","([^"]*)"/);
      const rawBody = extractSmsBody(lines, i);
      sms = {
        index,
        status: 'REC UNREAD',
        sender: meta ? decodeUcs2(meta[1]) : '',
        timestamp: meta ? meta[2] : '',
        body: decodeUcs2(rawBody),
      };
      break;
    }
  }
  if (sms) {
    addSmsToStore(moduleId, simId, sms);
  }
  return sms;
}

/**
 * Modules with a USSD phone-number query in flight, keyed by moduleId, valued
 * by the muxService switch-generation captured when the query was sent. The
 * async +CUSD reply (handled in processUnsolicitedLine) only counts if this
 * map still holds the SAME generation — otherwise the SIM rotated since we
 * asked and the reply belongs to a SIM that's no longer MUX-active.
 * @type {Map<number, number>}
 */
const _pendingUssd = new Map();

/**
 * Query a SIM's own phone number. Tries AT+CNUM first (instant, no network);
 * falls back to a USSD request.
 *
 * CRITICAL: the USSD reply is NOT awaited under the per-module serial lock.
 * The previous implementation awaited the async +CUSD line for up to 120s
 * INSIDE the selectAndRun callback, freezing every other select/call/SMS on
 * that module for the whole wait (the root cause of "selection sometimes does
 * nothing / calls not answerable until restart"). Now we only hold the lock
 * long enough to send the request, then return. The reply is captured
 * asynchronously by the global +CUSD handler in processUnsolicitedLine, which
 * stores the number for whichever SIM is MUX-active when it lands — gated by
 * the switch-generation guard so a reply arriving after a SIM rotation is
 * discarded rather than mis-attributed.
 * @param {number} moduleId
 * @param {number} simId
 * @param {string} ussdCode
 * @returns {Promise<string>} the number if AT+CNUM resolved it synchronously,
 *   else '' (the USSD-derived number arrives later via SIM_NUMBER broadcast).
 */
async function queryPhoneNumber(moduleId, simId, ussdCode) {
  return muxService.selectAndRun(moduleId, simId, async () => {
    await new Promise((resolve) => setTimeout(resolve, CONFIG.POST_MUX_DELAY_MS));

    // 1. AT+CNUM — own number straight from the SIM, no network needed.
    try {
      const cnumLines = await sendATAndCollect(moduleId, 'AT+CNUM\r\n');
      for (const l of cnumLines) {
        const m = l.match(/\+CNUM:\s*"[^"]*","(\+?\d+)"/);
        if (m && !/^(\+?\d{1,3})0{6,}$/.test(m[1])) {
          console.log(`[SIM] AT+CNUM returned number: ${m[1]}`);
          const normalized = normalizePhone(m[1]);
          storePhone(moduleId, simId, normalized);
          return normalized;
        }
        if (m) console.log(`[SIM] AT+CNUM returned placeholder ${m[1]}, skipping`);
      }
    } catch (_) { /* not supported, continue to USSD */ }

    // 2. USSD — fire and forget. Cancel any stale session, mark a pending
    // request at the current switch-generation, then send and RETURN. The
    // reply is handled asynchronously (see processUnsolicitedLine).
    try { await sendATAndCollect(moduleId, 'AT+CUSD=2\r\n'); } catch (_) {}
    _pendingUssd.set(moduleId, muxService.getSwitchGeneration(moduleId));
    console.log(`[SIM] USSD request: ${ussdCode} (async — lock released, reply handled on arrival)`);
    const command = `${AT_COMMANDS.CUSD_PREFIX}${ussdCode}${AT_COMMANDS.CUSD_SUFFIX}`;
    try {
      await sendATAndCollect(moduleId, command);
    } catch (err) {
      console.warn(`[SIM] USSD send failed for ${moduleId}:${simId}: ${err.message}`);
      _pendingUssd.delete(moduleId);
    }
    return '';
  });
}

/**
 * Switch to a SIM and wait for it to register.
 * Runs the full hardware-safe sequence via muxService:
 *   AT+CHUP → CFUN=0 → MUX switch → 500ms settle → CFUN=1 → poll CREG.
 * Returns the resulting registration status once the sequence completes.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<'unknown' | 'searching' | 'registered' | 'roaming' | 'error'>}
 */
async function switchSim(moduleId, simId) {
  await muxService.selectSim(moduleId, simId);
  return getStatus(moduleId, simId);
}

/**
 * In-memory signal quality per SIM, keyed by "moduleId:simId".
 * @type {Map<string, number>} rssi value 0-31 (99 = unknown)
 */
const signalStore = new Map();

/**
 * In-memory serving RAT per SIM, keyed by "moduleId:simId". Token is the
 * first field of +CPSI? — "LTE", "WCDMA", "GSM", "NO SERVICE", or "".
 * @type {Map<string, string>}
 */
const networkTypeStore = new Map();

/**
 * Read AT+CPSI? on the currently-MUX-selected SIM and return the serving
 * RAT token. Cached in networkTypeStore so getCachedNetworkType serves the
 * UI without extra AT calls.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<string>}
 */
async function getNetworkType(moduleId, simId) {
  try {
    const lines = await selectAndSend(moduleId, simId, 'AT+CPSI?\r\n');
    for (const line of lines) {
      const m = line.match(/\+CPSI:\s*([A-Z0-9-]+)/);
      if (!m) continue;
      const rat = m[1] === 'NO' ? 'NO SERVICE' : m[1]; // "+CPSI: NO SERVICE"
      networkTypeStore.set(simKey(moduleId, simId), rat);
      return rat;
    }
  } catch (err) {
    console.error(`[SIM] getNetworkType error for ${moduleId}:${simId}:`, err.message);
  }
  return '';
}

/**
 * Get cached serving RAT (no AT call). Empty string if never read or cleared.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {string}
 */
function getCachedNetworkType(moduleId, simId) {
  return networkTypeStore.get(simKey(moduleId, simId)) || '';
}

/**
 * Query signal quality (AT+CSQ) for the currently selected SIM.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {Promise<number>} rssi 0-31, or 99 if unknown
 */
async function getSignal(moduleId, simId) {
  try {
    const lines = await selectAndSend(moduleId, simId, AT_COMMANDS.SIGNAL_QUALITY);
    for (const line of lines) {
      if (line.includes(AT_RESPONSE_PATTERNS.CSQ_PREFIX)) {
        const match = line.match(/\+CSQ:\s*(\d+)/);
        if (match) {
          const rssi = parseInt(match[1], 10);
          signalStore.set(simKey(moduleId, simId), rssi);
          return rssi;
        }
      }
    }
  } catch (err) {
    console.error(`[SIM] getSignal error for ${moduleId}:${simId}:`, err.message);
  }
  return 99;
}

/**
 * Get cached signal quality.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {number}
 */
function getCachedSignal(moduleId, simId) {
  return signalStore.get(simKey(moduleId, simId)) ?? 99;
}

/**
 * Process an unsolicited AT line and update internal state.
 * Returns an event descriptor if the line is meaningful, or null.
 * @param {string} line - Raw AT line from serial
 * @param {number} moduleId - Currently selected module
 * @param {number} simId - Currently selected SIM
 * @returns {{ type: string, moduleId: number, simId: number, data: any } | null}
 */
function processUnsolicitedLine(line, moduleId, simId) {
  const key = simKey(moduleId, simId);

  // +CMTI, +CMT and +CUSD must be processed even during an AT collect window —
  // they arrive asynchronously and can race with any in-flight AT command.
  if (line.includes(AT_RESPONSE_PATTERNS.CMTI_PREFIX)) {
    // +CMTI: "SM",<index>  — modem stored the SMS, we need to fetch it
    const match = line.match(/\+CMTI:\s*"[^"]*",(\d+)/);
    if (match) {
      return { type: 'sms:stored', moduleId, simId, data: { index: parseInt(match[1], 10) } };
    }
    return null;
  }

  // +CMT and +CUSD must be processed even during an AT collect window — they
  // arrive asynchronously and can race with any in-flight AT command.
  if (line.includes(AT_RESPONSE_PATTERNS.CMT_PREFIX)) {
    const cmtMatch = line.match(/\+CMT:\s*"([^"]*)",[^,]*,"([^"]*)"/);
    if (cmtMatch) {
      return {
        type: 'sms:header',
        moduleId,
        simId,
        data: {
          index: -1,
          status: 'REC UNREAD',
          sender: decodeUcs2(cmtMatch[1]),
          timestamp: cmtMatch[2],
          body: '',
        },
      };
    }
    return null;
  }

  if (line.includes(AT_RESPONSE_PATTERNS.CUSD_PREFIX)) {
    // Only accept a +CUSD that answers a query WE issued (queryPhoneNumber
    // registers a pending entry). Anything else is an operator promo / network
    // message we don't want to mine for a "phone number".
    const expectedGen = _pendingUssd.get(moduleId);
    if (expectedGen === undefined) return null;
    // Stale-reply guard: if the SIM rotated (or was deselected) since we sent
    // the query, the switch-generation moved on. Drop the reply rather than
    // attributing this number to the SIM now sitting in the MUX slot.
    if (expectedGen !== muxService.getSwitchGeneration(moduleId)) {
      _pendingUssd.delete(moduleId);
      console.log(`[SIM] +CUSD arrived after SIM rotation on module=${moduleId} — ignoring (stale)`);
      return null;
    }
    _pendingUssd.delete(moduleId);
    console.log(`[SIM] +CUSD received: ${line}`);
    const number = parseUssdPhoneNumber(line);
    if (number) {
      const normalized = normalizePhone(number);
      console.log(`[SIM] phone number extracted: ${normalized}`);
      storePhone(moduleId, simId, normalized);
      return { type: 'phone:number', moduleId, simId, data: { phoneNumber: normalized } };
    }
    return null;
  }

  // RING, CLIP and NO CARRIER must be processed even during an AT collect
  // window — missing an incoming call notification is unacceptable.
  if (line.includes(AT_RESPONSE_PATTERNS.RING) || line.includes(AT_RESPONSE_PATTERNS.CLIP_PREFIX)) {
    let callerNumber = '';
    if (line.includes(AT_RESPONSE_PATTERNS.CLIP_PREFIX)) {
      const clipMatch = line.match(/\+CLIP:\s*"([^"]*)"/);
      if (clipMatch) {
        callerNumber = clipMatch[1];
      }
    }
    const current = callStateStore.get(key) || { state: 'idle', callerNumber: '', startTime: null };
    if (current.state !== 'incoming') {
      callStateStore.set(key, { state: 'incoming', callerNumber, startTime: null });
      return { type: 'call:incoming', moduleId, simId, data: { callerNumber } };
    }
    // Subsequent RING/CLIP while already incoming: heartbeat used by the
    // socket layer to reset its "caller hung up before pickup" timer. The
    // SIM7600 doesn't always emit NO CARRIER in that scenario — it just
    // stops sending RING. Without this signal, the dashboard would keep
    // showing "incoming" forever.
    return { type: 'call:ringing', moduleId, simId, data: {} };
  }

  if (line.includes(AT_RESPONSE_PATTERNS.NO_CARRIER)) {
    callStateStore.set(key, { state: 'idle', callerNumber: '', startTime: null });
    return { type: 'call:ended', moduleId, simId, data: {} };
  }

  // Skip lines that are AT command responses being actively collected —
  // they are not unsolicited notifications.
  if (isAtBusy(moduleId)) return null;

  if (line.includes(AT_RESPONSE_PATTERNS.CREG_PREFIX)) {
    const status = parseRegistrationStatus([line]);
    // Only update state when the unsolicited reports a meaningful change.
    // 'unknown' from a single unsolicited line is not reliable enough to
    // overwrite a previously confirmed registered/roaming state.
    const current = statusStore.get(key) || 'unknown';
    if (status !== 'unknown' || current === 'unknown') {
      // Track registration stability only when the value genuinely changed —
      // a rapid home↔roaming (1↔5) oscillation here is the network re-running
      // location updates, the window in which incoming calls/SMS get dropped.
      if (status !== current) {
        const { flips, unstable } = recordRegEvent(key, status);
        if (unstable) {
          console.warn(
            `[REG-UNSTABLE] module=${moduleId} sim=${simId}: ${flips} registration flips in <${REG_FLIP_WINDOW_MS / 1000}s ` +
            `(now ${status}) — registration not settling; incoming calls/SMS may be dropped by the network`
          );
        }
      }
      statusStore.set(key, status);
      return { type: 'status', moduleId, simId, data: { status } };
    }
    return null;
  }

  return null;
}

/**
 * Add an SMS to the in-memory store for a SIM.
 * @param {number} moduleId
 * @param {number} simId
 * @param {{ index: number, status: string, sender: string, timestamp: string, body: string }} sms
 */
function addSmsToStore(moduleId, simId, sms) {
  const key = simKey(moduleId, simId);
  const messages = smsStore.get(key) || [];
  messages.push(sms);
  if (messages.length > CONFIG.MAX_SMS_HISTORY) {
    messages.splice(0, messages.length - CONFIG.MAX_SMS_HISTORY);
  }
  smsStore.set(key, messages);
}

/**
 * Clear all in-memory data for a SIM slot.
 * Called before activation so stale data from a previous physical SIM is wiped.
 * @param {number} moduleId
 * @param {number} simId
 */
function clearSimData(moduleId, simId) {
  const key = simKey(moduleId, simId);
  smsStore.delete(key);
  operatorStore.delete(key);
  phoneNumberStore.delete(key);
  statusStore.delete(key);
  regHistoryStore.delete(key);
  signalStore.delete(key);
  networkTypeStore.delete(key);
  // Keep callStateStore — an active call shouldn't be wiped
}

module.exports = {
  checkRegistration,
  switchSim,
  getSms,
  answerCall,
  hangupCall,
  sendDtmf,
  getStoredMessages,
  getCallState,
  resetCallState,
  powerOffRadio,
  getStatus,
  setStatus,
  getRegStability,
  getOperator,
  setOperator,
  getPhoneNumber,
  onPhoneNumber,
  queryPhoneNumber,
  readSms,
  processUnsolicitedLine,
  addSmsToStore,
  decodeUcs2,
  getSignal,
  getCachedSignal,
  getNetworkType,
  getCachedNetworkType,
  clearSimData,
};
