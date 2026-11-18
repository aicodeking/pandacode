import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTextUndo, isEditableField, undoDirection } from '../src/text-undo.ts';

test('Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo', () => {
  assert.equal(undoDirection('z', false), 'undo');
  assert.equal(undoDirection('Z', false), 'undo');
  assert.equal(undoDirection('z', true), 'redo');
  assert.equal(undoDirection('Z', true), 'redo');
  assert.equal(undoDirection('y', false), 'redo');
  assert.equal(undoDirection('Y', true), 'redo');
  assert.equal(undoDirection('a', false), null);
  assert.equal(undoDirection('Enter', false), null);
});

function fakeDoc() {
  return {
    keydown: null, commands: [],
    activeElement: null,
    execCommand(command) { this.commands.push(command); return true; },
    addEventListener(type, listener) { this.keydown = listener; },
  };
}
const key = over => ({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, preventDefault() { this.prevented = true; }, ...over });
const run = (doc, event) => doc.keydown(event);

test('the Linux handler routes undo and redo to execCommand and consumes the key', () => {
  const doc = fakeDoc();
  attachTextUndo(doc, 'Linux x86_64');
  doc.activeElement = { tagName: 'TEXTAREA' };
  const undo = key();
  run(doc, undo);
  assert.equal(undo.prevented, true);
  assert.deepEqual(doc.commands, ['undo']);
  run(doc, key({ shiftKey: true }));
  run(doc, key({ key: 'y' }));
  assert.deepEqual(doc.commands, ['undo', 'redo', 'redo']);
});

test('the handler is Linux-only and ignores everything that is not a text edit', () => {
  const mac = fakeDoc();
  attachTextUndo(mac, 'MacIntel');
  assert.equal(mac.keydown, null);

  const doc = fakeDoc();
  attachTextUndo(doc, 'Linux x86_64');
  doc.activeElement = { tagName: 'INPUT', type: 'checkbox' };
  run(doc, key());
  assert.deepEqual(doc.commands, []);
  doc.activeElement = null;
  run(doc, key());
  assert.deepEqual(doc.commands, []);
  doc.activeElement = { tagName: 'TEXTAREA' };
  run(doc, key({ metaKey: true }));
  run(doc, key({ altKey: true }));
  run(doc, key({ isComposing: true }));
  run(doc, key({ defaultPrevented: true }));
  run(doc, key({ key: 'a' }));
  assert.deepEqual(doc.commands, []);
});

test('the terminal keeps its Ctrl keys: xterm fields are never text edits', () => {
  const doc = fakeDoc();
  attachTextUndo(doc, 'Linux x86_64');
  let asked;
  doc.activeElement = { tagName: 'TEXTAREA', closest: selector => { asked = selector; return {}; } };
  run(doc, key());
  assert.deepEqual(doc.commands, []);
  assert.equal(asked, '.xterm');
  doc.activeElement = { tagName: 'TEXTAREA' };
  run(doc, key());
  assert.deepEqual(doc.commands, ['undo']);
});

test('text fields qualify for the undo fix, buttons and checkboxes do not', () => {
  assert.equal(isEditableField({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableField({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableField({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isEditableField({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(isEditableField({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableField({ tagName: 'INPUT', type: 'submit' }), false);
  assert.equal(isEditableField({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableField({ tagName: 'DIV', isContentEditable: false }), false);
  assert.equal(isEditableField(null), false);
});
