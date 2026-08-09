/**
 * @fileoverview Main dashboard — renders module rows with SIM cards.
 * Manages per-module SIM selection state.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../../hooks/useSocket';
import { useTopology } from '../../hooks/useTopology';
import { useSerialStatus } from '../../hooks/useSerialStatus';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../constants/socketEvents';
import { SimCard } from '../SimCard/SimCard';
import { LoginForm } from '../LoginForm/LoginForm';
import { SystemInfoModal } from '../SystemInfo/SystemInfoModal';
import { ServerLogsModal } from '../SystemInfo/ServerLogsModal';
import { useSimStore } from '../../hooks/useSimStore';
import { useTheme } from '../../hooks/useTheme';
import { useDataSim } from '../../hooks/useDataSim';
import { useServerLogs } from '../../hooks/useServerLogs';
import './Dashboard.css';

/**
 * Dashboard component — top-level layout with one horizontal row per module.
 */
export function Dashboard() {
  const { socket, isConnected } = useSocket();
  const { modules, loading, error } = useTopology();
  const { serialStatus } = useSerialStatus();
  const { getSimInfo } = useSimStore();
  const { theme, toggleTheme } = useTheme();
  const { dataState, transit, toggleData, isDataSim } = useDataSim();
  const serverLogs = useServerLogs();
  const [showSystemInfo, setShowSystemInfo] = useState(false);
  const [showServerLogs, setShowServerLogs] = useState(false);

  /** Per-SIM registration status, keyed "moduleId:simId". */
  const [simStatuses, setSimStatuses] = useState(new Map());

  /** Per-module RNDIS driver status: { [moduleId]: 'ok'|'missing'|'unknown' } */
  const [rndisStatus, setRndisStatus] = useState({});

  /** Pending data-activation requests per module. Map<moduleId, simId>. */
  const [pendingDataRequests, setPendingDataRequests] = useState(new Map());

  const [restarting, setRestarting] = useState(false);

  const arduinoReady = isConnected && serialStatus === 'ready';
  const arduinoInitializing = isConnected && serialStatus === 'initializing';
  const arduinoPillClass = arduinoReady ? 'status-ok' : arduinoInitializing ? 'status-warn' : 'status-err';
  const arduinoDotClass = arduinoReady ? 'dot-ok' : arduinoInitializing ? 'dot-warn' : 'dot-err';
  const arduinoLabel = arduinoInitializing ? 'Arduino (loading...)' : 'Arduino';

  const [wasDisconnected, setWasDisconnected] = useState(false);

  useEffect(() => {
    if (restarting && !isConnected) {
      setWasDisconnected(true);
    }
    if (wasDisconnected && isConnected) {
      setRestarting(false);
      setWasDisconnected(false);
    }
  }, [restarting, isConnected, wasDisconnected]);

  const handleRestart = useCallback(() => {
    if (restarting) return;
    setRestarting(true);
    socket.emit(CLIENT_EVENTS.SERVER_RESTART);
  }, [socket, restarting]);

  /** Per-module SIM selection. Map<moduleId, simId>. */
  const [selections, setSelections] = useState(new Map());

  /** Per-module queue state from server. Map<moduleId, { activating: number|null, queued: number[] }> */
  const [moduleQueues, setModuleQueues] = useState(new Map());

  useEffect(() => {
    const onQueue = ({ moduleId, activating, queued }) => {
      setModuleQueues((prev) => {
        const next = new Map(prev);
        next.set(moduleId, { activating, queued });
        return next;
      });
    };
    socket.on(SERVER_EVENTS.SIM_QUEUE, onQueue);
    return () => socket.off(SERVER_EVENTS.SIM_QUEUE, onQueue);
  }, [socket]);

  // Server tells us it's shutting down — drop every piece of UI state that was
  // tracking a live server-side selection so the dashboard doesn't display
  // ghost highlights ("selected SIM, unknown status") until the user refreshes.
  useEffect(() => {
    const onClear = () => {
      setSelections(new Map());
      setModuleQueues(new Map());
      setPendingDataRequests(new Map());
      setSimStatuses(new Map());
    };
    socket.on(SERVER_EVENTS.SELECTIONS_CLEAR, onClear);
    return () => socket.off(SERVER_EVENTS.SELECTIONS_CLEAR, onClear);
  }, [socket]);

  // On (re)connect the server sends a snapshot of which SIM is MUX-active per
  // module — repaint the "selected" border immediately instead of waiting for
  // the user to re-click. We MERGE (don't replace) so any optimistic local
  // selection that pre-dates the connect event isn't clobbered.
  useEffect(() => {
    const onRestore = ({ selections: list }) => {
      if (!Array.isArray(list)) return;
      setSelections((prev) => {
        const next = new Map(prev);
        for (const { moduleId, simId } of list) {
          if (!next.has(moduleId)) next.set(moduleId, simId);
        }
        return next;
      });
    };
    socket.on(SERVER_EVENTS.SELECTIONS_RESTORE, onRestore);
    return () => socket.off(SERVER_EVENTS.SELECTIONS_RESTORE, onRestore);
  }, [socket]);

  // Per-module RNDIS driver status — drives the header warning + disables
  // affected modules' SIM cards.
  useEffect(() => {
    const onRndis = ({ statuses }) => setRndisStatus(statuses || {});
    socket.on(SERVER_EVENTS.RNDIS_STATUS, onRndis);
    return () => socket.off(SERVER_EVENTS.RNDIS_STATUS, onRndis);
  }, [socket]);

  // Push our current selections back to the server on every (re)connect.
  // socket.io reconnect assigns a new socket.id whose clientSelections map
  // starts empty — without this rehydrate, emitToSelectedClients silently
  // skips our socket until the user clicks something.
  useEffect(() => {
    if (!isConnected) return;
    const payload = {
      selections: Array.from(selections, ([moduleId, simId]) => ({ moduleId, simId })),
    };
    socket.emit(CLIENT_EVENTS.SELECTIONS_REHYDRATE, payload);
    // selections intentionally not in deps: we want to fire on connect only,
    // not on every click (each SIM_SELECT already updates the server map via
    // executeSimSelect). isConnected flips false→true on reconnect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, socket]);

  useEffect(() => {
    const onStatus = ({ moduleId, simId, status }) => {
      setSimStatuses((prev) => {
        const next = new Map(prev);
        next.set(`${moduleId}:${simId}`, status);
        return next;
      });
    };
    socket.on(SERVER_EVENTS.SIM_STATUS, onStatus);
    return () => socket.off(SERVER_EVENTS.SIM_STATUS, onStatus);
  }, [socket]);

  // Fire DATA_SELECT once a pending-data SIM reaches MUX-selected + registered.
  // Also clears stale pending on error. The "latest wins" rule is enforced
  // naturally: setPendingDataRequests(moduleId, newSimId) overwrites the key.
  useEffect(() => {
    if (pendingDataRequests.size === 0) return;
    for (const [moduleId, simId] of pendingDataRequests) {
      const key = `${moduleId}:${simId}`;
      const status = simStatuses.get(key);
      const q = moduleQueues.get(moduleId);
      const isMuxSelected = selections.get(moduleId) === simId;
      const isActivating = q?.activating === simId;
      const isQueued = q?.queued?.includes(simId);
      const isRegistered = status === 'registered' || status === 'roaming';
      if (status === 'error') {
        // The modem cycles through transient CREG states while searching
        // (typically 0 → 2 → 3 → 5); +CREG: 3 emits a one-shot status=error
        // that doesn't mean the SIM ultimately fails. Only honour the error
        // when the muxService lifecycle has stopped activating this SIM —
        // by then the FINAL outcome (registered/roaming via switch:registered,
        // or persistent error via switch:timeout) is what's in `status`.
        if (isActivating || isQueued) continue;
        setPendingDataRequests((prev) => {
          const next = new Map(prev);
          next.delete(moduleId);
          return next;
        });
        continue;
      }
      if (isMuxSelected && !isActivating && !isQueued && isRegistered) {
        socket.emit(CLIENT_EVENTS.DATA_SELECT, { moduleId, simId });
        setPendingDataRequests((prev) => {
          const next = new Map(prev);
          next.delete(moduleId);
          return next;
        });
      }
    }
  }, [pendingDataRequests, simStatuses, selections, moduleQueues, socket]);

  const handleToggleData = useCallback(
    (moduleId, simId) => {
      if (!arduinoReady) return;

      // If this SIM is already the active data SIM, let the server toggle it off.
      if (isDataSim(moduleId, simId)) {
        toggleData(moduleId, simId);
        return;
      }

      // Clicking a pending-data SIM on the same module cancels the pending.
      if (pendingDataRequests.get(moduleId) === simId) {
        setPendingDataRequests((prev) => {
          const next = new Map(prev);
          next.delete(moduleId);
          return next;
        });
        return;
      }

      // New data intent — overrides any existing pending on this module.
      setPendingDataRequests((prev) => {
        const next = new Map(prev);
        next.set(moduleId, simId);
        return next;
      });

      const q = moduleQueues.get(moduleId);
      const isMuxSelected = selections.get(moduleId) === simId;
      const isActivating = q?.activating === simId;
      const isQueued = q?.queued?.includes(simId);
      if (!isMuxSelected && !isActivating && !isQueued) {
        setSelections((prev) => {
          const next = new Map(prev);
          next.set(moduleId, simId);
          return next;
        });
        socket.emit(CLIENT_EVENTS.SIM_SELECT, { moduleId, simId });
      }
    },
    [socket, arduinoReady, selections, moduleQueues, pendingDataRequests, isDataSim, toggleData]
  );

  const handleSelect = useCallback(
    (moduleId, simId) => {
      if (!arduinoReady) return;

      const q = moduleQueues.get(moduleId);
      const isQueued = q?.queued?.includes(simId) || false;
      const isActivating = q?.activating === simId;
      const isSelected = selections.get(moduleId) === simId;
      const hasBorder = isQueued || isActivating || isSelected;

      // No border → select
      if (!hasBorder) {
        setSelections((prev) => {
          const next = new Map(prev);
          next.set(moduleId, simId);
          return next;
        });
        socket.emit(CLIENT_EVENTS.SIM_SELECT, { moduleId, simId });
        return;
      }

      // Can't deselect a SIM that's mid-activation — the MUX switch is in
      // flight and CFUN=0 here would brick it. Wait until isActivating
      // clears, then the click can release.
      if (isActivating) return;

      if (isQueued) {
        socket.emit(CLIENT_EVENTS.SIM_DEQUEUE, { moduleId, simId });
      }
      if (isSelected) {
        setSelections((prev) => {
          const next = new Map(prev);
          next.delete(moduleId);
          return next;
        });
        // Tell the server too — without this the modem keeps the radio on
        // for this SIM and the card UI lies (still shows roaming, signal,
        // etc.) even though the user has visually deselected it.
        socket.emit(CLIENT_EVENTS.SIM_DESELECT, { moduleId, simId });
        // Drop any pending data intent on this module — a deselect means
        // "release this SIM", not "queue a data activation".
        setPendingDataRequests((prev) => {
          if (!prev.has(moduleId)) return prev;
          const next = new Map(prev);
          next.delete(moduleId);
          return next;
        });
      }
    },
    [socket, selections, arduinoReady, moduleQueues]
  );

  if (loading) {
    return (
      <div className="dashboard-status">
        Connecting to Arduino...
      </div>
    );
  }

  if (error === 'Unauthorized') {
    return <LoginForm onSuccess={() => window.location.reload()} />;
  }

  if (error) {
    return (
      <div className="dashboard-status dashboard-error">
        Connection error: {error}
      </div>
    );
  }

  if (modules.length === 0) {
    return (
      <div className="dashboard-status">
        No modules detected. Check Arduino connection.
      </div>
    );
  }

  // Modules whose RNDIS network-adapter driver isn't installed. Their data
  // won't work and we disable their SIM cards until the user installs it.
  const driverMissingModules = modules
    .map((m) => m.id)
    .filter((id) => rndisStatus[id] === 'missing');

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1 className="dashboard-title">SIM Station</h1>
        <div className="dashboard-header-right">
          <div className="dashboard-statuses">
            <span className={`status-pill ${isConnected ? 'status-ok' : 'status-err'}`}>
              <span className={`status-dot ${isConnected ? 'dot-ok' : 'dot-err'}`} />
              Server
            </span>
            <span className={`status-pill ${arduinoPillClass}`}>
              <span className={`status-dot ${arduinoDotClass}`} />
              {arduinoLabel}
            </span>
            {driverMissingModules.length > 0 && (
              <span
                className="status-pill status-warn"
                title={
                  `RNDIS driver missing on module(s) ${driverMissingModules.join(', ')}. ` +
                  `4G data won't work and these SIMs are disabled until you install it.\n\n` +
                  `Fix: Device Manager → "Other devices" → right-click the RNDIS entry → ` +
                  `Update driver → Browse my computer → "Let me pick from a list" → ` +
                  `Network adapters → Microsoft → "Remote NDIS Compatible Device" (a.k.a. Carte RNDIS USB). ` +
                  `Then unplug/replug the module. Or install the official SimCom driver to make it permanent.`
                }
              >
                <span className="status-dot dot-warn" />
                Driver: module {driverMissingModules.join(', ')}
              </span>
            )}
            <DataStatusPill dataState={dataState} transit={transit} onToggleOff={() => toggleData(dataState.moduleId, dataState.simId)} />
          </div>
          <button
            className={`dashboard-icon-btn${restarting ? ' restart-spin' : ''}`}
            onClick={handleRestart}
            title="Restart server"
            disabled={restarting}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            className="dashboard-icon-btn"
            onClick={() => setShowSystemInfo(true)}
            title="System information"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
          <button
            className="dashboard-icon-btn"
            onClick={() => setShowServerLogs(true)}
            title="Server logs"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="16" y2="17" />
              <line x1="8" y1="9" x2="11" y2="9" />
            </svg>
          </button>
        </div>
      </header>

      {showSystemInfo && (
        <SystemInfoModal
          onClose={() => setShowSystemInfo(false)}
          serverConnected={isConnected}
          arduinoStatus={arduinoInitializing ? 'initializing' : arduinoReady ? 'ready' : 'disconnected'}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      )}

      {showServerLogs && (
        <ServerLogsModal
          onClose={() => setShowServerLogs(false)}
          serverLogs={serverLogs}
        />
      )}

      {(() => {
        const renderCard = (mod, simId) => {
          const q = moduleQueues.get(mod.id);
          const isActivating = q?.activating === simId;
          const isQueued = q?.queued?.includes(simId) || false;
          const isDataPending = pendingDataRequests.get(mod.id) === simId;
          const driverMissing = rndisStatus[mod.id] === 'missing';
          return (
            <SimCard
              key={`${mod.id}-${simId}`}
              moduleId={mod.id}
              simId={simId}
              isSelected={selections.get(mod.id) === simId}
              isActivating={isActivating}
              isQueued={isQueued}
              isDisabled={!arduinoReady || driverMissing}
              disabledReason={driverMissing ? 'RNDIS driver missing — install it (see header warning)' : ''}
              onSelect={handleSelect}
              initialInfo={getSimInfo(mod.id, simId)}
              dataStatus={isDataSim(mod.id, simId) ? dataState.status : 'off'}
              dataIp={isDataSim(mod.id, simId) ? dataState.ip : null}
              isDataPending={isDataPending}
              onToggleData={handleToggleData}
            />
          );
        };

        // Desktop: one column per module
        const desktop = (
          <div className="module-columns">
            {modules.map((mod) => (
              <div key={mod.id} className="module-column">
                <div className="module-label">Module {mod.id}</div>
                <div className="module-sims">
                  {Array.from({ length: mod.simCount }, (_, simId) => renderCard(mod, simId))}
                </div>
              </div>
            ))}
          </div>
        );

        // Mobile: SIM-major, modules chunked 2 per row
        const maxSims = modules.reduce((m, mod) => Math.max(m, mod.simCount), 0);
        const chunks = [];
        for (let i = 0; i < modules.length; i += 2) chunks.push(modules.slice(i, i + 2));
        const mobile = (
          <div className="mobile-sim-grid">
            {Array.from({ length: maxSims }, (_, simId) => (
              <div key={simId} className="mobile-sim-block">
                <div className="module-label">SIM {simId}</div>
                {chunks.map((chunk, idx) => (
                  <div key={idx} className="mobile-sim-row">
                    {chunk.map((mod) =>
                      simId < mod.simCount ? (
                        <div key={mod.id} className="mobile-sim-cell">
                          <div className="mobile-sim-cell-label">Module {mod.id}</div>
                          {renderCard(mod, simId)}
                        </div>
                      ) : (
                        <div key={mod.id} className="mobile-sim-cell" />
                      )
                    )}
                    {chunk.length === 1 && <div className="mobile-sim-cell" />}
                  </div>
                ))}
              </div>
            ))}
          </div>
        );

        return (
          <>
            {desktop}
            {mobile}
          </>
        );
      })()}
    </div>
  );
}

/**
 * Compact status pill showing which SIM is the 4G data SIM.
 * Click while active/connecting to turn it off; hidden interaction when off.
 * @param {{ dataState: { moduleId: number|null, simId: number|null, status: 'off'|'connecting'|'active'|'error', ip?: string|null, publicIp?: string|null }, transit: 'cellular'|'local'|'unknown'|null, onToggleOff: () => void }} props
 */
function DataStatusPill({ dataState, transit, onToggleOff }) {
  const { status, ip, publicIp } = dataState;
  const isOff = status === 'off';
  // Pending = server still attaching, OR active but transit verdict in flight
  // (transit===null while the ipify fetch runs). Once the verdict comes in
  // (cellular/local/unknown) the pending state drops.
  const isPending = !isOff && status !== 'error' && (status === 'connecting' || transit === null);
  const dotClass = isOff
    ? 'dot-data is-off'
    : status === 'error'
    ? 'dot-err'
    : isPending
    ? 'dot-data is-connecting'
    : 'dot-data';
  const suffix = isPending
    ? ''
    : transit === 'cellular'
    ? ' · Cellular'
    : transit === 'local'
    ? ' · Local'
    : ''; // 'unknown' or other → no suffix; the IP couldn't be verified end-to-end
  const label = `Data${suffix}`;
  const title = isOff
    ? 'No SIM used for data'
    : status === 'connecting'
    ? 'Activating…'
    : isPending
    ? `Verifying network egress (host IP: ${publicIp || ip || 'unknown'})…`
    : transit === 'cellular'
    ? `Egress via 4G (public IP: ${publicIp}) — click to disable`
    : transit === 'local'
    ? `Client uses its own connection (host IP: ${publicIp}) — click to disable`
    : transit === 'unknown'
    ? `Active (public IP unverified — modem IP: ${ip}) — click to disable`
    : ip
    ? `IP: ${ip} — click to disable`
    : 'Click to disable data';

  return (
    <span
      role="button"
      aria-disabled={isOff}
      tabIndex={isOff ? -1 : 0}
      className={`status-pill status-data${isOff ? ' is-off' : ''}${isPending ? ' is-pending' : ''}`}
      onClick={isOff ? undefined : onToggleOff}
      onKeyDown={(e) => {
        if (isOff) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleOff();
        }
      }}
      title={title}
    >
      <span className={`status-dot ${dotClass}`} />
      {label}
    </span>
  );
}
