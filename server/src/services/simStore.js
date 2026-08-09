/**
 * @fileoverview Persistent per-SIM store.
 * Saves operator, phone number, and recent messages per SIM to a JSON file so
 * state survives restarts.
 *
 * The store grows organically: when a new topology is received, missing SIMs
 * are added with defaults. Entries are never removed.
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'simStore.json');

/**
 * @typedef {{
 *   operator: string,
 *   phoneNumber: string,
 *   messages: Array
 * }} SimEntry
 */

const MAX_MESSAGES = 10;

const DEFAULT_ENTRY = { operator: '', phoneNumber: '', messages: [] };

class SimStore {
  constructor() {
    /** @type {Record<string, SimEntry>} keyed by "moduleId:simId" */
    this._store = {};
    this._load();
  }

  /** @private */
  _load() {
    try {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [key, val] of Object.entries(parsed)) {
        this._store[key] = { ...DEFAULT_ENTRY, ...(typeof val === 'object' && val ? val : {}) };
      }
    } catch {
      this._store = {};
    }
  }

  /** @private */
  _save() {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(this._store, null, 2));
  }

  /**
   * Ensure a key exists with defaults.
   * @param {string} key
   * @private
   */
  _ensure(key) {
    if (!(key in this._store)) this._store[key] = { ...DEFAULT_ENTRY };
  }

  /**
   * Ensure all SIMs from the current topology have an entry.
   * @param {{ modules: Array<{ id: number, simCount: number }> }} topology
   */
  ensureFromTopology(topology) {
    if (!topology || !topology.modules) return;
    let added = 0;
    for (const mod of topology.modules) {
      for (let s = 0; s < mod.simCount; s++) {
        const key = `${mod.id}:${s}`;
        if (!(key in this._store)) {
          this._store[key] = { ...DEFAULT_ENTRY };
          added++;
        }
      }
    }
    if (added > 0) {
      this._save();
      console.log(`[STORE] Added ${added} new SIM(s) to store`);
    }
  }

  /**
   * Update SIM info fields (operator, phoneNumber). Only provided fields change.
   * @param {number} moduleId
   * @param {number} simId
   * @param {{ operator?: string, phoneNumber?: string }} data
   */
  setSimInfo(moduleId, simId, data) {
    const key = `${moduleId}:${simId}`;
    this._ensure(key);
    let changed = false;
    for (const field of ['operator', 'phoneNumber']) {
      if (data[field] !== undefined && this._store[key][field] !== data[field]) {
        this._store[key][field] = data[field];
        changed = true;
      }
    }
    if (changed) this._save();
  }

  /**
   * Add a message to the store, keeping only the last MAX_MESSAGES.
   * @param {number} moduleId
   * @param {number} simId
   * @param {{ index: number, sender: string, timestamp: string, body: string }} msg
   */
  addMessage(moduleId, simId, msg) {
    const key = `${moduleId}:${simId}`;
    this._ensure(key);
    const msgs = this._store[key].messages;
    const exists = msg.index !== -1
      ? msgs.some((m) => m.index === msg.index)
      : msgs.some((m) => m.sender === msg.sender && m.timestamp === msg.timestamp && m.body === msg.body);
    if (exists) return;
    msgs.push(msg);
    if (msgs.length > MAX_MESSAGES) msgs.splice(0, msgs.length - MAX_MESSAGES);
    this._save();
  }

  /**
   * Replace all messages for a SIM (from an initial SMS list fetch).
   * @param {number} moduleId
   * @param {number} simId
   * @param {Array} messages
   */
  setMessages(moduleId, simId, messages) {
    const key = `${moduleId}:${simId}`;
    this._ensure(key);
    this._store[key].messages = messages.slice(-MAX_MESSAGES);
    this._save();
  }

  /**
   * Get SIM info for a single SIM.
   * @param {number} moduleId
   * @param {number} simId
   * @returns {SimEntry}
   */
  getSimInfo(moduleId, simId) {
    return this._store[`${moduleId}:${simId}`] || { ...DEFAULT_ENTRY };
  }

  /** @returns {Record<string, SimEntry>} Full store snapshot */
  getAll() {
    const out = {};
    for (const [key, entry] of Object.entries(this._store)) {
      out[key] = { ...entry };
    }
    return out;
  }
}

module.exports = new SimStore();
