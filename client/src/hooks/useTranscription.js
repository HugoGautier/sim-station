/**
 * @fileoverview Live call transcript hook.
 *
 * Two backends:
 *   - Server-side whisper.cpp (preferred). Activated when the server emits
 *     TRANSCRIBE_STATUS { enabled: true } on connect. We just listen for
 *     SIM_TRANSCRIPT / SIM_TRANSCRIPT_DONE and render the text verbatim —
 *     no audio processing on the client.
 *   - In-browser Vosk WASM (fallback). Used when the server didn't enable
 *     transcription (WHISPER_CLI_PATH not configured). Loads the small
 *     French model once, runs a Kaldi recognizer per call. Accuracy on
 *     8 kHz cellular audio is mediocre but it works without setup.
 *
 * The hook signature stays unchanged so CallControls doesn't care which
 * backend produces the text.
 */

import { useRef, useState, useEffect } from 'react';
import { useSocket } from './useSocket';
import { SERVER_EVENTS } from '../constants/socketEvents';

/** URL of the Vosk French model served by the backend */
const MODEL_URL = '/models/vosk-model-small-fr-0.22.zip';

/** Shared singleton — model loads once across all hook instances */
let modelPromise = null;
let sharedModel = null;

function loadVoskModel() {
  if (sharedModel) return Promise.resolve(sharedModel);
  if (modelPromise) return modelPromise;

  modelPromise = (async () => {
    const { createModel } = await import('vosk-browser');
    sharedModel = await createModel(MODEL_URL);
    console.log('[TRANSCRIPTION] Vosk model loaded (fallback path)');
    return sharedModel;
  })();

  return modelPromise;
}

/** Max characters to keep in the finalized Vosk transcript */
const MAX_DISPLAY = 100;

/**
 * Module-scope cache so the parent component (one SimCard) doesn't have to
 * thread the moduleId through. The hook is called per-SimCard, so each
 * instance only renders transcripts that match its own moduleId.
 */

/**
 * @param {boolean} active - Whether transcription should be running
 * @param {number} [moduleId] - Filter server transcripts to this module's…
 * @param {number} [simId]    - …specific SIM (otherwise the same transcript
 *                              would appear on all 4 SIM cards of the module)
 * @returns {{ transcript: string, isModelReady: boolean, error: string | null }}
 */
export function useTranscription(active, moduleId, simId) {
  const { socket } = useSocket();
  const [transcript, setTranscript] = useState('');
  // Server-side whisper.cpp configured? Null while unknown (pre-connect).
  const [serverEnabled, setServerEnabled] = useState(null);
  const [isVoskReady, setIsVoskReady] = useState(!!sharedModel);
  const [error, setError] = useState(null);
  const recognizerRef = useRef(null);
  const finalizedRef = useRef('');

  // Listen for the server's "transcription enabled" status on connect.
  useEffect(() => {
    const onStatus = ({ enabled }) => setServerEnabled(!!enabled);
    socket.on(SERVER_EVENTS.TRANSCRIBE_STATUS, onStatus);
    return () => socket.off(SERVER_EVENTS.TRANSCRIBE_STATUS, onStatus);
  }, [socket]);

  // ===== Server-side path (whisper.cpp) =====
  useEffect(() => {
    if (!serverEnabled) return;
    const matches = (data) => {
      if (typeof moduleId === 'number' && data.moduleId !== moduleId) return false;
      // STRICT simId match: both sides must agree on which SIM the transcript
      // is for, otherwise it would smear onto every SIM card of the module.
      // We require the payload's simId AND our own to be numbers and equal.
      if (typeof simId === 'number') {
        if (typeof data.simId !== 'number' || data.simId !== simId) return false;
      }
      return true;
    };
    const onTranscript = (data) => {
      if (!matches(data)) return;
      setTranscript(data.text || '');
    };
    const onDone = (data) => {
      if (!matches(data)) return;
      // Don't wipe — user wants the last call's transcript to linger.
      // (Same behaviour as the Vosk path: cleared on next call start.)
    };
    socket.on(SERVER_EVENTS.SIM_TRANSCRIPT, onTranscript);
    socket.on(SERVER_EVENTS.SIM_TRANSCRIPT_DONE, onDone);
    return () => {
      socket.off(SERVER_EVENTS.SIM_TRANSCRIPT, onTranscript);
      socket.off(SERVER_EVENTS.SIM_TRANSCRIPT_DONE, onDone);
    };
  }, [socket, serverEnabled, moduleId, simId]);

  // Clear server transcript at the START of a new call (so the previous
  // call's text isn't visually appended to the new one).
  useEffect(() => {
    if (!serverEnabled) return;
    if (active) setTranscript('');
  }, [active, serverEnabled]);

  // ===== Vosk fallback =====
  // Only load Vosk if the server explicitly told us it isn't running its own
  // transcription. While serverEnabled is still null (pre-connect), don't
  // commit to either — we'd otherwise download the ~30 MB Vosk model only
  // to discard it once the status arrives.
  useEffect(() => {
    if (serverEnabled !== false) return;
    loadVoskModel()
      .then(() => setIsVoskReady(true))
      .catch((err) => {
        console.error('[TRANSCRIPTION] Vosk load failed:', err);
        setError('Voice model unavailable');
        modelPromise = null;
      });
  }, [serverEnabled]);

  // Vosk recognizer lifecycle.
  useEffect(() => {
    if (serverEnabled !== false) return;
    if (!active || !isVoskReady || !sharedModel) {
      if (recognizerRef.current) {
        recognizerRef.current.remove();
        recognizerRef.current = null;
      }
      return;
    }

    finalizedRef.current = '';
    setTranscript('');

    const recognizer = new sharedModel.KaldiRecognizer(8000);

    recognizer.on('result', (message) => {
      const text = message.result?.text;
      if (text) {
        const combined = finalizedRef.current ? `${finalizedRef.current} ${text}` : text;
        finalizedRef.current = combined.length > MAX_DISPLAY
          ? combined.slice(combined.length - MAX_DISPLAY)
          : combined;
        setTranscript(finalizedRef.current);
      }
    });

    recognizer.on('partialresult', (message) => {
      const partial = message.result?.partial;
      if (partial) {
        const display = finalizedRef.current
          ? `${finalizedRef.current} ${partial}`
          : partial;
        setTranscript(display.length > MAX_DISPLAY
          ? display.slice(display.length - MAX_DISPLAY)
          : display);
      }
    });

    recognizerRef.current = recognizer;

    return () => {
      recognizer.remove();
      recognizerRef.current = null;
    };
  }, [active, isVoskReady, serverEnabled]);

  // Feed audio chunks to Vosk.
  useEffect(() => {
    if (serverEnabled !== false) return;
    if (!active || !recognizerRef.current) return;

    const onChunk = ({ chunk, moduleId: chunkModuleId }) => {
      if (typeof moduleId === 'number' && typeof chunkModuleId === 'number' && chunkModuleId !== moduleId) return;
      if (!recognizerRef.current) return;

      const bytes = atob(chunk);
      const sampleCount = bytes.length >> 1;
      const buffer = new AudioBuffer({ length: sampleCount, numberOfChannels: 1, sampleRate: 8000 });
      const channelData = buffer.getChannelData(0);

      const GAIN = 15;
      for (let i = 0; i < sampleCount; i++) {
        const lo = bytes.charCodeAt(i * 2);
        const hi = bytes.charCodeAt(i * 2 + 1);
        let sample = (hi << 8) | lo;
        if (sample > 32767) sample -= 65536;
        let amplified = (sample / 32768) * GAIN;
        if (amplified > 1) amplified = 1;
        else if (amplified < -1) amplified = -1;
        channelData[i] = amplified;
      }

      try {
        recognizerRef.current.acceptWaveform(buffer);
      } catch (_) { /* ignore */ }
    };

    socket.on(SERVER_EVENTS.AUDIO_CHUNK, onChunk);
    return () => socket.off(SERVER_EVENTS.AUDIO_CHUNK, onChunk);
  }, [socket, active, serverEnabled, moduleId]);

  // `isModelReady` reflects "ready to transcribe": for the server path we're
  // always ready as soon as the socket is up; for the Vosk path we need the
  // model loaded. Either way it's only used to gate UI placeholder text.
  const isModelReady = serverEnabled === true || isVoskReady;

  return { transcript, isModelReady, error };
}
