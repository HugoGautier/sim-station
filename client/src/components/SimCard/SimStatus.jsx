/**
 * @fileoverview Displays the network registration status of a SIM with a colored dot.
 * Line 1: dot + status label .............. signal bars
 * Line 2: operator · phone number
 */

import React from 'react';
import { findOperator } from '../../constants/operators';
import { SignalBars } from './SignalBars';

/**
 * Map status to dot color. When the SIM is the active data SIM, the dot
 * takes the --data-active colour regardless of registration state — data
 * only activates post-registration so this consistently signals "this SIM
 * is the data pipe" rather than duplicating the registered indicator.
 * @param {'unknown' | 'switching' | 'searching' | 'registered' | 'roaming' | 'error'} status
 * @param {boolean} isDataActive
 * @returns {string} CSS color value
 */
function getStatusColor(status, isDataActive) {
  if (isDataActive) return 'var(--data-active)';
  switch (status) {
    case 'registered':
    case 'roaming':
      return '#22C55E';
    case 'switching':
      return '#6366F1';
    case 'searching':
      return '#F59E0B';
    case 'error':
    case 'no_sim':
    case 'sim_error':
      return '#EF4444';
    case 'unknown':
    default:
      return '#9CA3AF';
  }
}

/**
 * Map status to display label.
 * @param {'unknown' | 'switching' | 'searching' | 'registered' | 'roaming' | 'error'} status
 * @returns {string}
 */
function getStatusLabel(status) {
  switch (status) {
    case 'registered': return 'Registered';
    case 'roaming': return 'Roaming';
    case 'switching': return 'Switching...';
    case 'searching': return 'Searching...';
    case 'error': return 'Error';
    case 'no_sim': return 'No SIM';
    case 'sim_error': return 'SIM error';
    case 'unknown':
    default:
      return 'Unknown';
  }
}

/** Statuses that represent an in-progress operation. */
const BUSY_STATUSES = new Set(['switching', 'searching']);

/**
 * Format a stripped phone number as `6 00 00 00 00` — first digit, then
 * 2-digit groups. Server already strips the country code so input is e.g.
 * "612345678". Untouched if it already contains spaces.
 * @param {string} num
 * @returns {string}
 */
function formatPhoneNumber(num) {
  if (!num) return '';
  if (/\s/.test(num)) return num;
  const digits = num.replace(/[^\d]/g, '');
  if (digits.length < 2) return digits;
  let out = digits[0];
  for (let i = 1; i < digits.length; i += 2) out += ' ' + digits.slice(i, i + 2);
  return out;
}

/**
 * Map a raw CPSI RAT token to a short, user-readable label. We collapse
 * the WCDMA/HSDPA/HSUPA family to "3G" and treat anything else as the raw
 * token uppercased — keeps unknown future RATs visible rather than hiding
 * them behind a generic label.
 * @param {string} raw
 * @returns {string}
 */
function shortNetworkLabel(raw) {
  if (!raw) return '';
  const t = raw.toUpperCase();
  if (t === 'LTE' || t.startsWith('LTE-') || t.startsWith('NR')) return t.startsWith('NR') ? '5G' : 'LTE';
  if (t === 'WCDMA' || t === 'HSDPA' || t === 'HSUPA' || t === 'HSPA' || t === 'TD-SCDMA') return '3G';
  if (t === 'GSM' || t === 'EDGE' || t === 'GPRS') return '2G';
  if (t === 'NO SERVICE' || t === 'NO-SERVICE') return '';
  return t;
}

/**
 * SIM registration status indicator — two lines.
 * @param {{
 *   status: 'unknown' | 'switching' | 'searching' | 'registered' | 'roaming' | 'error',
 *   operator?: string,
 *   phoneNumber?: string,
 *   signal?: number,
 *   networkType?: string
 * }} props
 */
export function SimStatus({ status, operator, phoneNumber, signal = 99, networkType = '', isSelected = false, everRegistered = false, isDataActive = false, dataIp = null }) {
  // "No network" = this SIM is selected (radio on), HAS registered at least
  // once this session, and has now dropped off the network (status unknown/
  // error). The three gates each kill a false positive:
  //   - isSelected      → a cold start selects nothing → all cards show Unknown
  //   - everRegistered  → a SIM mid-activation (or one that never registers)
  //                       doesn't flash amber before/while connecting
  //   - status unknown/error → registered/roaming/switching/searching keep
  //                       their own labels
  // (Previously gated on a non-empty persisted `operator`, which made every
  //  previously-seen SIM show "No network" on a fresh server start.)
  const noService = isSelected && everRegistered
    && (status === 'unknown' || status === 'error'
        || (networkType || '').toUpperCase() === 'NO SERVICE');

  const color = noService ? '#F59E0B' : getStatusColor(status, isDataActive);
  const label = noService ? 'No network' : getStatusLabel(status);
  // Pulse only for genuinely in-flight transitions. Previously we also pulsed
  // while "registered but still fetching live operator/phone" — that kept
  // pulsing forever for SIMs whose operator info never arrives live (e.g.
  // operators without a USSD number code), which is what the user sees as
  // "it keeps pulsing after registration is done".
  const isBusy = BUSY_STATUSES.has(status) || noService;
  const operatorLabel = operator ? (findOperator(operator)?.label ?? operator) : '';
  const phoneFormatted = formatPhoneNumber(phoneNumber);
  // Show the RAT chip only while the SIM is actually carrying traffic:
  //   - data session is active on this SIM (isDataActive), AND
  //   - the SIM is selected (status reaches registered/roaming after select),
  // so it disappears the moment the user toggles data off or releases the SIM.
  // status=unknown / error / no-service also short-circuits as a belt-and-
  // braces in case the server's SIM_NETWORK_TYPE='' clear event hasn't propagated.
  const netVisible = isDataActive && status !== 'unknown' && status !== 'error' && !noService;
  const netLabel = netVisible ? shortNetworkLabel(networkType) : '';

  return (
    <div style={{ marginBottom: '8px' }}>
      {/* Line 1: status dot + label ... signal bars */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: color,
            display: 'inline-block',
            flexShrink: 0,
            animation: isBusy ? 'simStatusPulse 1s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}{isDataActive && dataIp ? ` · ${dataIp}` : ''}
        </span>
        {netLabel && (
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.4px',
              color: 'var(--text-secondary)',
              backgroundColor: 'var(--bg-btn)',
              padding: '1px 5px',
              borderRadius: '4px',
              flexShrink: 0,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            {netLabel}
          </span>
        )}
        <SignalBars rssi={signal} />
      </div>

      {/* Line 2: operator · phone number */}
      {(operatorLabel || phoneNumber) && (
        <div
          style={{
            fontSize: '12px',
            color: 'var(--text-secondary)',
            marginTop: '3px',
            paddingLeft: '14px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {operatorLabel}{operatorLabel && phoneFormatted ? ' · ' : ''}{phoneFormatted}
        </div>
      )}
    </div>
  );
}
