import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askedWhenOffText, mayStillLoadText, coversTarget, enforcementLabel, enforcementNote, errorText, flagLabel, flagPlace, flagsOf, harnessName, modesOf, installedNames, installNote, installTargets, isLocked, isOff, heldOff, flaggedOutcome,
  installable, isLocalSource, libraryNote, listText, matches, notShownText, skillDomId, summaryText, withSkillOff, harnessesOf, hasQuarantine, BOT_LIBRARY, canUninstall, uninstalledText, expiredUndoText, APPLIES_NOTE,
  APP_MISSING, appMissingText, noticeLines, prefsErrorText, addedNote, flaggedNames,
} from '../src/skill-manager-model.ts';
import { readFileSync } from 'node:fs';
import { createPreviewSkillManager, MATRIX, parseSource, previewHarness } from '../src/preview-skill-manager.ts';

const skill = over => ({ name: 'pdf', description: 'Extract text from PDF files.', agents: [], offInPandaCode: false, offInProject: false, offInProjects: [], source: null, switchable: true, ...over });
const agent = (harness, over = {}) => ({ harness, scope: 'user', path: `~/.${harness}/skills/pdf`, ...over });
const harness = (id, over = {}) => ({ id, installed: true, enforcement: 'asked', consoleEnforcement: 'asked', installable: true, installAs: id, ...over });
const inventory = (skills, over = {}) => ({ projectId: null, harnesses: [], skills, ...over });

test('withSkillOff returns a copy and leaves the original untouched', () => {
  const before = inventory([skill(), skill({ name: 'docx' })]);
  const after = withSkillOff(before, 'pdf', '', true);
  assert.notEqual(after, before);
  assert.equal(after.skills[0].offInPandaCode, true);
  assert.equal(before.skills[0].offInPandaCode, false);
  assert.equal(after.skills[1], before.skills[1]);
});

test('withSkillOff in a project tracks the project list without duplicates', () => {
  const before = inventory([skill({ offInProjects: ['p2'] })]);
  const off = withSkillOff(before, 'pdf', 'p1', true);
  assert.equal(off.skills[0].offInProject, true);
  assert.equal(off.skills[0].offInPandaCode, false);
  assert.deepEqual(off.skills[0].offInProjects, ['p2', 'p1']);
  assert.deepEqual(withSkillOff(off, 'pdf', 'p1', true).skills[0].offInProjects, ['p2', 'p1']);
  assert.deepEqual(withSkillOff(off, 'pdf', 'p1', false).skills[0].offInProjects, ['p2']);
});

test('off and locked depend on the scope being viewed', () => {
  const everywhere = skill({ offInPandaCode: true }), project = skill({ offInProject: true });
  assert.equal(isOff(everywhere, ''), true);
  assert.equal(isOff(everywhere, 'p1'), true);
  assert.equal(isOff(project, ''), false);
  assert.equal(isOff(project, 'p1'), true);
  assert.equal(isLocked(everywhere, ''), false);
  assert.equal(isLocked(everywhere, 'p1'), true);
  assert.equal(isLocked(project, 'p1'), false);
});

test('search matches every word in the name or description', () => {
  assert.equal(matches(skill(), 'PDF text'), true);
  assert.equal(matches(skill(), '  '), true);
  assert.equal(matches(skill(), 'pdf word'), false);
});

test('summary counts skills, what is off in the scope, and search matches', () => {
  const skills = [skill(), skill({ name: 'docx', offInPandaCode: true }), skill({ name: 'xlsx', offInProject: true })];
  assert.equal(summaryText(skills, '', ''), '3 skills · 1 off in all projects');
  assert.equal(summaryText(skills, 'p1', 'orbit'), '3 skills · 1 off in all projects · 1 off in orbit');
  // Off in both places counts once, under All projects.
  assert.equal(summaryText([skill({ offInPandaCode: true, offInProject: true })], 'p1', 'orbit'), '1 skill · 1 off in all projects');
  assert.equal(summaryText([skill({ offInProject: true })], 'p1', 'orbit'), '1 skill · 1 off in orbit');
  assert.equal(summaryText(skills, '', '', 1, true), '1 of 3 skills');
  assert.equal(summaryText([skill()], '', ''), '1 skill');
  // A setting left for a skill no longer installed is neither a skill nor an off one.
  const leftovers = [skill({ name: 'a', offInPandaCode: true, missing: true }), skill({ name: 'b', offInProject: true, missing: true })];
  assert.equal(summaryText([skill(), ...leftovers], 'p1', 'orbit'), '1 skill');
  assert.equal(summaryText(leftovers, '', ''), '0 skills');
  assert.equal(summaryText([skill(), ...leftovers], '', '', 1, true), '1 of 1 skill');
});

test('summary tells skills that may still load apart from blocked ones, on one line', () => {
  const harnesses = [harness('claude', { enforcement: 'blocked', consoleEnforcement: 'blocked' }), harness('pi'), harness('kimi', { installed: false })];
  const skills = [
    skill({ offInPandaCode: true, agents: [agent('claude')] }),
    skill({ name: 'docx', offInPandaCode: true, agents: [agent('claude'), agent('pi')] }),
    // Only asked by an agent that isn't installed: nothing asks, so it doesn't count.
    skill({ name: 'xlsx', offInPandaCode: true, agents: [agent('kimi')] }),
    skill({ name: 'pptx', offInProject: true, agents: [agent('pi')] }),
    skill({ name: 'csv' }),
  ];
  assert.equal(summaryText(skills, '', '', skills.length, false, harnesses), '5 skills · 3 off in all projects (1 may still load)');
  assert.equal(summaryText(skills, 'p1', 'orbit', skills.length, false, harnesses), '5 skills · 3 off in all projects (1 may still load) · 1 off in orbit (1 may still load)');
  // A per-skill override that blocks wins over the harness's asked default.
  const blocked = [skill({ offInPandaCode: true, agents: [agent('pi')], enforcementOverrides: { pi: { enforcement: 'blocked', consoleEnforcement: 'blocked' } } })];
  assert.equal(summaryText(blocked, '', '', 1, false, harnesses), '1 skill · 1 off in all projects');
  // A console that isn't told counts too, even where tasks block it: off doesn't hold there.
  const consoleOpen = [harness('kimi', { enforcement: 'blocked', consoleEnforcement: 'none' })];
  assert.equal(summaryText([skill({ offInPandaCode: true, agents: [agent('kimi')] })], '', '', 1, false, consoleOpen), '1 skill · 1 off in all projects (1 may still load)');
  // Quarantined skills are never asked about.
  assert.equal(summaryText([skill({ offInPandaCode: true, quarantined: true, agents: [agent('pi')] })], '', '', 1, false, harnesses), '1 skill · 1 off in all projects');
});

test('notShown is a lower bound on skipped folders and is quiet when absent', () => {
  assert.equal(notShownText({}), '');
  assert.equal(notShownText({ notShown: 0 }), '');
  assert.equal(notShownText({ notShown: 1 }), '1+ folder not shown');
  assert.equal(notShownText({ notShown: 12 }), '12+ folders not shown');
});

test('installNote compares every harness, scope, project and location', () => {
  const before = inventory([skill({ agents: [agent('claude')] })]);
  assert.equal(installNote(before, before), 'Already installed.');
  const after = inventory([
    skill({ agents: [agent('claude'), agent('codex')] }),
    skill({ name: 'xlsx', agents: [agent('claude', { scope: 'project', projectId: 'p1', path: '.claude/skills/xlsx' })] }),
  ]);
  assert.equal(installNote(before, after), 'Installed 2 skills for Codex and Claude Code.');
  const sameHarnessNewProject = inventory([skill({ agents: [agent('claude'), agent('claude', { scope: 'project', projectId: 'p1', path: '.claude/skills/pdf' })] })]);
  assert.equal(installNote(before, sameHarnessNewProject), 'Installed 1 skill for Claude Code.');
});

test('an install note never counts a flagged skill as installed', () => {
  const before = inventory([]);
  const finding = (name, quarantined) => ({ skill: name, rule: 'secret', file: 'SKILL.md', line: 1, excerpt: '', ...(quarantined ? { quarantined: true } : {}) });
  const after = { ...inventory([skill({ agents: [agent('claude')] }), skill({ name: 'xlsx', agents: [agent('claude')] }), skill({ name: 'pptx', agents: [agent('claude')] })]), findings: [finding('pptx', false)] };
  assert.equal(installNote(before, after), 'Installed 2 skills for Claude Code · 1 skill off for review.');
  const quarantined = { ...inventory([skill({ name: 'xlsx', quarantined: true, agents: [agent('claude')] })]), findings: [finding('xlsx', true), finding('xlsx', true)] };
  assert.equal(installNote(before, quarantined), '1 skill quarantined for review.');
  assert.deepEqual(flaggedNames([finding('a', true), finding('b', false), finding('a', false)]), { quarantined: ['a'], off: ['b'] });
  assert.equal(addedNote(1, ['Codex'], [finding('a', true), finding('b', false)]), 'Installed 1 skill for Codex · 1 skill quarantined · 1 skill off for review.');
  assert.equal(addedNote(0, []), 'Already installed.');
});

test('install targets are the harnesses the skills CLI supports, installed here or not', () => {
  const targets = installTargets([harness('claude', { installAs: 'claude-code' }), harness('kimi', { installed: false }), harness('devin', { installable: false }), harness('pi', { installAs: undefined })]);
  assert.deepEqual(targets.map(h => h.id), ['claude', 'kimi']);
});

test('a local folder source is an absolute path; preview skills with unswitchable names are not installable', () => {
  for (const source of ['/Users/you/skills', 'C:\\skills', 'D:/skills', '\\\\server\\share', '  /Users/you/skills']) assert.equal(isLocalSource(source), true, source);
  for (const source of ['owner/repo', 'https://github.com/o/r', 'skills', './skills', '~/skills', '~skills', '']) assert.equal(isLocalSource(source), false, source);
  assert.equal(installable({ name: 'pdf', description: '' }), true);
  assert.equal(installable({ name: 'a (b)', description: '', switchable: false, unswitchableReason: 'no' }), false);
});

test('modes are what native sends; deprecated enforce is never read', () => {
  assert.deepEqual(modesOf(harness('claude', { enforcement: 'blocked', consoleEnforcement: 'blocked' })), { enforcement: 'blocked', consoleEnforcement: 'blocked' });
  assert.deepEqual(modesOf(harness('pi')), { enforcement: 'asked', consoleEnforcement: 'asked' });
  assert.deepEqual(modesOf(harness('kimi', { enforce: 'hard', enforcement: 'asked', consoleEnforcement: 'none' })), { enforcement: 'asked', consoleEnforcement: 'none' });
  // A payload missing its modes never claims 'blocked', whatever a stale `enforce` says.
  assert.deepEqual(modesOf({ id: 'old', installed: true, enforce: 'hard', installable: false }), { enforcement: 'asked', consoleEnforcement: 'asked' });
});

test('enforcement labels name the task behaviour, a different console behaviour, and missing harnesses', () => {
  const roster = [
    harness('claude', { enforcement: 'blocked', consoleEnforcement: 'blocked' }),
    harness('pi', { enforcement: 'asked', consoleEnforcement: 'asked' }),
    harness('kimi', { enforcement: 'asked', consoleEnforcement: 'none' }),
    harness('deepseek', { installed: false, enforcement: 'asked' }),
  ];
  assert.equal(enforcementLabel(roster, 'claude'), 'Won’t load when off');
  assert.equal(enforcementLabel(roster, 'pi'), 'Asked when off');
  assert.equal(enforcementLabel(roster, 'kimi'), 'Asked when off · console: not enforced when off');
  // A missing harness gets its own 'Not installed' marker in the view, never the enforcement slot.
  assert.equal(enforcementLabel(roster, 'deepseek'), '');
  assert.equal(enforcementLabel(roster, 'unknown'), '');
});

test('per-skill enforcementOverrides are rendered exactly; askOnly is never read', () => {
  const roster = ['claude', 'codex', 'opencode'].map(id => harness(id, { enforcement: 'blocked', consoleEnforcement: 'blocked' }));
  const advisory = skill({
    name: 'Friendly 技能', askOnly: ['claude', 'opencode', 'codex'],
    enforcementOverrides: { claude: { enforcement: 'asked', consoleEnforcement: 'asked' }, opencode: { enforcement: 'asked', consoleEnforcement: 'none' } },
  });
  assert.equal(enforcementLabel(roster, 'claude', advisory), 'Asked when off');
  // OpenCode consoles have no advisory channel: native says none, so the label says so.
  assert.equal(enforcementLabel(roster, 'opencode', advisory), 'Asked when off · console: not enforced when off');
  // askOnly lists codex here, but there is no override for it: the harness default stands.
  assert.equal(enforcementLabel(roster, 'codex', advisory), 'Won’t load when off');
  assert.equal(enforcementLabel(roster, 'claude', skill({ askOnly: ['claude'] })), 'Won’t load when off');
  assert.equal(enforcementLabel([harness('claude', { installed: false })], 'claude', advisory), '');
});

test('preview mirrors native\'s enforcement table and reset clears global and project switches', async () => {
  const mock = createPreviewSkillManager({ prefsError: 'Unreadable preferences' });
  const roster = mock.list({}).harnesses;
  assert.deepEqual(roster.find(h => h.id === 'opencode'), { id: 'opencode', installable: true, installAs: 'opencode', installed: true, enforcement: 'blocked', consoleEnforcement: 'blocked' });
  // Claude-family consoles carry native's note; others omit it. Neither deprecated field is sent.
  assert.equal(roster.find(h => h.id === 'claude').consoleNote, 'Typed /commands still run in the console');
  assert.ok(roster.every(h => !('enforce' in h) && (h.id === 'claude' || !('consoleNote' in h))));
  assert.deepEqual(roster.find(h => h.id === 'kimi') && modesOf(roster.find(h => h.id === 'kimi')), { enforcement: 'asked', consoleEnforcement: 'none' });
  assert.deepEqual(roster.find(h => h.id === 'muse') && modesOf(roster.find(h => h.id === 'muse')), { enforcement: 'asked', consoleEnforcement: 'asked' });
  await mock.add({ source: 'anthropics/skills', skills: ['Friendly 技能'], harnesses: ['claude', 'codex', 'opencode'] });
  const friendly = mock.list({}).skills.find(s => s.name === 'Friendly 技能');
  const asked = { enforcement: 'asked', consoleEnforcement: 'asked' };
  assert.deepEqual(friendly.enforcementOverrides, { alibaba: asked, claude: asked, glm: asked, mimo: asked, opencode: { enforcement: 'asked', consoleEnforcement: 'none' } });
  assert.equal('askOnly' in friendly, false);
  assert.equal(mock.list({}).skills.find(s => s.name === 'pdf').enforcementOverrides, undefined);
  mock.set({ name: 'pdf', enabled: false });
  mock.set({ name: 'docx', enabled: false, projectId: 'project-1' });
  const reset = mock.reset({ projectId: 'project-1' });
  assert.equal(reset.projectId, 'project-1');
  assert.equal(reset.prefsError, undefined);
  assert.ok(reset.skills.every(s => !s.offInPandaCode && !s.offInProject && !s.offInProjects.length));
  assert.ok(mock.list({}).skills.every(s => !s.offInPandaCode && !s.offInProjects.length));
});

test('off hints count only installed agents using the skill, once each, and respect scope and overrides', () => {
  const roster = [harness('claude', { enforcement: 'blocked', consoleEnforcement: 'blocked' }), harness('pi'), harness('kimi', { installed: false }), harness('omp')];
  const advisory = skill({ agents: [agent('claude'), agent('claude'), agent('pi'), agent('kimi')], enforcementOverrides: { claude: { enforcement: 'asked', consoleEnforcement: 'asked' } } });
  assert.equal(askedWhenOffText(advisory, roster, ''), '');
  assert.equal(askedWhenOffText({ ...advisory, offInPandaCode: true }, roster, ''), 'Claude Code and Pi can only be asked not to use it.');
  assert.equal(askedWhenOffText({ ...advisory, offInProject: true }, roster, ''), '');
  assert.equal(askedWhenOffText({ ...advisory, offInProject: true }, roster, 'p1'), 'Claude Code and Pi can only be asked not to use it.');
  assert.equal(askedWhenOffText(skill({ agents: [agent('pi')], offInPandaCode: true }), roster, ''), 'Pi can only be asked not to use it.');
  assert.equal(askedWhenOffText(skill({ agents: [agent('claude')], offInPandaCode: true }), roster, ''), '');
});

test('may still load names consoles that are not told, and agents that are not told at all', () => {
  const roster = [
    harness('claude', { enforcement: 'blocked', consoleEnforcement: 'blocked' }),
    harness('kimi', { enforcement: 'asked', consoleEnforcement: 'none' }),
    harness('cline', { enforcement: 'asked', consoleEnforcement: 'none' }),
    harness('opencode', { enforcement: 'blocked', consoleEnforcement: 'none' }),
    harness('codex', { enforcement: 'blocked', consoleEnforcement: 'asked' }),
    harness('devin', { enforcement: 'none', consoleEnforcement: 'none' }),
  ];
  const off = (...ids) => skill({ offInPandaCode: true, agents: ids.map(id => agent(id)) });
  assert.equal(mayStillLoadText(off('claude'), roster), '');
  assert.equal(mayStillLoadText(off('kimi'), roster), 'Kimi Code can only be asked not to use it. In its console, Kimi Code isn’t told to skip it.');
  assert.equal(mayStillLoadText(off('opencode'), roster), 'In its console, OpenCode isn’t told to skip it.');
  assert.equal(mayStillLoadText(off('kimi', 'cline'), roster), 'Kimi Code and Cline can only be asked not to use it. In their consoles, Kimi Code and Cline aren’t told to skip it.');
  assert.equal(mayStillLoadText(off('codex'), roster), 'In its console, Codex can only be asked not to use it.');
  assert.equal(mayStillLoadText(off('devin'), roster), 'Devin isn’t told to skip it.');
  assert.equal(askedWhenOffText({ ...off('opencode'), offInPandaCode: false }, roster, ''), '');
});

test('preview preserves an unreadable identity and its unswitchable reason', () => {
  const reason = 'Couldn’t read SKILL.md, so the skill’s name is unknown.';
  const mock = createPreviewSkillManager({ skills: [skill({ switchable: false, unswitchableReason: reason })] });
  assert.equal(mock.list({}).skills[0].switchable, false);
  assert.equal(mock.list({}).skills[0].unswitchableReason, reason);
  // Native refuses with its own words; the reason is what the page shows beforehand.
  assert.throws(() => mock.set({ name: 'pdf', enabled: false }), /identity could not be resolved safely/);
  assert.equal(mock.list({}).skills[0].offInPandaCode, false);
});

test('preview set refuses what native refuses: bad names, unknown or uninstalled skills, turning a missing skill off', () => {
  const mock = createPreviewSkillManager({ missing: ['gone'] });
  for (const name of ['', '  ', '-rf', 'a,b', 'a(b)', 'a`b', 'a<b>', 'a*', 'x'.repeat(201), 'a\nb']) {
    assert.throws(() => mock.set({ name, enabled: false }), /can't be switched/, JSON.stringify(name));
  }
  assert.throws(() => mock.set({ name: 'nope', enabled: false }), /no longer installed/);
  assert.throws(() => mock.set({ name: 'gone', enabled: false }), /no longer installed/);
  // A project view lists only its own project skills: another project's skill is unknown there.
  assert.throws(() => mock.set({ name: 'tauri-ipc', enabled: false, projectId: 'project-1' }), /no longer installed/);
  mock.changeOnDisk('docx', null);
  assert.throws(() => mock.set({ name: 'docx', enabled: false }), /no longer installed/);
  assert.equal(mock.set({ name: 'pdf', enabled: false }).skills.find(s => s.name === 'pdf').offInPandaCode, true);
});

test('a quarantined skill says why from its flags, else from the add response', () => {
  const flag = { rule: 'pipe-to-shell', file: 'SKILL.md', line: 12, excerpt: 'curl … | sh' };
  assert.deepEqual(flagsOf(skill({ flags: [flag] }), { findings: [{ ...flag, skill: 'pdf', line: 3 }] }), [flag]);
  assert.deepEqual(flagsOf(skill(), { findings: [{ ...flag, skill: 'pdf', quarantined: true }, { ...flag, skill: 'docx' }] }), [flag]);
  assert.deepEqual(flagsOf(skill(), null), []);
  assert.equal(flagLabel('pipe-to-shell'), 'Download piped into a shell');
  assert.equal(flagLabel('scan-limit'), 'Safety scan incomplete');
  assert.equal(flagLabel('new-rule'), 'Flagged by the safety check');
  assert.equal(flagPlace(flag), 'SKILL.md:12');
  assert.equal(flagPlace({ file: 'scripts/', line: 0 }), 'scripts/');
});

test('DOM ids stay unique for names that sanitize alike', () => {
  const ids = ['a b', 'a_b', 'a:b', 'a.b', 'Friendly 技能', 'Friendly 技术'].map(skillDomId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(skillDomId('a b'), skillDomId('a b'));
  for (const id of ids) assert.match(id, /^skill-[A-Za-z0-9_-]+$/);
});

test('preview switches a flagged update off where the add went: the project for a project add', async () => {
  const flag = { rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' };
  const mock = createPreviewSkillManager({ findings: [{ ...flag, skill: 'orbit-deploy' }, { ...flag, skill: 'pdf' }] });
  const project = await mock.add({ source: 'anthropics/skills', skills: ['orbit-deploy'], harnesses: ['claude'], projectId: 'project-1' });
  const deploy = project.skills.find(s => s.name === 'orbit-deploy');
  assert.equal(deploy.offInProject, true);
  assert.equal(deploy.offInPandaCode, false);
  assert.deepEqual(deploy.offInProjects, ['project-1']);
  assert.ok(!deploy.quarantined);
  // Only the skills this add installed: pdf, flagged but not added, keeps its switches.
  assert.equal(project.skills.find(s => s.name === 'pdf').offInProject, false);
  assert.deepEqual(project.switchedOff, ['orbit-deploy']);
  const global = await mock.add({ source: 'anthropics/skills', skills: ['pdf'], harnesses: ['claude'] });
  assert.equal(global.skills.find(s => s.name === 'pdf').offInPandaCode, true);
  assert.deepEqual(global.switchedOff, ['pdf']);
  // Already off there: the add switches nothing, so nothing is listed.
  const again = await mock.add({ source: 'anthropics/skills', skills: ['pdf'], harnesses: ['codex'] });
  assert.equal(again.switchedOff, undefined);
});

test('preview quarantines a newly installed flagged skill and restores it', async () => {
  const findings = [{ skill: 'xlsx', rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' }];
  const mock = createPreviewSkillManager({ findings });
  const after = await mock.add({ source: 'anthropics/skills', skills: ['xlsx'], harnesses: ['claude'] });
  assert.equal(after.findings[0].quarantined, true);
  assert.equal(after.switchedOff, undefined);
  const row = after.skills.find(s => s.name === 'xlsx');
  assert.equal(row.quarantined, true);
  assert.deepEqual(row.flags, [{ rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'curl | sh' }]);
  assert.equal(row.offInPandaCode, false);
  const restored = mock.restore({ name: 'xlsx', projectId: 'project-1' });
  assert.equal(restored.projectId, 'project-1');
  assert.ok(!restored.skills.find(s => s.name === 'xlsx').quarantined);
  assert.equal(restored.skills.find(s => s.name === 'xlsx').flags, undefined);
  assert.throws(() => mock.restore({ name: 'xlsx' }), /isn’t quarantined/);
});

test('preview lists a switched-off skill that is no longer installed until its switch clears', () => {
  const mock = createPreviewSkillManager({ missing: ['gone'] });
  const gone = mock.list({}).skills.find(s => s.name === 'gone');
  assert.deepEqual({ missing: gone.missing, off: gone.offInPandaCode, agents: gone.agents }, { missing: true, off: true, agents: [] });
  assert.equal(mock.set({ name: 'gone', enabled: true }).skills.some(s => s.name === 'gone'), false);
});

test('a leftover setting is held off in All projects by any project’s switch, in a project only by its own', () => {
  const projectOnly = skill({ missing: true, offInProjects: ['p1'] });
  assert.equal(heldOff(projectOnly, ''), true);
  assert.equal(heldOff(projectOnly, 'p2'), false);
  assert.equal(heldOff({ ...projectOnly, offInProject: true }, 'p1'), true);
  assert.equal(heldOff(skill({ missing: true }), ''), false);
  assert.equal(heldOff(skill({ missing: true, offInPandaCode: true }), ''), true);
});

test('flaggedOutcome reads only native’s answer: switchedOff gets Turn on anyway, the rest stay as they were', () => {
  const finding = (skill, over = {}) => ({ skill, rule: 'pipe-to-shell', file: 'SKILL.md', line: 1, excerpt: 'x', ...over });
  const after = { findings: [finding('a'), finding('b'), finding('q', { quarantined: true })], switchedOff: ['a'] };
  assert.equal(flaggedOutcome(after, 'a'), 'switched');
  assert.equal(flaggedOutcome(after, 'b'), 'stayed');
  assert.equal(flaggedOutcome(after, 'q'), 'quarantined');
  // No switchedOff (an older build, or nothing switched): never a button.
  assert.equal(flaggedOutcome({ findings: [finding('a')] }, 'a'), 'stayed');
  // An add that also returned an error: a name in switchedOff still gets Turn on anyway; the rest claim nothing.
  assert.equal(flaggedOutcome({ ...after, error: 'disk full' }, 'a'), 'switched');
  assert.equal(flaggedOutcome({ ...after, error: 'disk full' }, 'b'), 'unconfirmed');
  assert.equal(flaggedOutcome({ ...after, error: 'disk full' }, 'q'), 'quarantined');
});

test('the mock lists a leftover setting held only by a project, in All projects and that project', () => {
  const mock = createPreviewSkillManager({ skills: [], missingInProjects: { p1: ['orbit-old'] } });
  assert.deepEqual(mock.list({}).skills.map(s => [s.name, s.missing, s.offInPandaCode, s.offInProjects]), [['orbit-old', true, false, ['p1']]]);
  assert.equal(mock.list({ projectId: 'p1' }).skills[0].offInProject, true);
  assert.equal(mock.set({ name: 'orbit-old', enabled: true }).skills.length, 0);
});

test('the enforcement note uses plain language', () => {
  assert.equal(enforcementNote(), 'Switches apply in PandaCode, for the scope picked here. Agents PandaCode runs follow them from the next turn; files stay installed.');
});

test('small text helpers', () => {
  assert.equal(listText([]), '');
  assert.equal(listText(['A']), 'A');
  assert.equal(listText(['A', 'B', 'C']), 'A, B and C');
  assert.equal(harnessName('opencode'), 'OpenCode');
  assert.equal(harnessName('newcli'), 'Newcli');
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('disk full'), 'disk full');
  assert.equal(errorText({ message: 'from IPC' }), 'from IPC');
  assert.equal(errorText({ code: 42 }), 'Something went wrong. Try again.');
});

// The browser preview mirrors normalize_source/validate_source in src-tauri/src/skill_manager{,/cli}.rs.
test('preview sources: skills.sh links become owner/repo plus the named skill, like native', () => {
  for (const [source, expected] of [
    ['https://skills.sh/vercel-labs/agent-skills/web-design-guidelines/?ref=share', { source: 'vercel-labs/agent-skills', selected: ['web-design-guidelines'] }],
    ['https://skills.sh/vercel-labs/agent-skills/?ref=share', { source: 'vercel-labs/agent-skills' }],
    ['https://skills.sh/vercel-labs/agent-skills', { source: 'vercel-labs/agent-skills' }],
    ['https://skills.sh/vercel-labs/agent-skills/web-design#top', { source: 'vercel-labs/agent-skills', selected: ['web-design'] }],
  ]) assert.deepEqual(parseSource(source), expected, source);
  for (const source of ['https://skills.sh/owner', 'https://skills.sh/o/r/skill/extra', 'https://skills.sh/o/r/-bad', 'https://skills.sh/o/r/with%20space', 'https://skills.sh/o/r\n']) {
    assert.throws(() => parseSource(source), undefined, source);
  }
});

test('preview sources: a local folder is passed through as the source', () => {
  assert.deepEqual(parseSource('/Users/you/skills'), { source: '/Users/you/skills' });
  assert.deepEqual(parseSource(' /Users/you/skills '), { source: '/Users/you/skills' });
  assert.throws(() => parseSource('/Users/you/../skills'), /Choose an existing folder/);
});

test('preview sources: everything else is validated and passed through unchanged, like native', () => {
  for (const source of ['vercel-labs/agent-skills', 'owner/repo/skills/pdf', 'https://github.com/vercel-labs/agent-skills', 'https://gitlab.com/group/repo', 'https://github.com/o/r.git']) {
    assert.deepEqual(parseSource(source), { source }, source);
  }
  for (const source of ['', '-rf', 'owner/repo/', 'owner//repo', 'owner/../repo', 'owner/repo?x', 'https://example.com/a/b', 'https://github.com/a/b?tab=readme', 'https://user@github.com/a/b', 'https://github.com:8443/a/b', 'http://github.com/a/b', 'https://github.com', 'x'.repeat(1025)]) {
    assert.throws(() => parseSource(source), /Enter owner\/repo/, source);
  }
});

test('installedNames marks skills at the chosen target for every chosen agent', () => {
  const harnesses = [harness('claude', { installAs: 'claude-code' }), harness('glm', { installAs: 'claude-code' }), harness('codex', { installAs: 'codex' })];
  const all = inventory([
    skill({ name: 'pdf', agents: [agent('claude'), agent('codex')] }),
    skill({ name: 'docx', agents: [agent('glm')] }),
    skill({ name: 'deploy', agents: [agent('claude', { scope: 'project', projectId: 'p1', path: '.claude/skills/deploy' })] }),
    skill({ name: 'flagged', quarantined: true, agents: [agent('claude')] }),
    skill({ name: 'gone', missing: true, agents: [] }),
  ], { harnesses });
  assert.deepEqual([...installedNames(all, '', ['claude-code'])], ['pdf', 'docx']);
  assert.deepEqual([...installedNames(all, '', ['claude-code', 'codex'])], ['pdf']);
  assert.deepEqual([...installedNames(all, 'p1', ['claude-code'])], ['deploy']);
  assert.deepEqual([...installedNames(all, 'p2', ['claude-code'])], []);
  assert.deepEqual([...installedNames(all, '', [])], []);
  // A project view's own agents may omit projectId: they belong to the viewed project.
  const project = inventory([skill({ name: 'deploy', agents: [agent('claude', { scope: 'project' })] })], { harnesses, projectId: 'p1' });
  assert.deepEqual([...installedNames(project, 'p1', ['claude-code'])], ['deploy']);
  assert.equal(coversTarget(all, 'p2'), true);
  assert.equal(coversTarget(project, ''), true);
  assert.equal(coversTarget(project, 'p1'), true);
  assert.equal(coversTarget(project, 'p2'), false);
});

test('preview: turning a missing skill on in All projects clears its global and every project switch, like native', () => {
  const mock = createPreviewSkillManager({ skills: [{ name: 'old', description: '', source: null, switchable: true, agents: [agent('claude')] }] });
  mock.set({ name: 'old', enabled: false });
  mock.set({ name: 'old', enabled: false, projectId: 'project-1' });
  mock.set({ name: 'old', enabled: false, projectId: 'project-2' });
  mock.changeOnDisk('old', { agents: [], missing: true });
  assert.equal(mock.list({ projectId: 'project-1' }).skills.find(s => s.name === 'old').missing, true);
  const cleared = mock.set({ name: 'old', enabled: true });
  assert.equal(cleared.skills.some(s => s.name === 'old'), false);
  for (const projectId of ['project-1', 'project-2']) assert.equal(mock.list({ projectId }).skills.some(s => s.name === 'old'), false);
});

test('preview: a missing skill turned on in one project clears only that project, like native', () => {
  const mock = createPreviewSkillManager({ skills: [{ name: 'old', description: '', source: null, switchable: true, agents: [agent('claude')] }] });
  mock.set({ name: 'old', enabled: false, projectId: 'project-1' });
  mock.set({ name: 'old', enabled: false, projectId: 'project-2' });
  mock.changeOnDisk('old', { agents: [], missing: true });
  mock.set({ name: 'old', enabled: true, projectId: 'project-1' });
  // Still listed while project-2 holds it (native's prefs_mentions), but on in project-1.
  assert.equal(mock.list({ projectId: 'project-1' }).skills.find(s => s.name === 'old').offInProject, false);
  assert.deepEqual(mock.list({}).skills.find(s => s.name === 'old').offInProjects, ['project-2']);
});

test('the preview mock builds its harness matrix from the fixture native generates', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/skill-matrix.json', import.meta.url), 'utf8'));
  assert.ok(Object.keys(fixture).length >= 3);
  assert.deepEqual(MATRIX, fixture);
  for (const [id, row] of Object.entries(fixture)) {
    const listed = previewHarness(id, true);
    assert.deepEqual({ enforcement: listed.enforcement, consoleEnforcement: listed.consoleEnforcement, consoleNote: listed.consoleNote, installAs: listed.installAs },
      { enforcement: row.enforcement, consoleEnforcement: row.consoleEnforcement, consoleNote: row.consoleNote, installAs: row.installAs }, id);
    assert.equal(listed.installable, !!row.installAs, id);
  }
  // What the mock lists agrees with the fixture for every harness it shows.
  const { harnesses } = createPreviewSkillManager().list({});
  assert.ok(harnesses.length);
  for (const h of harnesses) {
    const row = fixture[h.id];
    assert.ok(row, `${h.id} is in the fixture`);
    assert.equal(h.enforcement, row.enforcement, h.id);
    assert.equal(h.consoleEnforcement, row.consoleEnforcement, h.id);
    assert.equal(h.consoleNote, row.consoleNote, h.id);
    assert.equal(h.installAs, row.installAs, h.id);
  }
  // A non-identifier name reports only the harnesses whose modes differ from the fixture's.
  const spaced = createPreviewSkillManager({ skills: [{ name: 'house style', description: '', source: null, switchable: true, agents: [] }] }).list({}).skills[0];
  assert.deepEqual(Object.keys(spaced.enforcementOverrides).sort(), ['alibaba', 'claude', 'glm', 'mimo', 'opencode']);
  for (const [id, m] of Object.entries(spaced.enforcementOverrides ?? {})) {
    assert.notDeepEqual(m, { enforcement: fixture[id].enforcement, consoleEnforcement: fixture[id].consoleEnforcement }, id);
  }
});


test('bot library adds word their note and import only clean skills, without touching agents', async () => {
  assert.equal(libraryNote({ imported: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], findings: [], failures: [] }), 'Added 2 skills to the bot library.');
  assert.equal(libraryNote({ imported: [{ id: 'a', name: 'a' }], findings: [], failures: [] }), 'Added 1 skill to the bot library.');
  assert.equal(libraryNote({ imported: [], findings: [], failures: [] }), 'No skills were added to the bot library.');
  // Never a project id: projects are UUID-like or 'project-N'.
  assert.match(BOT_LIBRARY, /^@/);
  const finding = { skill: 'pptx', rule: 'pipe-to-shell', file: 'x.sh', line: 1, excerpt: 'curl x | sh' };
  const mock = createPreviewSkillManager({ findings: [finding] });
  const before = mock.list({}).skills.map(s => s.name);
  const result = await mock.addLibrary({ source: 'anthropics/skills', skills: ['xlsx', 'pptx'] });
  assert.deepEqual(result.imported.map(i => i.name), ['xlsx']);
  assert.deepEqual(result.findings, [finding]);
  assert.deepEqual(mock.list({}).skills.map(s => s.name), before);
  // Nothing imported and nothing flagged: refused with native's reason.
  const other = createPreviewSkillManager({ library: { importSkills: (_source, skills) => ({ imported: [], failures: skills.map(s => ({ skill: s.name, reason: `${s.name} is already in the library from /x.` })) }) } });
  await assert.rejects(other.addLibrary({ source: 'anthropics/skills', skills: ['xlsx'] }), /xlsx is already in the library from \/x\./);
  await assert.rejects(other.addLibrary({ source: 'anthropics/skills', skills: [] }), /Choose at least one skill/);
});

test('a quarantined copy beside a clean install: its locations load nowhere and count for nothing', () => {
  const roster = [harness('claude', { enforcement: 'blocked', consoleEnforcement: 'blocked' }), harness('pi')];
  const row = skill({ name: 'docx', quarantinedCopy: true, offInPandaCode: true, agents: [agent('claude'), { ...agent('pi'), quarantined: true }] });
  assert.deepEqual(harnessesOf(row), ['claude']);
  assert.equal(hasQuarantine(row), true);
  assert.equal(hasQuarantine(skill()), false);
  // Pi only holds the quarantined copy: it isn't asked about anything.
  assert.equal(askedWhenOffText(row, roster, ''), '');
  assert.equal(summaryText([row], '', '', 1, false, roster), '1 skill · 1 off in all projects');
  // Add doesn't treat the copy's location as installed.
  const inventory = { projectId: null, harnesses: [{ ...harness('pi'), installable: true, installAs: 'pi' }], skills: [row] };
  assert.equal(installedNames(inventory, '', ['pi']).size, 0);
});

test('the preview folds a quarantined copy into its clean row, as native does, and restore moves it back', () => {
  const mock = createPreviewSkillManager({ quarantinedCopies: ['docx'], findings: [{ skill: 'docx', rule: 'secret', file: 'SKILL.md', line: 4, excerpt: 'KEY=…' }] });
  const rows = mock.list({}).skills.filter(s => s.name === 'docx');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quarantinedCopy, true);
  assert.equal(rows[0].quarantined, undefined);
  assert.deepEqual(rows[0].agents.map(a => [a.harness, a.quarantined ?? false]), [['claude', false], ['codex', true]]);
  assert.deepEqual(rows[0].flags.map(f => f.rule), ['secret']);
  const after = mock.restore({ name: 'docx' }).skills.filter(s => s.name === 'docx');
  assert.equal(after.length, 1);
  assert.equal(after[0].quarantinedCopy, undefined);
  assert.deepEqual(after[0].agents.map(a => [a.harness, a.quarantined ?? false]), [['claude', false], ['codex', false]]);
  assert.deepEqual(createPreviewSkillManager().bots(), []);
  assert.deepEqual(createPreviewSkillManager({ bots: ['Scout'] }).bots().map(b => b.name), ['Scout']);
});

test('Uninstall is offered for a copy in the view: user-level in All projects, the project’s own in a project', () => {
  assert.equal(canUninstall(skill({ agents: [agent('claude')] }), ''), true);
  assert.equal(canUninstall(skill({ agents: [agent('claude')] }), 'p1'), false);
  assert.equal(canUninstall(skill({ agents: [agent('claude', { scope: 'project', projectId: 'p1' })] }), 'p1'), true);
  assert.equal(canUninstall(skill({ agents: [agent('claude', { scope: 'project', projectId: 'p2' })] }), 'p1'), false);
  assert.equal(canUninstall(skill({ quarantined: true, agents: [agent('claude')] }), ''), false);
  assert.equal(canUninstall(skill({ agents: [agent('claude', { quarantined: true })] }), ''), false);
  assert.equal(canUninstall(skill({ missing: true }), ''), false);
  assert.equal(uninstalledText({ id: 'u', name: 'pdf' }, 'orbit'), 'Uninstalled pdf from orbit.');
  assert.equal(uninstalledText({ id: 'u', name: 'pdf', kept: ['~/.kimi/skills/pdf'] }, 'all projects'), 'Uninstalled pdf from all projects. Left a copy PandaCode didn’t install in place: ~/.kimi/skills/pdf.');
});

test('older uninstalls whose Undo expired get one quiet note naming them', () => {
  assert.equal(expiredUndoText({}), '');
  assert.equal(expiredUndoText({ expiredUndo: [] }), '');
  assert.equal(expiredUndoText({ expiredUndo: ['old'] }), 'Older uninstalls can no longer be undone (old).');
  assert.equal(expiredUndoText({ expiredUndo: ['a', 'b', 'a'] }), 'Older uninstalls can no longer be undone (a and b).');
  assert.equal(expiredUndoText({ expiredUndo: ['a', 'b', 'c', 'd', 'e'] }), 'Older uninstalls can no longer be undone (a, b and 3 more).');
  // The preview mirrors native past its record limit: the oldest expire, by name and id; none when there is room.
  const mock = createPreviewSkillManager({ undoLimit: 1 });
  const first = mock.uninstall({ name: 'docx' });
  assert.equal(first.uninstalled.expiredUndo, undefined);
  const second = mock.uninstall({ name: 'pdf' });
  assert.deepEqual(second.uninstalled.expiredUndo, ['docx']);
  assert.deepEqual(second.uninstalled.expiredUndoIds, [first.uninstalled.id]);
  assert.throws(() => mock.undoUninstall({ id: first.uninstalled.id }), /can no longer be undone/);
});

test('switches apply from the next turn: one phrase, no short form', () => {
  assert.equal(APPLIES_NOTE, 'Applies from the next turn');
});

test('the preview uninstalls one scope, clears switches when no copy is left, and undoes once', () => {
  const mock = createPreviewSkillManager();
  mock.set({ name: 'docx', enabled: false });
  const result = mock.uninstall({ name: 'docx' });
  assert.equal(result.skills.some(s => s.name === 'docx'), false);
  assert.equal(result.uninstalled.switchesCleared, true);
  assert.deepEqual(result.uninstalled.kept, []);
  assert.throws(() => mock.uninstall({ name: 'docx' }), /no longer installed/);
  const back = mock.undoUninstall({ id: result.uninstalled.id });
  assert.equal(back.skills.find(s => s.name === 'docx')?.offInPandaCode, true);
  assert.throws(() => mock.undoUninstall({ id: result.uninstalled.id }), /can no longer be undone/);
  // A project uninstall leaves user-level copies alone.
  const project = mock.uninstall({ name: 'orbit-deploy', projectId: 'project-1' });
  assert.equal(project.skills.some(s => s.name === 'orbit-deploy'), false);
  assert.throws(() => mock.uninstall({ name: 'pdf', projectId: 'project-1' }), /no copy of this skill it can remove here/);
});

test('the preview refuses network folders as native does', () => {
  for (const source of ['\\\\server\\share\\skills', '//server/share', '\\\\?\\UNC\\server\\share']) assert.throws(() => parseSource(source), /network folders can't be added/, source);
  assert.deepEqual(parseSource('/Users/you/skills'), { source: '/Users/you/skills' });
});

test('a missing agent app reads as the app missing, never as the skill not installed', () => {
  assert.equal(APP_MISSING, 'app missing');
  assert.equal(appMissingText('kimi'), 'Kimi Code app missing');
  assert.doesNotMatch(appMissingText('codex'), /not installed/i);
});

test('the prefs card follows native’s prefsLost, not the switches it happens to report', () => {
  assert.equal(prefsErrorText({ prefsLost: true }), 'All skills are off until you reset.');
  assert.equal(prefsErrorText({}), 'Using the last saved switches until you reset.');
  // Every skill off with readable settings is just every skill off.
  assert.equal(prefsErrorText({ prefsLost: false }), 'Using the last saved switches until you reset.');
});

test('calm notices: names kept off (unless the prefs card speaks) and native’s links note', () => {
  assert.deepEqual(noticeLines(null), []);
  assert.deepEqual(noticeLines({ prefsWarning: 'Kept 1 skill off.', linksWarning: 'Couldn’t put back 1 link.' }), ['Kept 1 skill off.', 'Couldn’t put back 1 link.']);
  assert.deepEqual(noticeLines({ prefsError: 'Unreadable', prefsWarning: 'Kept 1 skill off.', linksWarning: ' ' }), []);
});

test('the preview reports prefsLost and linksWarning as native does', () => {
  const lost = createPreviewSkillManager({ prefsError: 'Unreadable', prefsLost: true, linksWarning: 'Couldn’t put back 1 link.' });
  const listed = lost.list({});
  assert.equal(listed.prefsLost, true);
  assert.equal(listed.linksWarning, 'Couldn’t put back 1 link.');
  assert.ok(listed.skills.every(skill => skill.offInPandaCode));
  assert.equal(lost.reset({}).prefsLost, undefined);
  assert.equal(createPreviewSkillManager({ prefsError: 'Unreadable' }).list({}).prefsLost, undefined);
});

test('copies native keeps for a reason (shared ancestor folders) read apart from ones PandaCode didn’t install', () => {
  const shared = '../.agents/skills/pdf (in a folder above this project, shared with the projects under it)';
  assert.equal(uninstalledText({ id: 'u', name: 'pdf', kept: [shared] }, 'orbit'), `Uninstalled pdf from orbit. Left in place: ${shared}.`);
  assert.equal(uninstalledText({ id: 'u', name: 'pdf', kept: ['~/.kimi/skills/pdf', shared] }, 'orbit'),
    `Uninstalled pdf from orbit. Left a copy PandaCode didn’t install in place: ~/.kimi/skills/pdf. Left in place: ${shared}.`);
});
