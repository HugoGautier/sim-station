/**
 * @fileoverview Hook that subscribes to socket events for a specific SIM
 * and maintains its messages, call state, and registration status.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from './useSocket';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../constants/socketEvents';

/**
 * @typedef {'idle' | 'incoming' | 'active'} CallState
 * @typedef {'unknown' | 'searching' | 'registered' | 'roaming' | 'error'} SimStatus
 * @typedef {{ index: number, status: string, sender: string, timestamp: string, body: string }} SmsMessage
 */

/**
 * Provides real-time data for a specific SIM card.
 * @param {number} moduleId
 * @param {number} simId
 * @returns {{ messages: SmsMessage[], callState: CallState, callStartTime: number | null, callerNumber: string, status: SimStatus }}
 */
export function useSimData(moduleId, simId, initialInfo) {
  const { socket } = useSocket();
  const [messages, setMessages] = useState([]);
  const [callState, setCallState] = useState('idle');
  const [callStartTime, setCallStartTime] = useState(null);
  const [callerNumber, setCallerNumber] = useState('');
  const [status, setStatus] = useState('unknown');
  const [operator, setOperator] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [signal, setSignal] = useState(99);
  const [networkType, setNetworkType] = useState('');
  // Whether this SIM has registered at least once during the CURRENT session
  // (since the last select cycle / server restart). Distinguishes "never
  // registered yet → Unknown" from "was registered then lost → No network".
  // Deliberately NOT derived from `operator` (which is persisted to disk and
  // reloaded at boot, which would make every card show No network on start).
  const [everRegistered, setEverRegistered] = useState(false);
  const moduleIdRef = useRef(moduleId);
  const simIdRef = useRef(simId);

  useEffect(() => {
    moduleIdRef.current = moduleId;
    simIdRef.current = simId;
  }, [moduleId, simId]);

  // Apply persistent store data (operator, phoneNumber, messages)
  // only when no live data has been set yet.
  useEffect(() => {
    if (!initialInfo) return;
    if (initialInfo.operator) setOperator((prev) => prev || initialInfo.operator);
    if (initialInfo.phoneNumber) setPhoneNumber((prev) => prev || initialInfo.phoneNumber);
    if (initialInfo.messages?.length) setMessages((prev) => prev.length ? prev : initialInfo.messages);
  }, [initialInfo]);

  /**
   * Check if an event payload matches this SIM.
   * @param {{ moduleId: number, simId: number }} payload
   * @returns {boolean}
   */
  const isForThisSim = useCallback(
    (payload) => payload.moduleId === moduleId && payload.simId === simId,
    [moduleId, simId]
  );

  useEffect(() => {
    /** @param {{ moduleId: number, simId: number, messages: SmsMessage[] }} data */
    const onSmsList = (data) => {
      if (isForThisSim(data)) {
        setMessages(data.messages);
      }
    };

    /** @param {{ moduleId: number, simId: number, message: SmsMessage }} data */
    const onSms = (data) => {
      if (isForThisSim(data)) {
        setMessages((prev) => [...prev, data.message]);
      }
    };

    /** @param {{ moduleId: number, simId: number, callerNumber: string }} data */
    const onCallIncoming = (data) => {
      if (isForThisSim(data)) {
        setCallState('incoming');
        setCallerNumber(data.callerNumber || '');
        setCallStartTime(null);
      }
    };

    /** @param {{ moduleId: number, simId: number, startTime: number }} data */
    const onCallActive = (data) => {
      if (isForThisSim(data)) {
        setCallState('active');
        setCallStartTime(data.startTime || Date.now());
      }
    };

    /** @param {{ moduleId: number, simId: number }} data */
    const onCallEnded = (data) => {
      if (isForThisSim(data)) {
        setCallState('idle');
        setCallerNumber('');
        setCallStartTime(null);
      }
    };

    /** @param {{ moduleId: number, simId: number, status: SimStatus, operator?: string }} data */
    const onStatus = (data) => {
      if (!isForThisSim(data)) return;
      setStatus(data.status);
      if (data.status === 'registered' || data.status === 'roaming') {
        setEverRegistered(true);
      } else if (data.status === 'switching') {
        // A fresh select cycle starts — forget any past registration so a
        // brand-new selection doesn't inherit a stale "was registered" flag.
        setEverRegistered(false);
      }
      if (data.operator !== undefined) {
        setOperator(data.operator);
      }
    };

    /** @param {{ moduleId: number, simId: number, phoneNumber: string }} data */
    const onNumber = (data) => {
      if (isForThisSim(data)) {
        setPhoneNumber(data.phoneNumber);
      }
    };

    const onSignal = (data) => {
      if (isForThisSim(data)) setSignal(data.rssi);
    };

    const onNetworkType = (data) => {
      if (isForThisSim(data)) setNetworkType(data.networkType || '');
    };

    // Server-side shutdown wiped all selections; drop our cached live data so
    // the card doesn't keep showing last-known registered/signal/operator.
    const onClear = () => {
      setStatus('unknown');
      setOperator('');
      setSignal(99);
      setNetworkType('');
      setEverRegistered(false);
      setCallState('idle');
      setCallStartTime(null);
      setCallerNumber('');
    };

    socket.on(SERVER_EVENTS.SIM_SMS_LIST, onSmsList);
    socket.on(SERVER_EVENTS.SIM_SMS, onSms);
    socket.on(SERVER_EVENTS.SIM_CALL_INCOMING, onCallIncoming);
    socket.on(SERVER_EVENTS.SIM_CALL_ACTIVE, onCallActive);
    socket.on(SERVER_EVENTS.SIM_CALL_ENDED, onCallEnded);
    socket.on(SERVER_EVENTS.SIM_STATUS, onStatus);
    socket.on(SERVER_EVENTS.SIM_NUMBER, onNumber);
    socket.on(SERVER_EVENTS.SIM_SIGNAL, onSignal);
    socket.on(SERVER_EVENTS.SIM_NETWORK_TYPE, onNetworkType);
    socket.on(SERVER_EVENTS.SELECTIONS_CLEAR, onClear);

    return () => {
      socket.off(SERVER_EVENTS.SIM_SMS_LIST, onSmsList);
      socket.off(SERVER_EVENTS.SIM_SMS, onSms);
      socket.off(SERVER_EVENTS.SIM_CALL_INCOMING, onCallIncoming);
      socket.off(SERVER_EVENTS.SIM_CALL_ACTIVE, onCallActive);
      socket.off(SERVER_EVENTS.SIM_CALL_ENDED, onCallEnded);
      socket.off(SERVER_EVENTS.SIM_STATUS, onStatus);
      socket.off(SERVER_EVENTS.SIM_NUMBER, onNumber);
      socket.off(SERVER_EVENTS.SIM_SIGNAL, onSignal);
      socket.off(SERVER_EVENTS.SIM_NETWORK_TYPE, onNetworkType);
      socket.off(SERVER_EVENTS.SELECTIONS_CLEAR, onClear);
    };
  }, [socket, isForThisSim]);

  return { messages, callState, callStartTime, callerNumber, status, operator, phoneNumber, signal, networkType, everRegistered };
}
