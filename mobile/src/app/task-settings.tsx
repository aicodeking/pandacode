// Model & permissions for one task, in a sheet: harness, model, effort and mode (task.configure).
// The composer's Model…, Effort… and Permissions… open it at that control (`focus`).
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { connect } from '../connect/client.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import type { TaskSummary } from '../connect/types.ts';
import { useConnect } from '../store/index.ts';
import { Choice } from '../ui/Choice.tsx';
import { Banner, EmptyState, geometry, Group, haptic, Row, type as textStyle } from '../ui/ds/index.ts';
import { Glyph, PermissionPicker, useSheetTop } from '../ui/FormParts.tsx';
import { HarnessLogo } from '../ui/harness.tsx';
import { useModelOptions } from '../ui/models.ts';
import { useColors } from '../ui/theme.ts';

type Settings = Pick<TaskSummary, 'provider' | 'model' | 'effort' | 'mode'>;

const HIGHLIGHT_HOLD_MS = 700;
const HIGHLIGHT_FADE_MS = 500;
const SCROLL_MARGIN = 8;
const HIGHLIGHT_RADIUS = 10;

export default function TaskSettings() {
  const { device = '', session = '', focus } = useLocalSearchParams<{ device: string; session: string; focus?: string }>();
  const task = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session));
  if (!task) return <EmptyState icon={{ ios: 'hourglass', android: 'hourglass_empty' }} title="This task is not loaded yet." />;
  return <Form deviceId={device} sessionId={session} task={task} focus={focus} />;
}

/** Marks the control the sheet was opened for: a soft fill that holds a moment and fades. */
function Spotlight({ on, children }: { on: boolean; children: ReactNode }) {
  const colors = useColors();
  const opacity = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    if (!on) return;
    opacity.set(1);
    opacity.set(withDelay(HIGHLIGHT_HOLD_MS, withTiming(0, { duration: HIGHLIGHT_FADE_MS, reduceMotion: ReduceMotion.Never })));
  }, [on, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.spotlight, { backgroundColor: colors.fill, borderColor: colors.borderStrong }, style]} />
      {children}
    </View>
  );
}

function Form({ deviceId, sessionId, task, focus }: { deviceId: string; sessionId: string; task: TaskSummary; focus?: string }) {
  const top = useSheetTop();
  const [settings, setSettings] = useState<Settings>({ provider: task.provider, model: task.model, effort: task.effort, mode: task.mode });
  const options = useModelOptions(deviceId, settings.provider);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrolled = useRef(false);
  const allowed = useHostAllows(deviceId, 'task.configure');
  const configure = async (change: Partial<Settings>) => {
    if (!allowed) return;
    const before = settings;
    setSettings(s => ({ ...s, ...change }));
    haptic('selection');
    try {
      await connect.configureTask(deviceId, { sessionId, ...change });
    } catch (error) {
      setSettings(before);
      Alert.alert('Could not change settings', (error as Error).message);
    }
  };
  const efforts = options.efforts(settings.model);
  // Permissions sit below the fold on short phones. Model and Effort are in the first card.
  const toPermissions = (event: LayoutChangeEvent) => {
    if (focus !== 'mode' || scrolled.current) return;
    scrolled.current = true;
    scroll.current?.scrollTo({ y: event.nativeEvent.layout.y - SCROLL_MARGIN, animated: true });
  };
  // A harness without efforts has no Effort row, and Model is the nearest thing.
  const spotlit = focus === 'effort' && !efforts.length ? 'model' : focus;
  return (
    <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={[styles.page, { paddingTop: top }]} bounces={false}>
      <AccessNote device={deviceId} methods={['task.configure']} />
      <Banner visible={!!options.error} tone="danger" title="Couldn't load the agents and models" body={options.error ?? undefined} action={{ label: 'Retry', onPress: options.retry }} />
      <Group title="Model">
        <Row leading={<HarnessLogo id={settings.provider} size={20} />} title="Agent"
          trailing={options.harnesses.length > 0
            ? <Choice label="Agent" value={settings.provider} options={options.harnesses} onChange={provider => configure({ provider, model: 'default', effort: null })} />
            : <Meta text={settings.provider} />} />
        <Spotlight on={spotlit === 'model'}>
          <Row leading={<Glyph icon={{ ios: 'cpu', android: 'memory' }} />} title="Model"
            trailing={options.models.length > 0
              ? <Choice label="Model" value={settings.model} options={options.models} onChange={model => configure({ provider: settings.provider, model, effort: options.defaultEffort(model) })} />
              : <Meta text={settings.model} />} />
        </Spotlight>
        {efforts.length > 0 && (
          <Spotlight on={spotlit === 'effort'}>
            <Row leading={<Glyph icon={{ ios: 'gauge.with.dots.needle.67percent', android: 'speed' }} />} title="Effort"
              trailing={<Choice label="Effort" value={settings.effort ?? ''} options={efforts} onChange={effort => configure({ effort })} />} />
          </Spotlight>
        )}
      </Group>
      <Group title="Permissions" onLayout={toPermissions}>
        <Spotlight on={spotlit === 'mode'}>
          <PermissionPicker value={settings.mode} onChange={mode => configure({ mode })} note="Changes apply from the next message." />
        </Spotlight>
      </Group>
    </ScrollView>
  );
}

function Meta({ text }: { text: string }) {
  const colors = useColors();
  return <Text numberOfLines={1} style={[styles.meta, { color: colors.muted }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  page: { paddingHorizontal: geometry.screenMargin, gap: geometry.sectionGap },
  spotlight: { borderRadius: HIGHLIGHT_RADIUS, borderCurve: 'continuous', borderWidth: geometry.hairline, marginHorizontal: 2 },
  meta: { ...textStyle.subhead, flexShrink: 1 },
});
