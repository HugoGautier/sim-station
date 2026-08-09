/**
 * @fileoverview Central configuration constants.
 * Values are loaded from environment variables with sensible defaults.
 */

require('dotenv').config();

const CONFIG = {
  /** Serial baud rate */
  BAUD_RATE: parseInt(process.env.BAUD_RATE, 10) || 115200,

  /** HTTP server port */
  PORT: parseInt(process.env.PORT, 10) || 3001,

  /** Timeout (ms) waiting for MUX_OK after sending MUX command */
  MUX_TIMEOUT_MS: 3000,

  /** Timeout (ms) waiting for AT command response */
  AT_RESPONSE_TIMEOUT_MS: 5000,

  /** Timeout (ms) for AT+CMGL (listing SMS can be slow with many stored messages) */
  CMGL_TIMEOUT_MS: 30000,

  /** Delay (ms) after port open before sending the first TOPOLOGY_REQUEST.
   *  Accounts for Arduino reset triggered by DTR on serial connect (~1-2s boot). */
  TOPOLOGY_REQUEST_DELAY_MS: parseInt(process.env.TOPOLOGY_REQUEST_DELAY_MS, 10) || 2000,

  /** Interval (ms) between TOPOLOGY_REQUEST retries until a response is received */
  TOPOLOGY_RETRY_INTERVAL_MS: 5000,

  /** Delay (ms) after MUX switch before sending AT command */
  POST_MUX_DELAY_MS: 200,

  /** Timeout for AT+CHUP (hang up before switch — result is ignored) */
  CHUP_TIMEOUT_MS: 2000,

  /** Timeout for AT+CFUN=0 (radio off can take up to 3s) */
  CFUN0_TIMEOUT_MS: 5000,

  /** Timeout for AT+CFUN=1 (radio on can take up to 5s, but allow more) */
  CFUN1_TIMEOUT_MS: 10000,

  /** Minimum settle time (ms) for the MUX hardware after physical switch */
  MUX_SETTLE_MS: 500,

  /** Interval (ms) between registration polls after CFUN=1 */
  REGISTRATION_POLL_INTERVAL_MS: 2000,

  /** Total timeout (ms) waiting for SIM to register after switch */
  REGISTRATION_TIMEOUT_MS: 60000,

  /** Maximum SMS messages to keep in memory per SIM */
  MAX_SMS_HISTORY: 100,

  /** Interval (ms) between reconnection attempts after serial port loss */
  SERIAL_RECONNECT_INTERVAL_MS: parseInt(process.env.SERIAL_RECONNECT_INTERVAL_MS, 10) || 5000,

  /** Client origin for CORS */
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  /** Dashboard password — set in .env to enable auth. Empty = no auth. */
  AUTH_PASSWORD: process.env.AUTH_PASSWORD || '',

  /** whisper.cpp CLI binary path. Empty = server-side transcription disabled
   *  (the client's in-browser Vosk fallback runs instead). */
  WHISPER_CLI_PATH: process.env.WHISPER_CLI_PATH || '',

  /** whisper.cpp ggml model file path. */
  WHISPER_MODEL_PATH: process.env.WHISPER_MODEL_PATH || '',

  /** Language hint for whisper.cpp ("fr", "en", "auto", ...). */
  WHISPER_LANG: process.env.WHISPER_LANG || 'fr',

  /** Seconds of audio whisper.cpp sees per invocation. */
  WHISPER_WINDOW_SEC: parseInt(process.env.WHISPER_WINDOW_SEC, 10) || 5,

  /** How often (ms) whisper.cpp runs on the current window. */
  WHISPER_INTERVAL_MS: parseInt(process.env.WHISPER_INTERVAL_MS, 10) || 1500,
};

module.exports = { CONFIG };
