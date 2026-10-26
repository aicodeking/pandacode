import test from 'node:test';
import assert from 'node:assert/strict';
import { brandFor, brandChipHtml } from '../src/trace-brands.ts';

test('brandFor matches MCP names and URLs', () => {
  for (const [input, id] of [
    ['slack', 'slack'], ['claude_ai_Slack', 'slack'], ['GMAIL', 'gmail'], ['google-drive', 'gdrive'], ['gcal', 'gcal'], ['google_calendar', 'gcal'],
    ['atlassian', 'jira'], ['box', 'box'], ['dropbox', 'dropbox'], ['https://acme.slack.com/archives/C1', 'slack'],
    ['https://mail.google.com/mail/u/0/', 'gmail'], ['https://github.com/a/b/commit/1', 'github'], ['linear.app/acme/issue/X-1', 'linear'],
    ['https://notion.so/x', 'notion'], ['https://www.granola.ai/n', 'granola'], ['mcp-github', 'github'],
  ]) assert.equal(brandFor(input)?.id, id, input);
  for (const input of ['', 'https://example.com', 'unknown-server', 'https://evilgithub.com']) assert.equal(brandFor(input), undefined, input);
});

test('brandChipHtml escapes the label', () => {
  const html = brandChipHtml(brandFor('slack'), '<img onerror=x>');
  assert.match(html, /^<span class="trace-brand-chip"><svg /);
  assert.ok(html.includes('<b>&lt;img onerror=x&gt;</b>'));
});
