/**
 * @fileoverview Known USB vendor/product identifiers for Arduino boards.
 * Used by portDetector to auto-discover the Arduino serial port.
 */

/**
 * @typedef {Object} ArduinoIdentifier
 * @property {string} vendorId  - USB vendor ID (hex, lowercase)
 * @property {string} [productId] - USB product ID (hex, lowercase) — optional for broad matching
 * @property {string} label     - Human-readable board name
 */

/** @type {ArduinoIdentifier[]} */
const ARDUINO_IDENTIFIERS = [
  { vendorId: '2341', productId: '0042', label: 'Arduino Mega 2560' },
  { vendorId: '2341', productId: '0010', label: 'Arduino Mega (legacy)' },
  { vendorId: '2341', productId: '0043', label: 'Arduino Uno R3' },
  { vendorId: '2341', productId: '0001', label: 'Arduino Uno (legacy)' },
  { vendorId: '2341', productId: '003d', label: 'Arduino Due (prog)' },
  { vendorId: '2341', productId: '003e', label: 'Arduino Due (native)' },
  { vendorId: '2341', label: 'Arduino (generic)' },
  { vendorId: '1a86', productId: '7523', label: 'CH340 (Arduino clone)' },
  { vendorId: '0403', productId: '6001', label: 'FTDI FT232R (Arduino clone)' },
  { vendorId: '10c4', productId: 'ea60', label: 'CP2102 (Arduino clone)' },
  { vendorId: '1a86', productId: '55d4', label: 'CH9102 (Arduino clone)' },
];

/**
 * Manufacturer substrings that indicate an Arduino-compatible device.
 * Used as fallback when vendorId matching fails.
 * @type {string[]}
 */
const ARDUINO_MANUFACTURER_KEYWORDS = [
  'arduino',
  'ch340',
  'ch341',
  'ch9102',
  'ftdi',
  'cp210',
  'wch',
  'silicon labs',
];

module.exports = { ARDUINO_IDENTIFIERS, ARDUINO_MANUFACTURER_KEYWORDS };
