import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document ??= { documentElement: { dataset: {} } };
import { FEATURE_REQUEST_URL_LIMIT, issueDraft, issueUrl, requestProblem } from '../src/feature-requests.ts';

const BASE = 'https://github.com/aicodeking/pandacode/issues/new?template=feature_request.yml';

test('issueUrl fills the feature request template and leaves the proposal to the user', () => {
  const url = issueUrl('Dark mode for tool rows', 'Rows are hard to read at night.');
  assert.ok(url.startsWith(`${BASE}&title=`));
  assert.ok(url.endsWith('&proposal='));
  const params = new URL(url).searchParams;
  assert.equal(params.get('template'), 'feature_request.yml');
  assert.equal(params.get('title'), 'Dark mode for tool rows');
  assert.equal(params.get('problem'), 'Rows are hard to read at night.');
  assert.equal(params.get('proposal'), '');
});

test('issueUrl encodes reserved characters, newlines and non-ASCII text', () => {
  const title = 'Export & share: a/b?c=d #1';
  const description = 'Line one\nLine two\n\n- bullet “quoted” ü 日本語 & more=1';
  const params = new URL(issueUrl(title, description)).searchParams;
  assert.equal(params.get('title'), title);
  assert.equal(params.get('problem'), description);
  assert.deepEqual([...params.keys()], ['template', 'title', 'problem', 'proposal']);
});

test('issueUrl trims the text it sends', () => {
  const params = new URL(issueUrl('  A title  ', '\n  Details here \n')).searchParams;
  assert.equal(params.get('title'), 'A title');
  assert.equal(params.get('problem'), 'Details here');
});

test('a long description is cut so the URL stays under the limit', () => {
  const description = 'word '.repeat(2000);
  const draft = issueDraft('Long one', description);
  assert.equal(draft.shortened, true);
  assert.ok(draft.url.length <= FEATURE_REQUEST_URL_LIMIT, `${draft.url.length} characters`);
  const problem = new URL(draft.url).searchParams.get('problem');
  assert.ok(problem.endsWith('…'));
  assert.ok(description.trim().startsWith(problem.slice(0, -1)));
  assert.ok(problem.length > 1000, 'keeps as much text as fits');
});

test('text that fits is never marked as shortened', () => {
  const draft = issueDraft('Short', 'Fits easily.');
  assert.equal(draft.shortened, false);
  assert.equal(draft.url, issueUrl('Short', 'Fits easily.'));
});

test('the cut never splits a surrogate pair or an escape sequence', () => {
  const description = '😀'.repeat(3000);
  const draft = issueDraft('Emoji', description);
  assert.ok(draft.url.length <= FEATURE_REQUEST_URL_LIMIT);
  const problem = new URL(draft.url).searchParams.get('problem');
  assert.doesNotMatch(problem, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.doesNotMatch(problem, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.doesNotThrow(() => decodeURIComponent(draft.url.slice(draft.url.indexOf('&problem='))));
});

test('the longest allowed title and description still produce a valid URL', () => {
  const draft = issueDraft('t'.repeat(120), 'é'.repeat(4000));
  assert.ok(draft.url.length <= FEATURE_REQUEST_URL_LIMIT);
  assert.equal(new URL(draft.url).searchParams.get('title').length, 120);
});

test('requestProblem names the first empty field and accepts a full request', () => {
  assert.equal(requestProblem('', 'text'), 'Add a title');
  assert.equal(requestProblem('   ', 'text'), 'Add a title');
  assert.equal(requestProblem('Title', ''), 'Add a description');
  assert.equal(requestProblem('Title', ' \n '), 'Add a description');
  assert.equal(requestProblem('Title', 'text'), '');
});
