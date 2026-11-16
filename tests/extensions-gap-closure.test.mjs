import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Integrated gap closure (T60K): the machine-checked map from each of T60's 49 gap keys to the coverage block, adapter,
// catalog locations and passing evidence of T60A-T60J. T60's own retry flips its completionAudit dispositions; this file
// only proves that every key has a real delivery that the ledger, the source and the specs agree on.
const read = path => readFileSync(path, 'utf8');
const ledger = JSON.parse(read('tests/fixtures/extensions/surfaces.json'));

/** The 49 gap keys of the T60 failure record (extensibility-final-261113-v3yy), in the record's order. */
const GAPS = [
  'panda.workspace.views.tiles', 'panda.workspace.views.project-picker', 'panda.thread.attachments', 'panda.thread.find', 'panda.thread.changes',
  'panda.thread.usage-limit', 'panda.composer.model', 'panda.composer.permissions', 'panda.composer.queue', 'panda.composer.steering',
  'panda.composer.saver', 'panda.composer.council', 'panda.composer.wake', 'panda.composer.recipes', 'panda.commands.harness', 'panda.commands.slash',
  'panda.menus.team', 'panda.menus.attach', 'panda.menus.workspace-view', 'panda.menus.deploy', 'panda.menus.permissions', 'panda.menus.task',
  'panda.menus.sort', 'panda.menus.project-filter', 'panda.menus.bot-assignment', 'panda.menus.wake', 'panda.projections.bot-web',
  'src/bot-shared-channels.ts', 'src/bot-thread.ts', 'src/council-panel.ts', 'src/main.ts#architect-setup', 'src/main.ts#attach', 'src/main.ts#attach-file',
  'src/main.ts#bot-task-menu', 'src/main.ts#change-task-project', 'src/main.ts#mode', 'src/main.ts#model', 'src/main.ts#steer', 'src/main.ts#steer-clear',
  'src/main.ts#steer-edit', 'src/main.ts#team-menu', 'src/message-attachments.ts', 'src/message-queue.ts', 'src/recipes.ts', 'src/schedules-thread.ts',
  'src/token-saver-panel.ts', 'src/turn-changes.ts#open-turn-diff', 'src/usage-limit.ts', 'useCase:2',
];
const LEADS = ['T60A', 'T60B', 'T60C', 'T60D', 'T60E', 'T60F', 'T60G', 'T60H', 'T60I', 'T60J'];
const KINDS = ['adapter', 'projection-policy', 'enablement-scope'];

/** The same reference rule T60's own checker applies: top-level ledger keys, implementedAdapters ids and catalog surfaces. */
const known = value => new Set([...Object.keys(value), ...value.implementedAdapters.map(row => row.id), ...value.catalog.surfaces]);

function checkClosure(value, exists = existsSync) {
  const closure = value.gapClosure, resolvable = known(value);
  assert.equal(GAPS.length, 49);
  assert.deepEqual(Object.keys(closure.keys).sort(), [...GAPS].sort(), 'gapClosure must list exactly the 49 T60 gap keys');
  const adapters = new Map(value.implementedAdapters.map(row => [row.id, row]));
  const referenced = new Map();
  for (const [key, entry] of Object.entries(closure.keys)) {
    assert.ok(KINDS.includes(entry.kind), `${key}: unknown kind`);
    assert.ok(LEADS.includes(entry.lead), `${key}: unknown lead`);
    const block = value[entry.block]?.[entry.entry];
    assert.ok(block && typeof block === 'object', `${key}: ${entry.block} has no entry ${entry.entry}`);
    assert.ok(entry.block.endsWith('Coverage'), `${key}: ${entry.block} is not a coverage block`);
    assert.ok(Array.isArray(block.closes) && block.closes.includes(key), `${key}: not listed in closes of ${entry.block}/${entry.entry}`);
    assert.equal(block.lead, entry.lead, `${key}: lead differs from the coverage block`);
    assert.equal(block.adapter, entry.adapter, `${key}: adapter differs from the coverage block`);
    assert.ok(adapters.has(entry.adapter), `${key}: unknown implementedAdapters id ${entry.adapter}`);
    for (const surface of entry.catalog) assert.ok(value.catalog.surfaces.includes(surface), `${key}: unknown catalog surface ${surface}`);
    assert.deepEqual(entry.by, [entry.block, entry.adapter, ...entry.catalog], `${key}: by is the block, its adapter and its catalog surfaces`);
    for (const ref of entry.by) assert.ok(resolvable.has(ref), `${key}: unknown reference ${ref}`);
    assert.ok(entry.evidence.length >= 3, `${key}: evidence`);
    for (const path of entry.evidence) assert.ok(exists(path), `${key}: missing evidence ${path}`);
    for (const path of block.evidence) assert.ok(entry.evidence.includes(path), `${key}: drops the block's evidence ${path}`);
    // A closure is a delivery, never only an inspect-only entry.
    if (entry.kind === 'adapter') {
      assert.ok(entry.catalog.some(surface => !surface.endsWith('.protected')), `${key}: points only at protected/inspect-only entries`);
      assert.ok(block.members.length > 0 && block.protected.length > 0 && block.protectedControls.length > 0, `${key}: adapter without members and a protected list`);
    } else if (entry.kind === 'projection-policy') {
      assert.ok(block.projection?.length > 60 && entry.evidence.includes('src-tauri/src/extensions/projections.rs'), `${key}: projection policy without its native test`);
    } else {
      assert.ok(entry.evidence.includes('src-tauri/src/extensions/context.rs') && entry.evidence.includes('tests/extensions-project-scope.spec.ts'), `${key}: scope without its native admission`);
    }
    referenced.set(`${entry.block}/${entry.entry}`, [...referenced.get(`${entry.block}/${entry.entry}`) ?? [], key]);
  }
  // Every T60A-T60J coverage block closes only keys that gapClosure maps back to it.
  let blocks = 0;
  for (const [name, group] of Object.entries(value)) {
    if (!name.endsWith('Coverage') || typeof group !== 'object') continue;
    for (const [id, block] of Object.entries(group)) {
      if (!LEADS.includes(block?.lead) || !Array.isArray(block.closes)) continue;
      blocks++;
      assert.deepEqual([...block.closes].sort(), (referenced.get(`${name}/${id}`) ?? []).sort(), `${name}/${id}: closes and gapClosure disagree`);
    }
  }
  assert.equal(blocks, 10, 'T60A-T60J each own one coverage block');
  assert.equal(closure.status, 'closed');
  assert.ok(!('completionAudit' in value), 'T60 owns completionAudit and adds it when it is retried');
}

test('gapClosure lists exactly the 49 T60 gap keys and every reference, catalog surface and evidence path resolves', () => {
  checkClosure(ledger);
  assert.equal(Object.keys(ledger.gapClosure.keys).length, 49);
  assert.deepEqual(Object.keys(ledger).slice(0, 3), ['schemaVersion', 'controlsAudit', 'primitivesCoverage'], 'the first lines stay as the held T60 patch expects');
});

test('the checker fails on a missing or extra key, an unknown reference, a missing evidence path and a protected-only closure', () => {
  const mutate = change => { const copy = structuredClone(ledger); change(copy); return copy; };
  assert.throws(() => checkClosure(mutate(copy => { delete copy.gapClosure.keys['panda.composer.model']; })), /exactly the 49/);
  assert.throws(() => checkClosure(mutate(copy => { copy.gapClosure.keys['panda.composer.extra'] = copy.gapClosure.keys['panda.composer.model']; })), /exactly the 49/);
  assert.throws(() => checkClosure(mutate(copy => { copy.gapClosure.keys['panda.thread.find'].by.push('panda.thread.nowhere'); })), /by is the block|unknown reference/);
  assert.throws(() => checkClosure(mutate(copy => { copy.gapClosure.keys['panda.thread.find'].block = 'nowhereCoverage'; })), /has no entry/);
  assert.throws(() => checkClosure(mutate(copy => { copy.gapClosure.keys['panda.thread.find'].adapter = 'panda.not.an.adapter'; copy.gapClosure.keys['panda.thread.find'].by[1] = 'panda.not.an.adapter'; })), /adapter differs|unknown implementedAdapters/);
  assert.throws(() => checkClosure(mutate(copy => { copy.gapClosure.keys['panda.thread.find'].catalog = ['panda.thread.nowhere']; })), /unknown catalog surface/);
  assert.throws(() => checkClosure(ledger, path => path !== 'tests/extensions-thread-extras.test.mjs' && existsSync(path)), /missing evidence/);
  assert.throws(() => checkClosure(mutate(copy => { const entry = copy.gapClosure.keys['panda.thread.find']; entry.catalog = ['panda.thread.extras.protected']; entry.by = [entry.block, entry.adapter, ...entry.catalog]; })), /only at protected/);
  assert.throws(() => checkClosure(mutate(copy => { copy.threadCoverage['panda.thread.extras'].closes = copy.threadCoverage['panda.thread.extras'].closes.filter(key => key !== 'panda.thread.find'); })), /not listed in closes/);
  assert.throws(() => checkClosure(mutate(copy => { copy.threadCoverage['panda.thread.extras'].closes.push('panda.thread.invented'); })), /closes and gapClosure disagree/);
  assert.throws(() => checkClosure(mutate(copy => { copy.completionAudit = {}; })), /owns completionAudit/);
});

/** One row per family: where the audit confirms clicked actions, refusals and the protected list. */
const FAMILIES = [
  ['composerCoverage', 'panda.composer.controls', 'composer-controls', 'extensions-composer-controls-coverage', 'composer-core', 'composer-host', 'COMPOSER_PROTECTED_CONTROLS', 'extensions-composer-controls'],
  ['composerCoverage', 'panda.composer.panels', 'composer-panels', 'extensions-composer-panels-coverage', 'composer-panels-core', 'composer-panels-host', 'PANEL_PROTECTED_CONTROLS', 'extensions-composer-panels'],
  ['composerCoverage', 'panda.composer.attach', 'composer-attach', 'extensions-attach-wake-coverage', 'composer-attach-core', 'composer-attach-host', 'ATTACH_PROTECTED_CONTROLS', 'extensions-attach-wake'],
  ['threadCoverage', 'panda.thread.extras', 'thread-extras', 'extensions-thread-extras-coverage', 'thread-extras-core', 'thread-extras-host', 'THREAD_EXTRAS_PROTECTED_CONTROLS', 'extensions-thread-extras'],
  ['viewsCoverage', 'panda.workspace.tiles-picker', 'tiles-picker', 'extensions-tiles-picker-coverage', 'tiles-picker-core', 'tiles-picker-host', 'PICKER_PROTECTED_CONTROLS', 'extensions-tiles-picker'],
  ['commandsCoverage', 'panda.commands.extras', 'commands-extras', 'extensions-commands-extras-coverage', 'commands-core', 'commands-host', 'COMMANDS_PROTECTED_CONTROLS', 'extensions-commands-extras'],
  ['taskMenusCoverage', 'panda.menus.task', 'task-menus', 'extensions-task-menus-coverage', 'task-menus-core', 'task-menus-host', 'TASK_MENUS_PROTECTED_CONTROLS', 'extensions-task-menus'],
  ['windowMenusCoverage', 'panda.menus.window', 'window-menus', 'extensions-window-menus-coverage', 'window-menus-core', 'window-menus-host', 'WINDOW_MENUS_PROTECTED_CONTROLS', 'extensions-window-menus'],
  ['botConversationCoverage', 'panda.bot.conversation', 'bot-conversation', 'extensions-bot-conversation-coverage', 'bot-conversation-core', 'bot-conversation-host', 'BOT_CONVERSATION_PROTECTED_CONTROLS', 'extensions-bot-conversation'],
];

test('each family spec clicks its fixture package\'s contributed actions and refuses its protected controls with PermissionDenied', () => {
  for (const [block, entry, fixture, spec, core, host, constant, node] of FAMILIES) {
    const ledgerEntry = ledger[block][entry];
    const manifest = JSON.parse(read(`tests/fixtures/extensions/${fixture}/extension.json`));
    const text = read(`tests/${spec}.spec.ts`), nodeText = read(`tests/${node}.test.mjs`);
    const commands = new Map(manifest.contributes.commands.map(command => [command.id, command.title]));
    assert.ok(text.includes('.click()'), `${spec}: clicks nothing`);
    // Every contributed menu item is addressed by its title or its contribution id in the spec that clicks it.
    for (const menu of manifest.contributes.menus) {
      const local = menu.id.split('/')[1], title = commands.get(menu.command);
      assert.ok([`'${title}'`, `'${local}'`, `/${local}"`, `/${local}\``].some(token => text.includes(token)), `${spec}: never reaches ${menu.id} (${title})`);
    }
    for (const slash of manifest.contributes.slashCommands ?? []) assert.ok(text.includes(slash.name), `${spec}: never types ${slash.name}`);
    // Protected controls: refused as PermissionDenied in the browser spec and in the family's core test over the whole list.
    assert.ok(/reason: 'PermissionDenied'/.test(text), `${spec}: no PermissionDenied refusal`);
    assert.ok(nodeText.includes(constant) && /PermissionDenied/.test(nodeText), `${node}: protected controls are not dispatched`);
    const coreText = read(`src/extensions/${core}.ts`);
    for (const id of ledgerEntry.protectedControls) assert.ok(coreText.includes(`'${id}'`), `${core}: ${id} is not in the protected list`);
    assert.ok(existsSync(`src/extensions/${host}.ts`), host);
    // The closed gap's own source owners exist.
    for (const key of ledgerEntry.closes) if (key.startsWith('src/')) assert.ok(existsSync(key.split('#')[0]), key);
  }
});

test('project scope: native admission, services, storage, windows and updates refuse or filter outside the scope', () => {
  const natives = [
    ['src-tauri/src/extensions/context.rs', ['project_scope_refuses_captures_and_context_reads_outside_scope_and_keeps_the_captured_project', 'project_scope_gates_runtime_activation_and_storage_bindings_by_captured_project', '$.projectScope']],
    ['src-tauri/src/extensions/services.rs', ['service_calls_are_refused_when_the_consumer_or_provider_scope_excludes_the_captured_project']],
    ['src-tauri/src/extensions/updates.rs', ['project_scope_survives_restart_disable_safe_mode_update_and_rollback_and_legacy_records_mean_all']],
    ['src-tauri/src/extensions/windows.rs', ['project_scoped_packages_contribute_nothing_to_project_less_auxiliary_windows']],
  ];
  for (const [path, tokens] of natives) for (const token of tokens) assert.ok(read(path).includes(token), `${path}: ${token}`);
  // The families' declarative contributions run nothing natively: the webview withholds them for another project.
  const manager = read('src/extensions/manager.ts');
  assert.ok(manager.includes('scopeWithheld: true') && manager.includes('packageInScope'));
  for (const name of ['composer-controls', 'composer-panels', 'composer-attach', 'thread-extras', 'tiles-picker', 'commands-extras', 'task-menus', 'window-menus', 'bot-conversation']) {
    const manifest = JSON.parse(read(`tests/fixtures/extensions/${name}/extension.json`));
    const kinds = new Set(manifest.contributes.commands.map(command => command.action.kind));
    assert.ok([...kinds].every(kind => ['showMessage', 'showDialog', 'openView', 'runCommand'].includes(kind)), `${name}: ${[...kinds]}`);
    assert.ok(![...kinds].includes('runCommand') && !manifest.runtime, `${name}: a family fixture executes nothing`);
  }
});

test('the nine family fixtures and the T60A fixture install together without a duplicated id, location owner or slash name', () => {
  const names = ['sample-project-helper', 'composer-controls', 'composer-panels', 'composer-attach', 'thread-extras', 'tiles-picker', 'commands-extras', 'task-menus', 'window-menus', 'bot-conversation'];
  const manifests = names.map(name => JSON.parse(read(`tests/fixtures/extensions/${name}/extension.json`)));
  assert.equal(new Set(manifests.map(manifest => manifest.id)).size, manifests.length);
  const ids = manifests.flatMap(manifest => ['commands', 'menus', 'layouts', 'components', 'views', 'slashCommands'].flatMap(kind => (manifest.contributes[kind] ?? []).map(item => `${kind}:${item.id}`)));
  assert.equal(new Set(ids).size, ids.length, 'a contribution id is declared twice');
  const slash = manifests.flatMap(manifest => (manifest.contributes.slashCommands ?? []).map(command => command.name));
  assert.equal(new Set(slash).size, slash.length);
  // Every id belongs to its own package namespace.
  for (const manifest of manifests) for (const kind of ['commands', 'menus', 'layouts', 'components', 'views', 'slashCommands']) for (const item of manifest.contributes[kind] ?? []) assert.ok(item.id.startsWith(`${manifest.id}/`), item.id);
  // No two packages arrange or contribute to a host location with the same layout id.
  const locations = manifests.flatMap(manifest => (manifest.contributes.layouts ?? []).map(layout => `${layout.location}|${layout.id}`));
  assert.equal(new Set(locations).size, locations.length);
});

test('the gap-closure spec is registered in both Playwright configs and in CI, beside every family spec', () => {
  const specs = ['extensions-gap-closure', ...FAMILIES.map(row => row[3])];
  const chromium = read('playwright.config.ts'), webkit = read('playwright.webkit.config.ts'), ci = read('.github/workflows/ci.yml');
  for (const spec of specs) {
    assert.ok(chromium.includes(`**/${spec}.spec.ts`), `playwright.config.ts: ${spec}`);
    assert.ok(webkit.includes(`**/${spec}.spec.ts`), `playwright.webkit.config.ts: ${spec}`);
    assert.equal([...ci.matchAll(new RegExp(`tests/${spec}\\.spec\\.ts`, 'g'))].length, 2, `ci.yml: ${spec} in the Chromium and the WebKit step`);
  }
  assert.ok(webkit.includes('Gap closure extension:'), 'the WebKit grep selects the spec titles');
});

test('the held T60 patch hunk context stays: the first five ledger lines are unchanged', () => {
  const head = read('tests/fixtures/extensions/surfaces.json').split(/\r?\n/).slice(0, 5);
  assert.deepEqual(head.slice(0, 3), ['{', '  "schemaVersion": 1,', '  "controlsAudit": {']);
  assert.match(head[3], /^ {4}"task": "extensibility-final-261113-v3yy\/T56I",$/);
  assert.match(head[4], /^ {4}"status": "accepted",$/);
});
