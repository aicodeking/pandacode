// A computer's machines (?device=): local VMs (state, Start/Stop, tap a running one for its screen), cloud
// agents (tap opens the task; Start cloud agent opens a form and then the new task), cloud sandboxes, linked computers with agents' link requests (Accept/Decline)
// and model routing (read-only). Each section reads its own method, so a slow cloud listing never holds the rest.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, View } from 'react-native';
import { listCloudAgents, listCloudMachines, listMachines, powerVm, respondToLink, routingStatus, vmFrame } from '../connect/api/admin.ts';
import { useHostAllows, useHostBlock, useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { blockedNote } from '../connect/api/hello.ts';
import { AccessNote, useAccessNote } from '../ui/AccessNote.tsx';
import { outdated } from '../connect/rpc.ts';
import {
  ACCESS_LABELS, agentLine, cloudStartBlock, cloudTone, linkChoices, routingLine, sortVms, stageTone, vmLine,
  type CloudAgent, type CloudMachine, type LinkRequest, type MachinesList, type RoutingStatus, type VmStatus,
} from '../store/admin.ts';
import { useConnect } from '../store/index.ts';
import { CloudAgentStart } from '../ui/admin/CloudAgentStart.tsx';
import { Decide, FrameViewer, ToneDot } from '../ui/admin/parts.tsx';
import { Banner, Button, Card, CardSection, EmptyState, geometry, haptic, InnerCard, Row, Skeleton } from '../ui/ds/index.ts';
import { showActions } from '../ui/Menu.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { ago } from '../ui/status.tsx';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const MACHINE_ICON = { ios: 'desktopcomputer', android: 'computer' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
type Access = 'read' | 'ask' | 'full';
/** The first sheet's close animation, before the second one opens (iOS refuses two at once). */
const SHEET_GAP_MS = 350;

/** Picks a computer, then its access, and answers with both; dismissing either sheet answers nothing. */
function pickLink(list: MachinesList, request: LinkRequest, answer: (link: { deviceId: string; access: Access }) => void) {
  const choices = linkChoices(list, request);
  if (!choices.length) throw new Error('No other computers are signed in to this account.');
  showActions('Link which computer?', choices.map(device => ({
    label: `${device.name}${device.online ? '' : ' (offline)'}`,
    onPress: () => setTimeout(() => showActions(`Access for ${device.name}`, (Object.keys(ACCESS_LABELS) as Access[]).map(access => ({
      label: ACCESS_LABELS[access], onPress: () => answer({ deviceId: device.id, access }),
    }))), SHEET_GAP_MS),
  })));
}

function VmRow({ vm, canPower, busy, onPower, onOpen }: { vm: VmStatus; canPower: boolean; busy: boolean; onPower: () => void; onOpen: () => void }) {
  return (
    <Row title={vm.name} subtitle={vmLine(vm)} leading={<ToneDot tone={vm.running ? 'success' : 'muted'} />} onPress={vm.running && vm.attached ? onOpen : undefined}
      accessibilityHint={vm.running && vm.attached ? 'Shows its screen' : undefined}
      trailing={canPower ? <Button label={vm.running ? 'Stop' : 'Start'} size="small" loading={busy} onPress={onPower} /> : undefined} />
  );
}

export default function MachinesScreen() {
  const { device = '' } = useLocalSearchParams<{ device: string }>();
  const scroll = usePushedScroll();
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');
  const supported = useHostSupports(device, 'machines.list');
  const vmNote = useAccessNote(device, ['vm.start']);
  const can = {
    cloud: useHostSupports(device, 'cloud.machines'), agents: useHostSupports(device, 'cloudAgents.list'), routing: useHostSupports(device, 'routing.status'),
    start: useHostAllows(device, 'vm.start'), frame: useHostSupports(device, 'vm.frame'), respond: useHostAllows(device, 'orchestration.respond'),
  };
  const [list, setList] = useState<MachinesList | null>(null);
  const [agents, setAgents] = useState<CloudAgent[] | null>(null);
  const [cloud, setCloud] = useState<{ machines: CloudMachine[]; errors: string[] } | null>(null);
  const [routing, setRouting] = useState<RoutingStatus | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [frame, setFrame] = useState<{ uri: string; name: string } | null>(null);
  const [composing, setComposing] = useState(false);
  const caps = useHostCapabilities(device);
  const startBlock = cloudStartBlock(useHostBlock(device, 'cloudAgents.start'), caps?.kind === 'hello' ? caps.remoteFullAccess : undefined);
  const canLaunch = useHostSupports(device, 'cloudAgents.start') && startBlock !== 'outdated';

  const load = useCallback(async () => {
    const quiet = (e: Error) => setActionError(e.message);
    await Promise.all([
      listMachines(device).then(l => { setList(l); setError(''); }, (e: Error) => setError(e.message)),
      can.agents ? listCloudAgents(device).then(setAgents, quiet) : null,
      can.routing ? routingStatus(device).then(setRouting, quiet) : null,
      can.cloud ? listCloudMachines(device).then(setCloud, quiet) : null,
    ]);
  }, [device, can.agents, can.routing, can.cloud]);
  useFocusEffect(useCallback(() => { if (supported) void load(); }, [load, supported]));
  useReloadOnReconnect(device, () => (supported ? load() : undefined));
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const act = async (key: string, work: () => Promise<unknown>, reload = true) => {
    setBusy(key);
    try {
      await work();
      haptic('success');
      setActionError('');
      if (reload) setList(await listMachines(device));
    } catch (e) {
      haptic('error');
      setActionError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const openFrame = (vm: VmStatus) => act(`frame:${vm.name}`, async () => setFrame({ uri: await vmFrame(device, vm.name), name: vm.name }), false);
  const power = (vm: VmStatus) => {
    const run = () => void act(`vm:${vm.name}`, () => powerVm(device, vm.name, vm.running ? 'stop' : 'start'));
    if (!vm.running) return run();
    Alert.alert(`Stop ${vm.name}?`, `This shuts down the VM on ${computer}; anything running in it stops.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: run },
    ]);
  };
  const accept = (request: LinkRequest) => {
    if (!list) return;
    try {
      pickLink(list, request, link => void act(`link:${request.requestId}`, () => respondToLink(device, request.requestId, link)));
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const vms = list ? sortVms(list.vms.vms) : [];
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Machines' }} />
      <HeaderActions />
      {!supported && <EmptyState icon={MACHINE_ICON} title={outdated(computer)} style={styles.empty} />}
      {supported && !list && !error && <Card><InnerCard style={styles.loading}><Skeleton width="60%" /><Skeleton width="45%" /><Skeleton width="70%" /></InnerCard></Card>}
      {supported && !list && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the machines" body={error} action={{ label: 'Retry', onPress: () => void load() }} style={styles.empty} />}
      <Banner visible={!!list && !!(error || actionError)} tone="danger" title={actionError ? 'That didn’t work' : 'Couldn’t refresh'} body={actionError || error} />

      {list && (
        <CardSection title="Local VMs" footer={vms.length && vmNote ? <AccessNote device={device} methods={['vm.start']} /> : undefined}>
          {!list.vms.supported && <Row title="Not available" subtitle={`Local VMs need an Apple silicon Mac; ${computer} isn’t one.`} />}
          {list.vms.supported && !list.vms.installed && <Row title="Not set up" subtitle={`Set up VMs in PandaCode on ${computer}.`} />}
          {list.vms.installed && !vms.length && <Row title="No VMs" subtitle={`Create one in PandaCode on ${computer}.`} />}
          {vms.map(vm => (
            <VmRow key={vm.name} vm={vm} canPower={can.start} busy={busy === `vm:${vm.name}` || busy === `frame:${vm.name}`}
              onPower={() => power(vm)}
              onOpen={() => { if (can.frame) void openFrame(vm); }} />
          ))}
        </CardSection>
      )}

      {list && ((agents && agents.length > 0) || canLaunch) && (
        <CardSection title="Cloud agents">
          {canLaunch && !!startBlock && <Row title="Start cloud agent" subtitle={blockedNote(startBlock, computer, caps?.kind === 'hello' ? caps.access : undefined)} disabled />}
          {canLaunch && !startBlock && !composing && <Row title="Start cloud agent" subtitle="Runs on a cloud machine with a copy of a project" chevron onPress={() => setComposing(true)} />}
          {composing && (
            <CloudAgentStart device={device} computer={computer} onCancel={() => setComposing(false)}
              onStarted={session => {
                setComposing(false);
                void listCloudAgents(device).then(setAgents, () => undefined);
                router.push({ pathname: '/task/[device]/[session]', params: { device, session } });
              }} />
          )}
          {(agents ?? []).map(agent => (
            <Row key={agent.sessionId} title={agent.title} subtitle={`${agentLine(agent)} · ${ago(agent.updatedAt)}`} leading={<ToneDot tone={stageTone(agent.cloud.stage)} />} chevron
              onPress={() => router.push({ pathname: '/task/[device]/[session]', params: { device, session: agent.sessionId } })} />
          ))}
        </CardSection>
      )}

      {list && cloud && (cloud.machines.length > 0 || cloud.errors.length > 0) && (
        <CardSection title="Cloud machines">
          {cloud.machines.map(m => <Row key={m.id} title={m.name} subtitle={[m.provider, m.state, m.detail].filter(Boolean).join(' · ')} leading={<ToneDot tone={cloudTone(m)} />} />)}
          {cloud.errors.map((e, i) => <Row key={`e${i}`} title="Couldn’t list a provider" subtitle={e} tone="danger" />)}
        </CardSection>
      )}

      {list && (
        <CardSection title="Linked computers">
          {!list.orchestration.enabled && <Row title="Agent orchestration is off" subtitle={`Turn it on in Settings → Remote access on ${computer}.`} />}
          {list.pending.map(request => (
            <View key={request.requestId}>
              <Row title={`An agent asks to link ${request.machine ?? 'a computer'}`} subtitle={request.reason} />
              {can.respond ? (
                <Decide yes="Accept" no="Decline" busy={busy === `link:${request.requestId}`}
                  onYes={() => accept(request)} onNo={() => void act(`link:${request.requestId}`, () => respondToLink(device, request.requestId, null))} />
              ) : <AccessNote device={device} methods={['orchestration.respond']} />}
            </View>
          ))}
          {list.orchestration.enabled && !list.orchestration.links.length && !list.pending.length && <Row title="No linked computers" />}
          {list.orchestration.links.map(link => (
            <Row key={link.deviceId} title={link.name} subtitle={[link.departed ? 'Left the account' : link.online ? 'Online' : 'Offline', link.platform].filter(Boolean).join(' · ')}
              leading={<ToneDot tone={link.online ? 'success' : 'muted'} />} trailing={ACCESS_LABELS[link.access] ?? link.access} />
          ))}
        </CardSection>
      )}

      {list && routing && (
        <CardSection title="Model routing">
          <Row title={routing.enabled ? 'On' : 'Off'} subtitle={routingLine(routing)} tone={routing.error ? 'danger' : undefined} />
        </CardSection>
      )}
      <FrameViewer uri={frame?.uri ?? null} title={frame?.name ?? ''} onClose={() => setFrame(null)} />
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: geometry.rowInset },
});
