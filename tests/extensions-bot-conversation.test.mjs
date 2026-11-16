import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBotConversationControls, snapshotBotConversation, BOT_CONVERSATION_CONTROL_IDS, BOT_CONVERSATION_CHOICE_CONTROLS, BOT_CONVERSATION_PROTECTED_CONTROLS, BOT_CONVERSATION_REGISTRY } from '../src/extensions/bot-conversation-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { BOT_CONVERSATION_ACTION_SURFACES, BOT_THREAD_CONTROLS, BOT_CHANNEL_CONTROLS, BOT_CONVERSATION_PINNED, BOT_CONVERSATION_FIXED, BOT_CONVERSATION_PROTECTED, BOT_THREAD_LOCATION, BOT_CHANNEL_LOCATION, BOT_CONVERSATION_PROTECTED_LOCATION, SIDEBAR_ACTION_SURFACES } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/bot-conversation/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.bot-conversation/timeline', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.projections.bot-web', 'src/bot-thread.ts', 'src/bot-shared-channels.ts'];
const CONTROLS = [[BOT_THREAD_LOCATION, BOT_THREAD_CONTROLS], [BOT_CHANNEL_LOCATION, BOT_CHANNEL_CONTROLS]];

test('Bot conversation registry: each owned gap has public locations, operations and an extension hook in its source, and the ledger closes exactly the three gaps', () => {
  assert.deepEqual(BOT_CONVERSATION_REGISTRY.map(entry => [entry.member, entry.source]), [['src/bot-thread.ts', 'src/bot-thread.ts'], ['src/bot-shared-channels.ts', 'src/bot-shared-channels.ts'], ['panda.projections.bot-web', 'src-tauri/src/bots.rs']]);
  for (const entry of BOT_CONVERSATION_REGISTRY) {
    assert.ok(entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
  }
  for (const entry of BOT_CONVERSATION_REGISTRY.slice(0, 2)) {
    assert.ok(entry.actions && entry.order && entry.hide, entry.member);
    // T60's audit found no extension hook in these owners (rg -c "extension" = 0); each now draws the user's layout.
    assert.match(read(`../${entry.source}`), /extension layout/, entry.source);
    assert.match(read(`../${entry.source}`), /BotConversationLayout/, entry.source);
  }
  // The projection's policy lives beside its token boundary.
  assert.match(read('../src-tauri/src/bots.rs'), /pub\(crate\) fn web_projection\(/);
  assert.match(read('../src-tauri/src/bots/channels/web.rs'), /projections::bot_web_for\(app\)/);
  assert.match(read('../src-tauri/src/extensions/projections.rs'), /fn bot_web_projection_never_forwards_package_actions_contributions_or_desktop_html/);
  assert.ok(ledger.families.find(family => family.id === 'panda.projections').members.some(([id, owner]) => id === 'bot-web' && owner === 'src-tauri/src/bots.rs'));
  assert.deepEqual([...BOT_CONVERSATION_CONTROL_IDS], schema.$defs.botConversationControlId.enum);
  const row = ledger.botConversationCoverage['panda.bot.conversation'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.bot.conversation'); assert.equal(row.lead, 'T60J');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: every other coverage block keeps its own keys.
  for (const [key, block] of Object.entries(ledger).filter(([key]) => key.endsWith('Coverage'))) for (const [id, entry] of Object.entries(block)) if (!(key === 'botConversationCoverage' && id === 'panda.bot.conversation')) assert.equal([entry?.closes ?? []].flat().filter(gap => GAPS.includes(gap)).length, 0, `${key}.${id}`);
  assert.deepEqual(row.members, [...BOT_CONVERSATION_CONTROL_IDS]);
  assert.deepEqual(row.threadControls, BOT_THREAD_CONTROLS.map(([id]) => id)); assert.deepEqual(row.channelControls, BOT_CHANNEL_CONTROLS.map(([id]) => id));
  assert.deepEqual(row.pinned, Object.keys(BOT_CONVERSATION_PINNED)); assert.deepEqual(row.fixed, Object.keys(BOT_CONVERSATION_FIXED));
  assert.deepEqual(row.protected, BOT_CONVERSATION_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...BOT_CONVERSATION_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'conflict', 'move', 'replacement', 'projection', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.bot.conversation').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.bot.conversation').tests.includes('tests/extensions-bot-conversation-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-bot-conversation-coverage\.spec\.ts/);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/extensions/bot-conversation-host.ts'), ['src/extensions/bot-conversation-host.ts', [], 0, 1]);
  assert.ok(ledger.families.find(family => family.id === 'panda.menus').members.some(([id, owner]) => id === 'bot-conversation-extension-entry' && owner === 'src/extensions/bot-conversation-host.ts'));
  // The original actions keep their inventory rows; nothing new is a host action.
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/bot-thread.ts'), ['src/bot-thread.ts', ['bot-pause', 'bot-settings', 'suggest'], 0, 0]);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/bot-shared-channels.ts')[1], ['cancel', 'continue', 'earlier', 'reassign', 'reassign-toggle', 'settings-cancel', 'shared-channel-settings', 'stop']);
  // main.ts draws the layout and mounts the adoption once extensions load; the docs declare the web projection policy.
  const main = read('../src/main.ts');
  assert.match(main, /mountBotConversationAdoption\(\{/);
  for (const call of ['welcomeHtml(bot, botConversation?.threadLayout())', 'layout: botConversation?.threadLayout()', 'sharedChannelThreadHtml(channel, sidebarBots, botConversation?.channelLayout())', 'sharedChannelActionsHtml(channel, sidebarBots, botConversation?.channelLayout())']) assert.ok(main.includes(call), call);
  const docs = read('../docs/extensions/bot-conversation.md');
  assert.match(docs, /## Bot web chat projection/); assert.match(docs, /withheld/); assert.match(docs, /UnsupportedCapability: the bot web chat is a text-only projection/);
  assert.ok(read('../src-tauri/src/extensions/projections.rs').includes(docs.match(/`(UnsupportedCapability: the bot web chat[^`]+)`/)[1]));
});

test('Bot conversation schema, selection kinds, package, catalog operations, protected items and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const [kind, surfaceId, ids] of [['bot', 'panda.bot.thread.actions', ['bot-1']], ['channel', 'panda.bot.channel.actions', ['channel-1']]]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: 'task-1', revision: 1, selection: { kind, ids } }).ok, true, kind);
  }
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.bot.thread.actions', revision: 1, selection: { kind: 'bot-message', ids: ['m'] } }).ok, false);
  // New slots, distinct from the sidebar's bot and channel menus.
  assert.deepEqual([...BOT_CONVERSATION_ACTION_SURFACES], ['panda.bot.thread.actions', 'panda.bot.channel.actions']);
  for (const location of BOT_CONVERSATION_ACTION_SURFACES) { assert.ok(!SIDEBAR_ACTION_SURFACES.includes(location)); assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  for (const [location] of CONTROLS) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of [BOT_CONVERSATION_PROTECTED_LOCATION, 'panda.bot', 'panda.bot.thread']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreign = structuredClone(manifest); foreign.contributes.layouts[0].rules[0].id = 'panda.bot.channel.controls/reassign'; assert.equal(validateContract('packages', [foreign]).ok, false);
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute', 'tasks.transcript.read', 'tasks.tools.read']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of BOT_CONVERSATION_ACTION_SURFACES) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  for (const [location] of CONTROLS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: BOT_CONVERSATION_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  // Pinned controls never hide but still reorder; fixed ones hide in place; Stop and Show earlier messages are inspect-only.
  for (const [location, controls] of CONTROLS) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) {
      const pinned = BOT_CONVERSATION_PINNED[item.id], fixed = BOT_CONVERSATION_FIXED[item.id];
      assert.deepEqual(item.supportedOperations, pinned && fixed ? ['inspect'] : pinned ? ['inspect', 'reorder'] : fixed ? ['inspect', 'hide', 'show'] : ['inspect', 'hide', 'show', 'reorder'], item.id);
      if (pinned || fixed) assert.match(item.label, / — .{20,}/);
    }
  }
  assert.deepEqual(catalog.listItems({ location: BOT_CHANNEL_LOCATION, limit: 100 }).items.find(item => item.id.endsWith('/stop')).supportedOperations, ['inspect']);
  const protectedItems = catalog.listItems({ location: BOT_CONVERSATION_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), BOT_CONVERSATION_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]), [
    ['sample.bot-conversation/channel', 'panda.bot.channel.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.bot-conversation/thread', 'panda.bot.thread.actions', ['inspect', 'hide', 'show', 'reorder']],
  ]);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  const layoutIds = CONTROLS.flatMap(([location, controls]) => controls.map(([id]) => `${location}/${id}`));
  for (const id of layoutIds.filter(id => !BOT_CONVERSATION_PINNED[id])) { layout.setVisible(id, false); assert.equal(layout.isHidden(id), true); layout.setVisible(id, true); assert.equal(layout.isHidden(id), false); }
  const pair = ['continue', 'reassign'].map(id => `${BOT_CHANNEL_LOCATION}/${id}`); layout.move(BOT_CHANNEL_LOCATION, pair, { id: pair[1], target: pair[0], side: 'before' }); assert.equal(layout.order(BOT_CHANNEL_LOCATION, pair)[0], pair[1]);
  // Bounded JSON only: no names, message text, drafts, tokens or HTML cross the presentation.
  const state = fixture('state');
  assert.equal(validateContract('botConversationPresentation', state).ok, true); assert.equal(validateContract('botConversationAction', fixture('action')).ok, true);
  for (const change of [{ controls: Array(129).fill(state.controls[0]) }, { selector: '#breadcrumb' }, { text: 'hello' }, { draft: 'x' }, { name: 'Scout' }, { token: 'abc' }, { html: '<b>' }, { view: 'web' }, { window: 'tray' }, { contractVersion: 2 }, { bot: 'x'.repeat(257) }]) assert.equal(validateContract('botConversationPresentation', { ...state, ...change }).ok, false, JSON.stringify(change).slice(0, 40));
  for (const extra of [{ label: 'Pause Scout' }, { text: 'What can you help me with?' }]) assert.equal(validateContract('botConversationPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  assert.throws(() => snapshotBotConversation({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});

test('Bot conversation binds owner/window/mount/project/bot/session/channel/revision, resources, busy, hidden, protected controls and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createBotConversationControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'bot', 'session', 'channel', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { controlId: 'channel-settings' }, { resource: 'channel-b' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.id !== 'control-earlier') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/timeline'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.bot-conversation/timeline';
  // Stop, deletion, credentials, settings and membership changes, sending and the draft are named as protected and never run.
  for (const controlId of BOT_CONVERSATION_PROTECTED_CONTROLS) for (const control of ['control-earlier', 'control-pause', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, text: 'stop everything' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '#breadcrumb' }, { controlId: 'bot-open' }, { text: 'hello' }, { token: 'abc' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Bot conversation never pauses, opens settings, writes the draft, continues or reassigns without a fresh host choice, and no protected behavior is a public control', () => {
  const state = fixture('state');
  for (const control of state.controls.filter(item => BOT_CONVERSATION_CHOICE_CONTROLS.includes(item.controlId))) {
    const slot = createBotConversationControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource }).reason, 'PermissionDenied', control.controlId);
  }
  // Showing earlier messages and opening the Reassign menu only reveal what the host draws.
  const opened = [], slot = createBotConversationControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), action => opened.push(action.controlId));
  for (const control of state.controls.filter(item => !BOT_CONVERSATION_CHOICE_CONTROLS.includes(item.controlId))) assert.deepEqual(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource, requestId: control.id }), { ok: true });
  assert.deepEqual(opened, ['channel-earlier', 'channel-reassign-open']);
  for (const id of [...BOT_CONVERSATION_PROTECTED.map(([id]) => id), ...BOT_CONVERSATION_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.botConversationControlId.enum.includes(id), id);
  assert.deepEqual(BOT_CONVERSATION_CHOICE_CONTROLS, ['bot-pause', 'bot-settings', 'bot-suggest', 'channel-continue', 'channel-reassign', 'channel-settings']);
});

test('Bot conversation layout reaches the original renderers only when arranged: zero extensions draw the same header, welcome and channel controls', () => {
  const thread = read('../src/bot-thread.ts'), channels = read('../src/bot-shared-channels.ts');
  // Without a layout every renderer draws what it always drew: no layout attribute, the built-in order.
  for (const source of [thread, channels]) assert.match(source, /layout\?\.hidden\.includes\(id\) \? ' data-layout-hidden inert' : ''/);
  assert.match(thread, /const order = layout \? \[\.\.\.layout\.order/);
  assert.match(channels, /const order = layout \? \[\.\.\.layout\.order/);
  // Stop keeps its place first; the Reassign menu stays right after its toggle in either order.
  assert.match(channels, /\$\{stop\}\$\{stoppedRow\}/);
  assert.match(channels, /reassign: `<button type="button" class="secondary-button" data-shared-action="reassign-toggle"[^`]+<div class="bc-reassign-menu" hidden\$\{hidden\}>/);
});
