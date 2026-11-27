// The computer hub's PandaCode card: the version that computer runs, and the update it can install.
//
// The version is host.hello's appVersion, worded by versionLine (ui/hub/entries.ts) so the hub never
// says it twice; the update state comes from host.updateStatus (View, read-only). Check for updates
// and Update and restart are host.checkUpdate and host.updateAndRestart: both need Full access AND the
// computer's "Full access for remote tasks" switch, because installing restarts the app and stops
// whatever runs there, so a narrower phone reads the version and the state with an AccessNote below.
//
// A restart is the one action here that cannot be undone from the phone, so it sits behind a native
// Alert that says what happens on that computer and on this one. After it, the computer's socket
// drops: presence marks it offline (the hub's banner), this card holds a calm "Restarting…", and
// client.ts fails calls to it at once (LOST, as for a closed socket) instead of waiting out their
// 20 s timeouts. When it is back, presence reloads this card (useLoad → useReloadOnReconnect) and it
// reads the version it restarted into, so nothing hangs and nothing has to be tapped again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useHostAllows, useHostCapabilities, useHostSupports } from '../../connect/api/capabilities.ts';
import { checkHostUpdate, hostUpdateStatus, installHostUpdate } from '../../connect/api/host.ts';
import { maybeRan } from '../../connect/rpc.ts';
import {
  CHECKING, canInstall, markRestarting, restartInFlight, restartWarning, updateLine, updateReady, updateTone, type HostUpdateStatus,
} from '../../store/host-update.ts';
import { AccessNote } from '../AccessNote.tsx';
import { Button, geometry, Group, haptic, Row, type as text } from '../ds/index.ts';
import { Icon } from '../Icon.tsx';
import { useColors } from '../theme.ts';
import { useComputerName, useLoad } from './common.tsx';
import { versionLine } from './entries.ts';

const APP_ICON = { ios: 'app.badge', android: 'apps' } as const;
/** The state line before the first read, while the computer cannot answer. */
const OFFLINE_LINE = 'Reads when the computer is online';

export function HostUpdate({ device, online }: { device: string; online: boolean }) {
  const colors = useColors();
  const computer = useComputerName(device);
  const caps = useHostCapabilities(device);
  const served = useHostSupports(device, 'host.updateStatus');
  const allowed = useHostAllows(device, 'host.checkUpdate');
  const load = useCallback(() => hostUpdateStatus(device), [device]);
  const { value, error, reload } = useLoad<HostUpdateStatus>(served ? load : null, `${device}:host.update`);
  const [restarting, setRestarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState('');
  /** The read that was on screen when Update and restart was tapped: a later one proves the restart. */
  const readAtTap = useRef<HostUpdateStatus | undefined>(undefined);

  // A status read newer than the tap (the reload after the reply, or presence once it is back) is
  // the computer answering for itself: it decides whether a restart is still going. The read that
  // was already on screen when the tap came is not one of those.
  useEffect(() => {
    if (restarting && value !== readAtTap.current) setRestarting(false);
  }, [restarting, value]);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setActionError('');
    try {
      await checkHostUpdate(device);
      // The read-only view behind the button now answers with what the check just found.
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    readAtTap.current = value;
    setRestarting(true);
    setActionError('');
    try {
      await installHostUpdate(device);
      haptic('success');
    } catch (e) {
      // A lost reply or a timeout means the computer may be installing already: keep the calm state
      // and let the next read settle it. A refusal (or a call never delivered) did nothing.
      if (!maybeRan(e)) {
        haptic('error');
        setRestarting(false);
        setActionError((e as Error).message);
      }
    }
    // Reads the truth now (a live host's own `restarting`) or fails harmlessly while it is away;
    // either way this decides the calm state above.
    void reload();
  };

  const confirm = () => Alert.alert('Update and restart?', restartWarning(computer), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Update and restart', style: 'destructive', onPress: () => void install() },
  ]);

  const version = versionLine(caps);
  // A host from before host.updateStatus: just the version line, as the status card always had it.
  if (!served) return version ? <Group><Row title={version} leading={<Icon {...APP_ICON} size={20} color={colors.muted} />} /></Group> : null;

  const shown = restarting ? markRestarting(value ?? null) : value ?? null;
  // A read that failed after a good one keeps the last state (useLoad keeps its value); one that never
  // landed while the computer is away says so plainly, rather than its raw OFFLINE error again under
  // the hub's banner.
  const line = shown ? updateLine(shown) : !online ? OFFLINE_LINE : error ?? CHECKING;
  const tone = shown ? updateTone(shown) : error && online ? 'danger' : undefined;
  const busy = restartInFlight(shown);
  // host.updateStatus's own currentVersion is newer than host.hello after an update: prefer it.
  const wording = versionLine(caps, shown?.currentVersion);

  return (
    <Group>
      <Row title={wording || 'PandaCode'} subtitle={line} tone={tone} leading={<Icon {...APP_ICON} size={20} color={colors.muted} />} />
      {allowed ? (
        <View style={styles.actions}>
          <Button label="Check for updates" size="small" loading={checking} disabled={!online || busy || checking} onPress={() => void check()} />
          {updateReady(shown) && (
            <Button label="Update and restart" size="small" variant="primary" disabled={!online || !canInstall(shown) || checking} onPress={confirm} />
          )}
        </View>
      ) : (
        <View style={styles.note}>
          <AccessNote device={device} methods={['host.checkUpdate', 'host.updateAndRestart']} />
        </View>
      )}
      {!!actionError && <Text accessibilityLiveRegion="polite" style={[text.footnote, styles.note, { color: colors.danger }]}>{actionError}</Text>}
    </Group>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: geometry.rowInset, paddingTop: 2, paddingBottom: 10 },
  note: { paddingHorizontal: geometry.rowInset, paddingBottom: 10 },
});
