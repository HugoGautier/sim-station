/**
 * @fileoverview All AT command strings used to communicate with SIM7600X modules.
 * No AT command should appear anywhere else in the codebase.
 */

/** @enum {string} */
const AT_COMMANDS = {
  /** Check module is alive */
  AT: 'AT\r\n',

  /** Enable unsolicited GSM network registration notifications */
  ENABLE_CREG: 'AT+CREG=1\r\n',

  /** Query GSM network registration status */
  CHECK_REGISTRATION: 'AT+CREG?\r\n',

  /** Enable unsolicited LTE/EPS network registration notifications (SIM7600 is LTE-first) */
  ENABLE_CEREG: 'AT+CEREG=1\r\n',

  /** Query LTE/EPS network registration status */
  CHECK_CEREG: 'AT+CEREG?\r\n',

  /** Set SMS text mode */
  SMS_TEXT_MODE: 'AT+CMGF=1\r\n',

  /** Force UTF-8 charset — prevents UCS2-encoded headers in +CMGR/+CMT */
  CHARSET_UTF8: 'AT+CSCS="UTF-8"\r\n',

  /** List all SMS messages */
  LIST_ALL_SMS: 'AT+CMGL="ALL"\r\n',

  /** List unread SMS messages */
  LIST_UNREAD_SMS: 'AT+CMGL="REC UNREAD"\r\n',

  /** Answer incoming call */
  ANSWER_CALL: 'ATA\r\n',

  /** Hang up current call */
  HANGUP_CALL: 'ATH\r\n',

  /** Hang up call unconditionally — used before MUX switch to clear any active/ringing call */
  CHUP: 'AT+CHUP\r\n',

  /**
   * Send DTMF tone — requires digit to be appended.
   * Usage: `DTMF_PREFIX + digit + '\r\n'`
   */
  DTMF_PREFIX: 'AT+VTS=',

  /** Power off radio and SIM — must be sent before MUX switch (5s timeout) */
  CFUN_OFF: 'AT+CFUN=0\r\n',

  /** Power on radio and SIM — must be sent after MUX switch (10s timeout) */
  CFUN_ON: 'AT+CFUN=1\r\n',

  /** Query current network operator (long alphanumeric format) */
  GET_OPERATOR: 'AT+COPS?\r\n',

  /**
   * Send a USSD request — append the code and closing suffix.
   * Usage: `CUSD_PREFIX + ussdCode + CUSD_SUFFIX`
   */
  CUSD_PREFIX: 'AT+CUSD=1,"',
  CUSD_SUFFIX: '"\r\n',

  /** Query preferred message storage (returns used/total counts) */
  CHECK_SMS_STORAGE: 'AT+CPMS?\r\n',

  /** Query signal quality */
  SIGNAL_QUALITY: 'AT+CSQ\r\n',

  /** Query SIM card status */
  SIM_STATUS: 'AT+CPIN?\r\n',

  /** Enable caller ID presentation */
  ENABLE_CLIP: 'AT+CLIP=1\r\n',

  /** Enable new SMS storage notification via +CMTI (index-based, universally supported) */
  ENABLE_CNMI: 'AT+CNMI=2,1,0,0,0\r\n',

  /**
   * Read a single SMS by index — append index + '\r\n'.
   * Usage: `READ_SMS_PREFIX + index + '\r\n'`
   */
  READ_SMS_PREFIX: 'AT+CMGR=',

  /** Delete all SMS from SIM storage */
  DELETE_ALL_SMS: 'AT+CMGD=1,4\r\n',

  /** Activate PCM audio stream on SIM7600X — sent via SimCom AT port when call becomes active */
  CPCMREG_ON: 'AT+CPCMREG=1\r\n',

  /** Deactivate PCM audio stream on SIM7600X — sent via SimCom AT port when call ends */
  CPCMREG_OFF: 'AT+CPCMREG=0\r\n',
};

/** @enum {string} Patterns found in AT responses */
const AT_RESPONSE_PATTERNS = {
  OK: 'OK',
  ERROR: 'ERROR',
  RING: 'RING',
  NO_CARRIER: 'NO CARRIER',
  CREG_PREFIX: '+CREG:',
  CGREG_PREFIX: '+CGREG:',
  CEREG_PREFIX: '+CEREG:',
  CMGL_PREFIX: '+CMGL:',
  CMT_PREFIX: '+CMT:',
  CLIP_PREFIX: '+CLIP:',
  CMTI_PREFIX: '+CMTI:',
  CMGR_PREFIX: '+CMGR:',
  COPS_PREFIX: '+COPS:',
  CPMS_PREFIX: '+CPMS:',
  CUSD_PREFIX: '+CUSD:',
  CSQ_PREFIX: '+CSQ:',
  CPIN_PREFIX: '+CPIN:',
};

module.exports = { AT_COMMANDS, AT_RESPONSE_PATTERNS };
