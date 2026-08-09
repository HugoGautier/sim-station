/**
 * @fileoverview Wrapper that auto-restarts the server on exit code 0.
 * Usage: node src/launcher.js
 *
 * Signal handling: on Ctrl+C the Windows console broadcasts CTRL_C_EVENT
 * to every process attached to the same console — both this launcher and
 * the spawned server receive their own SIGINT independently. Without an
 * explicit handler here, Node's default SIGINT behavior would exit the
 * launcher immediately and tear down the inherited stdio while the server
 * is still running its graceful shutdown. The result was [SHUTDOWN] never
 * appearing in server.log and RNDIS routes / exit-node advertisement
 * staying live after the user thought the server was gone.
 *
 * Fix: install a no-op handler so the launcher stays alive; the server
 * runs its own graceful shutdown via its own SIGINT handler, and the
 * launcher exits when the child does.
 */

const { spawn } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'index.js');

/** @type {import('child_process').ChildProcess | null} */
let currentChild = null;

/** True once the user signalled shutdown — stops the auto-restart loop. */
let shuttingDown = false;

function start() {
  console.log('[LAUNCHER] Starting server...');
  const child = spawn(process.argv[0], [script], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  currentChild = child;

  child.on('exit', (code) => {
    currentChild = null;
    if (shuttingDown) {
      // User asked us to stop — quit silently regardless of the child's
      // exit code (it may have been killed mid-shutdown by a 2nd Ctrl+C).
      process.exit(0);
    }
    if (code === 0) {
      console.log('[LAUNCHER] Server exited cleanly — restarting in 1s...');
      setTimeout(start, 1000);
    } else {
      console.error(`[LAUNCHER] Server crashed with code ${code} — not restarting`);
      process.exit(code ?? 1);
    }
  });
}

/**
 * Stay alive while the child handles its own shutdown. The signal already
 * reached the child via the console broadcast — we just need to NOT exit
 * synchronously here. Safety net: if the child wedges, force-kill after 10s.
 */
function onTerminationSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    if (currentChild) {
      try { currentChild.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
  }, 10000).unref();
}

process.on('SIGINT',  onTerminationSignal);
process.on('SIGTERM', onTerminationSignal);
process.on('SIGHUP',  onTerminationSignal);

start();
