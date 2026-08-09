/**
 * @fileoverview Server-side speech-to-text via whisper.cpp.
 *
 * Subscribes to simcomService 'audio:chunk' events, maintains a per-module
 * rolling PCM buffer (last N seconds of call audio), and every ~2 seconds
 * invokes the whisper.cpp CLI on the current buffer. Emits incremental
 * 'transcript' events to the rest of the server (consumed by socketHandler
 * and forwarded to clients as SIM_TRANSCRIPT).
 *
 * Why this design and not streaming whisper:
 *   - whisper.cpp is fundamentally non-streaming (it needs the full window
 *     to attend over). The "stream" example in upstream is a sliding
 *     window with overlap, same idea as this — we just do it in Node so we
 *     can plumb the audio source (modem) cleanly.
 *   - One spawn per ~2s on an 8-core CPU with `ggml-small.bin` runs in
 *     comfortably under 2s, so steady-state. If it lags, _tick skips the
 *     overlapping invocation rather than queuing.
 *
 * Audio path:
 *   modem (8 kHz 16-bit mono PCM) → buffer → linear-interp 16 kHz →
 *   WAV-wrap → temp file → whisper-cli stdout → stripped transcript.
 *
 * Setup: see WHISPER_CLI_PATH / WHISPER_MODEL_PATH / WHISPER_LANG in .env.
 * When either path is unset or missing on disk, the service stays disabled
 * and the client falls back to its in-browser Vosk model.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG } = require('../constants/config');
const { simcomService } = require('./simcomService');

const PCM_BYTES_PER_SAMPLE = 2;
const MODEM_SAMPLE_RATE = 8000;
const WHISPER_SAMPLE_RATE = 16000;

class TranscribeService extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<number, { buffer: Buffer, lastTranscript: string, processing: boolean, intervalHandle: NodeJS.Timeout|null }>} */
    this._activeCalls = new Map();
    this._enabled = false;
    this._verifyConfig();
    if (this._enabled) this._bindAudioFeed();
  }

  /**
   * Validate the configured whisper.cpp paths. Disables the service quietly
   * (and falls back to the client's Vosk path) if anything is missing.
   * @private
   */
  _verifyConfig() {
    if (!CONFIG.WHISPER_CLI_PATH || !CONFIG.WHISPER_MODEL_PATH) {
      console.log('[TRANSCRIBE] disabled — WHISPER_CLI_PATH / WHISPER_MODEL_PATH not set, client Vosk fallback will run');
      return;
    }
    if (!fs.existsSync(CONFIG.WHISPER_CLI_PATH)) {
      console.warn(`[TRANSCRIBE] WHISPER_CLI_PATH not found on disk: ${CONFIG.WHISPER_CLI_PATH}`);
      return;
    }
    if (!fs.existsSync(CONFIG.WHISPER_MODEL_PATH)) {
      console.warn(`[TRANSCRIBE] WHISPER_MODEL_PATH not found on disk: ${CONFIG.WHISPER_MODEL_PATH}`);
      return;
    }
    this._enabled = true;
    console.log(`[TRANSCRIBE] enabled — model=${path.basename(CONFIG.WHISPER_MODEL_PATH)} lang=${CONFIG.WHISPER_LANG} window=${CONFIG.WHISPER_WINDOW_SEC}s`);
  }

  /** @returns {boolean} whether server-side transcription is active */
  isEnabled() {
    return this._enabled;
  }

  /**
   * Subscribe to simcomService audio events. Audio is buffered only for
   * modules that have called startCall() so idle modules don't waste memory.
   * The buffer holds 2× the analysis window so the final-pass flush can
   * see audio that fell off the rolling tick window — captures the tail
   * of the call that would otherwise be lost.
   * @private
   */
  _bindAudioFeed() {
    simcomService.on('audio:chunk', ({ moduleId, chunk }) => {
      const call = this._activeCalls.get(moduleId);
      if (!call) return;
      const pcm = Buffer.from(chunk, 'base64');
      call.buffer = Buffer.concat([call.buffer, pcm]);
      const maxBytes = CONFIG.WHISPER_WINDOW_SEC * 2 * MODEM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;
      if (call.buffer.length > maxBytes) {
        call.buffer = call.buffer.subarray(call.buffer.length - maxBytes);
      }
    });
  }

  /**
   * Start buffering and transcribing for a call.
   * Idempotent — calling twice for the same module is a no-op.
   * @param {number} moduleId
   * @param {number} simId  — the MUX-active SIM hosting the call. Threaded
   *   through to the transcript event so the UI can show the text only on
   *   the right SIM card (otherwise all 4 cards on the module would show it).
   */
  startCall(moduleId, simId) {
    if (!this._enabled) return;
    if (this._activeCalls.has(moduleId)) return;
    const call = {
      simId,
      buffer: Buffer.alloc(0),
      // The committed (history) transcript that we keep growing.
      committed: '',
      // The most recent whisper pass result. Used for the LCP merge.
      lastPass: '',
      processing: false,
      intervalHandle: null,
    };
    call.intervalHandle = setInterval(() => this._tick(moduleId), CONFIG.WHISPER_INTERVAL_MS);
    this._activeCalls.set(moduleId, call);
    console.log(`[TRANSCRIBE] module=${moduleId} sim=${simId}: started`);
  }

  /**
   * Stop transcribing. Runs a final whisper pass on the FULL retained
   * buffer (2× the window) so the very end of the call — including
   * speech that arrived after the last periodic tick — gets captured
   * before we lock the display. Emits one last 'transcript' if anything
   * new came out, then 'done' so the client can stop showing the
   * "live" indicator.
   * @param {number} moduleId
   */
  async endCall(moduleId) {
    const call = this._activeCalls.get(moduleId);
    if (!call) return;
    if (call.intervalHandle) clearInterval(call.intervalHandle);

    // Final flush on the FULL buffer (up to 2× the rolling window). Best-
    // effort — if whisper errors we still emit 'done' so the UI doesn't lock.
    if (call.buffer.length >= MODEM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE) {
      try {
        const finalPass = await this._runWhisper(call.buffer);
        if (finalPass) {
          this._mergeAndEmit(call, finalPass, moduleId);
        }
      } catch (err) {
        console.warn(`[TRANSCRIBE] module=${moduleId}: final-pass error: ${err.message}`);
      }
    }

    this._activeCalls.delete(moduleId);
    console.log(`[TRANSCRIBE] module=${moduleId} sim=${call.simId}: ended (committed=${call.committed.length}c: "${call.committed.slice(-80)}")`);
    this.emit('done', { moduleId, simId: call.simId });
  }

  /**
   * One transcription pass on the current buffer. Skips if there's not
   * enough audio, or if a previous pass is still running (whisper-cli is
   * slower than our cadence — we don't queue overlapping invocations).
   * @private
   */
  async _tick(moduleId) {
    const call = this._activeCalls.get(moduleId);
    if (!call || call.processing) return;
    // At least 1s of audio before bothering whisper
    if (call.buffer.length < MODEM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE) return;

    call.processing = true;
    // Snapshot only the last analysis window — final pass already covers
    // the longer 2× retention used for end-of-call flush.
    const winBytes = CONFIG.WHISPER_WINDOW_SEC * MODEM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;
    const snapshot = call.buffer.length > winBytes
      ? call.buffer.subarray(call.buffer.length - winBytes)
      : call.buffer;
    try {
      const pass = await this._runWhisper(snapshot);
      if (!pass) return;
      this._mergeAndEmit(call, pass, moduleId);
    } catch (err) {
      console.error(`[TRANSCRIBE] module=${moduleId}: whisper error: ${err.message}`);
    } finally {
      call.processing = false;
    }
  }

  /**
   * Merge a fresh whisper pass into the call's running "committed" transcript
   * and emit the result. The merge uses a longest-common-overlap heuristic:
   * pass N+1 was computed over a window that overlaps pass N's window by
   * ~(window - interval) seconds, so its prefix should match the suffix of
   * what we've already committed. We find the largest matching suffix/prefix
   * pair (after normalising whitespace + punctuation) and append only the
   * non-overlapping tail. That way the committed transcript grows without
   * duplicating the overlap region, the user sees a smooth scroll instead of
   * the screen "flashing" between two adjacent windows, and the final pass's
   * audio that wasn't in the last tick still appears.
   * @private
   */
  _mergeAndEmit(call, pass, moduleId) {
    if (pass === call.lastPass) return;
    call.lastPass = pass;

    let next;
    if (!call.committed) {
      next = pass;
    } else {
      // Token-level overlap merge. We compare a normalised key (lowercase,
      // strip punctuation) per token so capitalisation/punctuation drift
      // between passes doesn't break the match, but we keep the ORIGINAL
      // tokens for the output (so the user sees whisper's punctuation).
      // Find the largest k such that committed's last k normalised tokens
      // equal pass's first k normalised tokens — append only the remaining
      // pass tokens.
      const norm = (t) => t.toLowerCase().replace(/[^a-zà-ÿ0-9]+/g, '');
      const cTokens = call.committed.split(/\s+/).filter(Boolean);
      const pTokens = pass.split(/\s+/).filter(Boolean);
      const cNorm = cTokens.map(norm);
      const pNorm = pTokens.map(norm);
      const maxK = Math.min(cTokens.length, pTokens.length);
      let overlap = 0;
      for (let k = maxK; k > 0; k--) {
        let match = true;
        for (let i = 0; i < k; i++) {
          if (cNorm[cTokens.length - k + i] !== pNorm[i]) { match = false; break; }
        }
        if (match) { overlap = k; break; }
      }
      const tail = pTokens.slice(overlap).join(' ');
      next = tail ? `${call.committed} ${tail}` : call.committed;
    }

    next = next.replace(/\s+/g, ' ').trim();
    if (next === call.committed) return;
    call.committed = next;
    this.emit('transcript', { moduleId, simId: call.simId, text: next });
  }

  /**
   * Resample 8 kHz to 16 kHz with linear interpolation, wrap in a WAV
   * header, write to a temp file, and run whisper-cli on it. Returns the
   * trimmed transcript text, or null if whisper produced no output.
   * @param {Buffer} pcm8 - mono 16-bit signed little-endian PCM at 8 kHz
   * @returns {Promise<string|null>}
   * @private
   */
  async _runWhisper(pcm8) {
    const pcm16 = this._upsample8to16(pcm8);
    const wav = this._wrapAsWav(pcm16, WHISPER_SAMPLE_RATE);
    const tmpFile = path.join(
      os.tmpdir(),
      `sim-dash-whisper-${process.pid}-${Date.now()}.wav`
    );
    fs.writeFileSync(tmpFile, wav);
    try {
      const args = [
        '-m', CONFIG.WHISPER_MODEL_PATH,
        '-f', tmpFile,
        '-l', CONFIG.WHISPER_LANG,
        '-otxt',           // write a .txt file next to the input
        '--no-prints',     // suppress progress to stderr
        '--no-timestamps', // raw transcript, no [00:00.000 --> 00:02.000] lines
      ];
      await this._spawn(CONFIG.WHISPER_CLI_PATH, args, 30000);
      // whisper-cli writes <input>.txt next to the input file when -otxt
      const txtFile = `${tmpFile}.txt`;
      if (!fs.existsSync(txtFile)) return null;
      const text = fs.readFileSync(txtFile, 'utf-8').trim();
      try { fs.unlinkSync(txtFile); } catch (_) {}
      return text || null;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }

  /**
   * 8 kHz → 16 kHz linear interpolation. The phone-bandwidth audio has no
   * energy above 4 kHz anyway, so this introduces no real degradation —
   * whisper just needs 16 kHz input.
   * @param {Buffer} pcm8
   * @returns {Buffer}
   * @private
   */
  _upsample8to16(pcm8) {
    const inSamples = pcm8.length / PCM_BYTES_PER_SAMPLE;
    const out = Buffer.alloc(inSamples * 2 * PCM_BYTES_PER_SAMPLE);
    for (let i = 0; i < inSamples; i++) {
      const s1 = pcm8.readInt16LE(i * 2);
      const s2 = i + 1 < inSamples ? pcm8.readInt16LE((i + 1) * 2) : s1;
      const mid = (s1 + s2) >> 1;
      out.writeInt16LE(s1, i * 4);
      out.writeInt16LE(mid, i * 4 + 2);
    }
    return out;
  }

  /**
   * Wrap raw 16-bit signed little-endian PCM in a 44-byte WAV header.
   * @param {Buffer} pcm
   * @param {number} sampleRate
   * @returns {Buffer}
   * @private
   */
  _wrapAsWav(pcm, sampleRate) {
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
  }

  /**
   * Run a child process, capture stderr for diagnostics, time it out after
   * `timeoutMs`. Rejects on non-zero exit so the caller can log it.
   * @param {string} cmd
   * @param {string[]} args
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   * @private
   */
  _spawn(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { windowsHide: true });
      let stderr = '';
      let stdout = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`whisper-cli timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // Format as hex on Windows so 0xC0000xxx crash codes (DLL missing,
          // access violation, etc.) are recognisable and so the decimal
          // form (10-13 digits) doesn't get mis-redacted as a phone number
          // by logRedact.
          const codeStr = (code < 0 || code > 1000)
            ? `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
            : String(code);
          const err = stderr.trim().slice(0, 400) || stdout.trim().slice(0, 400) || '(no output — usually DLL load failure on Windows, run whisper-cli.exe directly to check)';
          reject(new Error(`whisper-cli exit ${codeStr}: ${err}`));
          return;
        }
        resolve();
      });
    });
  }
}

const transcribeService = new TranscribeService();
module.exports = { transcribeService };
