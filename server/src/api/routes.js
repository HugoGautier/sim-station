/**
 * @fileoverview Express REST API routes for SIM dashboard.
 * All route handlers delegate to simService / muxService for business logic.
 */

const { Router } = require('express');
const simService = require('../services/simService');
const { muxService } = require('../services/muxService');
const { CONFIG } = require('../constants/config');
const { createToken, checkPassword, isRateLimited, recordFailedAttempt, clearAttempts } = require('../auth');
const { listAllPorts } = require('../services/portDetector');
const { serialService } = require('../services/serialService');

const router = Router();

/**
 * POST /api/login
 * Authenticate with password and receive a session cookie.
 */
router.post('/api/login', (req, res) => {
  const ip = req.ip;

  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return;
  }

  const { password } = req.body;
  if (!CONFIG.AUTH_PASSWORD || !checkPassword(password)) {
    recordFailedAttempt(ip);
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  clearAttempts(ip);
  const token = createToken();
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
  res.json({ success: true });
});

/**
 * GET /api/serial/status
 * Return the current Arduino serial connection status.
 */
router.get('/api/serial/status', (req, res) => {
  const status = req.app.get('serialStatus');
  if (!status) {
    res.status(503).json({ error: 'Serial status not yet available' });
    return;
  }
  res.json(status);
});

/**
 * GET /api/topology
 * Return the current module/SIM topology.
 */
router.get('/api/topology', (req, res) => {
  const topology = req.app.get('topology');
  if (!topology) {
    res.status(503).json({ error: 'Topology not yet available' });
    return;
  }
  res.json(topology);
});

/**
 * GET /api/sim/:moduleId/:simId/messages
 * Return SMS history for a specific SIM.
 */
router.get('/api/sim/:moduleId/:simId/messages', async (req, res) => {
  const moduleId = parseInt(req.params.moduleId, 10);
  const simId = parseInt(req.params.simId, 10);
  if (isNaN(moduleId) || isNaN(simId)) {
    res.status(400).json({ error: 'Invalid moduleId or simId' });
    return;
  }
  try {
    const messages = await simService.getSms(moduleId, simId);
    res.json({ moduleId, simId, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sim/:moduleId/:simId/select
 * Select a SIM on the MUX.
 */
router.post('/api/sim/:moduleId/:simId/select', async (req, res) => {
  const moduleId = parseInt(req.params.moduleId, 10);
  const simId = parseInt(req.params.simId, 10);
  if (isNaN(moduleId) || isNaN(simId)) {
    res.status(400).json({ error: 'Invalid moduleId or simId' });
    return;
  }
  try {
    await muxService.selectSim(moduleId, simId);
    res.json({ success: true, moduleId, simId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sim/:moduleId/:simId/answer
 * Answer an incoming call.
 */
router.post('/api/sim/:moduleId/:simId/answer', async (req, res) => {
  const moduleId = parseInt(req.params.moduleId, 10);
  const simId = parseInt(req.params.simId, 10);
  if (isNaN(moduleId) || isNaN(simId)) {
    res.status(400).json({ error: 'Invalid moduleId or simId' });
    return;
  }
  try {
    const success = await simService.answerCall(moduleId, simId);
    res.json({ success, moduleId, simId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sim/:moduleId/:simId/hangup
 * Hang up the current call.
 */
router.post('/api/sim/:moduleId/:simId/hangup', async (req, res) => {
  const moduleId = parseInt(req.params.moduleId, 10);
  const simId = parseInt(req.params.simId, 10);
  if (isNaN(moduleId) || isNaN(simId)) {
    res.status(400).json({ error: 'Invalid moduleId or simId' });
    return;
  }
  try {
    const success = await simService.hangupCall(moduleId, simId);
    res.json({ success, moduleId, simId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sim/:moduleId/:simId/dtmf
 * Send a DTMF digit during an active call.
 * Body: { digit: "0"-"9" | "*" | "#" }
 */
router.post('/api/sim/:moduleId/:simId/dtmf', async (req, res) => {
  const moduleId = parseInt(req.params.moduleId, 10);
  const simId = parseInt(req.params.simId, 10);
  const { digit } = req.body;
  if (isNaN(moduleId) || isNaN(simId)) {
    res.status(400).json({ error: 'Invalid moduleId or simId' });
    return;
  }
  if (!digit || !/^[0-9*#]$/.test(digit)) {
    res.status(400).json({ error: 'Invalid digit. Must be 0-9, *, or #' });
    return;
  }
  try {
    const success = await simService.sendDtmf(moduleId, simId, digit);
    res.json({ success, moduleId, simId, digit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/system/info
 * Return system info: topology breakdown, detected COM ports, serial status.
 */
router.get('/api/system/info', async (req, res) => {
  const topology = req.app.get('topology');
  const serialStatus = req.app.get('serialStatus');

  let ports = [];
  try {
    const allPorts = await listAllPorts();
    ports = allPorts.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
      friendlyName: p.friendlyName || '',
    }));
  } catch {
    // port listing failed — return empty
  }

  res.json({
    serial: {
      path: serialStatus?.path || '',
      label: serialStatus?.label || '',
      connected: serialStatus?.connected || false,
    },
    topology: topology
      ? {
          modules: topology.modules.map((m) => ({
            id: m.id,
            simCount: m.simCount,
          })),
          totalSims: topology.modules.reduce((sum, m) => sum + m.simCount, 0),
        }
      : null,
    ports,
  });
});

module.exports = { router };
