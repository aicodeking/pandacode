// The task composer, as on the desktop: an outer glass card with an inner input card and, under it, a
// tray with model, effort, permissions and the branch. A state row above the input says
// what a send will do while running. Send queues while running (like the desktop's Enter) and a long
// press or the row's Steer steers; "Steer instead of queue" swaps them. Stop shows while running, is
// the screen's only Stop, stays live during a slow send, and confirms once a run has gone on a while.
// Unreachable computers keep the message in the outbox.
// In a bot's conversation (`bot`) a send goes through the bot (bot.message), so its brief applies.
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, Alert, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View, type ColorValue } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { connect } from '../connect/client.ts';
import type { Bot } from '../connect/types.ts';
import { draftKey, restoreDraft, setDraft, useDrafts } from '../store/draft.ts';
import { elapsedLabel, runClockStart } from '../store/inbox.ts';
import { taskKey, useConnect, useModels } from '../store/index.ts';
import { markSteered, sendOrQueue, useLocal } from '../store/local.ts';
import { useColors } from './theme.ts';
import { BranchChip, Button, crossFadeIn, crossFadeOut, FADE_MS, geometry, haptic, InnerCard, PressScale, springs, type as textStyle, useMotion, type IconName } from './ds/index.ts';
import { Glass } from './Glass.tsx';
import { GlassIcon, nativeGlass } from './NativeGlass.tsx';
import { HarnessLogo, harnessName } from './harness.tsx';
import { Icon } from './Icon.tsx';
import { modelLabel } from './model-label.ts';
import { MODES } from './status.tsx';
import { TRAY_GAP, TRAY_ICON_WIDTH, trayFit, type TrayWidths } from './tray-fit.ts';

export const SIZE = 36;
const TRAY_HEIGHT = 44;
const SPRING_FROM_SCALE = 0.7;
/** A run this old asks before Stop ends it. */
const CONFIRM_STOP_MS = 60_000;
/** Above this text scale the tray's items wrap rather than shrink to nothing. */
const TRAY_WRAP_SCALE = 1.3;

/** Comes in with a spring from a little smaller, fades out: the send button, the jump to the newest message. */
export function SpringIn({ children }: { children: ReactNode }) {
  const progress = useSharedValue(0);
  useEffect(() => { progress.set(withSpring(1, springs.snappy)); }, [progress]);
  const style = useAnimatedStyle(() => ({ opacity: progress.get(), transform: [{ scale: SPRING_FROM_SCALE + (1 - SPRING_FROM_SCALE) * progress.get() }] }));
  return <Animated.View exiting={crossFadeOut} style={style}>{children}</Animated.View>;
}

function TrayButton({ label, icon, leading, hint, onPress, width, iconOnly }: { label: string; icon?: IconName; leading?: ReactNode; hint: string; onPress?: () => void; width?: number; iconOnly?: boolean }) {
  const colors = useColors();
  return (
    <PressScale onPress={onPress} accessibilityLabel={`${hint}: ${label}`} hitSlop={6} style={[styles.trayButton, iconOnly && styles.trayIcon, width !== undefined && { width }]}>
      {leading ?? (!!icon && <Icon {...icon} size={iconOnly ? 16 : 14} color={colors.muted} />)}
      {!iconOnly && <Text numberOfLines={1} style={[textStyle.subhead, styles.flexShrink, { color: colors.muted }]}>{label}</Text>}
    </PressScale>
  );
}

/** The tray's labels from the task row, and the model list if this host's is already loaded (never fetched here). */
function useSettingsLabels(deviceId: string, sessionId: string) {
  const task = useConnect(s => s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId));
  const model = useModels(deviceId, task?.provider ?? '')?.find(m => m.id === task?.model);
  // "Default" beside a harness's logo says nothing, and the wire doesn't say which model is its default: the harness's name then.
  const isDefault = !task?.model || task.model === 'default';
  const modelName = isDefault ? (model?.name && !/^default$/i.test(model.name) ? model.name : harnessName(task?.provider ?? '')) : model?.name ?? modelLabel(task.model);
  const effort = task?.effort ? model?.reasoningEfforts?.find(e => e.id === task.effort)?.name ?? `${task.effort[0].toUpperCase()}${task.effort.slice(1)}` : '';
  return { provider: task?.provider ?? '', branch: task?.branch ?? '', modelName, effort, mode: task?.mode ?? '', modeLabel: MODES.find(m => m.id === task?.mode)?.label ?? '' };
}

const EFFORT_ICON: IconName = { ios: 'gauge.with.dots.needle.67percent', android: 'speed' };
const NO_WIDTHS: TrayWidths = { model: 0, effort: 0, mode: 0, branch: 0 };

/** The tray's items at their natural widths, off to the side, so trayFit can decide from real numbers. */
function TrayMeasure({ children, onWidth }: { children: ReactNode; onWidth: (width: number) => void }) {
  return <View onLayout={e => onWidth(e.nativeEvent.layout.width)}>{children}</View>;
}

export function Composer({ deviceId, sessionId, running, waiting, bot }: { deviceId: string; sessionId: string; running: boolean; waiting?: boolean; bot?: Pick<Bot, 'id' | 'name'> }) {
  const botId = bot?.id;
  const colors = useColors();
  // The text lives in the draft store, so generative UI can fill it (fillDraft) and it survives leaving the task.
  const key = draftKey(deviceId, sessionId);
  const thread = taskKey(deviceId, sessionId);
  const text = useDrafts(s => s.text[key] ?? '');
  const setText = (t: string) => setDraft(key, t);
  const focus = useDrafts(s => s.focus[key] ?? 0);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  // Only a fill made while this composer is open focuses it: a count left from earlier must not reopen the keyboard.
  const seenFocus = useRef(focus);
  useEffect(() => {
    if (focus > seenFocus.current) input.current?.focus();
    seenFocus.current = focus;
  }, [focus]);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [steer, setSteer] = useState(false);
  const { layout } = useMotion();
  const { fontScale } = useWindowDimensions();
  const wrapTray = fontScale >= TRAY_WRAP_SCALE;
  const [trayWidth, setTrayWidth] = useState(0);
  const [widths, setWidths] = useState(NO_WIDTHS);
  const measured = (item: keyof TrayWidths) => (width: number) => setWidths(w => (w[item] === width ? w : { ...w, [item]: width }));
  // Steering belongs to one run: it ends with the run, and sending a steer finishes it.
  if (steer && !running) setSteer(false);
  const focused = useSharedValue(0);
  const focusRing = useAnimatedStyle(() => ({ opacity: focused.get() }));
  const labels = useSettingsLabels(deviceId, sessionId);

  // A status note holds only until the run, the outbox or the newest prompt moves on from when it was set.
  const [note, setNote] = useState({ text: '', stamp: '' });
  const outboxCount = useLocal(s => s.outbox.length);
  const lastPrompt = useConnect(s => s.messages[thread]?.findLast(m => m.role === 'user')?.id ?? 0);
  const stamp = `${running}/${outboxCount}/${lastPrompt}`;
  const shownNote = note.stamp === stamp ? note.text : '';
  const leaveNote = (noteText: string) => setNote({
    text: noteText,
    stamp: `${running}/${useLocal.getState().outbox.length}/${useConnect.getState().messages[thread]?.findLast(m => m.role === 'user')?.id ?? 0}`,
  });

  const stopNow = async () => {
    setStopping(true);
    haptic('warning');
    try {
      await connect.stopTask(deviceId, sessionId);
    } catch (error) {
      Alert.alert('Could not stop', (error as Error).message);
    } finally {
      setStopping(false);
    }
  };
  const stop = () => {
    const state = useConnect.getState();
    const since = runClockStart(state.live[thread], state.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)) || state.messages[thread]?.findLast(m => m.role === 'user')?.createdAt;
    const ran = since ? Date.now() - since : 0;
    if (ran <= CONFIRM_STOP_MS) return void stopNow();
    Alert.alert('Stop this run?', `It has been working for ${elapsedLabel(ran)}.`, [
      { text: 'Keep working', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => void stopNow() },
    ]);
  };
  const act = async (kind: 'send' | 'steer') => {
    const prompt = text.trim();
    if (!prompt) return;
    setBusy(true);
    // Cleared now, so anything typed while this is in flight stays.
    setText('');
    try {
      if (botId) {
        haptic('light');
        await connect.botMessage(deviceId, botId, sessionId, prompt);
        AccessibilityInfo.announceForAccessibility('Sent');
      } else if (running && kind === 'steer') {
        haptic('medium');
        const at = Date.now();
        await connect.steerTask(deviceId, sessionId, prompt);
        markSteered(thread, prompt, at);
        setSteer(false);
        leaveNote('Steering…');
        AccessibilityInfo.announceForAccessibility('Steering the agent');
      } else {
        haptic('light');
        const result = await sendOrQueue(deviceId, sessionId, prompt);
        const outcome = result.outbox ? 'Saved. Sends when the computer is back' : result.queued ? 'Queued for after this run' : '';
        leaveNote(outcome);
        AccessibilityInfo.announceForAccessibility(outcome || 'Sent');
      }
    } catch (error) {
      restoreDraft(key, text);
      haptic('error');
      Alert.alert('Could not send', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const settings = (section: string) => () => router.push({ pathname: '/task-settings', params: { device: deviceId, session: sessionId, focus: section } });
  const openInfo = () => router.push({ pathname: '/task-info', params: { device: deviceId, session: sessionId } });
  const hasText = !!text.trim();
  // While running, a tap does the preferred action and a long press the other one.
  const tap = running && steer && !botId && !waiting ? 'steer' : 'send';
  const hold = running && !botId && !waiting ? (steer ? 'send' : 'steer') : undefined;
  // While a request waits, the card owns the moment: a send just queues, and there's no steering past it.
  const steerable = running && !botId && !waiting;
  const fit = trayFit(trayWidth, { ...widths, branch: labels.branch ? widths.branch : 0, effort: labels.effort ? widths.effort : 0 }, labels.mode === 'full');
  const modeIcon: IconName = labels.mode === 'full' ? { ios: 'lock.open', android: 'lock_open' } : { ios: 'lock', android: 'lock' };
  return (
    <Glass style={styles.bar}>
      {/* Steering lives here for the whole run, so nothing moves between this row and the tray as you type. */}
      {steerable && (
        <Animated.View entering={crossFadeIn} exiting={crossFadeOut} style={styles.state}>
          <Icon ios={steer ? 'arrow.uturn.right' : 'list.number'} android={steer ? 'alt_route' : 'format_list_numbered'} size={14} color={colors.muted} />
          <Text numberOfLines={1} style={[textStyle.subhead, styles.stateText, { color: colors.muted }]}>{steer ? 'Steering the agent' : 'Queues after this run'}</Text>
          {steer
            ? <PressScale onPress={() => setSteer(false)} accessibilityLabel="Stop steering" hitSlop={10} style={styles.stateClose}><Icon ios="xmark" android="close" size={13} color={colors.muted} /></PressScale>
            : <Button label="Steer" variant="plain" size="small" icon={{ ios: 'arrow.uturn.right', android: 'alt_route' }} disabled={busy}
                onPress={() => (hasText ? act('steer') : (haptic('selection'), setSteer(true)))} accessibilityHint={hasText ? 'Sends this to the running agent now' : 'Your next message goes to the running agent'} />}
        </Animated.View>
      )}
      <InnerCard style={styles.field}>
        <Animated.View pointerEvents="none" style={[styles.focusRing, { borderColor: colors.borderStrong }, focusRing]} />
        <TextInput
          ref={input}
          value={text}
          onChangeText={t => { setText(t); if (note.text) setNote({ text: '', stamp: '' }); }}
          placeholder={shownNote || (bot ? `Message ${bot.name}…` : running && steer ? 'Steer the agent…' : 'Ask the agent…')}
          placeholderTextColor={colors.faint}
          multiline
          style={[styles.input, { color: colors.text }]}
          accessibilityLabel="Message"
          onFocus={() => focused.set(withTiming(1, { duration: FADE_MS }))}
          onBlur={() => focused.set(withTiming(0, { duration: FADE_MS }))}
        />
        {(running || hasText) && (
          <Animated.View layout={layout} style={[styles.pill, running && { backgroundColor: colors.track, borderColor: colors.border }]}>
            {running && (
              <PressScale onPress={stop} disabled={stopping} accessibilityLabel="Stop" accessibilityHint="Ends this run" hitSlop={4} style={styles.stop}>
                <Icon ios="stop.fill" android="stop" size={15} color={colors.danger} />
              </PressScale>
            )}
            {hasText && (
              <SpringIn>
                <Round label={tap === 'steer' ? 'Steer' : running ? 'Queue' : 'Send'} hint={hold && (hold === 'steer' ? 'Long press to steer' : 'Long press to queue')}
                  ios={running ? (tap === 'steer' ? 'arrow.uturn.right' : 'list.number') : 'arrow.up'} android={running ? (tap === 'steer' ? 'alt_route' : 'format_list_numbered') : 'arrow_upward'}
                  onPress={() => act(tap)} onLongPress={hold && (() => act(hold))} disabled={busy} bg={colors.primary} fg={colors.onPrimary} />
              </SpringIn>
            )}
          </Animated.View>
        )}
      </InnerCard>
      <View style={[styles.tray, wrapTray && styles.trayTop]}>
        <View style={[styles.trayItems, wrapTray && styles.trayWrap]} onLayout={e => setTrayWidth(e.nativeEvent.layout.width)}>
          {/* Each item moves with a layout transition when a neighbour changes, rather than snapping. */}
          {!!labels.provider && <Animated.View layout={layout}><TrayButton hint="Model" label={labels.modelName} width={wrapTray || fit.model >= widths.model ? undefined : fit.model} leading={<HarnessLogo id={labels.provider} size={15} />} onPress={settings('model')} /></Animated.View>}
          {!!labels.effort && <Animated.View layout={layout}><TrayButton hint="Effort" label={labels.effort} iconOnly={!wrapTray && fit.effortIcon} icon={EFFORT_ICON} onPress={settings('effort')} /></Animated.View>}
          {!!labels.modeLabel && <Animated.View layout={layout}><TrayButton hint="Permissions" label={labels.modeLabel} iconOnly={!wrapTray && fit.modeIcon} icon={modeIcon} onPress={settings('mode')} /></Animated.View>}
          {!!labels.branch && (wrapTray
            ? <View style={styles.branchRow}><BranchChip branch={labels.branch} onPress={openInfo} /></View>
            : fit.branch !== null && <><View style={styles.traySpacer} /><Animated.View layout={layout} entering={crossFadeIn} exiting={crossFadeOut}><BranchChip branch={labels.branch} style={[styles.branch, { width: fit.branch }]} onPress={openInfo} /></Animated.View></>)}
        </View>
        {!wrapTray && (
          <View style={styles.trayMeasure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <TrayMeasure onWidth={measured('model')}><TrayButton hint="" label={labels.modelName} leading={<HarnessLogo id={labels.provider} size={15} />} /></TrayMeasure>
            <TrayMeasure onWidth={measured('effort')}><TrayButton hint="" label={labels.effort} icon={EFFORT_ICON} /></TrayMeasure>
            <TrayMeasure onWidth={measured('mode')}><TrayButton hint="" label={labels.modeLabel} icon={modeIcon} /></TrayMeasure>
            {!!labels.branch && <TrayMeasure onWidth={measured('branch')}><BranchChip branch={labels.branch} /></TrayMeasure>}
          </View>
        )}
      </View>
    </Glass>
  );
}

export function Round({ label, hint, ios, android, onPress, onLongPress, disabled, bg, fg }: { label: string; hint?: string; ios: Parameters<typeof Icon>[0]['ios']; android: Parameters<typeof Icon>[0]['android']; onPress: () => void; onLongPress?: () => void; disabled?: boolean; bg: ColorValue; fg: ColorValue }) {
  if (nativeGlass) return <GlassIcon icon={ios} label={label} hint={hint} onPress={onPress} onLongPress={onLongPress} disabled={disabled} size={SIZE} iconSize={15} color={fg} tint={bg} />;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} hitSlop={6}
      style={({ pressed }) => [styles.round, { backgroundColor: bg, opacity: pressed ? 0.7 : 1 }]}>
      <Icon ios={ios} android={android} size={15} color={fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: 20, marginHorizontal: geometry.screenMargin, padding: 6, borderCurve: 'continuous' },
  state: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingLeft: 10, paddingRight: 4, paddingBottom: 4 },
  stateText: { flex: 1 },
  stateClose: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  field: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, padding: 4 },
  input: { flex: 1, fontSize: textStyle.body.fontSize, maxHeight: 140, minHeight: SIZE, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: SIZE / 2 + 2, borderCurve: 'continuous', borderWidth: 0.5, borderColor: 'transparent', padding: 1 },
  stop: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  focusRing: { position: 'absolute', top: -geometry.hairline, left: -geometry.hairline, right: -geometry.hairline, bottom: -geometry.hairline, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: 1 },
  tray: { flexDirection: 'row', alignItems: 'center', minHeight: TRAY_HEIGHT, paddingHorizontal: 8 },
  trayTop: { alignItems: 'flex-start' },
  trayItems: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: TRAY_GAP, overflow: 'hidden' },
  trayMeasure: { position: 'absolute', left: 0, top: 0, width: 2000, flexDirection: 'row', opacity: 0 },
  traySpacer: { flex: 1, marginLeft: -TRAY_GAP },
  trayWrap: { flexWrap: 'wrap', paddingVertical: 4 },
  trayButton: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: TRAY_HEIGHT },
  trayIcon: { width: TRAY_ICON_WIDTH, justifyContent: 'center' },
  flexShrink: { flexShrink: 1 },
  branch: { alignSelf: 'center' },
  branchRow: { width: '100%' },
  round: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
});
