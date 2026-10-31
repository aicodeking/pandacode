import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installNotes, macosNote, UNQUARANTINE } from './install-notes.mjs';

test('an unsigned macOS build says how to clear the quarantine attribute', () => {
  const notes = installNotes();
  assert.match(notes, /xattr -dr com\.apple\.quarantine \/Applications\/PandaCode\.app/);
  assert.match(notes, /not signed with a Developer ID/);
  assert.match(notes, /Open Anyway/);
});

test('a notarized build does not ask for the workaround', () => {
  const notes = installNotes({ signed: true });
  assert.doesNotMatch(notes, /xattr/);
  assert.doesNotMatch(notes, /Open Anyway/);
  assert.match(notes, /signed and notarized/);
});

test('both builds offer the terminal install, which signs locally on macOS', () => {
  for (const notes of [installNotes(), installNotes({ signed: true })]) {
    assert.match(notes, /npx pandacode/);
    assert.match(notes, /signs it locally on macOS/);
  }
});

test('every published asset is named once', () => {
  const notes = installNotes();
  for (const asset of [
    'PandaCode-macOS-arm64.dmg',
    'PandaCode-macOS-x64.dmg',
    'PandaCode-Windows-x64-setup.exe',
    'PandaCode-Windows-arm64-setup.exe',
    'PandaCode-Linux-x86_64.AppImage',
    'PandaCode-Linux-aarch64.AppImage',
  ]) {
    assert.equal(notes.split(asset).length - 1, 1, asset);
  }
});

test('the macOS note names the same command the uninstaller uses', () => {
  assert.equal(UNQUARANTINE, 'xattr -dr com.apple.quarantine /Applications/PandaCode.app');
  assert.ok(macosNote(false).includes(UNQUARANTINE));
});

test('every line of the macOS note stays inside its list item', () => {
  for (const line of macosNote(false).split('\n').slice(1)) {
    assert.ok(line === '' || line.startsWith('  '), JSON.stringify(line));
  }
});
