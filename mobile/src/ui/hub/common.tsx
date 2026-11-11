// Pieces the computer hub and its tool screens share: loading and error states, the computer's
// name, its projects (projects.list, else the inbox's), and pickers for a project or a task.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { useHostSupports } from '../../connect/api/capabilities.ts';
import { listProjects, type HostProject } from '../../connect/api/files.ts';
import type { TaskSummary } from '../../connect/types.ts';
import { useConnect } from '../../store/index.ts';
import { Card, CardSection, EmptyState, geometry, InnerCard, Row, Skeleton, type IconName } from '../ds/index.ts';
import { Icon } from '../Icon.tsx';
import { useColors } from '../theme.ts';
import { useIconSize } from '../usePagePadding.ts';
import { useReloadOnReconnect } from '../useReloadOnReconnect.ts';

export const ERROR_ICON: IconName = { ios: 'exclamationmark.triangle', android: 'warning' };
export const glyph = (icon: { ios: string; android: string }) => icon as IconName;

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <Card>
      <InnerCard style={styles.loading}>
        {Array.from({ length: rows }, (_, i) => <Skeleton key={i} width={`${80 - (i % 3) * 15}%`} />)}
      </InnerCard>
    </Card>
  );
}

export function Failed({ title, error, retry }: { title: string; error: string; retry?: () => void }) {
  return <EmptyState icon={ERROR_ICON} title={title} body={error} action={retry && { label: 'Retry', onPress: retry }} style={styles.empty} />;
}

/** A card of rows: Card > InnerCard, the content screens' grammar. */
export function RowsCard({ children }: { children: ReactNode }) {
  return <Card><InnerCard>{children}</InnerCard></Card>;
}

export const useComputerName = (device: string) => useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');

/** The computer a load's key is for: every caller's key leads with the device id (`device/…`, `device:…`). */
export const keyDevice = (key: string) => key.split(/[/:]/, 1)[0] ?? '';


/** An async load with its error and a reload; `key` changes start over, and so does the computer
 * coming back online (`device`, by default the key's leading id). While a load runs after a failure
 * (Retry), the error clears so screens show their loading state instead of the stale failure. */
export function useLoad<T>(load: (() => Promise<T>) | null, key: string, device: string = keyDevice(key)) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string; loading?: boolean }>({ key });
  const run = useCallback(async () => {
    if (!load) return;
    setState(s => (s.key === key ? { key, value: s.value, loading: true } : { key, loading: true }));
    try {
      const value = await load();
      setState({ key, value });
    } catch (e) {
      setState(s => ({ key, value: s.key === key ? s.value : undefined, error: (e as Error).message }));
    }
  }, [load, key]);
  useEffect(() => { void run(); }, [run]);
  useReloadOnReconnect(device, run);
  const current = state.key === key ? state : { key, loading: !!load };
  return { value: current.value, error: current.error, loading: !!current.loading, reload: run };
}

/** The computer's projects: projects.list where served, else the ones its tasks are in. */
export function useProjects(device: string) {
  const served = useHostSupports(device, 'projects.list');
  const fallback = useConnect(s => s.tasks[device]?.projects);
  const load = useCallback(() => listProjects(device), [device]);
  const { value, error, reload } = useLoad(served ? load : null, `${device}:${served}`);
  const projects = useMemo<HostProject[] | undefined>(() => {
    if (served) return value;
    return fallback?.map((p, i) => ({ id: p.id, name: p.name, repo: p.repo, path: '', chat: false, addedOrder: i }));
  }, [served, value, fallback]);
  return { projects, error: served ? error : undefined, reload };
}

/** The computer's tasks, newest first, optionally in one project; bot threads left out. */
export function useDeviceTasks(device: string, projectId?: string): TaskSummary[] {
  const tasks = useConnect(s => s.tasks[device]?.tasks);
  return useMemo(() => (tasks ?? []).filter(t => !t.botId && (!projectId || t.projectId === projectId)), [tasks, projectId]);
}

export function ProjectRows({ projects, selected, onPick, max }: { projects: readonly HostProject[]; selected?: string | null; onPick: (id: string) => void; max?: number }) {
  const colors = useColors();
  const size = useIconSize(20);
  const shown = max ? projects.slice(0, max) : projects;
  return shown.map(p => (
    <Row key={p.id} title={p.name} subtitle={p.repo ?? (p.path || undefined)} onPress={() => onPick(p.id)}
      leading={<Icon ios={p.chat ? 'bubble.left' : 'folder'} android={p.chat ? 'chat_bubble' : 'folder'} size={size} color={colors.muted} />}
      trailing={p.id === selected ? <Icon ios="checkmark" android="check" size={16} color={colors.text} /> : undefined}
      accessibilityState={{ selected: p.id === selected }} />
  ));
}

/** "Choose a project" for a project tool opened without one. */
export function ProjectPicker({ device, onPick, purpose }: { device: string; onPick: (id: string) => void; purpose: string }) {
  const { projects, error, reload } = useProjects(device);
  if (error && !projects) return <Failed title="Couldn’t list the projects" error={error} retry={() => void reload()} />;
  if (!projects) return <Loading />;
  if (!projects.length) return <EmptyState icon={glyph({ ios: 'folder', android: 'folder' })} title="No projects yet" body="Add a project in PandaCode on the computer." style={styles.empty} />;
  return <CardTitled title={purpose}><ProjectRows projects={projects} onPick={onPick} /></CardTitled>;
}

/** "Choose a task" for a task tool opened without one. */
export function TaskPicker({ device, projectId, onPick, purpose, selected }: { device: string; projectId?: string; onPick: (id: string) => void; purpose: string; selected?: string }) {
  const colors = useColors();
  const size = useIconSize(20);
  const tasks = useDeviceTasks(device, projectId).slice(0, 30);
  if (!tasks.length) return <EmptyState icon={glyph({ ios: 'tray', android: 'inbox' })} title="No tasks here yet" body="Start a task first." style={styles.empty} />;
  return (
    <CardTitled title={purpose}>
      {tasks.map(t => (
        <Row key={t.sessionId} title={t.title || 'Untitled task'} subtitle={[t.projectName, t.branch].filter(Boolean).join(' · ')} onPress={() => onPick(t.sessionId)}
          leading={<Icon ios="text.bubble" android="chat" size={size} color={colors.muted} />}
          trailing={t.sessionId === selected ? <Icon ios="checkmark" android="check" size={16} color={colors.text} /> : undefined}
          accessibilityState={{ selected: t.sessionId === selected }} />
      ))}
    </CardTitled>
  );
}

export function CardTitled({ title, trailing, footer, children }: { title: string; trailing?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return <CardSection title={title} trailing={trailing} footer={footer}>{children}</CardSection>;
}

export const styles = StyleSheet.create({
  loading: { padding: geometry.rowInset, gap: 14 },
  empty: { marginTop: geometry.emptyTop },
  gap: { gap: geometry.sectionGap },
});
