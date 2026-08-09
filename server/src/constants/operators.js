/**
 * @fileoverview Per-operator network configuration for SIM7600 data sessions.
 *
 * Each operator entry is merged over DEFAULT_CONFIG and drives every
 * AT command simcomService.startDataSession needs: APN, PDP type, CGAUTH
 * credentials, preferred radio mode (CNMP), preferred bands (CNBP), and
 * any operator-specific post-attach quirks.
 *
 * ## CNBP masks — SIM7600E-H bit layout
 *
 * The 64-bit LTE mask maps band N to bit (N-1):
 *   B1  = 0x1          B8  = 0x80         B20 = 0x80000
 *   B3  = 0x4          B7  = 0x40         B28 = 0x8000000
 * EU-relevant combined mask: 0x00000000080800C5 (B1+B3+B7+B8+B20+B28).
 * Factory LTE is `0x3F` = B1-B6 only — excludes B20 (800 MHz, common French
 * rural/indoor coverage) and B28 (700 MHz). Widening to include B20 is
 * often the difference between "no LTE here" and "LTE attaches".
 *
 * ⚠️ Firmware-width gotcha on newer SIM7600E-H builds (LE11B13/M22+):
 * `AT+CNBP?` read returns the WCDMA field as a **256-bit** value while GSM
 * and LTE stay 64-bit. Writes are rejected unless all three fields match
 * the *exact* widths the firmware uses internally. Two consequences:
 *   - Don't force a 64-bit WCDMA mask: leave cnbpWcdmaMask null and the
 *     code reads + re-emits the firmware's current value verbatim.
 *   - Same for GSM — factory coverage is fine for EU, null is safer.
 *   - Only the LTE field (64-bit on every SIM7600 variant) is safe to
 *     override with a canonical short mask.
 *
 * ## CNMP modes (SIM7600E-H)
 *
 *   2  — Auto
 *   13 — GSM only
 *   14 — WCDMA only
 *   38 — LTE only (needs VoLTE/IMS for voice — SIM7600 MBN flash required)
 *   51 — GSM + LTE (LTE data + CSFB voice — default)
 *   54 — GSM + WCDMA + LTE (adds 3G fallback; class A voice+data on 3G)
 *
 * ⚠️ The `+CNMP=?` supported list advertises modes 9/10/22/59/60/63/67 as
 * well — these are CDMA/EVDO/TDS-CDMA modes only present on the E-H's sibling
 * variants (CE for China, SA for NA). The firmware lists them but rejects
 * writes at the RIL layer. Stick to modes 2, 13, 14, 19, 38, 39, 48, 51, 54.
 *
 * ## Voice + data concurrency
 *
 * Three RATs, three concurrency profiles:
 *   - LTE    → combined EPS/IMSI attach (CSFB) lets voice + data coexist
 *   - WCDMA  → class A native, voice + data always simultaneous
 *   - GSM    → class B, voice XOR data — calls go to voicemail while a PDP
 *              context is actively transferring. Unsuitable for reliable
 *              remote-PC scenarios that need both.
 *
 * The `requireNonGsm` flag on each operator config gates the data session:
 * when true, `startDataSession` refuses to proceed if the modem only managed
 * to attach to GSM. Default is false — GSM data is allowed with a warning,
 * accepting that incoming voice calls may go to voicemail while a PDP
 * context is actively transferring. Set true per-operator for strict
 * voice-first behavior.
 */

/** @typedef {{
 *   copsName: string,
 *   numberCode: string | null,
 *   apn: string,
 *   pdpType: 'IP' | 'IPV4V6' | 'IPV6',
 *   authUser: string | null,
 *   authPass: string | null,
 *   authType: 0 | 1 | 2,
 *   cnmp: number | null,
 *   cnbpGsmMask: string | null,
 *   cnbpWcdmaMask: string | null,
 *   cnbpLteMask: string | null,
 *   csfb: boolean,
 *   volte: boolean,
 *   requireNonGsm: boolean,
 *   postAttachCmds: string[],
 * }} OperatorConfig */

/**
 * Defaults merged under every operator entry. EU-oriented: prefers LTE with
 * GSM retained for CSFB voice; widens LTE bands to include B20/B28 which the
 * SIM7600 factory mask (0x3F) excludes.
 * @type {OperatorConfig}
 */
const DEFAULT_CONFIG = {
  copsName: '',
  numberCode: null,
  apn: 'internet',
  pdpType: 'IP',
  authUser: null,
  authPass: null,
  authType: 0,
  cnmp: 54,
  cnbpGsmMask: null,
  cnbpWcdmaMask: null,
  cnbpLteMask: '0x00000000080800C5',
  csfb: true,
  volte: false,
  requireNonGsm: false,
  postAttachCmds: [],
};

/** @type {OperatorConfig[]} */
const OPERATORS = [
  {
    copsName: 'LycaMobile LycaMobile',
    numberCode: '*132#',
    apn: 'data.lycamobile.fr',
    pdpType: 'IP',
    authUser: 'lmfr',
    authPass: 'plus',
    authType: 1,
    cnmp: 54,
    cnbpGsmMask: null,
    cnbpWcdmaMask: null,
    cnbpLteMask: '0x00000000080800C5',
    csfb: true,
    volte: false,
    requireNonGsm: false,
    postAttachCmds: [],
  },
];

/**
 * Return the fully-populated config for a given AT+COPS? name. Falls back to
 * DEFAULT_CONFIG when the operator isn't in the list — a best-effort attempt
 * with the generic 'internet' APN. copsName is always echoed into the result
 * so callers can log which operator was resolved.
 * @param {string} copsName
 * @returns {OperatorConfig}
 */
function getOperatorConfig(copsName) {
  const op = OPERATORS.find((o) => o.copsName === copsName);
  return { ...DEFAULT_CONFIG, ...(op || {}), copsName: copsName || '' };
}

/**
 * Thin wrapper used by the USSD number-query flow (keeps the older import
 * site in socketHandler working without forcing callers to unwrap the full
 * config just for this one field).
 * @param {string} copsName
 * @returns {string | null}
 */
function getUssdCode(copsName) {
  return getOperatorConfig(copsName).numberCode;
}

module.exports = { OPERATORS, DEFAULT_CONFIG, getOperatorConfig, getUssdCode };
