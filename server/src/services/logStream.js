/**
 * @fileoverview In-process log capture — monkey-patches console.{log,info,warn,error}
 * to keep a ring buffer of recent lines and emit a 'log' event per entry.
 * The original console functions still fire so the terminal output is unchanged.
 *
 * Side effect: every captured line is also appended to a debug log file
 * (server/server.log), with PII (phone numbers, IMEIs, generated names)
 * redacted via logRedact. The file is truncated on each server start so
 * its content always reflects the latest run; a closeFile() hook flushes
 * pending writes during graceful shutdown.
 *
 * Require this module early in the entry point (before any service that logs)
 * so no startup lines are missed.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { redact } = require('./logRedact');

const BUFFER_MAX = 500;
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
/** @type {{ ts: number, level: 'info'|'warn'|'error', message: string }[]} */
const buffer = [];

const LOG_FILE = path.resolve(__dirname, '..', '..', 'server.log');

/** @type {fs.WriteStream | null} */
let fileStream = null;
try {
  // Truncate ('w') so each run starts fresh — easier to share with
  // collaborators (you only see logs since the last server start).
  fileStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  fileStream.on('error', () => {
    fileStream = null; // disable on error rather than crashing
  });
} catch {
  fileStream = null;
}

/**
 * Format a single log entry into one redacted line for the file.
 * @param {{ ts: number, level: string, message: string }} entry
 * @returns {string}
 */
function formatForFile(entry) {
  const ts = new Date(entry.ts).toISOString();
  const lvl = entry.level.toUpperCase().padEnd(5);
  return `${ts} ${lvl} ${redact(entry.message)}\n`;
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  if (a === undefined) return 'undefined';
  if (a === null) return 'null';
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function push(level, args) {
  const message = args.map(formatArg).join(' ');
  const entry = { ts: Date.now(), level, message };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  emitter.emit('log', entry);
  if (fileStream) {
    try { fileStream.write(formatForFile(entry)); } catch { /* swallow */ }
  }
}

const orig = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

console.log = (...args) => { orig.log(...args); push('info', args); };
console.info = (...args) => { orig.info(...args); push('info', args); };
console.warn = (...args) => { orig.warn(...args); push('warn', args); };
console.error = (...args) => { orig.error(...args); push('error', args); };

/**
 * Flush and close the file stream. Returns a promise that resolves when
 * the OS confirms the buffer is on disk. Safe to call multiple times.
 * @returns {Promise<void>}
 */
function closeFile() {
  return new Promise((resolve) => {
    if (!fileStream) return resolve();
    const stream = fileStream;
    fileStream = null;
    stream.end(resolve);
  });
}

module.exports = {
  /** @returns {{ ts: number, level: 'info'|'warn'|'error', message: string }[]} */
  getBuffer: () => buffer.slice(),
  on: (event, listener) => emitter.on(event, listener),
  off: (event, listener) => emitter.off(event, listener),
  closeFile,
  LOG_FILE,
};
