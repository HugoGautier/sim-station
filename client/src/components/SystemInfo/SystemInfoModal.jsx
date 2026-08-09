/**
 * @fileoverview Modal overlay showing system info: topology, COM ports, connections.
 * Status badges use live props from parent; topology and ports are fetched once on mount.
 */

import React, { useEffect, useState } from 'react';
import { fetchSystemInfo } from '../../services/apiService';
import './SystemInfoModal.css';

/**
 * @param {{
 *   onClose: () => void,
 *   serverConnected: boolean,
 *   arduinoStatus: 'ready' | 'initializing' | 'disconnected',
 *   theme: 'light' | 'dark',
 *   onToggleTheme: () => void,
 * }} props
 */
const ARDUINO_STATUS_MAP = {
  ready:        { label: 'Connected',    cls: 'badge-ok' },
  initializing: { label: 'Initializing', cls: 'badge-warn' },
  disconnected: { label: 'Disconnected', cls: 'badge-err' },
};

export function SystemInfoModal({ onClose, serverConnected, arduinoStatus, theme, onToggleTheme }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchSystemInfo()
      .then(setInfo)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sysinfo-overlay" onClick={onClose}>
      <div className="sysinfo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sysinfo-header">
          <h2 className="sysinfo-title">System Information</h2>
          <button className="sysinfo-close" onClick={onClose} title="Close">&times;</button>
        </div>

        {error && <div className="sysinfo-error">{error}</div>}

        {!info && !error && <div className="sysinfo-loading">Loading...</div>}

        {info && (
          <div className="sysinfo-body">
            {/* Appearance */}
            <section className="sysinfo-section">
              <h3 className="sysinfo-section-title">Appearance</h3>
              <div className="sysinfo-row">
                <span className="sysinfo-label">Theme</span>
                <button
                  type="button"
                  className="sysinfo-theme-toggle"
                  onClick={onToggleTheme}
                  title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                >
                  {theme === 'dark' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                  )}
                  <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
                </button>
              </div>
            </section>

            {/* Connection Status */}
            <section className="sysinfo-section">
              <h3 className="sysinfo-section-title">Connection</h3>
              <div className="sysinfo-row">
                <span className="sysinfo-label">Server</span>
                <span className={`sysinfo-badge ${serverConnected ? 'badge-ok' : 'badge-err'}`}>
                  {serverConnected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <div className="sysinfo-row">
                <span className="sysinfo-label">Arduino</span>
                <span className={`sysinfo-badge ${ARDUINO_STATUS_MAP[arduinoStatus].cls}`}>
                  {ARDUINO_STATUS_MAP[arduinoStatus].label}
                </span>
              </div>
              {info.serial.path && (
                <div className="sysinfo-row">
                  <span className="sysinfo-label">Port</span>
                  <span className="sysinfo-value">{info.serial.path}</span>
                </div>
              )}
              {info.serial.label && (
                <div className="sysinfo-row">
                  <span className="sysinfo-label">Device</span>
                  <span className="sysinfo-value">{info.serial.label}</span>
                </div>
              )}
            </section>

            {/* Topology */}
            <section className="sysinfo-section">
              <h3 className="sysinfo-section-title">Topology</h3>
              {info.topology ? (
                <>
                  <div className="sysinfo-row">
                    <span className="sysinfo-label">Modules</span>
                    <span className="sysinfo-value">{info.topology.modules.length}</span>
                  </div>
                  <div className="sysinfo-row">
                    <span className="sysinfo-label">Total SIMs</span>
                    <span className="sysinfo-value">{info.topology.totalSims}</span>
                  </div>
                  <div className="sysinfo-table">
                    <div className="sysinfo-table-head">
                      <span>Module</span>
                      <span>SIM cards</span>
                    </div>
                    {info.topology.modules.map((mod) => (
                      <div key={mod.id} className="sysinfo-table-row">
                        <span>Module {mod.id}</span>
                        <span>{mod.simCount}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="sysinfo-empty">No topology received yet</div>
              )}
            </section>

            {/* COM Ports */}
            <section className="sysinfo-section">
              <h3 className="sysinfo-section-title">Detected COM Ports</h3>
              {info.ports.length > 0 ? (
                <div className="sysinfo-table">
                  <div className="sysinfo-table-head sysinfo-table-3col">
                    <span>Port</span>
                    <span>Device</span>
                    <span>VID:PID</span>
                  </div>
                  {info.ports.map((port) => (
                    <div key={port.path} className="sysinfo-table-row sysinfo-table-3col">
                      <span className="sysinfo-port-path">
                        {port.path}
                        {info.serial.path === port.path && (
                          <span className="sysinfo-port-tag">Arduino</span>
                        )}
                      </span>
                      <span className="sysinfo-port-device">
                        {port.friendlyName || port.manufacturer || '-'}
                      </span>
                      <span className="sysinfo-port-vid">
                        {port.vendorId ? `${port.vendorId}:${port.productId}` : '-'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sysinfo-empty">No COM ports detected</div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
