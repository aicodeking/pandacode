// A computer's settings (?device=): its harnesses with a readiness dot, version and model count,
// the model routing switch (Full access) and the token saver's tools. Read from the computer;
// nothing secret comes back. Installing or updating harnesses, keys, accounts and themes stay on
// the computer, as the footer says.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { setRouting, settingsProviders, settingsRouting, settingsTokenSaver, type Harness, type RoutingState } from '../connect/api/settings.ts';
import { outdated } from '../connect/rpc.ts';
import { Banner, EmptyState, geometry, haptic, Row, StatusDot, Toggle, type } from '../ui/ds/index.ts';
import { CardTitled, Failed, glyph, Loading, styles as hub, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { harnessDetail, readinessLabel, routingNote, sortHarnesses, tokenSaverNote } from '../ui/hub/settings-labels.ts';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const SETTINGS_ICON = glyph({ ios: 'gearshape', android: 'settings' });
const DOT = 10;

function Dot({ harness }: { harness: Harness }) {
  const colors = useColors();
  const { tone, text } = readinessLabel(harness);
  if (tone) return <StatusDot tone={tone} size={DOT} accessibilityLabel={text} />;
  return <View accessible accessibilityLabel={text} style={[styles.hollow, { borderColor: colors.faint }]} />;
}

function HarnessRow({ harness }: { harness: Harness }) {
  const colors = useColors();
  const { text } = readinessLabel(harness);
  return (
    <Row title={harness.name} subtitle={harnessDetail(harness)} leading={<Dot harness={harness} />}
      trailing={<Text style={[type.footnote, { color: colors.muted }]}>{text}</Text>}
      accessibilityLabel={`${harness.name}, ${text}. ${harnessDetail(harness)}`} />
  );
}

export default function ComputerSettingsScreen() {
  const params = useLocalSearchParams<{ device: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const colors = useColors();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'settings.providers');
  const canRoute = useHostSupports(device, 'settings.routing');
  const canSetRoute = useHostAllows(device, 'settings.setRouting');
  const routeNote = useAccessNote(device, ['settings.setRouting']) ?? outdated(computer);
  const canSaver = useHostSupports(device, 'settings.tokenSaver');
  const loadProviders = useCallback(() => settingsProviders(device), [device]);
  const loadRouting = useCallback(() => settingsRouting(device), [device]);
  const loadSaver = useCallback(() => settingsTokenSaver(device), [device]);
  const providers = useLoad(supported ? loadProviders : null, device);
  const routing = useLoad(canRoute ? loadRouting : null, device);
  const saver = useLoad(canSaver ? loadSaver : null, device);
  const [route, setRoute] = useState<RoutingState | null>(null);
  const [saving, setSaving] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const shownRoute = route ?? routing.value;
  const refresh = async () => {
    setRefreshing(true); setRoute(null);
    await Promise.all([providers.reload(), routing.reload(), saver.reload()]);
    setRefreshing(false);
  };
  const toggleRouting = async (on: boolean) => {
    setSaving(true); setRouteError('');
    try {
      setRoute(await setRouting(device, on));
      haptic('success');
    } catch (e) {
      setRouteError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Settings' }} />
      <HeaderActions />
      {children}
    </PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={SETTINGS_ICON} title={outdated(computer)} style={hub.empty} />);

  const harnesses = () => {
    if (providers.value === undefined) return providers.error ? <Failed title="Couldn’t read the harnesses" error={providers.error} retry={() => void providers.reload()} /> : <Loading rows={4} />;
    const list = sortHarnesses(providers.value);
    const ready = list.filter(h => h.status === 'ready').length;
    return (
      <CardTitled title="Harnesses" trailing={<Text style={[type.footnote, { color: colors.faint }]}>{`${ready} ready`}</Text>}
        footer={<Text style={[type.footnote, { color: colors.muted }]}>Install and update harnesses, and add API keys, in Settings on the computer.</Text>}>
        {list.length ? list.map(h => <HarnessRow key={h.id} harness={h} />) : <Row title="No harnesses found" subtitle={`Install one on ${computer}.`} />}
      </CardTitled>
    );
  };
  const routingCard = () => {
    if (!canRoute) return null;
    if (!shownRoute) return routing.error ? <Failed title="Couldn’t read model routing" error={routing.error} retry={() => void routing.reload()} /> : <Loading rows={1} />;
    return (
      <CardTitled title="Model routing">
        <Row title="Route team steps" subtitle={canSetRoute ? routingNote(shownRoute) : `${routingNote(shownRoute)} ${routeNote}`}
          trailing={<Toggle accessibilityLabel="Model routing" value={shownRoute.on} disabled={saving || !canSetRoute} onValueChange={on => void toggleRouting(on)} />} />
      </CardTitled>
    );
  };
  const saverCard = () => {
    if (!canSaver) return null;
    if (!saver.value) return saver.error ? <Failed title="Couldn’t read the token saver" error={saver.error} retry={() => void saver.reload()} /> : <Loading rows={1} />;
    return (
      <CardTitled title="Token saver">
        <Row title={saver.value.rtk ? 'RTK installed' : 'RTK not installed'} subtitle={`${tokenSaverNote(saver.value)} Packs are chosen per thread on the computer.`}
          leading={<StatusDot tone={saver.value.rtk ? 'success' : 'info'} size={DOT} />} />
      </CardTitled>
    );
  };
  return page(
    <>
      {harnesses()}
      {routingCard()}
      <Banner visible={!!routeError} tone="danger" title="Couldn’t change model routing" body={routeError} />
      {saverCard()}
      <Text style={[type.footnote, styles.footer, { color: colors.faint }]}>Accounts, keys and themes are managed on the computer.</Text>
    </>,
  );
}

const styles = StyleSheet.create({
  hollow: { width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 1.5, flexShrink: 0 },
  footer: { textAlign: 'center', paddingHorizontal: geometry.rowInset },
});
