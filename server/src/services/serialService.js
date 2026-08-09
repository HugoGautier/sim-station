/**
 * @fileoverview Manages the physical serial (COM) port connection to the Arduino.
 * Emits raw lines via EventEmitter. Provides sendRaw() for writing.
 * Parses TOPOLOGY and MUX_OK prefixes into typed events.
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { EventEmitter } = require('events');
const { CONFIG } = require('../constants/config');
const { SERIAL_COMMANDS, SERIAL_RESPONSES, parseTopology, parseMuxOk, parseModuleLine } = require('../constants/serialProtocol');

/**
 * @typedef {Object} SerialServiceEvents
 * @property {'line'} line        - Raw line from Arduino (non-protocol)
 * @property {'topology'} topology - Parsed topology object
 * @property {'mux_ok'} mux_ok    - Parsed MUX_OK { moduleId, simId }
 * @property {'error'} error      - Serial error
 * @property {'open'} open        - Port opened
 * @property {'close'} close      - Port closed
 */

class SerialService extends EventEmitter {
  constructor() {
    super();
    /** @type {SerialPort | null} */
    this._port = null;
    /** @type {ReadlineParser | null} */
    this._parser = null;
    /** @type {boolean} */
    this._isOpen = false;
    /** @type {string} */
    this._portPath = '';
    /** Write mutex — serializes sendRaw calls to prevent interleaving */
    this._writeLock = Promise.resolve();
  }

  /**
   * Open the serial port and begin listening for data.
   * Sends TOPOLOGY_REQUEST on successful open.
   * @param {string} portPath - Port path returned by auto-detection (e.g., COM3, /dev/ttyUSB0).
   * @returns {Promise<void>}
   */
  open(portPath) {
    this._portPath = portPath;

    return new Promise((resolve, reject) => {
      this._port = new SerialPort({
        path: portPath,
        baudRate: CONFIG.BAUD_RATE,
        autoOpen: false,
      });

      this._parser = this._port.pipe(new ReadlineParser({ delimiter: '\n' }));

      this._parser.on('data', (line) => this._handleLine(line));

      this._port.on('error', (err) => {
        this.emit('error', err);
      });

      this._port.on('close', () => {
        this._isOpen = false;
        this.emit('close');
      });

      this._port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        this._isOpen = true;
        this.emit('open');
        this._startTopologyPolling();
        resolve();
      });
    });
  }

  /**
   * Route an incoming line to the correct event based on prefix.
   * @param {string} rawLine
   * @private
   */
  _handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    const topoIdx = line.indexOf(SERIAL_RESPONSES.TOPOLOGY_PREFIX);
    if (topoIdx !== -1) {
      const topology = parseTopology(line.slice(topoIdx));
      if (topology) {
        this.emit('topology', topology);
      }
      return;
    }

    const muxIdx = line.indexOf(SERIAL_RESPONSES.MUX_OK_PREFIX);
    if (muxIdx !== -1) {
      const muxResult = parseMuxOk(line.slice(muxIdx));
      if (muxResult) {
        this.emit('mux_ok', muxResult);
      }
      return;
    }

    // Module-tagged AT response: [moduleId]content
    const parsed = parseModuleLine(line);
    if (parsed) {
      this.emit('module_line', parsed);
      return;
    }

    // Untagged line (backward compat)
    this.emit('line', line);
  }

  /**
   * Send TOPOLOGY_REQUEST and retry every TOPOLOGY_RETRY_INTERVAL_MS until
   * the Arduino responds or the port closes.
   * The initial send is delayed by TOPOLOGY_REQUEST_DELAY_MS to let the Arduino
   * finish rebooting (DTR-triggered reset on serial connect takes ~1-2s).
   * @private
   */
  _startTopologyPolling() {
    const sendRequest = () => {
      this.sendRaw(SERIAL_COMMANDS.TOPOLOGY_REQUEST).catch(() => {});
    };

    const retryTimer = setTimeout(() => {
      if (!this._isOpen) return;
      sendRequest();

      const intervalTimer = setInterval(() => {
        if (!this._isOpen) {
          clearInterval(intervalTimer);
          return;
        }
        sendRequest();
      }, CONFIG.TOPOLOGY_RETRY_INTERVAL_MS);

      const stop = () => clearInterval(intervalTimer);
      this.once('topology', stop);
      this.once('close', stop);
    }, CONFIG.TOPOLOGY_REQUEST_DELAY_MS);

    this.once('close', () => clearTimeout(retryTimer));
  }

  /**
   * Write a raw string to the serial port.
   * @param {string} data - Data to send (caller must include terminators)
   * @returns {Promise<void>}
   */
  sendRaw(data) {
    const doWrite = () => new Promise((resolve, reject) => {
      if (!this._port || !this._isOpen) {
        reject(new Error('Serial port is not open'));
        return;
      }
      this._port.write(data, (err) => {
        if (err) {
          reject(err);
          return;
        }
        this._port.drain((drainErr) => {
          if (drainErr) {
            reject(drainErr);
            return;
          }
          resolve();
        });
      });
    });
    // Serialize writes to prevent interleaved partial lines
    this._writeLock = this._writeLock.then(doWrite, doWrite);
    return this._writeLock;
  }

  /**
   * Whether the serial port is currently open.
   * @returns {boolean}
   */
  isOpen() {
    return this._isOpen;
  }

  /**
   * The port path currently in use (or last attempted).
   * @returns {string}
   */
  getPortPath() {
    return this._portPath;
  }

  /**
   * Close the serial port gracefully.
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve, reject) => {
      if (!this._port || !this._isOpen) {
        resolve();
        return;
      }
      this._port.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

/** Singleton instance */
const serialService = new SerialService();

module.exports = { serialService };
