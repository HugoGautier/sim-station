/**
 * @fileoverview Hook for playing real-time PCM audio streamed from the server.
 *
 * The server captures audio from the SimCom USB audio port and emits
 * base64-encoded PCM chunks over socket.io. This hook decodes each chunk and
 * schedules it for gapless playback through the Web Audio API using a
 * jitter buffer that absorbs network timing irregularities.
 *
 * PCM format: 8 kHz, 16-bit signed little-endian, mono.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { useSocket } from './useSocket';
import { SERVER_EVENTS } from '../constants/socketEvents';

/** Minimum buffer ahead of currentTime before we start playing (seconds). */
const BUFFER_AHEAD = 0.08;

/** Output gain applied after the cleanup chain. Modem PCM is quiet — 4×
 * brings it to a comfortable listening level without clipping the
 * compressor's output. Adjust if too loud / too quiet for your speakers. */
const OUTPUT_GAIN = 4;

/**
 * Build a one-shot voice-cleanup graph and return its head node.
 * Chain: gain → highpass(150) → lowpass(3400) → compressor → destination
 *
 *   - gain (4×): amplifies the quiet modem PCM. Headroom is preserved
 *     because the compressor downstream catches anything that would clip.
 *   - highpass 150 Hz: kills 50/60 Hz mains hum, USB cable rumble, and
 *     low-frequency thump. Voice fundamentals start around 85 Hz but
 *     telephony content above 200 Hz is what carries intelligibility, so
 *     150 Hz is a safe cutoff.
 *   - lowpass 3400 Hz: telephony G.711 is band-limited to 300-3400 Hz
 *     anyway; everything above that is shaped noise / aliasing. Cutting
 *     it removes hiss without touching speech.
 *   - compressor: gentle limiter (threshold -18 dB, ratio 4:1, slow
 *     release) — keeps loud syllables from clipping after the gain
 *     stage, and pulls quiet syllables forward so speech is steadier.
 *
 * The graph is built once per AudioContext (held alive in audioGraphRef)
 * and every chunk's source node connects to its head — cheaper than
 * rebuilding nodes per chunk.
 */
function buildVoiceChain(ctx) {
  const gain = ctx.createGain();
  gain.gain.value = OUTPUT_GAIN;

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 150;
  highpass.Q.value = 0.7;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 3400;
  lowpass.Q.value = 0.7;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 6;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.18;

  gain.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(ctx.destination);

  return gain; // head — sources connect here
}

/**
 * Hook that subscribes to audio chunks and plays them through the browser
 * speakers via the Web Audio API with gapless scheduling.
 *
 * @returns {{ isPlaying: boolean, startAudio: () => void, stopAudio: () => void }}
 */
export function useAudio() {
  const { socket } = useSocket();
  /** @type {React.MutableRefObject<AudioContext | null>} */
  const audioCtxRef = useRef(null);
  /** Head node of the voice cleanup chain — sources connect here. */
  const audioGraphRef = useRef(null);
  /** Next time in AudioContext timeline to schedule a chunk */
  const nextTimeRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const startAudio = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({ sampleRate: 8000 });
      audioGraphRef.current = buildVoiceChain(audioCtxRef.current);
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    nextTimeRef.current = 0;
    setIsPlaying(true);
  }, []);

  const stopAudio = useCallback(() => {
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.suspend();
    }
    nextTimeRef.current = 0;
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    const onChunk = ({ chunk }) => {
      if (!audioCtxRef.current || audioCtxRef.current.state !== 'running') return;
      if (!audioGraphRef.current) return;

      const ctx = audioCtxRef.current;
      const bytes = atob(chunk);
      const sampleCount = bytes.length >> 1;
      if (sampleCount === 0) return;

      const buffer = ctx.createBuffer(1, sampleCount, 8000);
      const channelData = buffer.getChannelData(0);

      for (let i = 0; i < sampleCount; i++) {
        const lo = bytes.charCodeAt(i * 2);
        const hi = bytes.charCodeAt(i * 2 + 1);
        let sample = (hi << 8) | lo;
        if (sample > 32767) sample -= 65536;
        channelData[i] = sample / 32768;
      }

      const now = ctx.currentTime;
      const duration = sampleCount / 8000;

      // If we've fallen behind (gap in data, first chunk, or pause), reset
      // the schedule point to slightly ahead of now to absorb jitter.
      if (nextTimeRef.current < now) {
        nextTimeRef.current = now + BUFFER_AHEAD;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioGraphRef.current);
      source.start(nextTimeRef.current);

      nextTimeRef.current += duration;
    };

    socket.on(SERVER_EVENTS.AUDIO_CHUNK, onChunk);
    return () => socket.off(SERVER_EVENTS.AUDIO_CHUNK, onChunk);
  }, [socket]);

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
        audioGraphRef.current = null;
      }
    };
  }, []);

  return { isPlaying, startAudio, stopAudio };
}
