/* Test-runner output → TestSummary (node:test, Playwright, Vitest, Jest, cargo, pytest, go test) and its markup.
 * Pure and total: unparseable output simply has no summary. Re-exported by shell-intent.ts. */
import { escape } from './dom.ts';
import { clip, stripAnsi } from './tool-text.ts';

export interface TestSummary {
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs?: number;
  /** Up to five failing test names. */
  failures: string[];
}

const MAX_OUTPUT = 200_000;
const MAX_FAILURES = 5;
/** Failure names come from lines clipped to this length, so a lazy `(.+?)` before trailing blanks never scans far. */
const MAX_LINE = 400;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const toMs = (value: string, unit: string) => Math.round(Number(value) * (UNIT_MS[unit] ?? 1000));

/** Up to five names captured by `patterns` (single-line, unflagged), one clipped non-blank line at a time. */
function collect(text: string, patterns: RegExp[], skip: RegExp = /^$/): string[] {
  const names: string[] = [];
  const lines = text.split('\n').filter(line => line.length > 1);
  for (const pattern of patterns) {
    for (const line of lines) {
      const found = pattern.exec(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line)?.[1];
      const name = found ? clip(found.trim(), 160) : '';
      if (name && !skip.test(name) && !names.includes(name)) names.push(name);
      if (names.length >= MAX_FAILURES) return names;
    }
  }
  return names;
}

function countWords(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(/(?<!\d)(\d+) (passed|failed|skipped|todo|errors?|flaky|did not run|interrupted)\b/g)) counts[match[2]] = (counts[match[2]] ?? 0) + Number(match[1]);
  return counts;
}

function parseCargo(text: string): TestSummary | undefined {
  const results = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;[^\n]*?finished in ([\d.]+)s/g)];
  if (!results.length) return undefined;
  const sum = (index: number) => results.reduce((total, match) => total + Number(match[index]), 0);
  const durationMs = Math.round(sum(4) * 1000);
  return { runner: 'cargo', passed: sum(1), failed: sum(2), skipped: sum(3), durationMs, failures: collect(text, [/^---- (\S+) stdout ----$/]) };
}

function parsePytest(text: string): TestSummary | undefined {
  const line = /^(?:=+ )?((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in ([\d.]+)s\b/m.exec(text);
  if (!line) return undefined;
  const counts = countWords(line[1]);
  const failed = (counts.failed ?? 0) + (counts.error ?? 0) + (counts.errors ?? 0);
  return { runner: 'pytest', passed: counts.passed ?? 0, failed, skipped: counts.skipped ?? 0, durationMs: toMs(line[2], 's'), failures: collect(text, [/^(?:FAILED|ERROR) (\S+)/]) };
}

function parseVitestJest(text: string): TestSummary | undefined {
  const jest = /^Tests:[ \t]+(.+)$/m.exec(text);
  const vitest = jest ? null : /^[ \t]*Tests[ \t]+(\S.{0,200}?)[ \t]*\(\d+\)[ \t]*$/m.exec(text);
  const line = jest ?? vitest;
  if (!line || !/passed|failed/.test(line[1])) return undefined;
  const counts = countWords(line[1]);
  const duration = jest ? /^Time:[ \t]+([\d.]+)[ \t]*(ms|s|m)\b/m.exec(text) : /^[ \t]*Duration[ \t]+([\d.]+)(ms|s|m)\b/m.exec(text);
  const failures = jest ? collect(text, [/^[ \t]*● (.+)$/], /^Console$/) : collect(text, [/^[ \t]*(?:FAIL|×|✗)[ \t]+(.+?)(?:[ \t]+\d+m?s)?[ \t]*$/]);
  const summary: TestSummary = { runner: jest ? 'jest' : 'vitest', passed: counts.passed ?? 0, failed: counts.failed ?? 0, skipped: (counts.skipped ?? 0) + (counts.todo ?? 0), failures };
  return duration ? { ...summary, durationMs: toMs(duration[1], duration[2]) } : summary;
}

function parseNode(text: string): TestSummary | undefined {
  const value = (name: string) => new RegExp(`^[ \\t]*[#ℹ] ${name} ([\\d.]+)[ \\t]*$`, 'm').exec(text)?.[1];
  const passed = value('pass');
  if (passed === undefined) return undefined;
  const failures = collect(text, [/^[ \t]*not ok \d+ - (.+?)(?:[ \t]+#.*)?$/, /^[ \t]*✖ (.+?)(?:[ \t]+\([\d.]+m?s\))?[ \t]*$/], /^failing tests:?$/);
  const duration = value('duration_ms');
  const summary: TestSummary = { runner: 'node:test', passed: Number(passed), failed: Number(value('fail') ?? 0), skipped: Number(value('skipped') ?? 0), failures };
  return duration !== undefined ? { ...summary, durationMs: Math.round(Number(duration)) } : summary;
}

function parsePlaywright(text: string): TestSummary | undefined {
  const lines = [...text.matchAll(/^[ \t]*(\d+) (passed|failed|skipped|flaky|did not run|interrupted)(?: \(([\d.]+)(ms|s|m|h)\))?[ \t]*$/gm)];
  if (!lines.some(match => match[2] === 'passed' || match[2] === 'failed')) return undefined;
  const count = (...names: string[]) => lines.filter(match => names.includes(match[2])).reduce((total, match) => total + Number(match[1]), 0);
  const timed = lines.find(match => match[3]);
  const failures = collect(text, [
    /^[ \t]*[✘×✗][ \t]+\d+[ \t]+(?:\[[^\]]+\][ \t]+›[ \t]+)?(.+?)(?:[ \t]+\(retry #\d+\))?(?:[ \t]+\([\d.]+m?s\))?[ \t]*$/,
    /^[ \t]+\[[^\]]+\] › (.+?)[ \t]*$/,
  ]);
  const summary: TestSummary = { runner: 'playwright', passed: count('passed', 'flaky'), failed: count('failed'), skipped: count('skipped', 'did not run', 'interrupted'), failures };
  return timed ? { ...summary, durationMs: toMs(timed[3], timed[4]) } : summary;
}

function parseGo(text: string): TestSummary | undefined {
  const packages = [...text.matchAll(/^(ok|FAIL)[ \t]+(\S+)[ \t]+(?:([\d.]+)s|\(cached\))/gm)];
  if (!packages.length) return undefined;
  const failed = packages.filter(match => match[1] === 'FAIL');
  const failures = collect(text, [/^[ \t]*--- FAIL: (\S+)/]);
  const durationMs = Math.round(packages.reduce((total, match) => total + Number(match[3] ?? 0), 0) * 1000);
  const skipped = [...text.matchAll(/^[ \t]*--- SKIP: /gm)].length;
  return { runner: 'go', passed: packages.length - failed.length, failed: failed.length, skipped, durationMs, failures: failures.length ? failures : failed.slice(0, MAX_FAILURES).map(match => match[2]) };
}

const PARSERS = [parseCargo, parsePytest, parseVitestJest, parseNode, parsePlaywright, parseGo];

/** Every summary the output holds, one per runner, in PARSERS order (cargo before playwright). */
function summaries(output: unknown, all: boolean): TestSummary[] {
  if (typeof output !== 'string' || !output) return [];
  const found: TestSummary[] = [];
  try {
    const text = stripAnsi(output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output).replace(/\r\n?/g, '\n');
    for (const parse of PARSERS) {
      const summary = parse(text);
      if (summary) found.push(summary);
      if (summary && !all) break;
    }
  } catch { /* unparseable output simply has no summary */ }
  return found;
}

export function testSummary(output: string): TestSummary | undefined {
  return summaries(output, false)[0];
}

/** The runners whose summaries appear in the output (`['cargo']`, `['cargo', 'playwright']`); empty when none do. */
export function testRunners(output: unknown): string[] {
  return summaries(output, true).map(summary => summary.runner);
}

// ---------------------------------------------------------------- markup

const count = (value: unknown) => Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function testSummaryHtml(summary: TestSummary): string {
  const passed = count(summary?.passed), failed = count(summary?.failed), skipped = count(summary?.skipped);
  const parts: [string, number, string][] = [['pass', passed, 'passed'], ['fail', failed, 'failed'], ['skip', skipped, 'skipped']];
  const shown = parts.filter(([tone, value]) => tone === 'pass' || value > 0);
  const counts = shown.map(([tone, value, word]) => `<span class="tool-test-${tone}">${value} ${word}</span>`).join('');
  const label = shown.map(([, value, word]) => `${value} ${word}`).join(', ');
  const meter = parts.filter(([, value]) => value > 0).map(([tone, value]) => `<span class="tool-test-meter-${tone}" style="flex-grow:${value}"></span>`).join('');
  const duration = Number.isFinite(summary?.durationMs) ? `<span class="tool-test-duration">${escape(formatDuration(count(summary.durationMs)))}</span>` : '';
  const names = Array.isArray(summary?.failures) ? summary.failures.slice(0, MAX_FAILURES) : [];
  const failures = names.length ? `<ul class="tool-test-failures">${names.map(name => `<li class="tool-test-failure">${escape(name)}</li>`).join('')}</ul>` : '';
  return `<div class="tool-test-summary" data-status="${failed ? 'fail' : 'pass'}"><span class="tool-test-runner">${escape(summary?.runner)}</span>`
    + `<span class="tool-test-counts">${counts}</span><span class="tool-test-meter" role="img" aria-label="${escape(label)}">${meter}</span>${duration}${failures}</div>`;
}

/** What screencapture, ffmpeg and sips print when they wrote no image. Linear: no nested quantifiers. */
const IMAGE_FAILURE = /could not create image|Error opening output files?\b|Conversion failed!|Unable to render destination image|^Error(?: \d+)?: /im;
/** `echo sc=$?` printing a nonzero status on its own line. */
const ECHOED_FAILURE = /^\w+=[1-9]\d{0,2}$/m;

/** The output of a command that should have written an image says it did not (`could not create image from display`, or
 * `sc=1` from the command's own `echo sc=$?`). */
export function imageFailed(output: string, command: string): boolean {
  const text = output.slice(0, MAX_OUTPUT);
  return IMAGE_FAILURE.test(text) || (command.includes('=$?') && ECHOED_FAILURE.test(text));
}
