/**
 * @fileoverview Globe-icon toggle that marks a SIM as the active 4G data SIM.
 * Globally exclusive — server owns the state.
 */

import React, { useCallback } from 'react';

const COLOR = 'var(--data-active)';

/**
 * @param {{
 *   moduleId: number,
 *   simId: number,
 *   status: 'off'|'connecting'|'active'|'error',
 *   disabled?: boolean,
 *   onToggle: (moduleId: number, simId: number) => void,
 * }} props
 */
export function DataToggle({ moduleId, simId, status, disabled, disabledReason, onToggle }) {
  const active = status === 'active';
  const connecting = status === 'connecting';
  const errored = status === 'error';

  const handleClick = useCallback(
    (e) => {
      e.stopPropagation();
      if (disabled) return;
      onToggle(moduleId, simId);
    },
    [onToggle, moduleId, simId, disabled]
  );

  const title = disabled && disabledReason
    ? `Data — ${disabledReason}`
    : errored
    ? 'Data — error'
    : connecting
    ? 'Data — connecting (click to cancel)'
    : active
    ? 'Data — active (click to disable)'
    : 'Use this SIM for the 4G connection';

  const borderColor = errored ? 'var(--red)' : COLOR;
  const bg = active ? COLOR : 'transparent';
  const glow = active ? '0 0 6px rgba(192,38,211,0.5)' : 'none';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      style={{
        width: '25px',
        height: '25px',
        borderRadius: '50%',
        border: `2px solid ${borderColor}`,
        backgroundColor: bg,
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: active ? '#FFFFFF' : borderColor,
        transition: 'background-color 0.15s ease, color 0.15s ease',
        boxShadow: glow,
        opacity: disabled ? 0.5 : 1,
        animation: connecting ? 'data-toggle-pulse 1.2s ease-in-out infinite' : 'none',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    </button>
  );
}
