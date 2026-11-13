/// <reference types="node" />
// The task's More menu offers Unarchive in Archive's place for a settled or archived task, as its inbox
// row does (InboxRow manage), on both the iOS native menu and Android's action sheet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSettledTask } from '../src/store/inbox.ts';

const header = readFileSync(new URL('../src/ui/TaskHeader.tsx', import.meta.url), 'utf8');

test('a settled or archived task counts as settled', () => {
  assert.equal(isSettledTask({ stage: 'completed', archived: false }), true);
  assert.equal(isSettledTask({ archived: true }), true);
  assert.equal(isSettledTask({ archived: false }), false);
});

test('the header reads whether the task is settled', () => {
  // The inbox row's rule (offersUnarchive), with the header's live or listed run status.
  assert.match(header, /const settled = useConnect\(s => offersUnarchive\(\{ task: s\.tasks\[deviceId\]\?\.tasks\.find\(t => t\.sessionId === sessionId\), status \}\)\);/);
  assert.match(header, /const unarchiveTask = \(\) => unarchiveAction\(deviceId, sessionId\);/);
  // Archive's Undo reopens to the stage the task had before (unarchiveThread then thread.setStage).
  assert.match(header, /action: \{ label: 'Undo', onPress: \(\) => unarchiveAction\(deviceId, sessionId, task\?\.stage, reopen\) \}/);
});

test('Android offers Unarchive for a settled task and Archive otherwise, behind the archive gate', () => {
  assert.match(header, /\.\.\.\(settle && settled && can\.archive\.shown \? \[\{ label: 'Unarchive', section: 'Manage', android: 'unarchive', onPress: press\(can\.archive, unarchiveTask\) \}/);
  assert.match(header, /\.\.\.\(settle && !settled && can\.archive\.shown \? \[\{ label: 'Archive', section: 'Manage', android: 'archive', onPress: press\(can\.archive, archive\) \}/);
});

test('iOS offers Unarchive for a settled task and Archive otherwise, behind the archive gate', () => {
  assert.match(header, /<Stack\.Toolbar\.MenuAction icon="tray\.and\.arrow\.up" hidden=\{!settled \|\| !can\.archive\.shown\} \{\.\.\.nativeGate\(can\.archive\)\} onPress=\{unarchiveTask\}>Unarchive</);
  assert.match(header, /<Stack\.Toolbar\.MenuAction icon="archivebox" hidden=\{settled \|\| !can\.archive\.shown\} \{\.\.\.nativeGate\(can\.archive\)\} onPress=\{archive\}>Archive</);
});

test('Undo after archiving from the task screen reopens it once unarchived', () => {
  assert.match(header, /export function archiveAction\(deviceId: string, sessionId: string, after\?: \(\) => void, reopen\?: \(\) => void\)/);
  assert.match(header, /action: \{ label: 'Undo', onPress: \(\) => unarchiveAction\(deviceId, sessionId, task\?\.stage, reopen\) \}/);
  // The reopen runs after the computer confirms the unarchive, not on the tap.
  assert.match(header, /reopenTask\(s\.tasks, deviceId, sessionId, stage\)[\s\S]{0,120}after\?\.\(\);\s*\}, failed\('Could not unarchive'\)/);
  assert.match(header, /const archive = \(\) => archiveAction\(deviceId, sessionId, leave, reopen\);/);
  // The Duo's split view opens it as a sidebar pick; elsewhere a push to the task route; never twice.
  assert.match(header, /if \(sidebarSelection\(stack\) === `\$\{deviceId\}\/\$\{sessionId\}`\) return;/);
  assert.match(header, /if \(split\) openFromSidebar\(href, sidebarOpen\(stack\)\);\s*else router\.push\(href\);/);
  assert.match(header, /pathname: '\/task\/\[device\]\/\[session\]' as const, params/);
});
