// The new-task form state shared by the New task sheet and the iPhone Duo's New thread pane:
// computer, project, harness + model, effort, mode and worktree, each following the last task on
// that computer until the user picks, whether it starts a Chat (no project) or a team (an architect
// leading agents, where the computer serves team.start), and `begin`, which calls task.start,
// chat.start or team.start, uploading any attached images first (`imageIds`, which all three take).
// Run on: this computer, or a connected cloud provider (cloudAgents.targets), where Start calls
// cloudAgents.start with the same draft (a retry reuses its start id). The host has no local-VM
// start for tasks, so only cloud targets join this computer there.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { cloudAgentTargets, startCloudAgent } from '../connect/api/admin.ts';
import { useHostAllows, useHostBlock, useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { blockedNote } from '../connect/api/hello.ts';
import { startChatTask } from '../connect/api/projects.ts';
import { AUTO_TEAM, pickedTeam, startTeamTask, teamRoster, teamStartParams, type TeamRoster } from '../connect/api/team.ts';
import { connect } from '../connect/client.ts';
import { uuid } from '../connect/crypto.ts';
import { draftStartId, keepsStartId, unsentStartError, unsentStartNotice, type DraftStart } from '../connect/start-retry.ts';
import { draftKey, restoreDraft } from '../store/draft.ts';
import { chosenCloud, cloudHarnessRefusal, cloudStartBlock, cloudTaskForm, RUN_HERE, runOnChoices, type CloudTargets } from '../store/admin.ts';
import { useHosts, useProviders, useTasks } from '../store/index.ts';
import { haptic } from './ds/motion.ts';
import { showToast } from './ds/Toast.tsx';
import { harnessName } from './harness.tsx';
import type { SendImage } from '../store/attach.ts';
import { uploadAttached } from './ComposerAttach.tsx';
import { useAccessNote } from './AccessNote.tsx';
import type { MenuGate } from './menu-gate.ts';
import { useModelOptions } from './models.ts';
import { pickableProjects, startMethod } from './new-task-projects.ts';

export { pickableProjects };

/** A start that made the task without its first message: the prompt waits in that task's composer
 * and a toast says so; the task still opens. Returns whether the message went. */
export function noteUnsentStart(deviceId: string, reply: { sessionId: string; sent?: unknown; error?: unknown }, prompt: string): boolean {
  const show = unsentStartToast(deviceId, reply, prompt);
  show?.();
  return !show;
}

/** As noteUnsentStart, but hands back the "Message not sent" toast for the caller to show (after a
 * covering sheet has gone, where a native sheet would hide it) instead of showing it; undefined when
 * the message went. The draft is restored either way. */
export function unsentStartToast(deviceId: string, reply: { sessionId: string; sent?: unknown; error?: unknown }, prompt: string): (() => void) | undefined {
  const error = unsentStartError(reply);
  if (error === null) return undefined;
  if (prompt.trim()) restoreDraft(draftKey(deviceId, reply.sessionId), prompt);
  haptic('error');
  const notice = unsentStartNotice(error);
  return () => showToast(notice);
}

/** What Start answers: the session, any worktree note, and `sent: false` when its first message did not go. */
export interface BeginReply {
  sessionId: string; note?: unknown; sent?: boolean; error?: unknown;
  /** With `deferNotice`: shows the "Message not sent" toast; the caller runs it once its sheet has gone. */
  notice?: () => void;
}
/** `deferNotice`: hand back the unsent toast (BeginReply.notice) rather than show it under a sheet. */
export interface BeginOptions { deferNotice?: boolean }

/** The project Add project just cloned or found on a computer, for the open New task form to select. */
interface AddedProject { deviceId: string; projectId: string; seq: number }
const useAddedProject = create<AddedProject | null>(() => null);

/** Add project's hand-off: the New task sheet or Duo pane underneath selects this project. */
export function selectAddedProject(deviceId: string, projectId: string) {
  useAddedProject.setState(prev => ({ deviceId, projectId, seq: (prev?.seq ?? 0) + 1 }), true);
}

/** What every start method takes beyond the form: the attached images' ids. */
type Extra = { imageIds?: string[] };

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
  const projects = pickableProjects(list);
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

  const [listFailure, setListFailure] = useState<{ deviceId: string; message: string } | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  useEffect(() => {
    if (deviceId && !list) connect.listTasks(deviceId).catch((error: Error) => setListFailure({ deviceId, message: error.message }));
  }, [deviceId, list, listAttempt]);
  const problem = (listFailure?.deviceId === deviceId ? listFailure.message : null) ?? options.error;
  const retry = () => { setListFailure(null); setListAttempt(a => a + 1); options.retry(); };
  const pick = (change: Chosen) => setChosen(c => ({ ...c, ...change }));
  const pickDevice = (id: string) => { setDevicePick(id); setChosen({}); setProviderPick(undefined); setRunOn(RUN_HERE); };
  const pickProvider = (id: string) => { setProviderPick(id); pick({ model: 'default', effort: null }); };
  const pickModel = (id: string) => pick({ model: id, effort: options.defaultEffort(id) });

  // The draft's start id: a retry of the same draft after a lost reply reuses it, so the host
  // (which runs a repeated startId once) never starts the task twice.
  const draftStart = useRef<DraftStart | null>(null);
  /** Starts the task; returns its session id and any worktree note. */
  const startTask = async (prompt: string, extra: Extra) => {
    const params = { projectId, worktree, prompt, provider, model, mode, effort: efforts.some(e => e.value === effort) ? effort! : undefined, ...extra };
    const draft = draftStartId(draftStart.current, JSON.stringify([deviceId, params]), uuid);
    draftStart.current = draft;
    try {
      const session = await connect.startTask(deviceId, { ...params, startId: draft.id });
      draftStart.current = null;
      void connect.listTasks(deviceId).catch(() => undefined);
      return session;
    } catch (e) {
      if (!keepsStartId(e)) draftStart.current = null;
      throw e;
    }
  };

  const chatServed = useHostAllows(deviceId, 'chat.start');
  // Chat, Team and Add project show wherever the computer serves them; when this phone's grant or
  // the Full access switch keeps one off it stays, disabled, with the AccessNote text as its reason.
  const gates: Record<'chat' | 'team' | 'addProject', MenuGate> = {
    chat: { shown: useHostSupports(deviceId, 'chat.start'), note: useAccessNote(deviceId, ['chat.start']) },
    team: { shown: useHostSupports(deviceId, 'team.start'), note: useAccessNote(deviceId, ['team.start']) },
    addProject: { shown: useHostSupports(deviceId, 'projects.clone'), note: useAccessNote(deviceId, ['projects.clone']) },
  };
  const [chatPick, setChatPick] = useState(false);
  // A project Add project hands back (cloned, or already on the computer) becomes the pick. Only
  // selections made while this form is mounted apply; one from before isn't this form's.
  const currentDevice = useRef(deviceId);
  useEffect(() => { currentDevice.current = deviceId; }, [deviceId]);
  useEffect(() => useAddedProject.subscribe(added => {
    if (!added) return;
    const sameDevice = added.deviceId === currentDevice.current;
    setDevicePick(added.deviceId);
    if (!sameDevice) setProviderPick(undefined);
    setChosen(c => ({ ...(sameDevice ? c : {}), projectId: added.projectId }));
    setChatPick(false);
  }), []);
  // A computer with no project yet starts a Chat, where it can.
  const chat = chatServed && (chatPick || (!!list && projects.length === 0));

  // Run on: the computer's connected cloud providers, read once per computer where it serves the start.
  const [runOn, setRunOn] = useState(RUN_HERE);
  const cloudStartServed = useHostSupports(deviceId, 'cloudAgents.start');
  const cloudTargetsServed = useHostSupports(deviceId, 'cloudAgents.targets');
  const cloudServed = cloudStartServed && cloudTargetsServed;
  const [targets, setTargets] = useState<{ deviceId: string; targets: CloudTargets } | null>(null);
  useEffect(() => {
    if (!deviceId || !cloudServed || targets?.deviceId === deviceId) return;
    let live = true;
    // Optional: without it Run on offers this computer only.
    cloudAgentTargets(deviceId).then(t => { if (live) setTargets({ deviceId, targets: t }); }).catch(() => undefined);
    return () => { live = false; };
  }, [deviceId, cloudServed, targets?.deviceId]);
  const cloudTargets = cloudServed && targets?.deviceId === deviceId ? targets.targets : null;
  const runOnOptions = chat ? [] : runOnChoices(cloudTargets);
  /** The cloud provider Start runs on, or null for this computer (a Chat always runs here). */
  const cloud = chat ? null : chosenCloud(cloudTargets, runOn);
  const caps = useHostCapabilities(deviceId);
  const cloudBlock = cloudStartBlock(useHostBlock(deviceId, 'cloudAgents.start'), caps?.kind === 'hello' ? caps.remoteFullAccess : undefined);
  const computer = hosts.find(h => h.id === deviceId)?.name ?? 'the computer';
  /** Why a cloud start can't go now: the access note (grant or Full access switch) or the harness. */
  const cloudNote = !cloud ? null
    : cloudBlock ? blockedNote(cloudBlock, computer, caps?.kind === 'hello' ? caps.access : undefined)
    : provider ? cloudHarnessRefusal(provider, cloudTargets, harnessName(provider)) : null;
  const cloudDraft = useRef<DraftStart | null>(null);
  /** Starts the draft on the picked cloud provider, once per draft (a retry reuses the start id). */
  const startCloud = async (prompt: string, images: readonly SendImage[]): Promise<BeginReply> => {
    if (!cloud) throw new Error('Pick where to run the task.');
    if (cloudNote) throw new Error(cloudNote);
    if (images.length) throw new Error('Images can’t be sent to a cloud machine yet. Remove them, or run on this computer.');
    const form = cloudTaskForm({ provider: cloud.provider, harness: provider, projectId, prompt, model, mode, effort: efforts.some(e => e.value === effort) ? effort : null });
    const draft = draftStartId(cloudDraft.current, JSON.stringify([deviceId, form]), uuid);
    cloudDraft.current = draft;
    try {
      const { sessionId, sent, error } = await startCloudAgent(deviceId, form, draft.id);
      cloudDraft.current = null;
      void connect.listTasks(deviceId).catch(() => undefined);
      return { sessionId, ...(sent === false ? { sent, error } : {}) };
    } catch (e) {
      if (!keepsStartId(e)) cloudDraft.current = null;
      throw e;
    }
  };
  /** Starts a Chat with the picked harness, model, mode and effort. */
  const startChat = (prompt: string, extra: Extra): Promise<{ sessionId: string; note?: unknown }> =>
    startChatTask(deviceId, { prompt, provider, model, mode, ...(effort && efforts.some(e => e.value === effort) ? { effort } : {}), ...extra });
  // A team: the picked model leads (Auto) or a named team from the computer's Settings does.
  const teamServed = useHostAllows(deviceId, 'team.start');
  const [teamOn, setTeamOn] = useState(false);
  const [teamPick, setTeamPick] = useState(AUTO_TEAM);
  const [roster, setRoster] = useState<{ deviceId: string; roster: TeamRoster } | null>(null);
  const team = teamServed && teamOn && !chat && !cloud;
  const rosterServed = useHostSupports(deviceId, 'team.roster');
  useEffect(() => {
    if (!team || !rosterServed || roster?.deviceId === deviceId) return;
    let live = true;
    // Optional: without it the picker offers Auto only.
    teamRoster(deviceId).then(r => { if (live) setRoster({ deviceId, roster: r }); }).catch(() => undefined);
    return () => { live = false; };
  }, [team, rosterServed, deviceId, roster?.deviceId]);
  const teamRosterNow = roster?.deviceId === deviceId ? roster.roster : null;
  const profileId = pickedTeam(teamRosterNow, teamPick);
  /** Starts a team task in the picked project. */
  const startTeam = (prompt: string, extra: Extra): Promise<{ sessionId: string; note?: unknown }> => {
    const form = { projectId, prompt, provider, model, mode, ...(effort && efforts.some(e => e.value === effort) ? { effort } : {}), ...extra };
    return startTeamTask(deviceId, teamStartParams(form, profileId));
  };

  // What Start calls, and whether this phone may call it there (its grant, the Full access switch).
  const method = cloud ? 'cloudAgents.start' : startMethod({ chat, team });
  const taskAllowed = useHostAllows(deviceId, 'task.start');
  const allowed = cloud ? !cloudNote : method === 'chat.start' ? chatServed : method === 'team.start' ? teamServed : taskAllowed;

  // The draft's uploaded images: a retry of the same draft reuses their ids (as it does the start
  // id); they're dropped once the start went through or failed for good.
  const uploaded = useRef<{ key: string; ids: Promise<string[]> } | null>(null);
  const imageIdsFor = (images: readonly SendImage[]): Promise<string[]> => {
    const key = JSON.stringify([deviceId, images.map(i => i.uri)]);
    if (uploaded.current?.key !== key) uploaded.current = { key, ids: uploadAttached(deviceId, images) };
    return uploaded.current.ids;
  };

  /**
   * A Chat, a team or a task in the picked project, as the form says, with `images` uploaded first:
   * the session id and any worktree note. `starting` stays on after a task or team starts (the
   * screen moves on); a Chat and any failure clear it. Throws on failure. A start that made the
   * task but not its first message resolves too (`sent: false`): the prompt goes to that task's
   * composer draft and a "Message not sent" toast shows (or, with `deferNotice`, comes back as
   * `notice` for the caller to show once its sheet has gone), so the caller opens the task as usual.
   */
  const begin = async (prompt: string, images: readonly SendImage[] = [], { deferNotice = false }: BeginOptions = {}): Promise<BeginReply> => {
    const noted = (reply: BeginReply, text: string): BeginReply => {
      const notice = unsentStartToast(deviceId, reply, text);
      if (!notice) return reply;
      if (!deferNotice) { notice(); return reply; }
      return { ...reply, notice };
    };
    setStarting(true);
    haptic('medium');
    if (cloud) {
      try {
        return noted(await startCloud(prompt.trim(), images), prompt.trim());
      } catch (e) {
        setStarting(false);
        throw e;
      }
    }
    try {
      const extra: Extra = images.length ? { imageIds: await imageIdsFor(images) } : {};
      const text = prompt.trim();
      const reply: BeginReply = await (chat ? startChat(text, extra) : team ? startTeam(text, extra) : startTask(text, extra));
      uploaded.current = null;
      if (chat) setStarting(false);
      return noted(reply, text);
    } catch (e) {
      if (!keepsStartId(e)) uploaded.current = null;
      setStarting(false);
      throw e;
    }
  };

  return {
    hosts, deviceId, list, projects, projectId, provider, options, model, effort, efforts, mode, worktree, starting,
    pick, pickDevice, pickProvider, pickModel, setWorktree, setStarting, problem, retry,
    chat, chatServed, setChatPick, begin, method, allowed, gates,
    team, teamServed, setTeamOn, teamRoster: teamRosterNow, profileId, setTeamPick,
    runOn: cloud ? runOn : RUN_HERE, runOnOptions, setRunOn, cloud, cloudNote,
  };
}
