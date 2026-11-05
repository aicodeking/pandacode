import test from 'node:test';
import assert from 'node:assert/strict';
import { quickAnswerHtml } from '../src/quick-answer.ts';
test('explicit Yes/No questions offer radio choices without a default answer', () => {
  const html = quickAnswerHtml('Does it contain explicit lyrics—Yes or No?\nPlease confirm.', 42);
  assert.match(html, /type="radio"/);
  assert.match(html, /value="Yes"/);
  assert.match(html, /value="No"/);
  assert.match(html, /Send answer/);
  assert.doesNotMatch(html, /checked/);
  assert.equal(quickAnswerHtml('The answer was Yes or No.', 1), '');
  assert.equal(quickAnswerHtml('```\nYes or No?\n```', 1), '');
});
