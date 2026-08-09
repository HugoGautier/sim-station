/**
 * @fileoverview Call control UI — answer/hangup buttons, duration display, and DTMF keypad.
 */

import React, { useState, useEffect } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { useAudio } from '../../hooks/useAudio';
import { useTranscription } from '../../hooks/useTranscription';
import { LiveTranscript } from './LiveTranscript';

/** @type {string[]} DTMF keypad digits in display order */
const DTMF_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/**
 * Format elapsed seconds as MM:SS.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Call controls with answer/hangup, timer, and DTMF pad.
 * @param {{
 *   moduleId: number,
 *   callState: 'idle' | 'incoming' | 'active',
 *   callStartTime: number | null,
 *   callerNumber: string,
 *   onAnswer: () => void,
 *   onHangup: () => void,
 *   onDtmf: (digit: string) => void
 * }} props
 */
export function CallControls({ moduleId, simId, callState, callStartTime, callerNumber, onAnswer, onHangup, onDtmf }) {
  const [elapsed, setElapsed] = useState(0);
  const { startAudio, stopAudio } = useAudio();
  const { transcript, isModelReady, error: transcriptError } = useTranscription(callState === 'active', moduleId, simId);

  useEffect(() => {
    if (callState === 'active') {
      startAudio();
    } else {
      stopAudio();
    }
  }, [callState, startAudio, stopAudio]);

  useEffect(() => {
    if (callState !== 'active' || !callStartTime) {
      setElapsed(0);
      return;
    }

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - callStartTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [callState, callStartTime]);

  // Keep the last call's transcript on screen after hangup. The hook resets
  // it when the next call starts, so it doesn't accumulate forever.
  const showTranscript = callState === 'active' || !!(transcript && transcript.trim());

  return (
    <div>
      {callState === 'idle' && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', padding: '8px 0' }}>
          No active call
        </div>
      )}

      {callState === 'incoming' && (
        <div style={{ textAlign: 'center', marginBottom: '8px' }}>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
            Incoming call{callerNumber ? ` from ${callerNumber}` : ''}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onAnswer(); }}
            style={{
              backgroundColor: '#22C55E',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '50%',
              width: '40px',
              height: '40px',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Phone size={18} />
          </button>
        </div>
      )}

      {callState === 'active' && (
        <div
          style={{
            textAlign: 'center',
            marginBottom: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
          }}
        >
          <span style={{ fontSize: '16px', fontWeight: 600, color: '#22C55E', fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(elapsed)}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onHangup(); }}
            style={{
              backgroundColor: '#EF4444',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '50%',
              width: '36px',
              height: '36px',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PhoneOff size={16} />
          </button>
        </div>
      )}

      {showTranscript && (
        <LiveTranscript transcript={transcript} isModelReady={isModelReady} error={transcriptError} />
      )}

      {callState === 'active' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '4px',
            maxWidth: '160px',
            margin: '0 auto',
          }}
        >
          {DTMF_DIGITS.map((digit) => (
            <button
              key={digit}
              onClick={(e) => { e.stopPropagation(); onDtmf(digit); }}
              style={{
                backgroundColor: 'var(--bg-btn)',
                border: 'none',
                borderRadius: '6px',
                padding: '6px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                color: 'var(--text)',
              }}
            >
              {digit}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
