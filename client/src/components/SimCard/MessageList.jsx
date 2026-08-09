/**
 * @fileoverview Scrollable list of SMS messages with auto-scroll on new messages.
 */

import React, { useEffect, useRef } from 'react';

/**
 * Parse an AT-format SMS timestamp into an absolute Date.
 *
 * Modem format (3GPP TS 23.040): `YY/MM/DD,HH:MM:SS±QQ`. The TZ field is
 * **quarter-hours**, not hours — so "+08" means +2:00 (8 × 15 min), not
 * +08:00. The wall-clock part is local time at the SMSC; subtracting the
 * offset yields absolute UTC.
 * @param {string} s
 * @returns {Date | null}
 */
function parseAtTimestamp(s) {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-])(\d{2})/);
  if (!m) return null;
  const [, yy, mm, dd, h, mi, ss, sign, qq] = m;
  const offsetMinutes = (sign === '+' ? 1 : -1) * Number(qq) * 15;
  const utcMs = Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(h), Number(mi), Number(ss))
    - offsetMinutes * 60_000;
  return new Date(utcMs);
}

/**
 * Format an AT timestamp into "dd/mm/yyyy HH:MM" in the BROWSER's local
 * timezone. Without the TZ conversion, messages from carriers reporting
 * a different offset (or DST mismatches) drift ±1-2h relative to the
 * user's wall clock.
 * @param {string} timestamp
 * @returns {string}
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return '';
  const d = parseAtTimestamp(timestamp);
  if (!d || isNaN(d.getTime())) {
    // Fall back to a TZ-less display rather than the raw AT string.
    const fb = timestamp.match(/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}:\d{2})/);
    return fb ? `${fb[3]}/${fb[2]}/20${fb[1]} ${fb[4]}` : timestamp;
  }
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Scrollable SMS message list.
 * @param {{ messages: Array<{ index: number, sender: string, timestamp: string, body: string }> }} props
 */
export function MessageList({ messages }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div
      ref={containerRef}
      style={{
        height: '200px',
        overflowY: 'auto',
        padding: '8px',
        backgroundColor: 'var(--bg-msg-empty)',
        borderRadius: '8px',
        marginBottom: '8px',
      }}
    >
      {messages.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-muted)',
            fontSize: '13px',
          }}
        >
          No messages
        </div>
      ) : (
        [...messages].sort((a, b) => {
          // Sort on the parsed absolute UTC so two messages from carriers
          // with different TZ offsets still order chronologically. Fallback
          // to string compare when parse fails (very old / malformed slot).
          const da = parseAtTimestamp(a.timestamp || '');
          const db = parseAtTimestamp(b.timestamp || '');
          if (da && db) return da.getTime() - db.getTime();
          return (a.timestamp || '').localeCompare(b.timestamp || '');
        }).map((msg, i) => (
          <div
            key={msg.index !== -1 ? msg.index : `msg-${i}`}
            style={{
              backgroundColor: 'var(--bg-msg)',
              borderRadius: '8px',
              padding: '8px 10px',
              marginBottom: '6px',
              fontSize: '13px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: '4px',
                fontSize: '11px',
                color: 'var(--text-secondary)',
              }}
            >
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{msg.sender || 'Unknown'}</span>
              <span style={{ flexShrink: 0, marginLeft: '6px' }}>{formatTimestamp(msg.timestamp)}</span>
            </div>
            <div style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{msg.body}</div>
          </div>
        ))
      )}
    </div>
  );
}
