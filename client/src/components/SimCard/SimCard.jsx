/**
 * @fileoverview SIM card component — displays status, messages, and call controls
 * for a single SIM slot.
 */

import React, { useCallback } from 'react';
import { useSocket } from '../../hooks/useSocket';
import { useSimData } from '../../hooks/useSimData';
import { CLIENT_EVENTS } from '../../constants/socketEvents';
import { SimStatus } from './SimStatus';
import { MessageList } from './MessageList';
import { CallControls } from './CallControls';
import { DataToggle } from './DataToggle';
import './SimCard.css';

/**
 * Individual SIM card widget.
 * @param {{
 *   moduleId: number,
 *   simId: number,
 *   isSelected: boolean,
 *   isDisabled: boolean,
 *   onSelect: (moduleId: number, simId: number) => void
 * }} props
 */
export function SimCard({ moduleId, simId, isSelected, isActivating, isQueued, isDisabled, disabledReason = '', onSelect, initialInfo, dataStatus = 'off', dataIp = null, isDataPending = false, onToggleData }) {
  const { socket } = useSocket();
  const { messages, callState, callStartTime, callerNumber, status, operator, phoneNumber, signal, networkType, everRegistered } = useSimData(moduleId, simId, initialInfo);

  const blocked = isDisabled;
  // Only treat a SIM as "data active" once the session is fully up. While
  // 'connecting', the registration dot stays green (the SIM is registered,
  // data is just being negotiated) and only flips to the purple data tint
  // once dataStatus === 'active'. The DataToggle has its own connecting
  // pulse so the user still sees activation progress.
  const isDataActive = dataStatus === 'active';
  // The data toggle is always clickable (Dashboard orchestrates selection).
  // While pending, the toggle shows a "connecting" pulse so the user sees
  // their click registered — even before the server-side data session starts.
  const isDataInFlight = dataStatus === 'connecting' || dataStatus === 'active';
  const effectiveDataStatus = isDataPending && !isDataInFlight ? 'connecting' : dataStatus;
  // Priority: activating > queued > selected. The queued-before-selected
  // order matters during a "latest-wins" replacement: when the user clicks
  // a second SIM while another is still activating, the new SIM is both
  // locally `isSelected` (client optimistic) AND server-side `isQueued`.
  // Showing the queued grey instead of the selected purple makes the
  // actual server state visible to the user.
  const borderColor = isActivating
    ? 'var(--activating)'
    : isQueued
    ? 'var(--queued)'
    : isSelected
    ? 'var(--selected)'
    : 'transparent';
  // In-progress states (activating / queued) pulse the card outline instead
  // of showing a text badge — the badge crowded the already-full header.
  // The border colour already differentiates the state; the pulse signals
  // "something is happening".
  const isPulsing = isActivating || isQueued;

  const handleClick = useCallback(() => {
    if (blocked) return;
    onSelect(moduleId, simId);
  }, [moduleId, simId, onSelect, blocked]);

  const handleAnswer = useCallback(() => {
    socket.emit(CLIENT_EVENTS.SIM_ANSWER, { moduleId, simId });
  }, [socket, moduleId, simId]);

  const handleHangup = useCallback(() => {
    socket.emit(CLIENT_EVENTS.SIM_HANGUP, { moduleId, simId });
  }, [socket, moduleId, simId]);

  const handleDtmf = useCallback(
    (digit) => {
      socket.emit(CLIENT_EVENTS.SIM_DTMF, { moduleId, simId, digit });
    },
    [socket, moduleId, simId]
  );

  return (
    <div
      onClick={handleClick}
      title={blocked && disabledReason ? disabledReason : undefined}
      style={{
        position: 'relative',
        width: '280px',
        maxWidth: '100%',
        height: '420px',
        backgroundColor: 'var(--bg-card)',
        borderRadius: '12px',
        border: `2px solid ${borderColor}`,
        padding: '16px',
        cursor: blocked ? 'not-allowed' : 'pointer',
        opacity: blocked ? 0.6 : 1,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        boxSizing: 'border-box',
        transition: 'border-color 0.15s ease, opacity 0.2s ease',
        // Pulse the outline while activating/queued (replaces the old text badge).
        '--pulse-color': borderColor,
        animation: isPulsing ? 'cardOutlinePulse 1.3s ease-in-out infinite' : 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '8px',
        }}
      >
        <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text)', whiteSpace: 'nowrap' }}>
          Module {moduleId} / SIM {simId}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <DataToggle
            moduleId={moduleId}
            simId={simId}
            status={effectiveDataStatus}
            disabled={isDisabled}
            disabledReason={disabledReason}
            onToggle={onToggleData}
          />
        </div>
      </div>

      <SimStatus status={status} operator={operator} phoneNumber={phoneNumber} signal={signal} networkType={networkType} isSelected={isSelected} everRegistered={everRegistered} isDataActive={isDataActive} dataIp={dataIp} />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <MessageList messages={messages} />
      </div>

      <div>
        <CallControls
          moduleId={moduleId}
          simId={simId}
          callState={callState}
          callStartTime={callStartTime}
          callerNumber={callerNumber}
          onAnswer={handleAnswer}
          onHangup={handleHangup}
          onDtmf={handleDtmf}
        />
      </div>
    </div>
  );
}
