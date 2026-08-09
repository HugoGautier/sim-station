/**
 * @fileoverview Simple token-based authentication middleware.
 * When AUTH_PASSWORD is set in .env, all HTTP and Socket.io requests
 * require a valid session token obtained via POST /api/login.
 */

const crypto = require('crypto');
const { CONFIG } = require('./constants/config');

/** Active session tokens — Set<string> */
const sessions = new Set();

/** Max login attempts per IP within the time window */
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** Track failed login attempts per IP — Map<string, { count, firstAttempt }> */
const loginAttempts = new Map();

/** Generate a random session token */
function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  return token;
}

/** Validate a token */
function isValidToken(token) {
  return sessions.has(token);
}

/**
 * Timing-safe password comparison.
 * @param {string} input
 * @returns {boolean}
 */
function checkPassword(input) {
  const expected = CONFIG.AUTH_PASSWORD;
  if (typeof input !== 'string' || input.length === 0) return false;
  const inputBuf = Buffer.from(input);
  const expectedBuf = Buffer.from(expected);
  if (inputBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(inputBuf, expectedBuf);
}

/**
 * Check rate limit for an IP. Returns true if blocked.
 * @param {string} ip
 * @returns {boolean}
 */
function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

/**
 * Record a failed login attempt for an IP.
 * @param {string} ip
 */
function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    entry.count++;
  }
}

/**
 * Clear failed attempts for an IP after successful login.
 * @param {string} ip
 */
function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

/**
 * Express middleware — blocks unauthenticated requests.
 * Skips if AUTH_PASSWORD is empty (no auth configured).
 * Allows: POST /api/login, static login page assets.
 */
function authMiddleware(req, res, next) {
  if (!CONFIG.AUTH_PASSWORD) return next();

  // Allow login endpoint
  if (req.path === '/api/login') return next();

  // Check token from cookie
  const token = req.cookies?.auth_token;
  if (token && isValidToken(token)) return next();

  // No valid token — serve login page for HTML requests, 401 for API
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Serve inline login page
  return res.send(loginPage());
}

/**
 * Socket.io auth middleware — rejects unauthenticated connections.
 */
function socketAuthMiddleware(socket, next) {
  if (!CONFIG.AUTH_PASSWORD) return next();

  // Parse cookie from handshake headers
  const cookieHeader = socket.handshake.headers.cookie || '';
  const match = cookieHeader.match(/auth_token=([a-f0-9]{64})/);
  const token = match ? match[1] : null;

  if (token && isValidToken(token)) return next();

  return next(new Error('Unauthorized'));
}

/** Login page HTML */
function loginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SIM Station — Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #F3F4F6;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .login-card {
      background: white;
      border-radius: 12px;
      padding: 32px;
      width: 320px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      color: #1F2937;
      margin-bottom: 24px;
      text-align: center;
    }
    input {
      width: 100%;
      padding: 10px 14px;
      border: 1.5px solid #D1D5DB;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      margin-bottom: 16px;
    }
    input:focus { border-color: #6366F1; }
    button {
      width: 100%;
      padding: 10px;
      background: #6366F1;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #4F46E5; }
    .error {
      color: #EF4444;
      font-size: 13px;
      text-align: center;
      margin-bottom: 12px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>SIM Station</h1>
    <div class="error" id="err">Incorrect password</div>
    <form id="form">
      <input type="password" id="pw" placeholder="Password" autofocus>
      <button type="submit">Sign in</button>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        document.getElementById('err').style.display = 'block';
        document.getElementById('pw').value = '';
        document.getElementById('pw').focus();
      }
    });
  </script>
</body>
</html>`;
}

module.exports = { createToken, isValidToken, checkPassword, isRateLimited, recordFailedAttempt, clearAttempts, authMiddleware, socketAuthMiddleware };
