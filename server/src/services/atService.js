/**
 * @fileoverview Per-module AT command send/collect.
 * Each module has its own independent listener on 'module_line',
 * enabling parallel AT operations across different modules.
 */

const { serialService } = require('./serialService');
const { buildATCommand } = require('../constants/serialProtocol');
const { AT_RESPONSE_PATTERNS } = require('../constants/atCommands');
const { CONFIG } = require('../constants/config');

/**
 * Per-module busy flag for unsolicited line filtering.
 * @type {Map<number, boolean>}
 */
const _atBusy = new Map();

/**
 * Send an AT command to a specific module and collect response lines
 * until OK or ERROR.
 * @param {number} moduleId - Target module
 * @param {string} command - Full AT command string including \r\n
 * @param {number} [timeoutMs] - Defaults to CONFIG.AT_RESPONSE_TIMEOUT_MS
 * @returns {Promise<string[]>}
 */
/**
 * Polling commands whose request/response shouldn't pollute the log on
 * every tick. The function still runs them; we just skip the >>> / <<<
 * lines unless the response carries an ERROR or anything other than the
 * usual OK + value. Add commands here if a routine poll appears in logs.
 */
const SILENT_POLL_COMMANDS = new Set(['AT+CSQ', 'AT+CREG?', 'AT+CEREG?', 'AT+CGREG?']);

function sendATAndCollect(moduleId, command, timeoutMs = CONFIG.AT_RESPONSE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let timer;
    const cmdTrimmed = command.trim();
    const isSilentPoll = SILENT_POLL_COMMANDS.has(cmdTrimmed);

    _atBusy.set(moduleId, true);
    if (!isSilentPoll) console.log(`[AT:${moduleId}] >>> ${cmdTrimmed}`);

    const onModuleLine = ({ moduleId: mid, content }) => {
      if (mid !== moduleId) return;
      // Filter pure noise from the log:
      //   - command echo (modem repeats the AT we just sent — `<<< AT+...`)
      //   - empty lines
      //   - +SIMCARD: NOT AVAILABLE (normal during CFUN=0 transitions)
      //   - silent polls (CSQ etc.) unless the response is an error
      // Still pushed into `lines` so callers see the full response.
      const isEcho = content === cmdTrimmed;
      const isNoise = !content || content === '+SIMCARD: NOT AVAILABLE';
      const isError = /(?:^|\s)(?:ERROR|\+CME ERROR|\+CMS ERROR)\b/.test(content);
      const skip = isEcho || isNoise || (isSilentPoll && !isError);
      if (!skip) console.log(`[AT:${moduleId}] <<< ${content}`);
      lines.push(content);
      if (content.includes(AT_RESPONSE_PATTERNS.OK) || content.includes(AT_RESPONSE_PATTERNS.ERROR)) {
        clearTimeout(timer);
        serialService.removeListener('module_line', onModuleLine);
        _atBusy.set(moduleId, false);
        resolve(lines);
      }
    };

    serialService.on('module_line', onModuleLine);

    timer = setTimeout(() => {
      serialService.removeListener('module_line', onModuleLine);
      _atBusy.set(moduleId, false);
      console.error(`[AT:${moduleId}] TIMEOUT: ${command.trim()}`);
      reject(new Error(`AT command timeout: ${command.trim()}`));
    }, timeoutMs);

    const wire = buildATCommand(moduleId, command);
    serialService.sendRaw(wire).catch((err) => {
      clearTimeout(timer);
      serialService.removeListener('module_line', onModuleLine);
      _atBusy.set(moduleId, false);
      reject(err);
    });
  });
}

/**
 * Whether an AT command response is currently being collected for a module.
 * @param {number} moduleId
 * @returns {boolean}
 */
function isAtBusy(moduleId) {
  return _atBusy.get(moduleId) || false;
}

module.exports = { sendATAndCollect, isAtBusy };
