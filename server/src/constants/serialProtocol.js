/**
 * @fileoverview Serial protocol strings for MUX switching and topology exchange
 * between Node.js and Arduino Mega.
 */

/** @enum {string} Commands sent from Node to Arduino */
const SERIAL_COMMANDS = {
  /**
   * Request MUX switch. Append moduleIndex:simIndex + newline.
   * Example: MUX:0:2\n
   */
  MUX_PREFIX: 'MUX:',

  /** Request topology from Arduino on startup */
  TOPOLOGY_REQUEST: 'TOPOLOGY_REQUEST\n',

  /** Route an AT command to a specific module. Format: AT:moduleId:command\n */
  AT_PREFIX: 'AT:',
};

/** @enum {string} Responses received from Arduino */
const SERIAL_RESPONSES = {
  /**
   * MUX switch confirmed. Format: MUX_OK:moduleIndex:simIndex
   * Example: MUX_OK:0:2
   */
  MUX_OK_PREFIX: 'MUX_OK:',

  /**
   * Topology JSON payload. Format: TOPOLOGY:{json}
   * Example: TOPOLOGY:{"modules":[{"id":0,"simCount":4}]}
   */
  TOPOLOGY_PREFIX: 'TOPOLOGY:',
};

/**
 * Build a MUX select command string.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {string}
 */
function buildMuxCommand(moduleId, simId) {
  return `${SERIAL_COMMANDS.MUX_PREFIX}${moduleId}:${simId}\n`;
}

/**
 * Parse a MUX_OK response into moduleId and simId.
 * @param {string} line - Raw line starting with MUX_OK:
 * @returns {{ moduleId: number, simId: number } | null}
 */
function parseMuxOk(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(SERIAL_RESPONSES.MUX_OK_PREFIX)) {
    return null;
  }
  const parts = trimmed.slice(SERIAL_RESPONSES.MUX_OK_PREFIX.length).split(':');
  if (parts.length !== 2) {
    return null;
  }
  const moduleId = parseInt(parts[0], 10);
  const simId = parseInt(parts[1], 10);
  if (isNaN(moduleId) || isNaN(simId)) {
    return null;
  }
  return { moduleId, simId };
}

/**
 * Parse a TOPOLOGY response into a topology object.
 * @param {string} line - Raw line starting with TOPOLOGY:
 * @returns {{ modules: Array<{ id: number, simCount: number }> } | null}
 */
function parseTopology(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(SERIAL_RESPONSES.TOPOLOGY_PREFIX)) {
    return null;
  }
  try {
    const json = trimmed.slice(SERIAL_RESPONSES.TOPOLOGY_PREFIX.length);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Build a module-targeted AT command for the wire.
 * Strips trailing \r\n from the AT command (Arduino adds its own).
 * @param {number} moduleId
 * @param {string} command - AT command (may include trailing \r\n)
 * @returns {string}
 */
function buildATCommand(moduleId, command) {
  const stripped = command.replace(/\r?\n$/, '');
  return `${SERIAL_COMMANDS.AT_PREFIX}${moduleId}:${stripped}\n`;
}

/**
 * Parse a module-tagged response line: [moduleId]content
 * @param {string} line
 * @returns {{ moduleId: number, content: string } | null}
 */
function parseModuleLine(line) {
  const match = line.match(/^\[(\d+)\](.*)$/);
  if (!match) return null;
  return { moduleId: parseInt(match[1], 10), content: match[2] };
}

module.exports = {
  SERIAL_COMMANDS,
  SERIAL_RESPONSES,
  buildMuxCommand,
  buildATCommand,
  parseMuxOk,
  parseTopology,
  parseModuleLine,
};
