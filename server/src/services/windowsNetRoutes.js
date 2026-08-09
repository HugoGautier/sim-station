/**
 * @fileoverview Windows-only helpers to manage the host's RNDIS adapters
 * and toggle the default route between WiFi/Ethernet and cellular.
 *
 * Why a two-step activation: when the SIM7600 RNDIS comes up it adds a
 * 0.0.0.0/0 route. We need to test the bearer is actually usable before
 * making it the host's default — otherwise a dead bearer breaks the
 * host's WiFi-based internet (and the Tailscale peer egressing through
 * the host loses connectivity). So:
 *
 *   - prepareRndisAdapter(atPortPath): make the matching RNDIS FUNCTIONAL
 *     without promoting it. Disables every other RNDIS (anti-collision on
 *     192.168.225.0/24), Disable/Enable cycles the active one for a fresh
 *     DHCP lease, clamps MTU to 1430. After this returns, sockets bound
 *     to the adapter's source IP can reach 4G via localAddress routing,
 *     but the host's default route still points at WiFi.
 *
 *   - promoteRndisAdapter(atPortPath): set InterfaceMetric=1 + add a
 *     fresh 0.0.0.0/0 with RouteMetric=0. ONLY call after the bearer
 *     was probed end-to-end successfully (e.g. public IP fetched). Once
 *     this runs, all default-route traffic from the host (and Tailscale
 *     exit-node peers) goes through 4G.
 *
 *   - prioritizeRndisAdapter(atPortPath): convenience that runs prepare
 *     + promote in sequence. Kept for paths that want the old all-or-
 *     nothing behavior.
 *
 *   - restoreRndisAdapters(): bump InterfaceMetric to 999 on every RNDIS
 *     and disable AutomaticMetric so DHCP renewals don't silently restore
 *     a low metric. The default route is kept (we still need one for the
 *     adapter to be usable when selected explicitly). Call at startup and
 *     on data off.
 *
 * Requires the server to run with administrator privileges. If not elevated
 * PowerShell refuses and we log a warning — routing stays whatever it was.
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * @param {string} ps
 * @param {string} logTag
 * @param {number} [timeoutMs=30000] - override for long-running PS scripts
 *   like ensureRndisDriver where Pass 1 + Pass 2 + Pass 3 chain can blow
 *   past the default 30s and get killed mid-execution.
 */
async function runPs(ps, logTag, timeoutMs = 30000) {
  if (process.platform !== 'win32') return '';
  const cmd = `powershell -NoProfile -NonInteractive -Command "${ps}"`;
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs });
    const out = (stdout || '').trim();
    if (out) console.log(`[NET] ${logTag} ${out.split(/\r?\n/).join(' | ')}`);
    if (stderr && stderr.trim()) {
      console.warn(`[NET] ${logTag} stderr: ${stderr.trim().split(/\r?\n/).join(' | ')}`);
    }
    return out;
  } catch (err) {
    // execAsync rejection on non-zero exit. err.stdout / err.stderr carry
    // the real PowerShell output — surface them so the actual error is
    // readable, instead of "Command failed: <2KB of escaped command>".
    const stderr = (err.stderr || '').trim().split(/\r?\n/).filter(Boolean).join(' | ');
    const stdout = (err.stdout || '').trim().split(/\r?\n/).filter(Boolean).join(' | ');
    const killed = err.killed ? ' (timeout reached, process killed)' : '';
    console.warn(`[NET] ${logTag} failed (code=${err.code ?? '?'})${killed}: stderr=[${stderr}] stdout=[${stdout}]`);
    return (err.stdout || '').toString();
  }
}

/**
 * Make a single module's RNDIS the preferred default route and push every
 * other RNDIS back to metric 999. Without the demotion pass, previously
 * prioritised adapters (from a past data session) keep metric 1 and the
 * system default becomes a race between several RNDIS adapters.
 *
 * The active adapter is identified by USB instance hash: every interface of
 * a SIM7600 composite device (AT, audio, RNDIS) has an InstanceId of the
 * form `USB\VID_XXXX&PID_YYYY&MI_ZZ\<hash>&<iface>`, where <hash> is the
 * per-physical-device segment shared across all interfaces. We extract that
 * hash from the AT COM port and match it against each RNDIS. (ContainerId
 * would be the textbook answer but isn't always readable on Ports-class
 * devices on this machine, which silently broke module→adapter mapping.)
 *
 * Two tricks are needed to beat WiFi reliably on the prioritised adapter:
 *   - Route metric must be low. DHCP typically sets it to 256, so we delete
 *     whatever is there and add our own with RouteMetric=0.
 *   - InterfaceMetric must be low (set to 1) with AutomaticMetric disabled,
 *     otherwise Windows recomputes a large metric from USB link speed.
 *
 * The gateway is discovered via Get-NetIPConfiguration. Fallback: last octet
 * of the adapter IP swapped for .1 (SIM7600 modems expose the modem as .1
 * on the 192.168.225.x subnet).
 * @param {string} atPortPath — AT COM port of the active module (e.g. "COM5")
 * @returns {Promise<void>}
 */
/**
 * Shared PowerShell preamble: resolve the per-device USB instance hash for
 * the AT port we're activating. `$activeHash` is then matched against each
 * RNDIS adapter's PnPDeviceID to single out the right one.
 * @param {string} safePort
 * @returns {string[]}
 */
function _hashResolverPs(safePort) {
  return [
    `$atPort = '${safePort}';`,
    "$activeHash = $null;",
    "if ($atPort) {",
    "  $portPnp = Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match ('\\(' + $atPort + '\\)') } | Select-Object -First 1;",
    "  if ($portPnp) {",
    "    $tail = ($portPnp.InstanceId -split '\\\\')[-1];",
    "    $activeHash = ($tail -replace '&[^&]+$', '').ToLower();",
    "  }",
    "}",
  ];
}

/**
 * Step 1 of the activation pipeline: make the matching RNDIS adapter
 * functional WITHOUT promoting it to the host's default route. After this
 * returns, sockets bound to the adapter's source IP can reach 4G (via
 * localAddress routing), but the system default route still points at
 * WiFi/Ethernet — so a broken bearer doesn't take the host offline.
 *
 * Concretely:
 *   - Disables every OTHER RNDIS (anti-collision on 192.168.225.0/24).
 *   - Disable/Enable cycle on the active one for a fresh DHCP lease.
 *   - Waits up to ~6s for a non-APIPA IPv4 address to appear.
 *   - Clamps MTU to 1430 so TLS handshakes don't fragment on the bearer.
 *
 * Pair with promoteRndisAdapter() once a probe has confirmed the bearer
 * is usable end-to-end.
 * @param {string} atPortPath - AT COM port of the active module (e.g. "COM5")
 * @returns {Promise<void>}
 */
async function prepareRndisAdapter(atPortPath) {
  const safePort = String(atPortPath || '').replace(/[^A-Za-z0-9]/g, '');
  const ps = [
    ..._hashResolverPs(safePort),
    // Surface the "zero RNDIS adapters found" case explicitly — otherwise
    // an empty Get-NetAdapter result silently no-ops the ForEach below, and
    // the data-activation chain (probe, public IP, promote) fails downstream
    // with cryptic errors. Counting first lets us emit a clear log marker.
    "$rndis = @(Get-NetAdapter | Where-Object { $_.InterfaceDescription -like '*RNDIS*' -or $_.Name -like '*RNDIS*' });",
    "if ($rndis.Count -eq 0) { Write-Output 'no-rndis-adapter-bound'; return }",
    "$rndis | ForEach-Object {",
    "  $idx = $_.ifIndex;",
    "  $pnpId = $_.PnPDeviceID;",
    "  $isActive = $false;",
    "  if ($activeHash -and $pnpId) {",
    "    $tail2 = ($pnpId -split '\\\\')[-1];",
    "    $hash = ($tail2 -replace '&[^&]+$', '').ToLower();",
    "    if ($hash -and ($hash -eq $activeHash)) { $isActive = $true }",
    "  }",
    "  if ($isActive) {",
    // Force a clean re-enumeration: Disable → wait → Enable. Windows
    // sometimes leaves the adapter in a half-state where the modem says
    // "data up" but the host's TCP stack still routes through WiFi (and
    // the public IP probe times out). Toggling the adapter triggers a
    // fresh DHCP lease + interface bring-up, which resolves it.
    "    Disable-NetAdapter -InputObject $_ -Confirm:$false -ErrorAction SilentlyContinue;",
    "    Start-Sleep -Milliseconds 800;",
    "    Enable-NetAdapter -InputObject $_ -Confirm:$false -ErrorAction SilentlyContinue;",
    // Wait for the adapter to come back up with a real IPv4 (skip the
    // 169.254.* APIPA address that shows up briefly while DHCP is still
    // negotiating). Bound to ~6s — beyond that the modem isn't going to
    // hand out an address anyway and we should proceed with what we have.
    "    $waited = 0;",
    "    while ($waited -lt 12) {",
    "      $a = Get-NetAdapter -ifIndex $idx -ErrorAction SilentlyContinue;",
    "      if ($a -and $a.Status -eq 'Up') {",
    "        $haveIp = Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1;",
    "        if ($haveIp) { break }",
    "      }",
    "      Start-Sleep -Milliseconds 500;",
    "      $waited++;",
    "    }",
    // Clamp MTU to 1430. Windows defaults RNDIS to 1500 but the LTE bearer
    // on Bouygues / Orange / SFR / Free typically caps at 1428-1500. With
    // MTU=1500 on the host, full-size TCP segments to the carrier get
    // silently dropped or fragmented; small probes (DNS, TCP SYN) work
    // fine but TLS handshakes (multi-KB) stall and time out. 1430 leaves
    // headroom for any tunnel headers downstream and matches the most
    // restrictive observed bearer MTU.
    "    Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -NlMtuBytes 1430 -ErrorAction SilentlyContinue;",
    "    Write-Output ('prepared:' + $_.Name)",
    "  } else {",
    // Disable the inactive RNDIS instead of demoting it. Both modules
    // expose 192.168.225.0/24 — leaving the inactive one up causes ARP
    // collisions on the gateway IP that misroute traffic to the wrong
    // module. Disabling makes the adapter invisible to the IP stack.
    "    if ($_.Status -ne 'Disabled') { Disable-NetAdapter -InputObject $_ -Confirm:$false -ErrorAction SilentlyContinue }",
    "    Write-Output ('disabled:' + $_.Name)",
    "  }",
    "}",
  ].join(' ');
  return runPs(ps, 'prepared');
}

/**
 * Step 2 of the activation pipeline: promote a previously-prepared RNDIS
 * adapter to the host's default route. Sets InterfaceMetric=1 and rewrites
 * 0.0.0.0/0 with RouteMetric=0 so this adapter wins over WiFi/Ethernet.
 *
 * Only call AFTER prepareRndisAdapter() has run AND the bearer has been
 * verified end-to-end (e.g. public IP fetched). Calling this on a dead
 * bearer takes the host offline and breaks any Tailscale peer egressing
 * through it.
 * @param {string} atPortPath
 * @returns {Promise<void>}
 */
async function promoteRndisAdapter(atPortPath) {
  const safePort = String(atPortPath || '').replace(/[^A-Za-z0-9]/g, '');
  const ps = [
    ..._hashResolverPs(safePort),
    "$rndis = @(Get-NetAdapter | Where-Object { $_.InterfaceDescription -like '*RNDIS*' -or $_.Name -like '*RNDIS*' });",
    "if ($rndis.Count -eq 0) { Write-Output 'no-rndis-adapter-bound'; return }",
    "$rndis | ForEach-Object {",
    "  $idx = $_.ifIndex;",
    "  $pnpId = $_.PnPDeviceID;",
    "  $isActive = $false;",
    "  if ($activeHash -and $pnpId) {",
    "    $tail2 = ($pnpId -split '\\\\')[-1];",
    "    $hash = ($tail2 -replace '&[^&]+$', '').ToLower();",
    "    if ($hash -and ($hash -eq $activeHash)) { $isActive = $true }",
    "  }",
    "  if ($isActive) {",
    // Re-resolve gateway: prepare ran DHCP earlier so by now Windows has
    // committed an IPv4DefaultGateway for this interface. Fallback to .1
    // on the SIM7600's 192.168.225.x subnet if Get-NetIPConfiguration
    // doesn't report one (older firmware, race conditions).
    "    $cfg = Get-NetIPConfiguration -InterfaceIndex $idx -ErrorAction SilentlyContinue;",
    "    $gw = $null;",
    "    if ($cfg -and $cfg.IPv4DefaultGateway) { $gw = $cfg.IPv4DefaultGateway.NextHop | Select-Object -First 1 }",
    "    if (-not $gw) {",
    "      $ip = (Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress;",
    "      if ($ip) { $parts = $ip.Split('.'); $gw = $parts[0] + '.' + $parts[1] + '.' + $parts[2] + '.1' }",
    "    }",
    "    Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -InterfaceMetric 1 -AutomaticMetric Disabled -ErrorAction SilentlyContinue;",
    "    Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue;",
    "    Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -PolicyStore PersistentStore -ErrorAction SilentlyContinue;",
    "    if ($gw) { New-NetRoute -DestinationPrefix '0.0.0.0/0' -InterfaceIndex $idx -NextHop $gw -RouteMetric 0 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null }",
    "    Write-Output ($_.Name + ' (gw=' + $gw + ')')",
    "  }",
    "}",
  ].join(' ');
  return runPs(ps, 'promoted');
}

/**
 * Backwards-compat shortcut: prepare + promote in one go. Use the split
 * functions when you need to gate the promotion on a connectivity check.
 * @param {string} atPortPath
 * @returns {Promise<void>}
 */
async function prioritizeRndisAdapter(atPortPath) {
  await prepareRndisAdapter(atPortPath);
  await promoteRndisAdapter(atPortPath);
}

/**
 * Push the RNDIS back behind WiFi/Ethernet.
 *
 * We keep the default route alive (deleting it would make the adapter
 * unreachable when WiFi is off), but crank InterfaceMetric to 999 so the
 * effective metric sinks below any WiFi/Ethernet default.
 * @returns {Promise<void>}
 */
async function restoreRndisAdapters() {
  const ps = [
    "$rndis = @(Get-NetAdapter | Where-Object { $_.InterfaceDescription -like '*RNDIS*' -or $_.Name -like '*RNDIS*' });",
    "if ($rndis.Count -eq 0) { Write-Output 'no-rndis-adapter-bound'; return }",
    "$rndis | ForEach-Object {",
    // Re-enable adapters that prioritizeRndisAdapter disabled to break the
    // 192.168.225.0/24 collision. Without this, a previously-inactive
    // RNDIS stays disabled forever after the data SIM is toggled off.
    "  if ($_.Status -eq 'Disabled') { Enable-NetAdapter -InputObject $_ -Confirm:$false -ErrorAction SilentlyContinue }",
    "  $idx = $_.ifIndex;",
    "  Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -InterfaceMetric 999 -AutomaticMetric Disabled -ErrorAction SilentlyContinue;",
    "  Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv6 -InterfaceMetric 999 -AutomaticMetric Disabled -ErrorAction SilentlyContinue;",
    "  Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -PolicyStore PersistentStore -ErrorAction SilentlyContinue;",
    "  Write-Output $_.Name",
    "}",
  ].join(' ');
  return runPs(ps, 'restored');
}

/**
 * Diagnostic-only RNDIS driver check.
 *
 * Looked at: is there a Net-class RNDIS adapter bound to the same USB
 * device hash as the given AT port? If yes, the driver is fine, return.
 * If no, dump enough info for the user to fix it manually:
 *   - which interface is stuck (typically MI_00 with CM_PROB_FAILED_INSTALL)
 *   - which INF the modules that DO work are bound to (so the user can
 *     pick the same one in Device Manager → "Pick from list")
 *
 * Recovery automation was REMOVED here on purpose. We tried (logs show):
 *   - pnputil /scan-devices  →  no-op, the driver is already in the store
 *   - Disable-PnpDevice + Enable-PnpDevice  →  doesn't trigger re-bind
 *   - pnputil /remove-device + /scan-devices  →  same as above
 *   - pnputil /add-driver <inf> /install  →  no HwID match → no install
 *   - devcon updateni <inf> <HwID-prefix>  →  "devcon.exe failed" because
 *     the standard netrndis.inf doesn't declare VID_1E0E in its [Manufacturer]
 *     section, and devcon uses UpdateDriverForPlugAndPlayDevicesW which
 *     respects that. The manual "Pick from list" UI overrides this via
 *     SetupDiSetSelectedDriver, an API no CLI tool exposes.
 *
 * The only real fixes are:
 *   a) Install the official SimCom Windows driver package — its INF declares
 *      USB\VID_1E0E&PID_9011&MI_xx so Windows auto-binds on every replug
 *   b) Do the manual "Pick from list" once per failed module per Windows install
 *      (the working module's INF name is logged here so you know what to pick)
 *
 * Requires admin (we already do for routing changes).
 * @param {string} atPortPath - AT COM port path of the module to check
 * @returns {Promise<'ok'|'missing'|'unknown'>} bound driver state for the
 *   module behind this AT port. 'missing' = RNDIS adapter not found and a
 *   manual driver install is required; surfaced to the dashboard.
 */
async function ensureRndisDriver(atPortPath) {
  const safePort = String(atPortPath || '').replace(/[^A-Za-z0-9]/g, '');
  if (!safePort) return 'unknown';
  const ps = [
    `$atPort = '${safePort}';`,
    "$portPnp = Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match ('\\(' + $atPort + '\\)') } | Select-Object -First 1;",
    "if (-not $portPnp) { Write-Output ('no AT pnp for ' + $atPort); return }",
    "$tail = ($portPnp.InstanceId -split '\\\\')[-1];",
    "$activeHash = ($tail -replace '&[^&]+$', '').ToLower();",
    // Probe: is there already a Net-class RNDIS adapter for this hash?
    "$existing = Get-NetAdapter | Where-Object { $_.PnPDeviceID -like '*VID_1E0E*' -or $_.InterfaceDescription -match 'RNDIS|Remote NDIS' } | Where-Object { $tail2 = ($_.PnPDeviceID -split '\\\\')[-1]; ($tail2 -replace '&[^&]+$', '').ToLower() -eq $activeHash } | Select-Object -First 1;",
    "if ($existing) { Write-Output ('rndis ok: ' + $existing.Name); return }",
    // Broken case — dump diagnostic info and stop. No recovery attempts.
    "Write-Output ('rndis missing for ' + $atPort + ' (hash=' + $activeHash + ')');",
    "$allMatching = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like '*VID_1E0E*' } | Where-Object { $tail3 = ($_.InstanceId -split '\\\\')[-1]; ($tail3 -replace '&[^&]+$', '').ToLower() -eq $activeHash };",
    "$failedIface = $allMatching | Where-Object { $_.Status -eq 'Error' } | Select-Object -First 1;",
    "if ($failedIface) { Write-Output ('  failed device: ' + $failedIface.InstanceId + ' problem=' + $failedIface.Problem) }",
    // Surface the INF that any already-working RNDIS on this host uses — that
    // is exactly the one to pick in Device Manager → Update driver → Browse →
    // Pick from list, for any module stuck under "Other devices".
    "$workingRndis = Get-NetAdapter | Where-Object { $_.PnPDeviceID -like '*VID_1E0E*' -or $_.InterfaceDescription -match 'RNDIS|Remote NDIS' } | Select-Object -First 5;",
    "foreach ($w in $workingRndis) {",
    "  try {",
    "    $infOem = (Get-PnpDeviceProperty -InstanceId $w.PnPDeviceID -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction Stop).Data;",
    "    if ($infOem) { Write-Output ('  working RNDIS ' + $w.Name + ' uses INF: ' + $infOem) }",
    "  } catch { }",
    "}",
    "Write-Output ('  manual fix: Device Manager → Other devices → right-click the failed RNDIS → Update driver → Browse → Pick from list → Network adapter → Microsoft → Carte RNDIS USB. Or install the official SimCom Windows driver to make it permanent.')",
  ].join(' ');
  const out = (await runPs(ps, 'rndis-driver') || '').toLowerCase();
  if (/rndis ok:/.test(out)) return 'ok';
  if (/rndis missing for|manual fix:|failed device:/.test(out)) return 'missing';
  return 'unknown'; // 'no AT pnp' (port not enumerated yet) or non-Windows
}

module.exports = {
  prepareRndisAdapter,
  promoteRndisAdapter,
  prioritizeRndisAdapter,
  restoreRndisAdapters,
  ensureRndisDriver,
};
