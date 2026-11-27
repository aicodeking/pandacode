// Council on a phone: the card that says where the reviewers stand and offers exactly what this
// state allows (Keep fixing, Accept and finish, Lower target, Raise max rounds), and the settings
// sheet that turns Council on or changes it. Native's `councilStatus` decides everything shown here
// (src/store/team.ts councilView/councilActions), so the phone never guesses a state.
//
// This is the card a lead means when it says "press Accept and finish on the Council card": without
// it a phone user was told to press a button the app did not have.
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { acceptCouncil, setCouncil } from '../connect/api/team.ts';
import { connect } from '../connect/client.ts';
import { blockedNote, type Blocked } from '../connect/api/hello.ts';
import { COUNCIL_DEFAULTS, COUNCIL_REVIEWERS, COUNCIL_ROUNDS, COUNCIL_TARGETS, KEEP_FIXING, councilActions, councilCardShown, councilNotice, councilSeats, councilView, formatScore, seatVerdict, type CouncilConfig, type CouncilSeat, type Team, type TeamWorker } from '../store/team.ts';
import { showActions } from './Menu.tsx';
import { Button, geometry, haptic, InnerCard, PressScale, showToast, type as text } from './ds/index.ts';
import { Glass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { useColors } from './theme.ts';

/** A score to one decimal, as every Council surface shows it. */
const score = (value: number) => formatScore(value);

/** The target menu: only settings below the current one, so Lower target always lowers. */
function lowerOptions(config: CouncilConfig): CouncilConfig[] {
  return COUNCIL_TARGETS.filter(target => target < config.target).map(target => ({ ...config, target }));
}

/** Raise max rounds: only limits above the ones this cycle already used. */
function raiseOptions(config: CouncilConfig, round: number): CouncilConfig[] {
  return COUNCIL_ROUNDS.filter(rounds => rounds > Math.max(round, config.maxRounds)).map(maxRounds => ({ ...config, maxRounds }));
}

interface Props {
  deviceId: string;
  sessionId: string;
  team: Team | null | 'outdated' | undefined;
  /** Why this phone can't change Council there ('outdated' | 'access' | 'switch'), else null. */
  blocked: Blocked | null;
  computer: string;
  /** Set while the team runs: Keep fixing waits for it to stop. */
  running: boolean;
}

/** Runs one Council call with a busy key, a haptic and an inline error the card shows. */
function useCouncilAction(deviceId: string, sessionId: string) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError('');
    haptic('light');
    try {
      await work();
      haptic('success');
    } catch (e) {
      haptic('error');
      setError((e as Error).message || 'That did not go through.');
    } finally {
      setBusy('');
    }
  };
  return { busy, error, run };
}

/** One reviewer: its lens, its score and whether that clears the target. */
function Seat({ seat, target }: { seat: TeamWorker & { council: CouncilSeat }; target: number }) {
  const colors = useColors();
  const verdict = seatVerdict(seat.council, target);
  const tone = verdict.tone === 'at' ? colors.success : verdict.tone === 'below' ? colors.warning : colors.muted;
  return (
    <View style={styles.seat} accessible accessibilityLabel={`${seat.council.lens || seat.name}, ${verdict.text}`}>
      {/* Shape as well as colour: a scored seat is a tick or a mark, an unscored one a quiet ring. */}
      <Icon ios={verdict.tone === 'at' ? 'checkmark.circle.fill' : verdict.tone === 'below' ? 'exclamationmark.circle.fill' : 'circle'} android={verdict.tone === 'at' ? 'check_circle' : verdict.tone === 'below' ? 'error' : 'radio_button_unchecked'} size={13} color={tone} />
      <Text numberOfLines={1} style={[text.footnote, styles.seatLens, { color: colors.text }]}>{seat.council.lens.trim() || seat.name}</Text>
      <Text style={[text.footnote, { color: tone }]}>{seat.council.score === null ? '—' : score(seat.council.score)}</Text>
    </View>
  );
}

/**
 * The Council card, inside the task's dock above the composer. Renders nothing unless Council is on
 * and has something to say; a settled cycle can be dismissed for the session with its ×.
 */
export function CouncilCard({ deviceId, sessionId, team, blocked, computer, running }: Props) {
  const colors = useColors();
  const { busy, error, run } = useCouncilAction(deviceId, sessionId);
  // The × hides a settled card for this session. A state that needs the user (asking) overrides it:
  // the whole point of the card is to be the button a lead's message points at.
  const [closed, setClosed] = useState(false);
  const view = councilView(team);
  const actions = councilActions(team);
  if (!view || (closed && !actions.accept && !actions.keep) || !councilCardShown(team)) return null;
  const seats = councilSeats(team);
  const notice = councilNotice(team);
  // A blocked phone reads why instead of pressing a button that would be refused.
  const note = blocked ? blockedNote(blocked, computer) : '';
  const can = !note;
  const busyKey = busy;
  const change = (config: CouncilConfig, key: string) => run(key, () => setCouncil(deviceId, sessionId, config));
  const accept = () => run('accept', () => acceptCouncil(deviceId, sessionId));
  // Keep fixing is an ordinary follow-up to the lead, sent the way a queued message is, so the
  // composer's draft and attachments are never touched.
  const keep = () => run('keep', () => connect.sendMessage(deviceId, sessionId, KEEP_FIXING));
  const ask = (title: string, options: CouncilConfig[], key: string) => {
    if (!options.length) return;
    showActions(title, options.map(option => ({
      label: key === 'lower' ? `Target ${formatScore(option.target)}` : `${option.maxRounds} rounds`,
      onPress: () => void change(option, key),
    })));
  };
  return (
    <Glass style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.heading}>
        <Icon ios="scalemass" android="balance" size={15} color={colors.team} />
        <Text accessibilityRole="header" numberOfLines={2} style={[text.subhead, styles.headingText, { color: colors.muted }]}>{`Council · ${view.line}`}</Text>
        <PressScale onPress={() => { haptic('selection'); setClosed(true); }} accessibilityLabel="Dismiss Council" hitSlop={10} style={styles.dismiss}>
          <Icon ios="xmark" android="close" size={12} color={colors.faint} />
        </PressScale>
      </View>
      {!!notice && actions.keep && (
        <View style={styles.body}>
          <Markdown text={notice} />
        </View>
      )}
      <Text style={[text.footnote, styles.body, { color: colors.muted }]}>
        {view.lowest === null ? `Target ${score(view.target)}` : `Lowest ${score(view.lowest)} · target ${score(view.target)}${view.status.stale ? ' · work changed since' : ''}`}
      </Text>
      {seats.length > 0 && (
        <InnerCard style={[styles.seats, { backgroundColor: colors.fill, borderColor: colors.border }]}>
          {seats.map(seat => <Seat key={seat.id} seat={seat} target={view.target} />)}
        </InnerCard>
      )}
      {!!(error || note) && (
        <Text style={[text.footnote, styles.body, { color: error ? colors.danger : colors.muted }]} accessibilityRole="alert">{error || note}</Text>
      )}
      {(actions.accept || actions.keep || actions.lower || actions.raise) && (
        <View style={styles.actions}>
          {actions.raise && <Button size="small" label="Raise max rounds" loading={busyKey === 'raise'} disabled={!can || !!busy} onPress={() => ask('Raise max rounds', raiseOptions(view.config, view.status.round), 'raise')} />}
          {actions.lower && <Button size="small" label="Lower target" loading={busyKey === 'lower'} disabled={!can || !!busy} onPress={() => ask('Lower target', lowerOptions(view.config), 'lower')} />}
          {actions.keep && <Button size="small" variant="raised" label="Keep fixing" loading={busyKey === 'keep'} disabled={!can || running || !!busy} onPress={keep} />}
          {actions.accept && <Button size="small" variant="primary" label="Accept and finish" loading={busyKey === 'accept'} disabled={!can || !!busy} onPress={accept} />}
        </View>
      )}
      {actions.keep && running && <Text style={[text.caption, styles.body, { color: colors.muted }]}>Stop the run first, then Keep fixing.</Text>}
    </Glass>
  );
}

/**
 * Council's settings: on or off and the three values, reachable from the task's More menu. Turning
 * it off is `council: null`; any change takes effect at once, even mid-run.
 */
export function openCouncilSettings(deviceId: string, sessionId: string, team: Team | null | 'outdated' | undefined, note: string | null) {
  if (note) return void Alert.alert('Not available from this phone', note);
  const current = (team && team !== 'outdated' ? team.council : null) ?? null;
  const config = current ?? COUNCIL_DEFAULTS;
  const save = (next: CouncilConfig | null, done: string) => {
    setCouncil(deviceId, sessionId, next).then(
      () => { haptic('success'); showToast({ title: done, tone: 'success' }); },
      (e: Error) => { haptic('error'); Alert.alert('Council was not changed', e.message); },
    );
  };
  const items: { label: string; checked?: boolean; onPress: () => void }[] = [
    { label: current ? 'Council on' : 'Council off', checked: !current, onPress: () => save(null, 'Council is off') },
    ...COUNCIL_TARGETS.map(target => ({ label: `Target ${formatScore(target)}`, checked: config.target === target, onPress: () => save({ ...config, target }, `Target set to ${formatScore(target)}`) })),
    ...COUNCIL_ROUNDS.map(maxRounds => ({ label: `${maxRounds} rounds`, checked: config.maxRounds === maxRounds, onPress: () => save({ ...config, maxRounds }, `Max rounds set to ${maxRounds}`) })),
    ...COUNCIL_REVIEWERS.map(reviewers => ({ label: reviewers ? `${reviewers} reviewers` : 'Reviewers: Auto', checked: config.reviewers === reviewers, onPress: () => save({ ...config, reviewers }, reviewers ? `${reviewers} reviewers` : 'Reviewers set to Auto') })),
  ];
  showActions('Council', items);
}

const styles = StyleSheet.create({
  card: { borderRadius: geometry.cardRadius, borderWidth: geometry.hairline, padding: geometry.cardPadding, marginHorizontal: geometry.screenMargin, gap: 8, borderCurve: 'continuous' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30, paddingHorizontal: 6 },
  headingText: { flex: 1 },
  dismiss: { minWidth: 28, minHeight: 28, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 6 },
  seats: { paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  seat: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 },
  seatLens: { flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingTop: 2 },
});
