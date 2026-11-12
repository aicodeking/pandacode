// The GitHub item screen's parts (src/app/github-item.tsx): a pull request's checks, a run's jobs
// (each folds open to its steps and summary), earlier attempts and artifacts, and the comment box.
import { useState } from 'react';
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ItemCheck, RunDetail, RunJob } from '../../connect/api/github.ts';
import { Button, CardSection, Chevron, Collapse, Group, Row, type as text } from '../ds/index.ts';
import { Markdown } from '../Markdown.tsx';
import { useColors } from '../theme.ts';
import { useDiscardGuard } from '../useDiscardGuard.ts';
import { BadgeChip } from './Rows.tsx';
import { age, checkBadge, checksLine, isWebUrl, runBadge, safeMarkdown } from './model.ts';

const COMMENT_HEIGHT = 96;

export function Checks({ checks }: { checks: readonly ItemCheck[] }) {
  if (!checks.length) return null;
  return (
    <CardSection title="Checks" trailing={<Meta>{checksLine(checks)}</Meta>}>
      {checks.map((check, i) => (
        <Row key={`${check.name}${i}`} title={check.name || 'Check'} subtitle={check.workflow || undefined} trailing={<BadgeChip badge={checkBadge(check.state)} />}
          disabled={!isWebUrl(check.url)} onPress={isWebUrl(check.url) ? () => void Linking.openURL(check.url) : undefined} />
      ))}
    </CardSection>
  );
}

function Meta({ children }: { children: string }) {
  const colors = useColors();
  return <Text numberOfLines={1} style={[text.footnote, { color: colors.muted }]}>{children}</Text>;
}

function Job({ job }: { job: RunJob }) {
  const colors = useColors();
  const [open, setOpen] = useState(job.state === 'failed');
  const hasMore = job.steps.length > 0 || !!job.summary.trim();
  return (
    <View>
      <Row title={job.name} trailing={<View style={styles.trail}><BadgeChip badge={runBadge(job.state)} />{hasMore && <Chevron expanded={open} />}</View>}
        onPress={hasMore ? () => setOpen(!open) : undefined} accessibilityState={hasMore ? { expanded: open } : undefined} />
      <Collapse expanded={open}>
        <View style={styles.steps}>
          {job.steps.map((step, i) => (
            <View key={`${step.name}${i}`} style={styles.step}>
              <Text numberOfLines={2} style={[text.subhead, styles.fill, { color: colors.text }]}>{step.name}</Text>
              <BadgeChip badge={runBadge(step.state)} />
            </View>
          ))}
          {!!job.summary.trim() && <View style={styles.summary}><Markdown text={safeMarkdown(job.summary)} /></View>}
          {isWebUrl(job.url) && <Button label="Open job log" size="small" variant="plain" icon={{ ios: 'arrow.up.right', android: 'north_east' }} onPress={() => void Linking.openURL(job.url)} />}
        </View>
      </Collapse>
    </View>
  );
}

export function RunJobs({ run }: { run: RunDetail }) {
  return (
    <>
      <CardSection title="Jobs" trailing={<Meta>{String(run.jobs.length)}</Meta>}>
        {run.jobs.map(job => <Job key={job.id} job={job} />)}
      </CardSection>
      {run.attempts.length > 0 && (
        <CardSection title="Earlier attempts">
          {run.attempts.map(attempt => (
            <Row key={attempt.attempt} title={`Attempt ${attempt.attempt}`} subtitle={age(attempt.startedAt) ? `${age(attempt.startedAt)} ago` : undefined}
              trailing={<BadgeChip badge={runBadge(attempt.state)} />} disabled={!isWebUrl(attempt.url)} onPress={isWebUrl(attempt.url) ? () => void Linking.openURL(attempt.url) : undefined} />
          ))}
        </CardSection>
      )}
      {run.artifacts.length > 0 && (
        <CardSection title="Artifacts">
          {run.artifacts.map(artifact => <Row key={artifact.name} title={artifact.name} trailing={<Meta>{artifact.expired ? 'Expired' : size(artifact.size)}</Meta>} />)}
        </CardSection>
      )}
    </>
  );
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

/** A comment field and Comment button; `onSend` throws to keep the text. */
export function CommentBox({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const colors = useColors();
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const release = useDiscardGuard(!!body.trim(), { message: 'Your comment isn’t posted.' });
  const send = async () => {
    setSending(true);
    try {
      await onSend(body.trim());
      release();
      setBody('');
    } catch {
      // The caller showed the error; the text stays for another try.
    } finally {
      setSending(false);
    }
  };
  return (
    <Group title="Comment" footer={<Text style={[text.footnote, { color: colors.muted }]}>Posted on GitHub as the computer’s GitHub CLI account.</Text>}>
      <TextInput value={body} onChangeText={setBody} placeholder="Leave a comment" placeholderTextColor={colors.faint} multiline editable={!sending}
        style={[text.body, styles.comment, { color: colors.text }]} accessibilityLabel="Comment" />
      <View style={styles.send}>
        <Button label={sending ? 'Commenting…' : 'Comment'} size="small" variant="primary" loading={sending} disabled={!body.trim() || sending} onPress={() => void send()} />
      </View>
    </Group>
  );
}

const styles = StyleSheet.create({
  trail: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  steps: { paddingHorizontal: 12, paddingBottom: 10, gap: 6 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10 },
  fill: { flex: 1, minWidth: 0 },
  summary: { paddingTop: 4 },
  comment: { minHeight: COMMENT_HEIGHT, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, textAlignVertical: 'top' },
  send: { alignItems: 'flex-end', paddingHorizontal: 10, paddingBottom: 6 },
});
