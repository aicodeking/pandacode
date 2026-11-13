import test from 'node:test';
import assert from 'node:assert/strict';

// The pure half of crash recovery: what the native answer means and what the notice says.
const { parseCrashRecovery, plainCause, crashTime, crashNotice, anyInterruptedByCrash, interruptedByCrash, INTERRUPTED_WINDOW, INTERRUPTED_LINE, INTERRUPTED_SHORT, REPORT_LINE, PAUSED_LEAD, pausedLine, resumeTime, notRestartedLead, RESTARTS_OFF_LINE, TITLE_LIMIT, NOTICE_LIMIT, MIN_TITLE, RESUME_WINDOW, WINDOW_RELOADED_LINE, WINDOW_RELOADED_AGAIN_LINE, WINDOW_STOPPED_BEFORE_LINE, NOTHING_OPENED_LINE, NO_THREAD_OPENED, pausedLead, untilNextDay, heldBackLine, shortTitle, reloadNotice, openThreadName, OPEN_THREAD, RESTARTS_BACK_LINE, AGENTS_STOPPED_LINE, REPORT_SHORT, PAUSED_REPORT_LINE, PAUSED_REPORT_SHORT, PAUSED_NOTICE_LIMIT, RESUMED_NOTICE_LIMIT, keptClosedLine, resumesAt } = await import('../src/crash-recovery-model.ts');

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
/** The notice's time for a crash `ago` ms before NOW. */
const at = (ago = 5_000) => crashTime(NOW - ago, NOW);
/** The paused closing line for a crash `ago` ms before NOW. */
const resume = (ago = 60_000) => pausedLine(resumeTime(NOW - ago, NOW));
/** The limit a notice for `r` must keep: paused notices have their own. */
const limitOf = r => resumedAt(r) ? RESUMED_NOTICE_LIMIT : r?.restartsPaused ? PAUSED_NOTICE_LIMIT : NOTICE_LIMIT;
/** A paused notice past RESUME_WINDOW: restarts are on again. */
const resumedAt = r => Boolean(r?.restartsPaused) && NOW - r.crashedAt > RESUME_WINDOW;
const recovery = (overrides = {}) => ({ crashedAt: NOW - 5_000, summary: null, hasReport: false, restarted: true, restartsPaused: false, ...overrides });

test('no recovery or a malformed answer shows nothing', () => {
  assert.equal(parseCrashRecovery(null), null);
  assert.equal(parseCrashRecovery(undefined), null);
  assert.equal(parseCrashRecovery('crashed'), null);
  assert.equal(parseCrashRecovery({ crashedAt: 'yesterday', hasReport: true, restarted: true, restartsPaused: false }), null);
  assert.equal(parseCrashRecovery({ crashedAt: NOW, hasReport: 'yes', restarted: true, restartsPaused: false }), null);
  assert.equal(parseCrashRecovery({ crashedAt: -1, hasReport: false, restarted: true, restartsPaused: false }), null);
  // `restarted` is required: an older guard's answer cannot say whether a restart happened.
  assert.equal(parseCrashRecovery({ crashedAt: NOW, hasReport: false, restartsPaused: false }), null);
});

test('a well-formed answer is kept, with a non-string summary dropped', () => {
  assert.deepEqual(parseCrashRecovery({ crashedAt: NOW, summary: 'Crashed with SIGSEGV', hasReport: true, restarted: false, restartsPaused: false }),
    { crashedAt: NOW, summary: 'Crashed with SIGSEGV', hasReport: true, restarted: false, restartsPaused: false });
  assert.deepEqual(parseCrashRecovery({ crashedAt: NOW, summary: 42, hasReport: false, restarted: false, restartsPaused: true }),
    { crashedAt: NOW, summary: null, hasReport: false, restarted: false, restartsPaused: true });
});

test('agentsInterrupted is kept when it is a boolean and dropped otherwise, never failing the answer', () => {
  const base = { crashedAt: NOW, summary: null, hasReport: false, restarted: true, restartsPaused: false };
  assert.equal(parseCrashRecovery({ ...base, agentsInterrupted: true }).agentsInterrupted, true);
  assert.equal(parseCrashRecovery({ ...base, agentsInterrupted: false }).agentsInterrupted, false);
  assert.ok(!('agentsInterrupted' in parseCrashRecovery({ ...base, agentsInterrupted: 'yes' })));
  assert.ok(!('agentsInterrupted' in parseCrashRecovery(base)), 'an older guard leaves it out');
});

test('the native agentsInterrupted decides when given; only when absent does the task list', () => {
  const crashedAt = NOW - 10_000;
  const cutOff = [{ status: 'interrupted', archived: false, updatedAt: crashedAt - 60_000, lastPromptAt: null }];
  assert.equal(interruptedByCrash(recovery({ crashedAt, agentsInterrupted: false }), cutOff), false, 'a task left Interrupted by an earlier quit never makes this crash claim it stopped agents');
  assert.equal(interruptedByCrash(recovery({ crashedAt, agentsInterrupted: false }), []), false);
  assert.equal(interruptedByCrash(recovery({ crashedAt, agentsInterrupted: true }), []), true);
  assert.equal(interruptedByCrash(recovery({ crashedAt }), cutOff), true);
  assert.equal(interruptedByCrash(recovery({ crashedAt }), []), false);
});

test('the cause is plain: the signal or exception name, and nothing for a panic or anything else', () => {
  assert.equal(plainCause(null), null);
  assert.equal(plainCause('Panic: index out of bounds at /Users/alex/src/lib.rs:12'), null);
  assert.equal(plainCause('Crashed with SIGSEGV'), 'a memory error (SIGSEGV)');
  assert.equal(plainCause('Crashed with SIGBUS'), 'a memory error (SIGBUS)');
  assert.equal(plainCause('Crashed with SIGABRT\n'), 'a fatal error (SIGABRT)');
  assert.equal(plainCause('Crashed with SIGILL'), 'an invalid instruction (SIGILL)');
  assert.equal(plainCause('Crashed with SIGFPE'), 'a math error (SIGFPE)');
  assert.equal(plainCause('Crashed with SIGXCPU'), 'an unexpected signal (SIGXCPU)');
  // The guard never reports a forced stop or a stop request as a crash: no phrase makes one read like it.
  for (const name of ['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) assert.equal(plainCause(`Crashed with ${name}`), `an unexpected signal (${name})`);
  assert.equal(plainCause('Crashed with signal 99'), null);
  assert.equal(plainCause('Crashed with an access violation'), 'an access violation');
  assert.equal(plainCause('Crashed with exception 0xC0000135'), null);
  assert.equal(plainCause('Crashed with <img src=x onerror=alert(1)>'), null);
  assert.equal(plainCause('something else entirely'), null);
});

test('the crash time is a clock time, with the date when it was not today and the year when not this year', () => {
  const now = new Date(2026, 10, 12, 16, 5).getTime();
  assert.equal(crashTime(new Date(2026, 10, 12, 14, 32).getTime(), now, 'en-US'), 'at 2:32 PM');
  assert.equal(crashTime(new Date(2026, 10, 12, 14, 32).getTime(), now, 'en-GB'), 'at 14:32');
  assert.equal(crashTime(new Date(2026, 10, 11, 23, 59).getTime(), now, 'en-US'), 'on Nov 11 at 11:59 PM');
  assert.equal(crashTime(new Date(2025, 10, 3, 9, 0).getTime(), now, 'en-GB'), 'on 3 Nov 2025 at 9:00');
  // It never goes stale: the same words an hour or a day later.
  const later = crashNotice(recovery({ crashedAt: now - 60_000 }), now + 60 * 60_000, quiet).text;
  assert.equal(later, crashNotice(recovery({ crashedAt: now - 60_000 }), now, quiet).text);
  assert.doesNotMatch(later, /just now|ago/);
});

const quiet = { interrupted: false };
const sentences = text => text.split(/(?<=[.!?])\s+(?=[A-Z])/).length;

test('an automatic restart says so and when, leaving the cause to the report', () => {
  const plain = crashNotice(recovery(), NOW, quiet);
  assert.equal(plain.text, `PandaCode crashed ${at()} and restarted.`);
  assert.equal(plain.showReport, false);
  assert.ok(!('holdMs' in plain), 'the notice stays until the user closes it');
  const panic = crashNotice(recovery({ summary: 'Panic: boom', hasReport: true, crashedAt: NOW - 2 * 60_000 }), NOW, quiet);
  assert.equal(panic.text, `PandaCode crashed ${at(2 * 60_000)} and restarted.`);
  assert.equal(panic.showReport, true);
  const caused = crashNotice(recovery({ summary: 'Crashed with SIGSEGV', crashedAt: NOW - 2 * 60_000 }), NOW, quiet);
  assert.equal(caused.text, `PandaCode crashed ${at(2 * 60_000)} and restarted.`);
  for (const { recovery: r, text } of everyNotice()) if (r?.restarted) assert.doesNotMatch(text, /Cause:/, text);
});

test('without a relaunch the notice never claims a restart, and says when the Settings switch is off', () => {
  const crash = recovery({ restarted: false, summary: 'Crashed with SIGSEGV', crashedAt: NOW - 3 * 60 * 60_000 });
  const notice = crashNotice(crash, NOW, { interrupted: true });
  assert.equal(notice.text, `${notRestartedLead(at(3 * 60 * 60_000))} Cause: a memory error (SIGSEGV). ${INTERRUPTED_LINE}`);
  assert.doesNotMatch(notice.text, /restarted/);
  assert.equal(RESTARTS_OFF_LINE, 'Automatic restarts are off in Settings.');
  assert.equal(crashNotice(crash, NOW, { interrupted: false, restartsOff: true }).text, `PandaCode crashed ${at(3 * 60 * 60_000)}. Cause: a memory error (SIGSEGV). ${RESTARTS_OFF_LINE}`);
  // Restarts off: the notice offers the way to the switch, and only then.
  assert.equal(crashNotice(crash, NOW, { interrupted: false, restartsOff: true }).showSettings, true);
  assert.equal(notice.showSettings, false);
  for (const { recovery: r, context } of everyNotice()) if (r) assert.equal(crashNotice(r, NOW, context).showSettings, Boolean(context.restartsOff && !r.restarted && !r.restartsPaused));
  // A restart, or paused restarts, never mention the switch.
  assert.ok(!crashNotice(recovery(), NOW, { interrupted: false, restartsOff: true }).text.includes(RESTARTS_OFF_LINE));
  assert.ok(!crashNotice(recovery({ restarted: false, restartsPaused: true }), NOW, { interrupted: false, restartsOff: true }).text.includes(RESTARTS_OFF_LINE));
});

test('raw developer text never reaches the notice, and nothing ends in an ellipsis and a period', () => {
  const notice = crashNotice(recovery({ summary: `Panic: ${'x'.repeat(400)} /Users/alex/secret` }), NOW, quiet);
  assert.doesNotMatch(notice.text, /Panic|xxx|Users|…/);
  assert.doesNotMatch(notice.text, /Cause: Panic/);
});

test('interrupted agents get a line that says where they are', () => {
  assert.equal(INTERRUPTED_LINE, 'Running agents were stopped; their threads show as Interrupted.');
  assert.ok(crashNotice(recovery(), NOW, { interrupted: true }).text.endsWith(` ${INTERRUPTED_LINE}`));
  assert.ok(!crashNotice(recovery(), NOW, quiet).text.includes('stopped'));
});

test('paused restarts are short: the app did not restart, the thread kept closed and the next step', () => {
  const notice = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 3 * 60 * 60_000, summary: 'Panic: boom', hasReport: true }), NOW, { interrupted: true, heldBack: 'Refine the navigation' });
  // Restarts are on again: the report sentence goes first, then the time and "Your last thread" for
  // the ordinary limit; the Show crash report button stays.
  assert.equal(notice.text, `${PAUSED_LEAD} ${INTERRUPTED_SHORT} ${heldBackLine('Refine the navigation', true)} ${RESTARTS_BACK_LINE}`);
  const noAgents = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 3 * 60 * 60_000, hasReport: true }), NOW, { interrupted: false, heldBack: 'Refine the navigation' }).text;
  // Without agents the report sentence still gives way first, which leaves room for the time and "Your last thread".
  assert.equal(noAgents, `${pausedLead(at(3 * 60 * 60_000))} ${heldBackLine('Refine the navigation')} ${RESTARTS_BACK_LINE}`);
  assert.equal(PAUSED_LEAD, "PandaCode kept crashing and didn't restart.");
  assert.equal(pausedLine('by 2:42 PM'), 'Automatic restarts resume by 2:42 PM.');
  assert.doesNotMatch(notice.text, /Panic/);
  const plain = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, quiet);
  assert.equal(plain.text, `${pausedLead(at(60_000))} ${resume(60_000)}`);
  assert.equal(notice.showReport, true);
});

test('paused restarts say when they resume only within the native window after the crash', () => {
  assert.equal(RESUME_WINDOW, 10 * 60_000);
  const paused = (ago, hasReport = false) => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - ago, hasReport }), NOW, quiet).text;
  const lead = ago => pausedLead(at(ago));
  assert.equal(paused(RESUME_WINDOW), `${lead(RESUME_WINDOW)} ${resume(RESUME_WINDOW)}`);
  assert.equal(RESTARTS_BACK_LINE, 'Automatic restarts are on again.');
  assert.equal(paused(RESUME_WINDOW + 1), `${lead(RESUME_WINDOW + 1)} ${RESTARTS_BACK_LINE}`, 'without a report it closes by saying restarts are back');
  assert.equal(paused(3 * 60 * 60_000), `${lead(3 * 60 * 60_000)} ${RESTARTS_BACK_LINE}`, 'a manual launch hours later: restarts have already resumed');
});

test('an old paused crash with a report says restarts are on again, then gives a next step', () => {
  assert.equal(REPORT_LINE, 'If it keeps happening, open a GitHub issue with the crash report (check it for private details first).');
  assert.equal(REPORT_SHORT, 'If it keeps happening, open a GitHub issue with the crash report.');
  // Paused, it already kept happening.
  assert.equal(PAUSED_REPORT_LINE, 'If it crashes again, open a GitHub issue with the crash report (check it for private details first).');
  assert.equal(PAUSED_REPORT_SHORT, 'If it crashes again, open a GitHub issue with the crash report.');
  const paused = (ago, hasReport) => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - ago, hasReport }), NOW, quiet).text;
  assert.equal(paused(RESUME_WINDOW + 1, true), `${pausedLead(at(RESUME_WINDOW + 1))} ${RESTARTS_BACK_LINE} ${PAUSED_REPORT_SHORT}`, 'restarts are on again, then the report, which gives up its parenthesis before the time');
  for (const { recovery: r, text } of everyNotice()) if (r?.restartsPaused) assert.ok(!text.includes('If it keeps happening'), text);
  assert.equal(paused(RESUME_WINDOW, true), `${pausedLead(at(RESUME_WINDOW))} ${resume(RESUME_WINDOW)}`, 'while restarts are still paused, that comes first');
  assert.equal(paused(3 * 60 * 60_000, false), `${pausedLead(at(3 * 60 * 60_000))} ${RESTARTS_BACK_LINE}`);
  const held = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - RESUME_WINDOW - 1, hasReport: true }), NOW, { interrupted: false, heldBack: 'Fix login' }).text;
  assert.equal(held, `${pausedLead(at(RESUME_WINDOW + 1))} ${heldBackLine('Fix login')} ${RESTARTS_BACK_LINE}`, 'the report line gives way before anything else');
  assert.ok(held.length <= RESUMED_NOTICE_LIMIT, held);
  const long = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - RESUME_WINDOW - 1, hasReport: true }), NOW, { interrupted: false, heldBack: 'Refine the navigation of the settings' }).text;
  assert.ok(long.includes('“Refine the navigation of the settings”') && long.includes(RESTARTS_BACK_LINE) && long.length <= RESUMED_NOTICE_LIMIT, long);
});

test('every paused variant past the resume time says restarts are on again, report or not', () => {
  let checked = 0;
  for (const { recovery: r, text } of everyNotice()) {
    if (!r?.restartsPaused || NOW - r.crashedAt <= RESUME_WINDOW) continue;
    assert.ok(text.includes(RESTARTS_BACK_LINE), `restarts on again was cut: ${text}`);
    if (r.hasReport) checked++;
  }
  assert.ok(checked > 100, 'the enumeration has paused variants with a report');
});

test('the paused lead says when the last crash was while there is room, and gives the time up before anything else', () => {
  assert.equal(pausedLead('at 2:58 PM'), "PandaCode kept crashing, last at 2:58 PM, and didn't restart.");
  const paused = (context, overrides = {}) => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000, ...overrides }), NOW, context).text;
  assert.ok(paused(quiet).startsWith(pausedLead(at(60_000))));
  assert.equal(paused({ interrupted: false, nothingOpened: true }), `${pausedLead(at(60_000))} ${NOTHING_OPENED_LINE} ${resume()}`);
  assert.equal(paused({ interrupted: true }), `${pausedLead(at(60_000))} ${INTERRUPTED_LINE} ${resume()}`);
  // Beside stopped agents and a named thread the time and "Your last thread" give way; when restarts resume never does.
  assert.equal(paused({ interrupted: true, heldBack: 'Fix login' }), `${PAUSED_LEAD} ${INTERRUPTED_SHORT} ${heldBackLine('Fix login', true)} ${resume()}`);
  // A long name takes the shortest held-back sentence.
  const long = 'Refine the navigation of the settings';
  assert.equal(paused({ interrupted: true, heldBack: long }), `${PAUSED_LEAD} ${INTERRUPTED_SHORT} ${keptClosedLine(long)} ${resume()}`);
  // Another day: the date is part of the time.
  assert.match(paused(quiet, { crashedAt: NOW - 3 * 24 * 60 * 60_000 }), /^PandaCode kept crashing, last on .+ at .+, and didn't restart\./);
});

test('when boot opened nothing and no thread is named, the notice says so', () => {
  assert.equal(NOTHING_OPENED_LINE, 'No thread was opened, in case one caused this.');
  const paused = context => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, context).text;
  assert.equal(paused({ interrupted: false, nothingOpened: true }), `${pausedLead(at(60_000))} ${NOTHING_OPENED_LINE} ${resume()}`);
  // It keeps its place when the notice is tight: the agents line shortens, keeping the paused sentence.
  assert.equal(paused({ interrupted: true, nothingOpened: true }), `${pausedLead(at(60_000))} ${INTERRUPTED_SHORT} ${NOTHING_OPENED_LINE} ${resume()}`);
  // A named thread says it already.
  const named = paused({ interrupted: false, nothingOpened: true, heldBack: 'Fix login' });
  assert.equal(named, `${pausedLead(at(60_000))} ${NO_THREAD_OPENED} your last thread, “Fix login”, caused this. ${resume()}`, 'the named thread says that nothing was opened either');
  assert.ok(!named.includes(NOTHING_OPENED_LINE), named);
  assert.ok(!paused(quiet).includes(NOTHING_OPENED_LINE));
  assert.ok(crashNotice(recovery(), NOW, { interrupted: false, nothingOpened: true }).text.endsWith(` ${NOTHING_OPENED_LINE}`), 'a crash after the window had died too');
});

test('the wait until the date changes ends just after the next local midnight', () => {
  const late = new Date(2026, 10, 11, 23, 59, 0).getTime();
  assert.equal(untilNextDay(late), 61_000);
  assert.equal(new Date(late + untilNextDay(late)).getDate(), 12);
  const wait = untilNextDay(new Date(2026, 10, 11, 0, 0, 0).getTime());
  assert.ok(wait > 23 * 60 * 60_000 && wait <= 25 * 60 * 60_000 + 1000, String(wait));
  // The crash time then reads with its date.
  const crashedAt = new Date(2026, 10, 11, 14, 58).getTime();
  assert.equal(crashTime(crashedAt, late, 'en-US'), 'at 2:58 PM');
  assert.equal(crashTime(crashedAt, late + untilNextDay(late), 'en-US'), 'on Nov 11 at 2:58 PM');
});

test('the restarts-off line outranks the long agents line, which shortens first', () => {
  assert.equal(INTERRUPTED_SHORT, 'Stopped agents show as Interrupted.');
  const text = crashNotice(recovery({ restarted: false, summary: 'Crashed with SIGSEGV', crashedAt: NOW - 3 * 60 * 60_000 }), NOW, { interrupted: true, restartsOff: true, heldBack: 'Refine the navigation page layout' }).text;
  assert.ok(text.includes(RESTARTS_OFF_LINE), text);
  assert.ok(text.includes(INTERRUPTED_SHORT) && !text.includes(INTERRUPTED_LINE), text);
  assert.ok(text.includes('“Refine the navigation page layout”'), text);
  assert.ok(text.length <= NOTICE_LIMIT, text);
  // With room, the full agents line stays.
  assert.ok(crashNotice(recovery({ restarted: false }), NOW, { interrupted: true, restartsOff: true }).text.includes(INTERRUPTED_LINE));
});

test('paused, agents stopped and a short title: the thread is named in full', () => {
  const text = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, { interrupted: true, heldBack: 'Fix login' }).text;
  assert.match(text, /“Fix login”/);
  assert.ok(text.length <= PAUSED_NOTICE_LIMIT, text);
});

/** Every cause the guard can name, a crash today and one last year (the longest time), and every optional line. */
function* everyNotice() {
  const causes = [null, 'Panic: boom', 'Crashed with SIGXCPU', 'Crashed with SIGSYS', 'Crashed with SIGSEGV', 'Crashed with a fatal error (abort)', 'Crashed with an access violation'];
  const titles = [undefined, '', 'Fix login', 'Refine the navigation', 'x'.repeat(80), `Fix   the\nlogin ${'very '.repeat(30)}page`];
  for (const summary of causes) for (const mode of ['restarted', 'manual', 'paused']) for (const hasReport of [true, false]) for (const crashedAt of [NOW - 2 * 60_000, NOW - 59 * 60_000, NOW - 400 * 24 * 60 * 60_000])
    for (const agents of ['shown', 'hidden', false]) for (const restartsOff of [true, false, undefined]) for (const heldBack of titles) for (const nothingOpened of [false, true]) for (const notLast of heldBack ? [false, true] : [false]) {
      const r = recovery({ summary, hasReport, restarted: mode === 'restarted', restartsPaused: mode === 'paused', crashedAt });
      const context = { interrupted: Boolean(agents), agentsHidden: agents === 'hidden', restartsOff, heldBack, nothingOpened, notLast };
      yield { recovery: r, context, text: crashNotice(r, NOW, context).text };
    }
  for (const title of titles) for (const death of ['reloaded', 'again', 'before']) for (const nothingOpened of [false, true]) for (const notLast of [false, true]) yield { text: reloadNotice(title, death, nothingOpened, notLast) };
}

test(`no notice variant is longer than NOTICE_LIMIT (183) characters, or PAUSED_NOTICE_LIMIT (183) paused`, () => {
  assert.equal(NOTICE_LIMIT, 183);
  assert.equal(PAUSED_NOTICE_LIMIT, 183);
  const longest = new Map();
  for (const { recovery: r, text } of everyNotice()) {
    assert.ok(text.length <= limitOf(r), `${text.length}: ${text}`);
    const lead = /^.*?\.(?= |$)/.exec(text)[0].replace(/(?:at|on) [^.]*?(?=,? and |\.)/, '<time>') + (resumedAt(r) ? ' (restarts on again)' : '');
    if (text.length > (longest.get(lead)?.length ?? 0)) longest.set(lead, text);
  }
  // Printed so a reviewer sees the longest variant per lead.
  for (const [lead, text] of longest) console.log(`longest ${text.length} [${lead}] ${text}`);
  for (const { recovery: r, context, text } of everyNotice()) if (context?.nothingOpened && context.heldBack === undefined) assert.equal(text.includes(NOTHING_OPENED_LINE), !resumedAt(r), `the nothing-opened line gives way only once restarts are on again: ${text}`);
  assert.equal(Math.max(...[...longest.values()].map(text => text.length)), Math.max(NOTICE_LIMIT, PAUSED_NOTICE_LIMIT), 'the enumeration reaches the long combinations');
  // The paused limit holds the lead, the short agents line, a kept-closed thread at MIN_TITLE and
  // when restarts resume on another day of another year (en-US), with nothing to spare.
  const now = new Date(2026, 11, 31, 23, 58).getTime(), crashedAt = new Date(2026, 11, 31, 23, 57, 30).getTime();
  const worst = [PAUSED_LEAD, INTERRUPTED_SHORT, keptClosedLine(shortTitle('x'.repeat(80), MIN_TITLE)), pausedLine(resumeTime(crashedAt, now, 'en-US'))].join(' ');
  assert.equal(worst.length, PAUSED_NOTICE_LIMIT, worst);
});

test('every paused notice keeps its lead, the thread name (at least MIN_TITLE of it) and when restarts resume or that they are on again', () => {
  let checked = 0;
  for (const { recovery: r, context, text } of everyNotice()) {
    if (!r?.restartsPaused) continue;
    assert.match(text, /^PandaCode kept crashing(, last .+?,)? and didn't restart\. /, text);
    const closing = NOW - r.crashedAt > RESUME_WINDOW ? RESTARTS_BACK_LINE : pausedLine(resumeTime(r.crashedAt, NOW));
    assert.ok(text.includes(closing), `when restarts resume went: ${text}`);
    if (context.heldBack) assert.ok((/“([^”]+)”/.exec(text)?.[1].length ?? 0) >= shortTitle(context.heldBack, MIN_TITLE).length, text);
    checked++;
  }
  assert.ok(checked > 1000);
});

test('every variant prints, and every one with stopped agents says they show as Interrupted', () => {
  assert.match(INTERRUPTED_SHORT, /Interrupted/);
  let stopped = 0;
  for (const { context, text } of everyNotice()) {
    // Printed so a reviewer sees every variant.
    console.log(`${text.length} ${text}`);
    if (!context?.interrupted) continue;
    if (context.agentsHidden) { assert.ok(text.includes(AGENTS_STOPPED_LINE) && !text.includes('Interrupted'), `nothing shows as Interrupted, so the notice does not point there: ${text}`); continue; }
    assert.ok(text.includes('Interrupted'), `stopped agents without "Interrupted": ${text}`);
    stopped++;
  }
  assert.ok(stopped > 1000);
});

test('paused: the crash time comes back once the other trims leave room for it', () => {
  const paused = context => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, context).text;
  // Without stopped agents "Your last thread" and the time fit beside a named thread.
  const text = paused({ interrupted: false, heldBack: 'Refine the navigation' });
  assert.equal(text, `${pausedLead(at(60_000))} ${heldBackLine('Refine the navigation')} ${resume()}`);
  assert.ok(text.length <= PAUSED_NOTICE_LIMIT, text);
  // Every paused variant that lacks the time could not fit it.
  for (const { recovery: r, context, text: variant } of everyNotice()) {
    if (!r?.restartsPaused || !variant.startsWith(`${PAUSED_LEAD} `)) continue;
    const timed = variant.replace(PAUSED_LEAD, pausedLead(crashTime(r.crashedAt, NOW)));
    assert.ok(timed.length > limitOf(r), `the time fits but was left out: ${variant} (${JSON.stringify(context)})`);
  }
});

test('every variant with a titled held-back thread names it, with at least MIN_TITLE characters of it, and keeps the agent line', () => {
  assert.equal(MIN_TITLE, 30);
  let checked = 0;
  for (const { recovery, context, text } of everyNotice()) {
    if (!context?.heldBack) continue;
    const title = shortTitle(context.heldBack, Infinity);
    const quoted = /“([^”]+)”/.exec(text)?.[1];
    assert.ok(quoted, `not named: ${text}`);
    const kept = quoted.endsWith('…') ? quoted.slice(0, -1) : quoted;
    assert.ok(title.startsWith(kept), `${quoted} is not from ${title}`);
    assert.ok(quoted.length >= shortTitle(title, MIN_TITLE).length, `too short: ${text}`);
    if (context.interrupted) assert.ok(text.includes(context.agentsHidden ? AGENTS_STOPPED_LINE : INTERRUPTED_LINE) || text.includes(INTERRUPTED_SHORT), `agent line dropped: ${text}`);
    if (context.restartsOff && !recovery.restarted && !recovery.restartsPaused && text.includes(INTERRUPTED_LINE)) assert.ok(text.includes(RESTARTS_OFF_LINE), `the agents line shortens before the restarts-off line goes: ${text}`);
    assert.ok(text.length <= limitOf(recovery), text);
    checked++;
  }
  assert.ok(checked > 1000);
});

test('the agents line shortens before the last line goes', () => {
  let paused = 0;
  for (const { recovery: r, context, text } of everyNotice()) {
    if (!r || !text.includes(INTERRUPTED_LINE)) continue;
    // Restarts on again: the report line goes before the agents line shortens, RESTARTS_BACK_LINE never.
    const last = !r.restartsPaused ? '' : resumedAt(r) ? RESTARTS_BACK_LINE : pausedLine(resumeTime(r.crashedAt, NOW));
    if (last && text.includes(last)) paused++;
    // The full agents line next to a missing last line only when the short one could not save it.
    if (last && !text.includes(last)) {
      const shortened = text.replace(INTERRUPTED_LINE, INTERRUPTED_SHORT);
      assert.ok(`${shortened} ${last}`.length > limitOf(r), `the last line went before the agents line shortened: ${text}`);
    }
  }
  assert.ok(paused > 0, 'the enumeration has paused notices that keep both lines');
});

test('no variant claims a restart that did not happen, or says restarts are off unless the switch is', () => {
  for (const { recovery: r, context, text } of everyNotice()) {
    if (!r) continue;
    if (!r.restarted) assert.doesNotMatch(text, /and restarted/, text);
    if (text.includes(RESTARTS_OFF_LINE)) assert.ok(context.restartsOff === true && !r.restarted && !r.restartsPaused, text);
    assert.doesNotMatch(text, /Panic|internal error/, text);
    const reportLines = r.restartsPaused ? [PAUSED_REPORT_LINE, PAUSED_REPORT_SHORT] : [REPORT_LINE, REPORT_SHORT];
    if (text.includes('GitHub')) assert.ok(reportLines.some(line => text.includes(line)) && r.hasReport, `GitHub only in the report sentence, with a report: ${text}`);
  }
});

test('a held-back title is shortened to fit the notice, and the cause gives way before the name', () => {
  const roomy = crashNotice(recovery(), NOW, { interrupted: true, heldBack: 'Refine the navigation' });
  assert.equal(roomy.text, `PandaCode crashed ${at()} and restarted. ${INTERRUPTED_SHORT} ${heldBackLine('Refine the navigation')}`);
  assert.equal(crashNotice(recovery(), NOW, { interrupted: false, heldBack: 'Refine the navigation' }).text, `PandaCode crashed ${at()} and restarted. ${heldBackLine('Refine the navigation')}`);
  const tight = crashNotice(recovery({ restarted: false, summary: 'Crashed with SIGSYS', crashedAt: NOW - 59 * 60_000 }), NOW, { interrupted: true, restartsOff: true, heldBack: 'Refine the navigation' });
  assert.ok(tight.text.includes('“Refine the navigation”'), tight.text);
  assert.ok(tight.text.includes(INTERRUPTED_SHORT) && tight.text.includes(RESTARTS_OFF_LINE), tight.text);
  assert.ok(!tight.text.includes('Cause:'), tight.text);
});

test('the window-reloaded notice stands alone without a held-back thread', () => {
  assert.equal(WINDOW_RELOADED_LINE, "PandaCode's window stopped and was reloaded.");
  assert.equal(reloadNotice(), WINDOW_RELOADED_LINE);
  assert.equal(reloadNotice(''), `${WINDOW_RELOADED_LINE} ${heldBackLine('')}`);
  assert.equal(reloadNotice('Fix login'), `${WINDOW_RELOADED_LINE} ${heldBackLine('Fix login')}`);
});

test('a window that died again says so, names its suspect or says that nothing was opened', () => {
  assert.equal(WINDOW_RELOADED_AGAIN_LINE, "PandaCode's window stopped again and was reloaded.");
  assert.equal(WINDOW_STOPPED_BEFORE_LINE, 'Last time PandaCode ran, its window failed.');
  assert.doesNotMatch(WINDOW_STOPPED_BEFORE_LINE, /restart/, 'a quit and reopen by hand leaves the same note, so it never claims a restart');
  assert.equal(reloadNotice(undefined, 'again', true), `${WINDOW_RELOADED_AGAIN_LINE} ${NOTHING_OPENED_LINE}`);
  assert.equal(reloadNotice('Fix login', 'again', true), `${WINDOW_RELOADED_AGAIN_LINE} No thread was opened, in case your last thread, “Fix login”, caused this.`);
  assert.equal(reloadNotice(undefined, 'before', true), `${WINDOW_STOPPED_BEFORE_LINE} ${NOTHING_OPENED_LINE}`);
  assert.equal(reloadNotice('Fix login', 'before', true), `${WINDOW_STOPPED_BEFORE_LINE} ${heldBackLine('Fix login', false, true)}`);
});

test('the open button says Open thread and its accessible name carries the title', () => {
  assert.equal(OPEN_THREAD, 'Open thread');
  assert.equal(openThreadName('Fix   login\npage'), 'Open thread “Fix login page”');
  assert.equal(openThreadName(''), undefined);
});

test('every variant stays short and keeps distinct words for the app restarting and a thread kept closed', () => {
  for (const restarted of [true, false]) for (const restartsPaused of [true, false]) for (const hasReport of [true, false]) {
    const text = crashNotice(recovery({ restarted: restarted && !restartsPaused, restartsPaused, hasReport, summary: 'Crashed with SIGSEGV' }), NOW, { interrupted: false, restartsOff: true }).text;
    assert.ok(sentences(text) <= 3, text);
    assert.doesNotMatch(text, /reopen/);
  }
  assert.doesNotMatch(heldBackLine('x'), /reopen|restart/);
});

test('paused with stopped agents: when restarts resume always stays, beside a named thread shortened as far as MIN_TITLE', () => {
  const long = 'Refactor the authentication middleware for sessions';
  for (const ago of [60_000, RESUME_WINDOW + 1, 3 * 60 * 60_000]) for (const hasReport of [true, false]) for (const heldBack of [long, 'x'.repeat(80), 'Fix login', '']) for (const nothingOpened of [true, false]) {
    const text = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - ago, hasReport }), NOW, { interrupted: true, heldBack, nothingOpened }).text;
    // Printed so a reviewer sees every variant.
    console.log(`${text.length} ${text}`);
    const resumed = ago > RESUME_WINDOW;
    if (!resumed) assert.ok(text.endsWith(` ${resume(ago)}`), `when restarts resume went: ${text}`);
    if (resumed) assert.ok(text.includes(RESTARTS_BACK_LINE), text);
    assert.ok(text.includes(INTERRUPTED_SHORT) || text.includes(INTERRUPTED_LINE), text);
    assert.ok(text.length <= (resumed ? RESUMED_NOTICE_LIMIT : PAUSED_NOTICE_LIMIT), text);
  }
  // The worst case of round 21: the long name, stopped agents and when restarts resume all stay.
  const tight = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, { interrupted: true, heldBack: long }).text;
  assert.equal(tight, `${PAUSED_LEAD} ${INTERRUPTED_SHORT} ${keptClosedLine(long)} ${resume()}`);
  assert.equal(keptClosedLine(long), '“Refactor the authentication middleware…” was kept closed.');
  assert.equal(keptClosedLine(''), 'An untitled thread was kept closed.');
});

test('beside a kept-closed thread the agents line is always short, so it never says to open one', () => {
  let held = 0;
  for (const { context, text } of everyNotice()) {
    if (context?.heldBack === undefined || !context.interrupted) continue;
    assert.ok(!text.includes(INTERRUPTED_LINE) && !text.includes('Open one'), text);
    if (!context.agentsHidden) assert.ok(text.includes(INTERRUPTED_SHORT), text);
    held++;
  }
  assert.ok(held > 500);
  // The room it frees keeps "Your last thread" and the whole title (TITLE_LIMIT) where it fits.
  const title = 'Refine the navigation of the settings page';
  const text = crashNotice(recovery({ summary: 'Crashed with SIGSEGV' }), NOW, { interrupted: true, heldBack: title }).text;
  assert.equal(text, `PandaCode crashed ${at()} and restarted. ${INTERRUPTED_SHORT} ${heldBackLine(title)}`);
  assert.ok(text.length <= NOTICE_LIMIT, text);
});

test('not restarted: the agents line shortens, then the report hint loses its parenthesis, then goes, and only then the cause', () => {
  const ago = 3 * 60 * 60_000, crash = recovery({ restarted: false, hasReport: true, crashedAt: NOW - ago, summary: 'Crashed with SIGSEGV' });
  // The agents line shortens and the hint loses its parenthesis, which is enough: cause and hint both stay.
  assert.equal(crashNotice(crash, NOW, { interrupted: true }).text, `${notRestartedLead(at(ago))} Cause: a memory error (SIGSEGV). ${INTERRUPTED_SHORT} ${REPORT_SHORT}`);
  // Every not-restarted variant with a plain cause keeps it unless the name or restarts-off line needed the room.
  for (const { recovery: r, context, text } of everyNotice()) {
    if (!r || r.restarted || r.restartsPaused || !plainCause(r.summary) || context.heldBack !== undefined || context.nothingOpened || context.restartsOff) continue;
    assert.ok(text.includes('Cause: '), `the cause went: ${text}`);
  }
  // Without a cause, a longer lead (another day): the agents line shortens and the hint stays.
  const days = 3 * 24 * 60 * 60_000, earlier = recovery({ restarted: false, hasReport: true, crashedAt: NOW - days });
  assert.equal(crashNotice(earlier, NOW, { interrupted: true }).text, `${notRestartedLead(at(days))} ${INTERRUPTED_SHORT} ${REPORT_SHORT}`);
});

test('a crash without a restart, with restarts on and a report, gives the next step, which goes first under the limit', () => {
  const crash = recovery({ restarted: false, hasReport: true, crashedAt: NOW - 3 * 60 * 60_000 });
  assert.equal(crashNotice(crash, NOW, quiet).text, `${notRestartedLead(at(3 * 60 * 60_000))} ${REPORT_LINE}`);
  assert.equal(crashNotice(crash, NOW, { interrupted: false, restartsOff: undefined }).text, `${notRestartedLead(at(3 * 60 * 60_000))} ${REPORT_LINE}`, 'an unreadable switch is taken as on');
  assert.ok(!crashNotice(crash, NOW, { interrupted: false, restartsOff: true }).text.includes(REPORT_LINE), 'the restarts-off line is the closing line');
  assert.ok(!crashNotice({ ...crash, hasReport: false }, NOW, quiet).text.includes(REPORT_LINE), 'no report, nothing to point at');
  assert.ok(!crashNotice({ ...crash, restarted: true }, NOW, quiet).text.includes(REPORT_LINE), 'a restart needs no next step');
  // Under pressure it goes before "Your last thread" or the title gives way.
  const tight = crashNotice(crash, NOW, { interrupted: true, heldBack: 'Refine the navigation of the settings page' }).text;
  assert.equal(tight, `${notRestartedLead(at(3 * 60 * 60_000))} ${INTERRUPTED_SHORT} ${heldBackLine('Refine the navigation of the settings page', true)}`);
});

test('paused with a named thread says no thread was opened in one sentence, short of room in the shortest kept-closed sentence', () => {
  assert.equal(NO_THREAD_OPENED, 'No thread was opened, in case');
  const paused = (heldBack, interrupted = false) => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, { interrupted, heldBack, nothingOpened: true }).text;
  assert.ok(paused('Fix login').includes(`${NO_THREAD_OPENED} your last thread, “Fix login”, caused this.`), paused('Fix login'));
  assert.ok(paused('').includes(`${NO_THREAD_OPENED} an untitled thread caused this.`), paused(''));
  // Tight: the agents line is short and the shortest held-back sentence still says nothing was opened.
  assert.equal(paused('Fix the login page now', true), `${PAUSED_LEAD} ${INTERRUPTED_SHORT} “Fix the login page now” was kept closed; no thread was opened. ${resume()}`);
  // Tighter: it would not fit even with the title at MIN_TITLE, so "no thread was opened" goes, last, and the whole title comes back.
  const tight = paused('Refactor the authentication middleware', true);
  assert.equal(tight, `${PAUSED_LEAD} ${INTERRUPTED_SHORT} ${keptClosedLine('Refactor the authentication middleware')} ${resume()}`);
  assert.equal(keptClosedLine('Refactor the authentication middleware', true), '“Refactor the authentication middleware” was kept closed; no thread was opened.');
  assert.equal(keptClosedLine('', true), 'An untitled thread was kept closed; no thread was opened.');
  // Only when boot opened nothing.
  assert.ok(!crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, { interrupted: false, heldBack: 'Fix login' }).text.includes(NO_THREAD_OPENED));
});

test('every variant where boot opened nothing says so, named thread or not', () => {
  let named = 0;
  for (const { recovery, context, text } of everyNotice()) {
    if (!context?.nothingOpened) continue;
    // Paused, the shortest held-back sentence says it too, and gives it up only when the notice would not fit with it (the title at its floor).
    if (recovery?.restartsPaused && context.heldBack !== undefined && text.includes(' was kept closed.')) {
      assert.ok(text.replace(' was kept closed.', ' was kept closed; no thread was opened.').length > limitOf(recovery), `gave way with room to spare: ${text}`);
      continue;
    }
    // Restarts on again and no thread named: nothing to act on, so it is left out.
    if (resumedAt(recovery) && context.heldBack === undefined) { assert.ok(!text.includes(NOTHING_OPENED_LINE), text); continue; }
    assert.ok(text.includes(context.heldBack === undefined ? NOTHING_OPENED_LINE : NO_THREAD_OPENED) || text.includes(' was kept closed; no thread was opened.'), `nothing-opened dropped: ${text}`);
    if (context.heldBack) named++;
  }
  for (const title of ['Fix login', 'x'.repeat(80)]) for (const death of ['reloaded', 'again', 'before']) assert.ok(reloadNotice(title, death, true).includes(NO_THREAD_OPENED));
  assert.ok(named > 500);
});

test('paused restarts say by what clock time they resume, never early, with the date when that is another day', () => {
  const now = new Date(2026, 10, 12, 14, 35).getTime();
  assert.equal(resumeTime(new Date(2026, 10, 12, 14, 31, 59, 999).getTime(), now, 'en-US'), 'by 2:42 PM');
  assert.equal(resumeTime(new Date(2026, 10, 12, 14, 32, 20).getTime(), now, 'en-US'), 'by 2:43 PM', 'rounded up to the minute');
  // On the minute: at 2:42:00.000 the guard (inclusive `<=`) still counts the crash, so the stated time is the next minute.
  const exact = new Date(2026, 10, 12, 14, 32).getTime();
  assert.equal(resumeTime(exact, now, 'en-US'), 'by 2:43 PM');
  assert.equal(resumesAt(exact), exact + RESUME_WINDOW + 1);
  const notice = at => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: exact, hasReport: false }), at, { interrupted: false }).text;
  assert.match(notice(exact + RESUME_WINDOW), /Automatic restarts resume by/, 'still counted at the window\'s last instant');
  assert.ok(notice(resumesAt(exact)).endsWith(RESTARTS_BACK_LINE), 'on again from the first instant it is not');
  const late = new Date(2026, 10, 12, 23, 58).getTime();
  assert.equal(resumeTime(new Date(2026, 10, 12, 23, 54, 30).getTime(), late, 'en-GB'), 'by 13 Nov at 0:05');
  // Every paused variant that says when restarts resume says it with the time, within the window only.
  let timed = 0;
  for (const { recovery: r, text } of everyNotice()) {
    if (!r?.restartsPaused) continue;
    const line = pausedLine(resumeTime(r.crashedAt, NOW));
    if (NOW - r.crashedAt > RESUME_WINDOW) assert.doesNotMatch(text, /restarts resume/, text);
    else { assert.ok(text.endsWith(line), text); timed++; }
  }
  assert.ok(timed > 100);
});

test('not restarted with restarts on: the lead says it did not restart, and the report hint goes first', () => {
  assert.equal(notRestartedLead('at 2:32 PM'), "PandaCode crashed at 2:32 PM and didn't restart.");
  const crash = recovery({ restarted: false, hasReport: true, crashedAt: NOW - 3 * 60 * 60_000 });
  const tight = crashNotice(crash, NOW, { interrupted: true, heldBack: 'Refine the navigation of the settings page' }).text;
  assert.ok(tight.startsWith(notRestartedLead(at(3 * 60 * 60_000))) && !tight.includes(REPORT_LINE), tight);
  // Restarts off: that line says why instead.
  assert.ok(crashNotice(crash, NOW, { interrupted: false, restartsOff: true }).text.startsWith(`PandaCode crashed ${at(3 * 60 * 60_000)}. `));
  for (const { recovery: r, context, text } of everyNotice()) {
    if (!r || r.restarted || r.restartsPaused) continue;
    assert.equal(text.startsWith(notRestartedLead(crashTime(r.crashedAt, NOW))), context.restartsOff !== true, text);
  }
});

test('only tasks active in the day before the crash suggest agents were interrupted by it', () => {
  const crashedAt = NOW - 10_000;
  const task = (overrides) => ({ status: 'interrupted', archived: false, updatedAt: crashedAt - 60_000, lastPromptAt: null, ...overrides });
  assert.equal(anyInterruptedByCrash([task({})], crashedAt), true);
  assert.equal(anyInterruptedByCrash([task({ updatedAt: Math.floor((crashedAt - 5_000) / 1000) })], crashedAt), true);
  assert.equal(anyInterruptedByCrash([task({ updatedAt: crashedAt - INTERRUPTED_WINDOW - 1, lastPromptAt: crashedAt - 1_000 })], crashedAt), true);
  assert.equal(anyInterruptedByCrash([task({ updatedAt: crashedAt - INTERRUPTED_WINDOW - 1 }), task({ archived: true }), task({ status: 'idle' })], crashedAt), false);
  assert.equal(anyInterruptedByCrash([], crashedAt), false);
});

test('the kept-closed thread is named by a short one-line title, or not at all when it has none', () => {
  assert.equal(heldBackLine('Refine the navigation'), 'Your last thread, “Refine the navigation”, was kept closed in case it caused this.');
  assert.equal(heldBackLine(''), 'An untitled thread was kept closed in case it caused this.');
  assert.equal(heldBackLine(), 'An untitled thread was kept closed in case it caused this.');
  assert.equal(heldBackLine('', true), 'An untitled thread was kept closed in case it caused this.');
  const long = shortTitle(`Fix   the\nlogin ${'very '.repeat(20)}page`);
  assert.ok(long.length <= TITLE_LIMIT);
  assert.ok(long.endsWith('…') && !long.includes('\n') && !long.includes('  '));
  assert.equal(shortTitle('  Short  '), 'Short');
  assert.equal(crashNotice(recovery(), NOW, { interrupted: false, heldBack: 'A' }).text, `PandaCode crashed ${at()} and restarted. ${heldBackLine('A')}`);
  assert.ok(!crashNotice(recovery(), NOW, quiet).text.includes('kept closed'));
});

test('Settings search finds the General page, where Crash recovery lives, by crash words', async () => {
  const { SECTIONS } = await import('../src/settings-sections.ts');
  const general = SECTIONS.find(section => section.id === 'general').pages.find(page => page.id === 'general');
  const words = general.keywords.split(/\s+/);
  for (const word of ['crash', 'restart', 'recovery', 'report', 'unsent', 'drafts']) assert.ok(words.includes(word), word);
});

test('Settings takes the kept-drafts age from the drafts constant, with no second copy of the number, and no per-message size', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/crash-restart-settings.ts', import.meta.url), 'utf8');
  const { DRAFT_MAX_AGE } = await import('../src/launch-restore.ts');
  assert.equal(DRAFT_MAX_AGE, 30 * 24 * 60 * 60 * 1000, 'the spec expects 30 days');
  assert.match(source, /import \{ DRAFT_MAX_AGE \} from '\.\/launch-restore'/);
  // It ends with when the text goes: sent, cleared (the field or Clear saved drafts), or expired.
  assert.match(source, /The text of unsent messages \(not attachments or very long drafts\) is saved locally as plain text, so a crash rarely loses it\. A pasted secret is kept too, until the message is sent, cleared, or \$\{Math\.round\(DRAFT_MAX_AGE \/ 86_400_000\)\} days old\./);
  assert.doesNotMatch(source, /\b30 days\b|50,000|MAX_DRAFT_CHARS|characters each/);
  // A note under the group, not a row, with Clear saved drafts beside it, described by the note.
  assert.match(source, /<small class="settings-group-note" id="crash-drafts-note">\$\{DRAFTS_KEPT_DETAIL\}<\/small><button type="button" class="ds-btn" id="crash-drafts-clear" aria-describedby="crash-drafts-note">\$\{CLEAR_DRAFTS\}<\/button>/);
  assert.doesNotMatch(source, /<strong>Unsent messages<\/strong>/);
});

test('the restart switch is described in words true on every platform', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/crash-restart-settings.ts', import.meta.url), 'utf8');
  assert.match(source, /It won't restart if you force it to quit or the system ends it\./);
  assert.doesNotMatch(source, /Force Quit/);
});

test('a paused notice past the resume time always says restarts are on again; a report line follows it when it fits', () => {
  let back = 0, both = 0;
  for (const { recovery: r, context, text } of everyNotice()) {
    if (!r?.restartsPaused) continue;
    if (NOW - r.crashedAt <= RESUME_WINDOW) { assert.ok(!text.includes(RESTARTS_BACK_LINE), text); continue; }
    if (!r.hasReport || text.endsWith(` ${RESTARTS_BACK_LINE}`)) {
      assert.ok(text.endsWith(` ${RESTARTS_BACK_LINE}`), `restarts on again went: ${text}`);
      back++;
    } else {
      assert.ok(text.endsWith(` ${RESTARTS_BACK_LINE} ${PAUSED_REPORT_LINE}`) || text.endsWith(` ${RESTARTS_BACK_LINE} ${PAUSED_REPORT_SHORT}`), text);
      both++;
    }
    assert.ok(text.length <= PAUSED_NOTICE_LIMIT, text);
  }
  assert.ok(back > 100 && both > 0, `${back} ${both}`);
});

test('once the user opens any thread the nothing-opened wording goes: the unnamed sentence disappears and a named thread reads as the plain held-back sentence', () => {
  const paused = recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 });
  // nothingOpened false is how main.ts rewrites the notice after a thread or New task opens.
  const before = crashNotice(paused, NOW, { interrupted: false, nothingOpened: true }).text;
  const after = crashNotice(paused, NOW, { interrupted: false, nothingOpened: false }).text;
  assert.ok(before.includes(NOTHING_OPENED_LINE) && !after.includes(NOTHING_OPENED_LINE), after);
  assert.equal(after, `${pausedLead(at(60_000))} ${resume()}`);
  const named = crashNotice(paused, NOW, { interrupted: false, heldBack: 'Fix login', nothingOpened: false }).text;
  assert.ok(named.includes('Your last thread, “Fix login”, was kept closed in case it caused this.') && !named.includes(NO_THREAD_OPENED), named);
  assert.equal(reloadNotice(undefined, 'again', false), WINDOW_RELOADED_AGAIN_LINE);
  assert.equal(reloadNotice('Fix login', 'again', false), `${WINDOW_RELOADED_AGAIN_LINE} Your last thread, “Fix login”, was kept closed in case it caused this.`);
});

test('a held-back thread that was not the last place (a New task reopened instead) is "the thread", never "your last thread"', () => {
  assert.equal(heldBackLine('Fix login', false, false, true), 'The thread “Fix login” was kept closed in case it caused this.');
  assert.equal(heldBackLine('Fix login', true, false, true), '“Fix login” was kept closed in case it caused this.');
  assert.equal(heldBackLine('Fix login', false, true, true), `${NO_THREAD_OPENED} the thread “Fix login” caused this.`);
  assert.equal(heldBackLine('', false, false, true), 'An untitled thread was kept closed in case it caused this.');
  const text = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, { interrupted: false, heldBack: 'Fix login', notLast: true }).text;
  assert.ok(text.includes('The thread “Fix login” was kept closed') && !/your last/i.test(text), text);
  for (const { context, text: variant } of everyNotice()) if (context?.notLast) assert.doesNotMatch(variant, /your last/i, variant);
  assert.doesNotMatch(reloadNotice('Fix login', 'before', false, true), /your last/i);
});

test('agents stopped with none showing as Interrupted: the notice says they were stopped and points nowhere', () => {
  assert.equal(AGENTS_STOPPED_LINE, 'Running agents were stopped.');
  const text = crashNotice(recovery(), NOW, { interrupted: true, agentsHidden: true }).text;
  assert.equal(text, `PandaCode crashed ${at()} and restarted. ${AGENTS_STOPPED_LINE}`);
  const tight = crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - 60_000 }), NOW, { interrupted: true, agentsHidden: true, heldBack: 'Refactor the authentication middleware', nothingOpened: true }).text;
  assert.ok(tight.includes(AGENTS_STOPPED_LINE) && !/Open one|Interrupted/.test(tight), tight);
});

test('paused past the resume time: no unnamed nothing-opened line, the report line goes first, and the ordinary limit', () => {
  assert.equal(RESUMED_NOTICE_LIMIT, NOTICE_LIMIT);
  const resumed = (context, hasReport = true, ago = RESUME_WINDOW + 1) => crashNotice(recovery({ restarted: false, restartsPaused: true, crashedAt: NOW - ago, hasReport }), NOW, context).text;
  assert.equal(resumed({ interrupted: false, nothingOpened: true }, false), `${pausedLead(at(RESUME_WINDOW + 1))} ${RESTARTS_BACK_LINE}`);
  assert.equal(resumed({ interrupted: false, nothingOpened: true }, false, RESUME_WINDOW), `${pausedLead(at(RESUME_WINDOW))} ${NOTHING_OPENED_LINE} ${resume(RESUME_WINDOW)}`, 'still paused: it stays');
  // A named thread keeps its sentence.
  assert.ok(resumed({ interrupted: false, nothingOpened: true, heldBack: 'Fix login' }).includes('“Fix login”'));
  // The report line goes before the time, the agents line or the thread's longer sentence.
  assert.equal(resumed({ interrupted: true, heldBack: 'Fix login' }), `${PAUSED_LEAD} ${INTERRUPTED_SHORT} ${heldBackLine('Fix login')} ${RESTARTS_BACK_LINE}`);
  let longest = '';
  for (const { recovery: r, text } of everyNotice()) if (resumedAt(r)) {
    assert.ok(text.length <= RESUMED_NOTICE_LIMIT, text);
    assert.ok(text.includes(RESTARTS_BACK_LINE), text);
    if (text.length > longest.length) longest = text;
  }
  console.log(`longest resumed ${longest.length} ${longest}`);
});
