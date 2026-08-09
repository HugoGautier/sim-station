/**
 * @fileoverview Modal overlay dedicated to the server log stream.
 * Reuses the SystemInfoModal styling so the two feel like siblings.
 */

import React, { useEffect, useRef } from 'react';
import './SystemInfoModal.css';

function formatLogTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * @param {{
 *   onClose: () => void,
 *   serverLogs: { ts: number, level: 'info'|'warn'|'error', message: string }[],
 * }} props
 */
export function ServerLogsModal({ onClose, serverLogs = [] }) {
  const logsRef = useRef(null);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [serverLogs]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sysinfo-overlay" onClick={onClose}>
      <div className="sysinfo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sysinfo-header">
          <h2 className="sysinfo-title">Server Logs</h2>
          <button className="sysinfo-close" onClick={onClose} title="Close">&times;</button>
        </div>

        <div className="sysinfo-body">
          <section className="sysinfo-section">
            <div className="sysinfo-logs sysinfo-logs-tall" ref={logsRef}>
              {serverLogs.length === 0 ? (
                <div className="sysinfo-logs-empty">No logs yet.</div>
              ) : (
                serverLogs.map((line, i) => (
                  <div key={`${line.ts}-${i}`} className="sysinfo-log-line">
                    <span className="sysinfo-log-ts">{formatLogTime(line.ts)}</span>
                    <span className={`sysinfo-log-level lvl-${line.level}`}>
                      {line.level.toUpperCase()}
                    </span>
                    <span className="sysinfo-log-msg">{line.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
