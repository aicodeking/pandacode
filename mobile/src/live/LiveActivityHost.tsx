// One Live Activity (Lock Screen and Dynamic Island) summarising every computer's running and waiting
// tasks. It starts when anything runs or waits, follows the inbox at most every THROTTLE_MS and only
// when the summary changes, and ends SETTLE_MS after everything settled. iOS only, and off when
// ActivityKit refuses (Live Activities turned off in Settings, iPad, old iOS).
//
// The relay socket closes about 30 s after the app goes to the background, so updates stop there:
// each update while backgrounded carries a staleDate, after which the layout says "Open PandaCode to
// refresh". Background updates need APNs push from the relay (docs/app-store/live-activities.md).
import { requireOptionalNativeModule } from 'expo';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import type { LiveActivity, LiveActivityFactory } from 'expo-widgets';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import type { Inbox } from '../store/inbox.ts';
import { useInbox } from '../ui/useInbox.ts';
import { PandaActivity } from './PandaActivity.tsx';
import { summarize, type LiveSummary } from './summary.ts';

const THROTTLE_MS = 2_000;
const SETTLE_MS = 2 * 60_000;
/** How long an ended activity stays on the Lock Screen. */
const LINGER_MS = 15 * 60_000;
/** The socket closes ~30 s after backgrounding; past this the content may be out of date. */
const STALE_MS = 45_000;

type Widgets = typeof import('expo-widgets');

const state = {
  factory: null as LiveActivityFactory<LiveSummary> | null,
  activity: null as LiveActivity<LiveSummary> | null,
  disabled: false,
  tracked: new Set<string>() as ReadonlySet<string>,
  inbox: null as Inbox | null,
  signature: '',
  last: 0,
  backgroundAt: 0,
  mark: '',
  flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  endTimer: undefined as ReturnType<typeof setTimeout> | undefined,
};

// Required lazily: the native module exists only in iOS builds (Android excludes it from autolinking).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const widgets = (): Widgets => require('expo-widgets');

function factory(): LiveActivityFactory<LiveSummary> {
  state.factory ??= widgets().createLiveActivity('PandaActivity', PandaActivity);
  return state.factory;
}

/** Copies the panda mark into the app group directory the widget extension can read. */
async function copyMark() {
  const directory = widgets().widgetsDirectory;
  if (!directory) return;
  const asset = await Asset.fromModule(require('./mark.png')).downloadAsync();
  if (!asset.localUri) return;
  const target = new File(directory, 'panda-mark.png');
  new File(asset.localUri).copy(target, { overwrite: true });
  state.mark = target.uri;
  state.signature = ''; // show it on the next push
  schedule();
}

const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const staleDate = () => (state.backgroundAt ? new Date(state.backgroundAt + STALE_MS) : undefined);

function schedule() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flush, Math.max(0, state.last + THROTTLE_MS - Date.now()));
}

function flush() {
  state.flushTimer = undefined;
  if (state.disabled || !state.inbox) return;
  const { summary, tracked } = summarize(state.inbox, state.tracked, clock(), state.mark);
  if (!state.activity && !summary.active) return;
  const signature = JSON.stringify({ ...summary, updated: '' });
  if (signature === state.signature) return;
  state.signature = signature;
  state.tracked = tracked;
  state.last = Date.now();
  try {
    if (state.activity) void state.activity.update(summary, staleDate()).catch(warn);
    else state.activity = factory().start(summary, undefined, staleDate());
  } catch (error) {
    // ActivityKit refused (turned off or unsupported): stay off for this launch.
    state.disabled = true;
    warn(error);
    return;
  }
  clearTimeout(state.endTimer);
  state.endTimer = summary.active ? undefined : setTimeout(() => end(summary), SETTLE_MS);
}

function end(summary: LiveSummary) {
  const activity = state.activity;
  Object.assign(state, { activity: null, tracked: new Set(), signature: '', endTimer: undefined });
  void activity?.end(widgets().after(new Date(Date.now() + LINGER_MS)), summary).catch(warn);
}

const warn = (error: unknown) => console.warn('Live Activity:', error instanceof Error ? error.message : error);

/** Picks up an activity left by an earlier launch, and ends any extras. */
function adopt() {
  try {
    const [first, ...rest] = factory().getInstances();
    state.activity = first ?? null;
    for (const extra of rest) void extra.end('immediate').catch(warn);
  } catch (error) {
    warn(error);
  }
}

function useLiveActivity() {
  const { inbox } = useInbox();
  useEffect(() => {
    // A binary built before expo-widgets was added (or an update reaching one) has no native module.
    state.disabled = !requireOptionalNativeModule('ExpoWidgets');
    if (state.disabled) return;
    adopt();
    copyMark().catch(warn);
    const sub = AppState.addEventListener('change', next => {
      // Re-push on every switch so the staleDate is set going out and cleared coming back.
      state.backgroundAt = next === 'active' ? 0 : state.backgroundAt || Date.now();
      state.signature = '';
      schedule();
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    state.inbox = inbox;
    schedule();
  }, [inbox]);
}

function LiveActivitySync() {
  useLiveActivity();
  return null;
}

const Off = () => null;

/** Mounted once in the root layout. */
export const LiveActivityHost = Platform.OS === 'ios' ? LiveActivitySync : Off;
