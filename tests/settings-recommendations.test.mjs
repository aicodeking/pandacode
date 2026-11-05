import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendations, recommendationSummary } from '../src/settings-recommendations.ts';

const facts = over => ({ agentInstalled: true, updateMode: 'automatic', telemetryOff: true, routingOn: true, turnChecks: false, connectSignedIn: false, ...over });
const row = (list, id) => list.find(item => item.id === id);

test('every setting reads its own fact', () => {
  const list = recommendations(facts({ agentInstalled: false, updateMode: 'notify', telemetryOff: false, routingOn: false, turnChecks: true, connectSignedIn: true }));
  assert.equal(row(list, 'agent').done, false);
  assert.equal(row(list, 'updates').done, false);
  assert.equal(row(list, 'telemetry').done, false);
  assert.equal(row(list, 'routing').done, false);
  assert.equal(row(list, 'checks').done, true);
  assert.equal(row(list, 'connect').done, true);
});

test('a build that cannot update itself is not told to', () => {
  assert.equal(row(recommendations(facts({ updateMode: null })), 'updates'), undefined);
});

test('a status that could not be read says nothing, and is not counted', () => {
  const list = recommendations(facts({ telemetryOff: null, routingOn: null }));
  assert.equal(row(list, 'telemetry').done, null);
  assert.equal(recommendationSummary(list), 'All set');
});

test('the summary counts only what everyone should set', () => {
  // Project checks run with your credentials and Connect needs an account: never counted as unfinished.
  assert.equal(recommendationSummary(recommendations(facts({}))), 'All set');
  assert.equal(recommendationSummary(recommendations(facts({ routingOn: false }))), '3 of 4 set');
  assert.equal(recommendationSummary(recommendations(facts({ agentInstalled: false, updateMode: null, telemetryOff: false, routingOn: false }))), '0 of 3 set');
});

test('only settings that can do harm are optional, and every row names a page', () => {
  const list = recommendations(facts({}));
  assert.deepEqual(list.filter(item => item.optional).map(item => item.id), ['checks', 'connect', 'github']);
  for (const item of list) assert.ok(item.page && item.title && item.why);
  assert.equal(row(list, 'telemetry').fold, 'Advanced');
});
