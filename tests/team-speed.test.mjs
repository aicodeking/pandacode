import test from 'node:test';
import assert from 'node:assert/strict';
import { keepSpeed, modelSpeedTiers, namedTeamSetup, speedOptions } from '../src/team-mode.ts';

// Real shapes from the Codex catalog: GPT-6.1 Sol and GPT-6 Astra list Fast and Ultrafast, GPT-6 Luna
// only Fast, GPT-5.6 Sol none; Nova 9 is a fictional model with a fictional tier. Keys come from native.
const tier = (id, name, key, description) => ({ id, key, name, description });
const FAST = tier('priority', 'Fast', 'fast', '2x speed, increased usage');
const ULTRAFAST = tier('ultrafast', 'Ultrafast', 'ultrafast', 'The fastest available responses.');
const TURBO = tier('turbo', 'Turbo Max', 'turbo-max', 'Fictional "max" & <fast>.');
const providers = [
  { id: 'codex', models: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: '', speedTiers: [FAST, ULTRAFAST] },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: '', speedTiers: [FAST, ULTRAFAST] },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: '', speedTiers: [FAST] },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: '' },
    { id: 'nova-9', name: 'Nova 9', description: '', speedTiers: [TURBO] },
  ] },
  { id: 'claude', models: [{ id: 'opus', name: 'Opus', description: '' }] },
];
const labels = html => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);

test('the Speed select lists Default plus exactly the tiers the model\'s catalog reports', () => {
  const options = model => labels(speedOptions(modelSpeedTiers(providers, 'codex', model)));
  assert.deepEqual(options('gpt-6.1-sol'), [['', 'Default'], ['fast', 'Fast'], ['ultrafast', 'Ultrafast']]);
  assert.deepEqual(options('gpt-6-astra'), [['', 'Default'], ['fast', 'Fast'], ['ultrafast', 'Ultrafast']]);
  assert.deepEqual(options('gpt-6-luna'), [['', 'Default'], ['fast', 'Fast']]);
  assert.deepEqual(options('nova-9'), [['', 'Default'], ['turbo-max', 'Turbo Max']]);
  // No tiers: no Speed control at all (other harnesses and unknown models alike).
  assert.equal(speedOptions(modelSpeedTiers(providers, 'codex', 'gpt-5.6-sol')), '');
  assert.equal(speedOptions(modelSpeedTiers(providers, 'claude', 'opus')), '');
  assert.equal(speedOptions(modelSpeedTiers(providers, 'codex', 'gone')), '');
  // The catalog's description is the option's title, escaped; the saved tier is selected.
  const html = speedOptions(modelSpeedTiers(providers, 'codex', 'nova-9'), 'turbo-max');
  assert.match(html, /value="turbo-max" title="Fictional &#34;max&#34; &#38; &#60;fast&#62;\." selected/);
  // Never an option the catalog lacks: a stale saved tier selects Default, and no tiers means no control.
  assert.deepEqual(labels(speedOptions(modelSpeedTiers(providers, 'codex', 'gpt-6-luna'), 'ultrafast')), [['', 'Default'], ['fast', 'Fast']]);
  assert.match(speedOptions(modelSpeedTiers(providers, 'codex', 'gpt-6-luna'), 'ultrafast'), /value="" title="[^"]*" selected/);
  assert.equal(speedOptions([], 'fast'), '');
  assert.equal(speedOptions(modelSpeedTiers(providers, 'codex', 'gpt-5.6-sol'), 'ultrafast'), '');
});

test('after a live catalog load, a stale saved tier leaves the selection and shows only in the note', () => {
  // As the classic setup does once a harness's live catalog arrives (no earlier names known).
  const tiers = modelSpeedTiers(providers, 'codex', 'gpt-6-luna');
  const kept = keepSpeed('ultrafast', tiers, 'gpt-6-luna');
  assert.deepEqual(kept, { tier: null, note: 'Ultrafast is not available for gpt-6-luna; this worker will use the default speed only if you save it that way.' });
  const html = speedOptions(tiers, kept.tier);
  assert.ok(!html.includes('ultrafast') && !html.includes('not in the catalog'), html);
  // A model whose catalog lists no tiers hides Speed entirely, and its stale tier is noted too.
  const none = keepSpeed('fast', modelSpeedTiers(providers, 'codex', 'gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(none.tier, null);
  assert.equal(speedOptions(modelSpeedTiers(providers, 'codex', 'gpt-5.6-sol'), none.tier), '');
});

test('changing the model drops a tier the new model lacks, with a one-line note', () => {
  const tiers = model => modelSpeedTiers(providers, 'codex', model);
  assert.deepEqual(keepSpeed('fast', tiers('gpt-6-luna'), 'gpt-6-luna', tiers('gpt-6.1-sol')), { tier: 'fast', note: '' });
  const later = ' this worker will use the default speed only if you save it that way.';
  assert.deepEqual(keepSpeed('ultrafast', tiers('gpt-6-luna'), 'gpt-6-luna', tiers('gpt-6.1-sol')), { tier: null, note: `Ultrafast is not available for gpt-6-luna;${later}` });
  assert.deepEqual(keepSpeed('turbo-max', tiers('gpt-5.6-sol'), 'gpt-5.6-sol', tiers('nova-9')), { tier: null, note: `Turbo Max is not available for gpt-5.6-sol;${later}` });
  assert.deepEqual(keepSpeed('fast', [], 'opus'), { tier: null, note: `Fast is not available for opus;${later}` });
  assert.deepEqual(keepSpeed(null, [], 'opus'), { tier: null, note: '' });
});

test('a named team saves the chosen tier key for Codex workers only, as native will check it', () => {
  const lead = { provider: 'codex', harness: 'Codex', model: 'nova-9', name: 'Nova 9', serviceTier: 'turbo-max', speedTiers: [TURBO] };
  const claude = { provider: 'claude', harness: 'Claude Code', model: 'opus', name: 'Opus', serviceTier: 'fast' };
  const { config } = namedTeamSetup('Quick', lead, [lead, claude]);
  assert.equal(config.workers[0].serviceTier, 'turbo-max');
  assert.equal('serviceTier' in config.workers[1], false);
});
