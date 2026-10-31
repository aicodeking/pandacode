// Preview data for Connect diagnostics (src-tauri/src/remote/diagnostics.rs).
export function previewDiagnostics(command: string, args: Record<string, any>): unknown {
  void args;
  const now = Date.now();
  const stages = [
    { name: 'Signed in', ok: true, detail: 'GitHub account linked' },
    { name: 'Relay connected', ok: true, detail: 'Relay socket open' },
    { name: 'Device online', ok: true, detail: 'This computer is listed; 1 other online' },
    { name: 'Direct route', ok: true, detail: '1 direct route up' },
    { name: 'Encrypted session', ok: true, detail: "End-to-end encrypted with each computer's key" },
  ];
  const routes = [
    { device: 'Studio iMac', route: 'direct', state: 'connected', rttMs: 4, since: now - 125_000, lastError: null },
    { device: 'Studio iMac', route: 'relay', state: 'connected', rttMs: 48, since: now - 600_000, lastError: null },
    { device: 'Travel laptop', route: 'relay', state: 'failed', rttMs: null, since: now - 3_600_000, lastError: 'That computer is offline.' },
  ];
  const events = [
    { at: now - 5_000, kind: 'route.direct', detail: 'Studio iMac up at 192.168.1.20' },
    { at: now - 60_000, kind: 'socket.open', detail: 'relay.example.com' },
    { at: now - 61_000, kind: 'socket.connecting', detail: 'attempt 2' },
    { at: now - 120_000, kind: 'socket.close', detail: 'closed by peer' },
  ];
  if (command === 'remote_diagnostics_export') {
    return ['PandaCode Connect diagnostics', 'Version: preview', 'OS: macos aarch64', '', 'Stages', ...stages.map(s => `  [ok] ${s.name}: ${s.detail}`), '', 'Events (newest first)', ...events.map(e => `  ${new Date(e.at).toISOString()} ${e.kind} ${e.detail}`)].join('\n');
  }
  return { relay: { state: 'connected', url: 'relay.example.com', connectedSince: now - 60_000, lastError: 'closed by peer', reconnects: 2 }, routes, devices: [], stages, events };
}
