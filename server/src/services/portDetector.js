/**
 * @fileoverview Auto-detection of Arduino serial ports.
 * Scans all available COM ports and matches against known Arduino USB identifiers.
 * Falls back to manufacturer string matching when vendor/product IDs are unavailable.
 */

const { SerialPort } = require('serialport');
const { ARDUINO_IDENTIFIERS, ARDUINO_MANUFACTURER_KEYWORDS } = require('../constants/arduinoIdentifiers');

/**
 * @typedef {Object} DetectedPort
 * @property {string} path          - System port path (e.g., COM3, /dev/ttyUSB0)
 * @property {string} label         - Matched board label
 * @property {string} [vendorId]    - USB vendor ID if available
 * @property {string} [productId]   - USB product ID if available
 * @property {string} [manufacturer] - Manufacturer string if available
 */

/**
 * Normalize a hex ID to lowercase without leading "0x".
 * @param {string | undefined} id
 * @returns {string}
 */
function normalizeHexId(id) {
  if (!id) return '';
  return id.toLowerCase().replace(/^0x/, '');
}

/**
 * Check if a port's vendor/product IDs match a known Arduino identifier.
 * @param {import('serialport').PortInfo} port
 * @returns {ArduinoIdentifier | null}
 */
function matchByVendorProduct(port) {
  const vid = normalizeHexId(port.vendorId);
  const pid = normalizeHexId(port.productId);
  if (!vid) return null;

  for (const identifier of ARDUINO_IDENTIFIERS) {
    if (identifier.vendorId !== vid) continue;
    if (identifier.productId && identifier.productId !== pid) continue;
    return identifier;
  }
  return null;
}

/**
 * Check if a port's manufacturer string contains an Arduino-related keyword.
 * @param {import('serialport').PortInfo} port
 * @returns {boolean}
 */
function matchByManufacturer(port) {
  const manufacturer = (port.manufacturer || '').toLowerCase();
  if (!manufacturer) return false;
  return ARDUINO_MANUFACTURER_KEYWORDS.some((keyword) => manufacturer.includes(keyword));
}

/**
 * List all serial ports on the system.
 * @returns {Promise<import('serialport').PortInfo[]>}
 */
async function listAllPorts() {
  return SerialPort.list();
}

/**
 * Detect the first Arduino-compatible serial port.
 * Strategy:
 *   1. Match by USB vendor/product ID against known identifiers
 *   2. Fallback: match by manufacturer string keywords
 * @returns {Promise<DetectedPort | null>} The first matching port, or null if none found
 */
async function detectArduinoPort() {
  const ports = await listAllPorts();

  for (const port of ports) {
    const identifier = matchByVendorProduct(port);
    if (identifier) {
      return {
        path: port.path,
        label: identifier.label,
        vendorId: normalizeHexId(port.vendorId),
        productId: normalizeHexId(port.productId),
        manufacturer: port.manufacturer || '',
      };
    }
  }

  for (const port of ports) {
    if (matchByManufacturer(port)) {
      return {
        path: port.path,
        label: `${port.manufacturer} (auto-detected)`,
        vendorId: normalizeHexId(port.vendorId),
        productId: normalizeHexId(port.productId),
        manufacturer: port.manufacturer || '',
      };
    }
  }

  return null;
}

/**
 * Detect all Arduino-compatible serial ports on the system.
 * @returns {Promise<DetectedPort[]>}
 */
async function detectAllArduinoPorts() {
  const ports = await listAllPorts();
  const results = [];

  for (const port of ports) {
    const identifier = matchByVendorProduct(port);
    if (identifier) {
      results.push({
        path: port.path,
        label: identifier.label,
        vendorId: normalizeHexId(port.vendorId),
        productId: normalizeHexId(port.productId),
        manufacturer: port.manufacturer || '',
      });
      continue;
    }
    if (matchByManufacturer(port)) {
      results.push({
        path: port.path,
        label: `${port.manufacturer} (auto-detected)`,
        vendorId: normalizeHexId(port.vendorId),
        productId: normalizeHexId(port.productId),
        manufacturer: port.manufacturer || '',
      });
    }
  }

  return results;
}

/**
 * Substrings that identify a SimCom device in the manufacturer or friendlyName
 * strings returned by SerialPort.list() on Windows.
 * @type {string[]}
 */
const SIMCOM_KEYWORDS = ['simcom', 'simtech'];

/**
 * @typedef {Object} SimcomPortInfo
 * @property {string} path   - System port path (e.g., COM5)
 * @property {string} label  - Friendly name from Device Manager
 * @property {string} pnpId  - Windows InstanceId (e.g. USB\VID_1E0E&PID_9011&MI_04\7&A6F773E&0&0004)
 */

/**
 * Return true if a port belongs to a SimCom device.
 * @param {import('serialport').PortInfo} port
 * @returns {boolean}
 */
function matchSimcomPort(port) {
  const manufacturer = (port.manufacturer || '').toLowerCase();
  const friendlyName = (port.friendlyName || '').toLowerCase();
  const pnpId = (port.pnpId || '').toLowerCase();
  return SIMCOM_KEYWORDS.some(
    (kw) => manufacturer.includes(kw) || friendlyName.includes(kw) || pnpId.includes(kw)
  );
}

/**
 * Detect all SimCom USB COM ports and split into AT and audio categories.
 *
 * AT ports   — friendlyName contains "AT PORT"
 * Audio ports — friendlyName contains "Audio"
 *
 * @param {{ silent?: boolean }} [opts] — when silent, suppress the per-call
 *   "Found N port(s)" logs. Used by the periodic plug-and-play scan, which
 *   would otherwise spam the console every tick. Callers that want a one-shot
 *   inventory log (startup) leave silent off (the default).
 * @returns {Promise<{ atPorts: SimcomPortInfo[], audioPorts: SimcomPortInfo[] }>}
 */
async function detectSimcomPorts(opts = {}) {
  const ports = await listAllPorts();
  const simcomPorts = ports.filter(matchSimcomPort);

  /** @param {import('serialport').PortInfo} p */
  const toInfo = (p) => ({ path: p.path, label: p.friendlyName || p.manufacturer || p.path, pnpId: p.pnpId || '' });

  const atPorts = simcomPorts
    .filter((p) => (p.friendlyName || '').toLowerCase().includes('at port'))
    .map(toInfo);

  const audioPorts = simcomPorts
    .filter((p) => (p.friendlyName || '').toLowerCase().includes('audio'))
    .map(toInfo);

  if (!opts.silent) {
    if (atPorts.length > 0) {
      console.log(`[SIMCOM] Found ${atPorts.length} AT port(s): ${atPorts.map((p) => p.path).join(', ')}`);
    } else {
      console.warn('[SIMCOM] No AT ports found — SimCom modules may not be connected');
    }

    if (audioPorts.length > 0) {
      console.log(`[SIMCOM] Found ${audioPorts.length} Audio port(s): ${audioPorts.map((p) => p.path).join(', ')}`);
    } else {
      console.warn('[SIMCOM] No Audio ports found');
    }
  }

  return { atPorts, audioPorts };
}

module.exports = { detectArduinoPort, detectAllArduinoPorts, detectSimcomPorts, listAllPorts };
