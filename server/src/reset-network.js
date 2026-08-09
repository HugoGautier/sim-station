/**
 * @fileoverview Standalone network-state reset.
 *
 * Run this when the server is OFF and the host's WiFi feels unstable —
 * usually means the previous run was killed before gracefulShutdown could
 * restore RNDIS metrics, so the cellular adapter is still pinned at
 * InterfaceMetric=1 and Windows keeps trying to route through a dead
 * bearer.
 *
 * Usage:
 *   node src/reset-network.js
 *   (or)  npm run reset-network
 *
 * Effect: bumps every RNDIS InterfaceMetric to 999, re-enables any RNDIS
 * left disabled, and removes RNDIS-specific persistent default routes.
 * Idempotent. Does NOT touch the Tailscale exit-node advertisement —
 * the remote PC's --exit-node config relies on it staying live across
 * server restarts.
 */

const { restoreRndisAdapters } = require('./services/windowsNetRoutes');

(async () => {
  console.log('[RESET] restoring RNDIS adapters...');
  await restoreRndisAdapters().catch((err) => {
    console.error(`[RESET] restoreRndisAdapters failed: ${err.message}`);
  });

  console.log('[RESET] done — host should default to WiFi/Ethernet again.');
})();
