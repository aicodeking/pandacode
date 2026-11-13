// One file of a checkout (?device=&project= or &session=, &path=, optional &line=): text with line
// numbers in one horizontal scroll and a light syntax colouring, more pages as it scrolls (the host
// sends ~96 KB at a time), images inline (tap for full screen), and a note for binary or large files.
// With files.write (Full), Edit turns a small text file into a field; Save sends it with the version
// it started from, and a file changed on the computer meanwhile asks to Reload or Overwrite.
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { readFile, readImage, writeFile, type FileTarget } from '../connect/api/files.ts';
import { outdated } from '../connect/rpc.ts';
import { appendPage, bytesLabel, canEdit, draftProblem, fileName, isDirty, isWriteConflict, savedText, splitLines, startEdit, type EditState, type FilePage, type LoadedText } from '../store/files.ts';
import { Button, Card, EmptyState, geometry, haptic, InnerCard, type } from '../ui/ds/index.ts';
import { CodeView } from '../ui/hub/CodeView.tsx';
import { Failed, glyph, Loading, styles as hub, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { FileEditor } from '../ui/hub/FileEditor.tsx';
import { ImageModal } from '../ui/hub/ImageModal.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { usePaneInsets } from '../ui/split.tsx';
import { useColors } from '../ui/theme.ts';
import { DISCARD_TITLE, useDiscardGuard } from '../ui/useDiscardGuard.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { AccessNote } from '../ui/AccessNote.tsx';

const FILE_ICON = glyph({ ios: 'doc', android: 'draft' });

type State = { kind: 'loading' } | { kind: 'error'; error: string } | { kind: 'text'; loaded: LoadedText } | Exclude<FilePage, { kind: 'text' }>;

function ImagePreview({ device, target, path }: { device: string; target: FileTarget; path: string }) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  /** Bumped by Retry: reads the image again. */
  const [attempt, setAttempt] = useState(0);
  const { projectId, sessionId } = target;
  useEffect(() => {
    let live = true;
    readImage(device, { projectId, sessionId }, path).then(u => { if (live) setUri(u); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [device, projectId, sessionId, path, attempt]);
  if (error) return <Failed title="Couldn’t show this image" error={error} retry={() => { setError(''); setAttempt(a => a + 1); }} />;
  return (
    <Card>
      <InnerCard style={styles.imageFrame}>
        {uri ? (
          <Pressable onPress={() => setOpen(true)} accessibilityRole="imagebutton" accessibilityLabel={`${fileName(path)}, opens full screen`}>
            <Image source={{ uri }} style={styles.image} contentFit="contain" />
          </Pressable>
        ) : <ActivityIndicator style={styles.image} />}
      </InnerCard>
      <ImageModal uri={open ? uri : null} title={fileName(path)} onClose={() => setOpen(false)} />
    </Card>
  );
}

const EDIT_ICON = { ios: 'square.and.pencil', android: 'edit' } as const;
const WRITE_METHODS = ['files.write'] as const;

export default function FileScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string; path: string; line?: string }>();
  const device = params.device ?? '';
  const path = params.path ?? '';
  const target = useMemo<FileTarget>(() => ({ projectId: params.project || undefined, sessionId: params.session || undefined }), [params.project, params.session]);
  const line = Number(params.line) || undefined;
  const scroll = usePushedScroll();
  const colors = useColors();
  const side = usePaneInsets();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'files.read');
  const writable = useHostAllows(device, 'files.write');
  const [edit, setEdit] = useState<EditState>({ mode: 'view' });
  const [notice, setNotice] = useState('');
  const [more, setMore] = useState<{ message: string; changed: boolean } | null>(null);
  const [extended, setExtended] = useState<{ key: string; loaded: LoadedText } | null>(null);
  const loading = useRef(false);
  const key = `${device}/${target.projectId}/${target.sessionId}/${path}`;

  // The first page, then more until a hit's line (?line=) is in.
  const first = useCallback(async (): Promise<Exclude<State, { kind: 'loading' | 'error' }>> => {
    const page = await readFile(device, target, path);
    if (page.kind !== 'text') return page;
    let loaded = appendPage(null, page);
    while (line && !loaded.done && splitLines(loaded.text).length < line) {
      const next = await readFile(device, target, path, loaded.bytes);
      if (next.kind !== 'text') break;
      loaded = appendPage(loaded, next);
    }
    return { kind: 'text', loaded };
  }, [device, target, path, line]);
  const initial = useLoad(supported ? first : null, key);
  const state = useMemo<State>(() => {
    const firstState: State = initial.value ?? (initial.error ? { kind: 'error', error: initial.error } : { kind: 'loading' });
    return firstState.kind === 'text' && extended?.key === key ? { kind: 'text', loaded: extended.loaded } : firstState;
  }, [initial.value, initial.error, extended, key]);
  const retry = () => void initial.reload();

  const loadMore = useCallback(async () => {
    if (state.kind !== 'text' || state.loaded.done || loading.current) return;
    loading.current = true;
    try {
      const page = await readFile(device, target, path, state.loaded.bytes);
      if (page.kind !== 'text') {
        setMore({ message: 'The file changed while loading.', changed: true });
        return;
      }
      setExtended({ key, loaded: appendPage(state.loaded, page) });
      setMore(null);
    } catch (e) {
      setMore({ message: (e as Error).message, changed: false });
    } finally {
      loading.current = false;
    }
  }, [state, device, target, path, key]);
  // A file that changed under the pages already shown starts over; any other failure asks for the page again.
  const retryMore = () => {
    if (!more?.changed) return void loadMore();
    setMore(null);
    setExtended(null);
    retry();
  };

  const lines = useMemo(() => (state.kind === 'text' ? splitLines(state.loaded.text) : []), [state]);

  // ---- edit mode ----
  const dirty = isDirty(edit);
  const toView = () => { setEdit({ mode: 'view' }); setNotice(''); };
  useDiscardGuard(dirty, { message: `Your edits to ${fileName(path)} aren’t saved.`, onDiscard: toView });
  const reloadFromComputer = () => { toView(); setExtended(null); void initial.reload(); };
  const write = async (text: string, base: string) => {
    setEdit(e => (e.mode === 'edit' ? { ...e, saving: true, conflict: false } : e));
    setNotice('');
    try {
      const result = await writeFile(device, target, path, text, base);
      setExtended({ key, loaded: savedText(text, result.hash) });
      toView();
      haptic('success');
    } catch (e) {
      haptic('error');
      const conflict = isWriteConflict(e);
      setEdit(current => (current.mode === 'edit' ? { ...current, saving: false, conflict } : current));
      if (conflict) askConflict(text);
      else setNotice((e as Error).message);
    }
  };
  const overwrite = async (text: string) => {
    try {
      const latest = await readFile(device, target, path);
      if (latest.kind !== 'text' || !latest.hash) throw new Error('The file on the computer can no longer be edited here.');
      await write(text, latest.hash);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const askConflict = (text: string) => Alert.alert('Changed on the computer', `${fileName(path)} changed on ${computer} since you started editing.`, [
    { text: 'Keep Editing', style: 'cancel' },
    { text: 'Reload', onPress: reloadFromComputer },
    { text: 'Overwrite', style: 'destructive', onPress: () => void overwrite(text) },
  ]);
  const save = () => {
    if (edit.mode !== 'edit' || edit.saving) return;
    const problem = draftProblem(edit.draft);
    if (problem) { setNotice(problem); return; }
    if (!dirty) { toView(); return; }
    void write(edit.draft, edit.base);
  };
  const cancel = () => {
    if (!dirty) { toView(); return; }
    Alert.alert(DISCARD_TITLE, undefined, [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: toView },
    ]);
  };
  const fits = state.kind === 'text' && canEdit(state.loaded);
  const editable = writable && state.kind === 'text' && canEdit(state.loaded) ? state.loaded : null;

  const title = fileName(path);
  // Not editing: the back button and no Cancel or Save (Android keeps a side's views until they're set
  // again, hence the explicit empty sides); `sidebar` keeps the Duo's sidebar toggle beside the back button.
  const headerTitle = <><Stack.Screen options={{ ...PUSHED_HEADER, title, headerBackVisible: true }} /><HeaderActions left={[]} right={[]} sidebar /></>;
  const page = (children: React.ReactNode) => <PushedScroll scroll={scroll}>{headerTitle}{children}</PushedScroll>;

  if (!supported) return page(<EmptyState icon={FILE_ICON} title={outdated(computer)} style={hub.empty} />);
  if (state.kind === 'loading') return page(<Loading rows={8} />);
  if (state.kind === 'error') return page(<Failed title="Couldn’t open this file" error={state.error} retry={retry} />);
  if (state.kind === 'image') return page(<ImagePreview device={device} target={target} path={path} />);
  if (state.kind !== 'text' && state.kind === 'binary') return page(<EmptyState icon={FILE_ICON} title="This file isn’t text" body="Binary files can’t be shown on the phone." style={hub.empty} />);
  if (state.kind !== 'text') return page(<EmptyState icon={FILE_ICON} title="This file is too large to preview" body={`${state.message} Open it in PandaCode on ${computer}.`} style={hub.empty} />);

  const { loaded } = state;
  if (edit.mode === 'edit') {
    return (
      <>
        <Stack.Screen options={{ ...PUSHED_HEADER, title, headerBackVisible: false }} />
        <HeaderActions left={[{ label: 'Cancel', disabled: edit.saving, onPress: cancel }]} right={[{ label: edit.saving ? 'Saving…' : 'Save', primary: true, disabled: edit.saving, onPress: save }]} />
        <FileEditor value={edit.draft} onChange={draft => setEdit(e => (e.mode === 'edit' ? { ...e, draft } : e))} editable={!edit.saving}
          notice={edit.conflict ? `Changed on ${computer}. Save again to reload or overwrite.` : notice} insets={side} label={`Contents of ${title}`} />
      </>
    );
  }
  const footer = (
    <View style={styles.footer}>
      {/* Why there is no Edit: this phone's grant (or the computer's switch) keeps files.write off. */}
      {fits && !writable && <AccessNote device={device} methods={WRITE_METHODS} style={styles.access} />}
      {loaded.done
        ? <Text style={[type.footnote, { color: colors.faint }]}>{`${lines.length} lines · ${bytesLabel(loaded.total)}`}</Text>
        : more ? (
          <View style={styles.more}>
            <Text style={[type.footnote, { color: colors.danger }]}>{more.message}</Text>
            <Button label={more.changed ? 'Reload' : 'Retry'} size="small" onPress={retryMore} />
          </View>
        )
        : <ActivityIndicator />}
    </View>
  );
  return (
    <>
      <Stack.Screen options={{ ...PUSHED_HEADER, title, headerBackVisible: true }} />
      <HeaderActions left={[]} sidebar right={[{ label: `Edit ${title}`, icon: EDIT_ICON, hidden: !editable, onPress: () => editable && setEdit(startEdit(editable)) }]} />
      <CodeView lines={lines} path={path} focus={line} insets={side} footer={footer} onEndReached={() => void loadMore()}
        scrollHandler={scroll.onScroll} onLayout={scroll.edge.onLayout} onContentSizeChange={scroll.edge.onContentSizeChange} />
    </>
  );
}

const styles = StyleSheet.create({
  imageFrame: { padding: geometry.cardPadding },
  image: { width: '100%', aspectRatio: 4 / 3 },
  footer: { paddingVertical: geometry.sectionGap * 2, paddingHorizontal: geometry.rowInset, alignItems: 'flex-start', gap: geometry.sectionGap },
  access: { alignSelf: 'stretch' },
  more: { gap: geometry.cardPadding / 2, alignItems: 'flex-start' },
});
