import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(path, 'utf8');
const ledger = JSON.parse(read('tests/fixtures/extensions/surfaces.json'));
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
const sources = new Map(files('src').filter(path => path.endsWith('.ts') && !path.includes('/vendor/'))
  .map(path => [path, read(path)]));

// This inventory check intentionally reads source: its subject is source-owned UI
// coverage, not runtime behavior. Runtime characterization has separate gaps below.
function discover(input) {
  return [...input].flatMap(([owner, source]) => {
    const actions = [...new Set([
      ...source.matchAll(/data-(?:[\w-]*-)?action=["']([a-z][a-z0-9-]*)["']/g),
      ...source.matchAll(/\bbutton\(\s*'([a-z][a-z0-9-]*)'/g),
    ].map(match => match[1]))].sort();
    const calls = [...source.matchAll(/\b(modal|showChoices|openChoiceMenu)\(/g)]
      .filter(match => !/^\s*(?:title|anchor|options):/.test(source.slice(match.index + match[0].length)));
    const dialogs = calls.filter(match => match[1] === 'modal').length;
    return actions.length || calls.length ? [[owner, actions, dialogs, calls.length - dialogs]] : [];
  }).sort(([a], [b]) => a.localeCompare(b, 'en'));
}

function checkDiscovery(value, input = sources) {
  const expected = new Map(value.sourceInventory.map(row => [row[0], row]));
  for (const row of discover(input)) {
    assert.ok(expected.has(row[0]), `Uninventoried renderer: ${row[0]}`);
    assert.deepEqual(row, expected.get(row[0]), `Surface drift in ${row[0]}: audit new/removed actions, menus and dialogs`);
    expected.delete(row[0]);
  }
  assert.equal(expected.size, 0, `Stale renderer inventory: ${[...expected.keys()].join(', ')}`);
}

function members(value) {
  return value.families.flatMap(family => family.members.map(([local, owner, anchor, context, window]) => ({
    ...value.defaults, ...family, id: `${family.id}.${local}`, parent: family.id, owner, anchor, context,
    window: window ?? family.window ?? value.defaults.window,
  })));
}

function sourceActions(value) {
  const named = members(value);
  return value.sourceInventory.flatMap(([owner, actions]) => actions.map(action => {
    const matching = named.filter(row => row.owner === owner);
    const context = value.sourceContexts[owner] ?? matching.map(row => row.context).join('; ');
    assert.ok(context, `Missing contextual objects for source owner ${owner}`);
    return {
      ...value.defaults,
      id: `panda.inventory.${owner.slice(4, -3).replaceAll('/', '.')}.${action}`,
      parent: matching[0]?.parent ?? 'panda.inventory', owner, anchor: action,
      context: `${context}; local action: ${action}`,
      window: owner === 'src/agents-dock-window.ts' ? 'agents-dock' : 'main',
      coverage: { missing: `Characterize ${action} in ${owner} against captured ${context}; assert one intended effect, visible failure/retry and no effect on another task after navigation.` },
    };
  }));
}

function checkNamedDialogs(value) {
  const rows = members(value).filter(row => row.parent === 'panda.dialog');
  for (const [owner, source] of sources) {
    if (/\.showModal\(/.test(source)) {
      assert.ok(owner === 'src/main.ts' || rows.some(row => row.owner === owner && row.anchor.includes('showModal')),
        `Uninventoried direct dialog: ${owner}`);
    }
    for (const match of source.matchAll(/\bmodal\(\s*([^,\n]+)/g)) {
      if (/^title:/.test(match[1])) continue; // interface or implementation declaration
      const call = `modal(${match[1].trim()}`;
      assert.ok(rows.some(row => row.owner === owner && call.startsWith(row.anchor)),
        `Uninventoried dialog caller: ${owner}: ${call}`);
    }
  }
}

function checkNamedMenus(value) {
  const rows = members(value).filter(row => row.parent === 'panda.menus');
  for (const [owner, source] of sources) {
    for (const match of source.matchAll(/\b(?:showChoices|openChoiceMenu)\(\s*(?:anchor,\s*)?\{[^{}]{0,200}?\btitle:\s*(['"`])([^\n]+?)\1/g)) {
      assert.ok(rows.some(row => row.owner === owner && row.anchor.includes(match[2])),
        `Uninventoried named menu: ${owner}: ${match[2]}`);
    }
  }
}

function checkClosedViews(value) {
  const views = [...read('src/inspector-tabs.ts').match(/INSPECTOR_VIEWS[^=]*=\s*\[([^\]]+)\]/)[1]
    .matchAll(/'([^']+)'/g)].map(match => match[1]);
  const inspector = value.families.find(family => family.id === 'panda.inspector');
  for (const view of views) assert.ok(inspector.members.some(row => row[0] === view), `Missing inspector surface: ${view}`);
  const pages = [...read('src/settings-sections.ts').match(/export type SettingsPage = ([^;]+);/)[1]
    .matchAll(/'([^']+)'/g)].map(match => match[1]);
  const settings = value.families.find(family => family.id === 'panda.settings.pages');
  assert.deepEqual(settings.members.map(row => row[0]).sort(), pages.sort(), 'Every settings deep-link page needs its own surface');
}

function checkFirstActions(value) {
  const main = sources.get('src/main.ts');
  const shell = main.slice(main.indexOf('$app.innerHTML ='), main.indexOf('<div class="work-area">'));
  const actions = new Set([
    ...shell.matchAll(/data-action="([a-z][a-z0-9-]*)"/g),
    ...shell.matchAll(/\bbutton\('([a-z][a-z0-9-]*)'/g),
  ].map(match => match[1]));
  // These controls use their owning module or direct listeners, not data-action.
  for (const id of ['brand-name', 'sidebar-filter', 'star-panda', 'agents-toggle', 'update-status']) actions.add(id);
  const recorded = new Map(value.firstActions);
  for (const action of actions) {
    assert.ok(recorded.has(action), `Missing first-slot characterization: ${action}`);
    assert.ok(recorded.get(action).length > 45, `Specific expected behavior required: ${action}`);
  }
  assert.equal(recorded.size, value.firstActions.length, 'Duplicate first-slot action');
}

test('surface ledger expands source-owned families with honest operation and coverage status', () => {
  assert.equal(ledger.schemaVersion, 1);
  const required = ['panda.workspace.header.actions', 'panda.sidebar', 'panda.workspace.views', 'panda.thread',
    'panda.composer', 'panda.inspector', 'panda.content', 'panda.project', 'panda.agents', 'panda.settings.pages',
    'panda.status', 'panda.commands', 'panda.dialog', 'panda.menus', 'panda.quick-input', 'panda.tray',
    'panda.windows', 'panda.appearance', 'panda.projections'];
  assert.deepEqual(ledger.families.map(family => family.id), required);
  const expanded = [...members(ledger), ...sourceActions(ledger)];
  assert.equal(new Set(expanded.map(row => row.id)).size, expanded.length, 'Stable surface IDs must be unique');
  for (const row of expanded) {
    assert.ok(existsSync(row.owner), `${row.id}: missing owner ${row.owner}`);
    assert.ok(row.anchor && read(row.owner).includes(row.anchor), `${row.id}: stale source anchor ${row.anchor}`);
    assert.ok(row.window && row.context.length > 10 && row.parent);
    assert.match(row.milestone, /^M(?:[0-9]|10)$/);
    assert.deepEqual(row.allowedOperations, [], 'Inventory must not advertise unimplemented adapters');
    assert.ok(row.plannedOperations.length && row.visibility && row.move && row.replacement);
    assert.ok(row.coverage.missing.length > 40 || row.coverage.references?.length, `${row.id}: no coverage disposition`);
  }
  checkClosedViews(ledger);
});

test('source-discovered actions and transient call sites cannot disappear from the ledger', () => {
  checkDiscovery(ledger);
  checkNamedDialogs(ledger);
  checkNamedMenus(ledger);
});

test('validator rejects an omitted source-discovered action, owner and dialog', () => {
  const omittedAction = structuredClone(ledger);
  omittedAction.sourceInventory.find(row => row[0] === 'src/main.ts')[1].pop();
  assert.throws(() => checkDiscovery(omittedAction), /Surface drift/);
  const omittedOwner = structuredClone(ledger);
  omittedOwner.sourceInventory = omittedOwner.sourceInventory.filter(row => row[0] !== 'src/browser.ts');
  assert.throws(() => checkDiscovery(omittedOwner), /Uninventoried renderer/);
  const omittedDialog = structuredClone(ledger);
  omittedDialog.families.find(row => row.id === 'panda.dialog').members =
    omittedDialog.families.find(row => row.id === 'panda.dialog').members.filter(row => row[0] !== 'rename-task');
  assert.throws(() => checkNamedDialogs(omittedDialog), /Uninventoried dialog caller/);
  const omittedMenu = structuredClone(ledger);
  omittedMenu.families.find(row => row.id === 'panda.menus').members =
    omittedMenu.families.find(row => row.id === 'panda.menus').members.filter(row => row[0] !== 'deploy');
  assert.throws(() => checkNamedMenus(omittedMenu), /Uninventoried named menu/);
});

test('validator discovers new controls and transients without editing a discovery allowlist', () => {
  const added = new Map(sources);
  added.set('src/future-panel.ts', `const html = '<button data-action="future-command">Future</button>';`);
  assert.throws(() => checkDiscovery(ledger, added), /Uninventoried renderer/);
  added.delete('src/future-panel.ts');
  added.set('src/main.ts', `${sources.get('src/main.ts')}\nmodal('Future dialog', '');`);
  assert.throws(() => checkDiscovery(ledger, added), /Surface drift/);
});

test('every first header/sidebar/dock action has specific characterization work', () => {
  checkFirstActions(ledger);
  const omitted = structuredClone(ledger);
  omitted.firstActions = omitted.firstActions.filter(([id]) => id !== 'deploy');
  assert.throws(() => checkFirstActions(omitted), /Missing first-slot characterization: deploy/);
});

test('every baseline workflow group enumerates behavioral cases, not candidate filenames', () => {
  const requiredCases = [
    ['open-project', 'switch-thread', 'create-task', 'draft-undo', 'attach', 'model-mode', 'send-stream', 'stop-resume'],
    ['queue-steer', 'question', 'permission', 'tool-output', 'team', 'usage-limit'],
    ['tabs', 'file-diff-search-browser', 'terminal-state'],
    ['menu-keyboard', 'dialog-escape-focus', 'ime'],
    ['settings-deep-link', 'theme-icons-contrast', 'zoom-narrow', 'layout-persistence'],
    ['tray', 'secondary-windows', 'remote-reconnect', 'headless', 'missing-provider'],
    ['migration', 'storage-recovery'],
  ];
  assert.deepEqual(ledger.baselineWorkflows.map(group => group.id), ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);
  const ids = new Set();
  for (const [index, group] of ledger.baselineWorkflows.entries()) {
    assert.deepEqual(group.cases.map(([id]) => id), requiredCases[index], `Missing baseline behavior in ${group.id}`);
    for (const [id, missing] of group.cases) {
      assert.ok(!ids.has(`${group.id}.${id}`));
      ids.add(`${group.id}.${id}`);
      assert.ok(missing.length > 55 && !/^tests\//.test(missing), `Specific missing characterization: ${group.id}.${id}`);
    }
  }
  for (const ref of ledger.assertionReferences) {
    for (const target of ref.targets) assert.ok(ids.has(target), `Unknown coverage target: ${target}`);
    const source = read(ref.file);
    const start = source.indexOf(`test('${ref.test}'`);
    assert.ok(start >= 0, `Missing test: ${ref.file}: ${ref.test}`);
    const next = source.indexOf('\ntest(', start + 1);
    assert.ok(source.slice(start, next < 0 ? undefined : next).includes(ref.assertion),
      `Assertion must exist inside the named test, not merely its file: ${ref.file}`);
    assert.ok(ref.scope.length > 30, 'Reference must state the actual assertion boundary');
  }
});

test('native secondary window creation is inventoried separately from preview rendering', () => {
  const builders = files('src-tauri/src').filter(path => path.endsWith('.rs')).flatMap(owner => {
    const count = [...read(owner).matchAll(/WebviewWindowBuilder::new\(/g)].length;
    return count ? [[owner, count]] : [];
  });
  assert.deepEqual(builders.sort(), ledger.nativeInventory.toSorted(), 'New native windows need their own surface and IPC review');
  const windows = members(ledger).filter(row => row.parent === 'panda.windows');
  for (const label of ['main', 'launcher', 'agents-dock', 'tray']) {
    assert.ok(windows.some(row => row.context.includes(`label ${label}`)), `Missing native window label: ${label}`);
  }
  const tray = read('src-tauri/src/tray.rs');
  const nativeItems = [...tray.matchAll(/MenuItem::with_id\(app, "([^"]+)", "([^"]+)"/g)];
  for (const [, , title] of nativeItems) {
    assert.ok(members(ledger).some(row => row.owner === 'src-tauri/src/tray.rs' && row.anchor === `"${title}"`),
      `Missing native tray item: ${title}`);
  }
});

test('validator rejects omitted closed inspector/settings surfaces', () => {
  for (const family of ['panda.inspector', 'panda.settings.pages']) {
    const omitted = structuredClone(ledger);
    omitted.families.find(row => row.id === family).members.shift();
    assert.throws(() => checkClosedViews(omitted), /Missing inspector surface|Every settings/);
  }
});
