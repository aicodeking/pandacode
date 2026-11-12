import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { markupCache } from '../src/transcript-rows.ts';

/* The open thread serves each saved turn's markup from a cache (savedTurnHtml in src/main.ts) that holds while the
 * turn's `parts` and `markupEnv` are unchanged. A new input to turnHtml that is in neither would serve stale rows
 * without any test noticing, so the code of turnHtml and the functions it draws a turn with (in main.ts and the modules it calls) is pinned here. When this
 * fails: check every value the changed code reads; anything that is not the turn's own messages must be in savedTurnHtml's
 * `parts` or in `markupEnv`. Then record the new hash below. */
const PINNED = {
  'src/main.ts': ['turnHtml', 'turnCardHtml', 'turnLeadHtml', 'notesHtml', 'workerSlot', 'cardless', 'cardErrorsHtml', 'cardFootHtml', 'savedActivityHtml', 'savedTurnActivity', 'markupEnv', 'savedTurnHtml',
    'messageHtml', 'activityHtml', 'accountSwitchHtml', 'userContent', 'foldedLabelHtml', 'changesRow', 'changesFoot', 'steerStateHtml'],
  'src/message-actions.ts': ['messageActionsHtml'],
  'src/schedules-thread.ts': ['scheduledMark', 'workflowStep'],
  'src/turn-changes.ts': ['renderTurnChanges', 'turnChangesFoot', 'fileTree'],
  'src/dom.ts': ['fileIcon'],
  'src/turn-activity.ts': ['turnLabel'],
  'src/provider-logos.ts': ['providerLogo'],
  'src/provider-handoff.ts': ['historicalProvider'],
  'src/tool-activity.ts': ['renderToolGroup', 'renderToolActivity'],
  'src/turn-card.ts': ['replyHtml', 'timeHtml'],
  'src/transcript-host.ts': ['lastHandoff', 'turnMessages', 'markupShared'],
};
const RECORDED = 'aa4deacdb10159d6';

/** A top-level function's text in `file`, from its declaration to the next top-level statement. */
function functionText(file, name) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const start = source.search(new RegExp(`^(?:export )?(?:async )?(?:function ${name}\\(|const ${name} = )`, 'm'));
  assert.ok(start >= 0, `${file} no longer declares ${name} at the top level: update PINNED`);
  const rest = source.slice(start + 1), end = rest.search(/^(?:export |function |async function |const |let |type |\/\*\*|\/\/|[a-zA-Z$_.]+\()/m);
  return source.slice(start, start + 1 + (end < 0 ? rest.length : end));
}

test('turnHtml and its inputs are as the markup cache was last checked against', () => {
  const hash = createHash('sha256').update(Object.entries(PINNED).flatMap(([file, names]) => names.map(name => functionText(file, name))).join('\n')).digest('hex').slice(0, 16);
  assert.equal(hash, RECORDED, 'turnHtml or a function it draws with changed: put any new input in savedTurnHtml `parts` or `markupEnv`, then record this hash in tests/transcript-markup.test.mjs');
});

test('the markup cache holds while parts and env are the same, and only then', () => {
  const cache = markupCache();
  const head = {}, message = {};
  let renders = 0;
  const render = () => `<p>${++renders}</p>`;
  assert.equal(cache(head, [message, 1], 'env', render), '<p>1</p>');
  assert.equal(cache(head, [message, 1], 'env', render), '<p>1</p>');
  assert.equal(cache(head, [message, 2], 'env', render), '<p>2</p>', 'a changed part redraws');
  assert.equal(cache(head, [{}, 2], 'env', render), '<p>3</p>', 'a replaced message (same content) redraws');
  assert.equal(cache(head, [{}, 2], 'other', render), '<p>4</p>', 'a changed env redraws');
  assert.equal(cache(head, [{}, 2, 3], 'other', render), '<p>5</p>', 'a part added redraws');
  assert.equal(cache({}, [], 'other', render), '<p>6</p>', 'another turn has its own entry');
});

test('markupEnv holds what the changes cards read besides the turn: whether the thread is the open one, and the runner', () => {
  // A tile of a thread shares its message objects with the pane: without the open-thread flag the pane would reuse the
  // tile's markup, whose changes card has no working Run button.
  const env = functionText('src/main.ts', 'markupEnv');
  for (const name of ['changesRow', 'changesFoot']) {
    const reads = functionText('src/main.ts', name).match(/sessionId === state\.sessionId|projectRunner\.available\(\)/g) ?? [];
    assert.ok(reads.length, `${name} no longer reads the open thread: update this test`);
    for (const read of reads) assert.ok(env.includes(read), `markupEnv must include \`${read}\`, which ${name} reads`);
  }
});

test('markupEnv holds what a changes card\'s file icons read: whether their chunk loaded, and the theme', () => {
  // fileIcon draws a plain glyph until the icon chunk loads, then picks a variant from the theme: without both in the
  // env a cached card would keep plain or wrong-theme icons for the session.
  const icons = functionText('src/dom.ts', 'fileIcon');
  assert.ok(icons.includes("document.documentElement.dataset.theme === 'light'") && icons.includes('fileIcons?.'), 'fileIcon reads something new: update this test and markupEnv');
  assert.ok(functionText('src/turn-changes.ts', 'fileTree').includes('fileIcon('), 'fileTree no longer draws file icons: update this test');
  assert.ok(functionText('src/main.ts', 'markupEnv').includes('...turnInputs.inputs()'), 'markupEnv must include the shared inputs (transcript-host.ts markupShared)');
  const shared = functionText('src/transcript-host.ts', 'markupShared');
  for (const read of ['iconsLoaded', "document.documentElement.dataset.theme === 'light'"]) assert.ok(shared.includes(read), `markupShared must read \`${read}\``);
});
