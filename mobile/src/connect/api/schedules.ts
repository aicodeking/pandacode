// Host calls for the `schedules` feature group (src-tauri/src/remote/methods/schedules.rs). Reads are
// View; run now, on/off and snooze are Control; create, edit and delete are Full.
import { create } from 'zustand';
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { ACTION_SEND_ID, hostCallOnce } from './github.ts';
import { createScheduleWith, NO_SCHEDULE, type ScheduleInput, type ScheduleRun, type TaskSchedule } from '../../store/schedules.ts';

export const SCHEDULE_METHODS = registerMethods(['schedules.list', 'schedules.runs', 'schedules.runNow', 'schedules.setEnabled', 'schedules.snooze', 'schedules.create', 'schedules.update', 'schedules.delete'] as const);

export interface ScheduleList { schedules: TaskSchedule[]; paused: boolean; truncated: boolean }

export async function listSchedules(deviceId: string, sessionId?: string): Promise<ScheduleList> {
  const reply = await hostCall<Partial<ScheduleList>>(deviceId, 'schedules.list', sessionId ? { sessionId } : {});
  return { schedules: Array.isArray(reply?.schedules) ? reply.schedules : [], paused: !!reply?.paused, truncated: !!reply?.truncated };
}

export async function scheduleRuns(deviceId: string, filter: { scheduleId?: string; sessionId?: string; limit?: number } = {}): Promise<ScheduleRun[]> {
  const reply = await hostCall<{ runs?: ScheduleRun[] }>(deviceId, 'schedules.runs', filter);
  return Array.isArray(reply?.runs) ? reply.runs : [];
}

const scheduleOf = (reply: { schedule?: TaskSchedule }) => {
  if (!reply?.schedule) throw new Error(NO_SCHEDULE);
  return reply.schedule;
};

/** Runs a schedule now, once per call: a lost reply is retried under the same `sendId` (github.ts `runOnce`). */
export const runScheduleNow = (deviceId: string, scheduleId: string) => hostCallOnce<{ run: ScheduleRun }>(deviceId, 'schedules.runNow', { scheduleId }).then(reply => reply.run);
export const setScheduleEnabled = (deviceId: string, scheduleId: string, enabled: boolean) => hostCall<{ schedule?: TaskSchedule }>(deviceId, 'schedules.setEnabled', { scheduleId, enabled }).then(scheduleOf);
export const snoozeSchedule = (deviceId: string, scheduleId: string, minutes: number) => hostCall<{ schedule?: TaskSchedule }>(deviceId, 'schedules.snooze', { scheduleId, minutes }).then(scheduleOf);

/** Creates a schedule once per draft (`createScheduleWith`). */
export async function createSchedule(deviceId: string, input: ScheduleInput): Promise<TaskSchedule> {
  const { capabilitiesOf } = await import('./capabilities.ts');
  const caps = capabilitiesOf(deviceId);
  const dedupes = caps?.kind === 'hello' && caps.features.has(ACTION_SEND_ID);
  return createScheduleWith(params => hostCall<{ schedule?: TaskSchedule }>(deviceId, 'schedules.create', params), dedupes, deviceId, input);
}
export const updateSchedule = (deviceId: string, scheduleId: string, input: ScheduleInput) => hostCall<{ schedule?: TaskSchedule }>(deviceId, 'schedules.update', { scheduleId, input }).then(scheduleOf);
export const deleteSchedule = (deviceId: string, scheduleId: string) => hostCall<object>(deviceId, 'schedules.delete', { scheduleId });

/** Each computer's last schedule list, shared by the Schedules, Schedule and New schedule screens. */
export const useSchedules = create<Record<string, ScheduleList>>(() => ({}));

/** Reads `deviceId`'s schedules into `useSchedules`; throws the host's error. */
export async function refreshSchedules(deviceId: string): Promise<ScheduleList> {
  const list = await listSchedules(deviceId);
  useSchedules.setState({ [deviceId]: list });
  return list;
}

/** Puts a changed schedule in place (or first, when new) without a round trip; `null` removes `id`. */
export function placeSchedule(deviceId: string, id: string, schedule: TaskSchedule | null) {
  const list = useSchedules.getState()[deviceId];
  if (!list) return;
  const rest = list.schedules.filter(s => s.id !== id);
  const at = list.schedules.findIndex(s => s.id === id);
  const schedules = !schedule ? rest : at < 0 ? [schedule, ...rest] : list.schedules.map(s => (s.id === id ? schedule : s));
  useSchedules.setState({ [deviceId]: { ...list, schedules } });
}
