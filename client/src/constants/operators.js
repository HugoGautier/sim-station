/**
 * @fileoverview Known network operators.
 * `copsName`  — exact string returned by AT+COPS? (used to match the modem response).
 * `label`     — short display name shown in the UI.
 * `numberCode` — USSD code to dial to retrieve the SIM's own phone number.
 */

/** @type {Array<{ copsName: string, label: string, numberCode: string }>} */
export const OPERATORS = [
  {
    copsName: 'LycaMobile LycaMobile',
    label: 'LycaMobile',
    numberCode: '*132#',
  },
];

/**
 * Look up an operator entry by its AT+COPS? name.
 * @param {string} copsName
 * @returns {{ copsName: string, label: string, numberCode: string } | undefined}
 */
export function findOperator(copsName) {
  return OPERATORS.find((op) => op.copsName === copsName);
}
