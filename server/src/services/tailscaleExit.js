/**
 * @fileoverview Toggle this host's Tailscale exit-node advertisement on/off.
 *
 * Policy: this host advertises as an exit node continuously, INCLUDING
 * across dashboard server restarts and graceful shutdowns. The tailscaled
 * daemon is a separate Windows service that keeps running even when this
 * Node server is off, so the host can still relay traffic from the peer
 * over its WiFi/Ethernet path. A peer configured with
 * `--exit-node=<this-host>` would otherwise be knocked offline whenever
 * we restart the dashboard — modern Tailscale "blocks" rather than
 * transparently falls back when the advertised exit node disappears.
 *
 * `disableExitNode` is kept available for ad-hoc CLI usage but is NOT
 * wired into shutdown / reset paths.
 *
 * `cycleExitNode` (off → 1.5s → on) is run at startup to force a fresh
 * netmap push to peers — useful when a previous tailscaled state left
 * the peer's exit-node selection in a stale "blocked" cache.
 *
 * Uses the Tailscale CLI from PATH. On Windows the installer typically adds
 * `C:\Program Files\Tailscale\` to PATH. Requires admin for state changes —
 * already the case since RNDIS route manipulation needs the same privilege.
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Run a `tailscale` CLI command and log any output. Never throws — the rest
 * of the server must keep working even if Tailscale isn't installed.
 * @param {string} args
 * @param {string} logTag
 */
async function runTs(args, logTag) {
  try {
    const { stdout, stderr } = await execAsync(`tailscale ${args}`, { timeout: 10000 });
    const out = (stdout || '').trim();
    if (out) console.log(`[TS] ${logTag} ${out.split(/\r?\n/).join(' | ')}`);
    if (stderr && stderr.trim()) console.warn(`[TS] ${logTag} stderr: ${stderr.trim()}`);
  } catch (err) {
    console.warn(`[TS] ${logTag} failed (Tailscale CLI missing or not admin?): ${err.message.split('\n')[0]}`);
  }
}

/**
 * Advertise this host as an exit node so a connected peer can route default
 * traffic through our 4G uplink.
 * @returns {Promise<void>}
 */
async function enableExitNode() {
  return runTs('set --advertise-exit-node=true', 'advertise=on');
}

/**
 * Stop advertising as an exit node. The peer's Tailscale client will see the
 * exit node go away and automatically fall back to its own direct internet.
 * @returns {Promise<void>}
 */
async function disableExitNode() {
  return runTs('set --advertise-exit-node=false', 'advertise=off');
}

/**
 * Force a clean re-advertisement of the exit node by toggling it off then
 * on. Use at startup when the previous run left stale advertisement state
 * on the coordination server or in the peer's exit-node selection cache —
 * a plain `--advertise-exit-node=true` would be a no-op from the peer's
 * point of view and the remote PC's traffic stays broken until a manual
 * re-toggle. The off→on cycle forces the coordination server to push a
 * fresh netmap to peers, which re-resolves their exit-node route.
 *
 * 1.5s gap between off and on covers the coordination server's debounce
 * window — without it the two updates can be coalesced into a single
 * "still on" no-op and we're back to square one.
 * @returns {Promise<void>}
 */
async function cycleExitNode() {
  console.log('[TS] cycle exit-node: advertise=false, then re-true after 1.5s');
  await runTs('set --advertise-exit-node=false', 'advertise=off (cycle)');
  await new Promise((r) => setTimeout(r, 1500));
  await runTs('set --advertise-exit-node=true', 'advertise=on (cycle)');
  console.log('[TS] cycle exit-node done');
}

module.exports = { enableExitNode, disableExitNode, cycleExitNode };
