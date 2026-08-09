/**
 * @fileoverview Signal strength indicator — 4 bars like a phone.
 * rssi 0-31 from AT+CSQ: 0-1 = none, 2-9 = poor, 10-14 = fair, 15-19 = good, 20-31 = excellent.
 * 99 = unknown.
 */

import React from 'react';

/**
 * Convert rssi (0-31, 99) to bar count (0-4).
 * @param {number} rssi
 * @returns {number}
 */
function rssiBars(rssi) {
  if (rssi === 99 || rssi < 2) return 0;
  if (rssi < 10) return 1;
  if (rssi < 15) return 2;
  if (rssi < 20) return 3;
  return 4;
}

function rssiColor(bars) {
  if (bars === 0) return 'var(--text-muted, #9CA3AF)';
  if (bars === 1) return '#EF4444';
  if (bars === 2) return '#F59E0B';
  return '#22C55E';
}

/**
 * Map rssi (0-31) to dBm. AT+CSQ scale: 0 → -113 dBm, 31 → -51 dBm,
 * each step = 2 dBm. 99 = not detectable.
 * @param {number} rssi
 * @returns {number|null} dBm, or null if unknown
 */
function rssiToDbm(rssi) {
  if (rssi === 99 || rssi < 0 || rssi > 31) return null;
  return -113 + 2 * rssi;
}

/** Coarse quality label per bar count, for the tooltip. */
const QUALITY = ['No signal', 'Poor', 'Fair', 'Good', 'Excellent'];

/**
 * @param {{ rssi: number }} props
 */
export function SignalBars({ rssi }) {
  const bars = rssiBars(rssi);
  const color = rssiColor(bars);
  const heights = [4, 7, 10, 13];
  const dbm = rssiToDbm(rssi);
  const title = dbm === null
    ? 'Signal: unknown'
    : `Signal: ${dbm} dBm (${rssi}/31 — ${QUALITY[bars]})`;

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1.5px', height: '13px', flexShrink: 0, cursor: 'help' }}
      title={title}
    >
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            width: '3px',
            height: `${h}px`,
            borderRadius: '1px',
            backgroundColor: i < bars ? color : 'var(--border, #E5E7EB)',
            transition: 'background-color 0.3s',
          }}
        />
      ))}
    </div>
  );
}
