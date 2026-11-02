import test from 'node:test';
import assert from 'node:assert/strict';
import { isEditableField, undoDirection } from '../src/text-undo.ts';

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
