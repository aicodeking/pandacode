// One computer's hub (pushed from a Computers card): its status, its projects, and a grouped list of
// everything the phone can do there. Each row shows only when the host serves it (host.hello); project
// tools (Files, Search, Recipes, Run) use the project picked here. While it is offline only Tasks opens.
// With more than one project the bar's folder menu (HeaderActions, so Android draws it too) picks it; on a phone the Project group then just
// names the pick, and tapping it opens the same project menu, while the wide Duo pane also lists them. A Bots group lists
// the computer's bots, each opening its settings (bot-admin.tsx) where the host serves bot.detail.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl } from 'react-native';
import { useHostAllows, useHostCapabilities, useHostSupports } from '../../connect/api/capabilities.ts';
import type { HostProject } from '../../connect/api/files.ts';
import { computerSummary, platformName } from '../../store/inbox.ts';
import { useConnect, useStatus } from '../../store/index.ts';
import { Banner, Group, Row, StatusDot } from '../../ui/ds/index.ts';
import { BOT_DETAIL, botRows, entryParams, hubSections, versionLine, type HubEntry } from '../../ui/hub/entries.ts';
import { AccessNote } from '../../ui/AccessNote.tsx';
import { BotAvatar, openBotSettings } from '../../ui/BotRow.tsx';
import { HeaderActions } from '../../ui/HeaderActions.tsx';
import { Failed, glyph, Loading, ProjectRows, useDeviceTasks, useProjects } from '../../ui/hub/common.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { showActions } from '../../ui/Menu.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../../ui/PushedScroll.tsx';
import { ago } from '../../ui/status.tsx';
import { useSplit } from '../../ui/split.tsx';
import { useColors } from '../../ui/theme.ts';
import { useIconSize } from '../../ui/usePagePadding.ts';
import { useInbox } from '../../ui/useInbox.ts';

/** Projects shown before "All projects"; the rest are in the bar's menu. */
const SHOWN_PROJECTS = 5;

function StatusCard({ device }: { device: string }) {
  const colors = useColors();
  const size = useIconSize(20);
  const row = useConnect(s => s.devices.find(d => d.id === device));
  const caps = useHostCapabilities(device);
  const { connected } = useStatus();
  const { inbox } = useInbox();
  const bots = useConnect(s => s.bots[device]?.length ?? 0);
  // Where the host serves bot.detail the Bots group lists them instead.
  const listed = useHostSupports(device, BOT_DETAIL);
  if (!row) return null;
  const seen = !row.online && row.lastSeen ? ago(row.lastSeen) : '';
  const state = row.online ? 'Online' : seen && seen !== 'now' ? `Last seen ${seen} ago` : 'Offline';
  const summary = computerSummary(inbox, device);
  const link = !connected ? 'Connecting to PandaConnect…' : row.online ? 'Connected through PandaConnect, end-to-end encrypted' : 'Waiting for it to come online';
  return (
    <Group>
      <Row title={row.name} subtitle={`${platformName(row.platform)} · ${state}`} trailing={summary || undefined}
        leading={row.online ? <StatusDot tone="running" size={9} /> : <Icon ios="moon.zzz" android="bedtime" size={size} color={colors.faint} />} />
      {!!versionLine(caps) && <Row title={versionLine(caps)} leading={<Icon ios="app.badge" android="apps" size={size} color={colors.muted} />} />}
      <Row title={link} leading={<Icon ios="lock.shield" android="shield_lock" size={size} color={colors.muted} />} />
      {bots > 0 && !listed && <Row title={`${bots} ${bots === 1 ? 'bot' : 'bots'}`} subtitle="Listed under Bots in the inbox" leading={<Icon ios="person.crop.circle" android="smart_toy" size={size} color={colors.muted} />}
        chevron onPress={() => router.navigate({ pathname: '/inbox', params: { computer: device } })} />}
    </Group>
  );
}

/** The project the bar's folder menu picked, named in the Project group on a phone; a tap opens the
 * same choice of projects as that menu. */
function PickedProject({ project, projects, onPick }: { project?: HostProject; projects: readonly HostProject[]; onPick: (id: string) => void }) {
  const colors = useColors();
  const size = useIconSize(20);
  if (!project) return null;
  const choose = () => showActions('Project', projects.map(p => ({ label: p.name, checked: p.id === project.id, ios: 'folder', android: 'folder', onPress: () => onPick(p.id) })));
  return (
    <Row title={project.name} subtitle={project.repo ?? (project.path || undefined)} chevron onPress={choose}
      leading={<Icon ios="folder" android="folder" size={size} color={colors.muted} />} accessibilityHint="Changes the project" />
  );
}

/** This computer's bots, each opening its settings; hidden where the host lacks bot.detail. */
function BotsGroup({ device, online }: { device: string; online: boolean }) {
  const supported = useHostSupports(device, BOT_DETAIL);
  const allowed = useHostAllows(device, BOT_DETAIL);
  const list = useConnect(s => s.bots[device]);
  const rows = useMemo(() => botRows(list), [list]);
  if (!supported || rows.length === 0) return null;
  const blocked = !online || !allowed;
  return (
    <Group title="Bots">
      <AccessNote device={device} methods={[BOT_DETAIL]} />
      {rows.map(row => (
        <Row key={row.id} title={row.title} subtitle={online ? row.subtitle : 'Opens when the computer is online'} disabled={blocked} chevron
          leading={<BotAvatar bot={row.bot} size={24} />} onPress={() => openBotSettings(device, row.id)} accessibilityHint="Opens the bot's settings" />
      ))}
    </Group>
  );
}

/** Why a project tool is closed with no project chosen: still loading, none on the computer, or pick one. */
function noProjectLabel(projects: readonly unknown[] | undefined, failed: boolean): string {
  if (!projects) return failed ? 'Projects didn’t load' : 'Loading projects…';
  return projects.length ? 'Pick a project above' : 'Add a project first';
}

function EntryRow({ entry, device, project, online, projectsLabel }: { entry: HubEntry; device: string; project: string | null; online: boolean; projectsLabel: string }) {
  const colors = useColors();
  const size = useIconSize(20);
  // Tasks (the inbox) keep their cached list; every other tool needs the computer.
  const offline = !online && entry.key !== 'tasks';
  const blocked = offline || (!!entry.project && !project);
  const open = () => {
    const params = entryParams(entry, device, project);
    if (entry.key === 'tasks') router.navigate({ pathname: '/inbox', params });
    else router.push({ pathname: entry.pathname as never, params });
  };
  return (
    <Row title={entry.title} subtitle={offline ? 'Opens when the computer is online' : blocked ? projectsLabel : entry.subtitle} disabled={blocked} chevron onPress={open}
      leading={<Icon {...glyph(entry.icon)} size={size} color={colors.muted} />} />
  );
}

export default function ComputerHub() {
  const { device = '' } = useLocalSearchParams<{ device: string }>();
  const scroll = usePushedScroll();
  const name = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'Computer');
  const online = useConnect(s => s.devices.find(d => d.id === device)?.online ?? false);
  const caps = useHostCapabilities(device);
  const { projects, error, reload } = useProjects(device);
  const recent = useDeviceTasks(device)[0]?.projectId ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // The project of the newest task, else the first, until the user picks one (while it still exists).
  const chosen = picked && projects?.some(p => p.id === picked) ? picked : null;
  const project = chosen ?? (projects?.some(p => p.id === recent) ? recent : projects?.[0]?.id ?? null);
  const sections = useMemo(() => hubSections(caps), [caps]);
  const ordered = useMemo(() => {
    if (!projects) return [];
    const chosen = projects.find(p => p.id === project);
    return chosen ? [chosen, ...projects.filter(p => p.id !== project)] : projects;
  }, [projects, project]);
  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };
  const menu = !!projects && projects.length > 1;
  // On a phone the folder menu is the one picker; the group shows what it picked.
  const split = useSplit();
  const listed = !menu || split;

  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: name }} />
      <HeaderActions right={[{
        kind: 'menu', label: 'Project', icon: { ios: 'folder', android: 'folder' }, hidden: !menu,
        items: (projects ?? []).map(p => ({ label: p.name, subtitle: p.repo ?? undefined, checked: p.id === project, onPress: () => setPicked(p.id) })),
      }]} />
      <Banner visible={!online} title={`${name} is offline`} body="Its tools open once it is back online." icon={{ ios: 'moon.zzz', android: 'bedtime' }} />
      <StatusCard device={device} />
      {/* Offline first: the list can't arrive, so say so rather than an error (the call failing because
          it's offline) or an endless skeleton. */}
      {!projects ? (!online ? <Group title="Project"><Row title={`Projects load when ${name} is online.`} /></Group>
        : error ? <Failed title="Couldn’t list the projects" error={error} retry={() => void reload()} />
        : <Loading rows={2} />) : projects.length > 0 && (
        <Group title="Project">
          {listed
            ? <ProjectRows projects={ordered} selected={project} onPick={setPicked} max={showAll ? undefined : SHOWN_PROJECTS} />
            : <PickedProject project={ordered[0]} projects={projects} onPick={setPicked} />}
          {listed && projects.length > SHOWN_PROJECTS && (
            <Row title={showAll ? 'Fewer projects' : `All ${projects.length} projects`} onPress={() => setShowAll(v => !v)} />
          )}
        </Group>
      )}
      {sections.map(group => (
        <Group key={group.section} title={group.title}>
          {group.entries.map(entry => <EntryRow key={entry.key} entry={entry} device={device} project={project} online={online} projectsLabel={noProjectLabel(projects, !!error)} />)}
        </Group>
      ))}
      <BotsGroup device={device} online={online} />
    </PushedScroll>
  );
}
