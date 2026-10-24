// The new-task form state shared by the New task sheet and the iPhone Duo's New thread pane:
// computer, project, harness + model, effort, mode and worktree, each following the last task on
// that computer until the user picks, and `start`, which calls task.start.
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { connect } from '../connect/client.ts';
import { useHosts, useProviders, useTasks } from '../store/index.ts';
import { useModelOptions } from './models.ts';

type Chosen = { projectId?: string; provider?: string; model?: string; effort?: string | null; mode?: string };

export function useNewTask(initialDevice?: string) {
  const hosts = useHosts().filter(h => h.online);
  const [devicePick, setDevicePick] = useState(initialDevice);
  const deviceId = hosts.find(h => h.id === devicePick)?.id ?? hosts[0]?.id ?? '';
  const list = useTasks(deviceId);
  const recent = list?.tasks.find(t => !t.chat);
  // The user's picks; anything unpicked follows the last task on that computer.
  const [chosen, setChosen] = useState<Chosen>({});
  const [worktree, setWorktree] = useState(false);
  const [starting, setStarting] = useState(false);
  const projects = list?.projects ?? [];
  const projectId = projects.find(p => p.id === chosen.projectId)?.id ?? recent?.projectId ?? projects[0]?.id ?? '';
  // The picked project's icon (the others show only as menu text).
  useEffect(() => { if (deviceId && projectId) void connect.projectIcons(deviceId, [projectId]); }, [deviceId, projectId]);
  const [providerPick, setProviderPick] = useState<string>();
  const firstInstalled = useProviders(deviceId)?.find(p => p.installed)?.id;
  const provider = providerPick ?? recent?.provider ?? firstInstalled ?? '';
  const options = useModelOptions(deviceId, provider);
  const model = chosen.model ?? (recent && provider === recent.provider ? recent.model : 'default');
  const effort = chosen.effort !== undefined ? chosen.effort : recent && model === recent.model ? recent.effort : options.defaultEffort(model);
  const mode = chosen.mode ?? recent?.mode ?? 'ask';
  const efforts = options.efforts(model);

  useEffect(() => { if (deviceId && !list) connect.listTasks(deviceId).catch(() => undefined); }, [deviceId, list]);
  const pick = (change: Chosen) => setChosen(c => ({ ...c, ...change }));
  const pickDevice = (id: string) => { setDevicePick(id); setChosen({}); setProviderPick(undefined); };
  const pickProvider = (id: string) => { setProviderPick(id); pick({ model: 'default', effort: null }); };
  const pickModel = (id: string) => pick({ model: id, effort: options.defaultEffort(id) });

  const canStart = (prompt: string) => !!(deviceId && projectId && provider && prompt.trim()) && !starting;
  /** Starts the task and returns its session id; throws (and clears `starting`) on failure. */
  const start = async (prompt: string) => {
    setStarting(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const session = await connect.startTask(deviceId, { projectId, worktree, prompt: prompt.trim(), provider, model, mode, effort: efforts.some(e => e.value === effort) ? effort! : undefined });
      void connect.listTasks(deviceId).catch(() => undefined);
      return session;
    } catch (e) {
      setStarting(false);
      throw e;
    }
  };

  return {
    hosts, deviceId, list, projects, projectId, provider, options, model, effort, efforts, mode, worktree, starting,
    pick, pickDevice, pickProvider, pickModel, setWorktree, setStarting, canStart, start,
  };
}
