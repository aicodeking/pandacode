/// <reference types="node" />
// Every text-entry sheet asks before throwing typed input away, through the one shared hook, and a
// successful submit releases the guard before it leaves.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

/** Screens guarded by useDiscardGuard; `release`: they leave with router.back() after saving. */
const GUARDED: readonly { file: string; release: boolean }[] = [
  { file: 'app/new-schedule.tsx', release: true },
  { file: 'app/commit.tsx', release: true },
  { file: 'app/new-pull.tsx', release: true },
  { file: 'app/rename.tsx', release: true },
  { file: 'app/add-project.tsx', release: true },
  { file: 'app/btw.tsx', release: false },
  { file: 'app/pull.tsx', release: false },
  { file: 'app/queue.tsx', release: false },
  { file: 'app/task-info.tsx', release: false },
  { file: 'app/file.tsx', release: false },
];

test('the hook asks Discard changes? with Keep Editing and Discard, and can be released', () => {
  const hook = read('ui/useDiscardGuard.ts');
  assert.match(hook, /usePreventRemove\(dirty && !released,/);
  assert.match(hook, /DISCARD_TITLE = 'Discard changes\?'/);
  assert.match(hook, /text: 'Keep Editing', style: 'cancel'/);
  assert.match(hook, /text: 'Discard', style: 'destructive'/);
  assert.match(hook, /setReleased\(true\); disable\(\);/);
});

test('each text-entry screen uses the shared guard, not its own usePreventRemove', () => {
  for (const { file } of GUARDED) {
    const source = read(file);
    assert.match(source, /import \{[^}]*useDiscardGuard[^}]*\} from '\.\.\/ui\/useDiscardGuard\.ts'/, file);
    assert.match(source, /useDiscardGuard\(/, file);
    assert.doesNotMatch(source, /usePreventRemove/, file);
  }
});

test('a successful submit releases the guard right before it leaves', () => {
  for (const { file, release } of GUARDED.filter(g => g.release)) {
    const source = read(file);
    assert.ok(release);
    assert.match(source, /const release = useDiscardGuard\(/, file);
    assert.match(source, /release\(\);\n\s+router\.back\(\);/, file);
  }
});

test('the schedule sheet is dirty only once the draft differs from the seeded one', () => {
  const source = read('app/new-schedule.tsx');
  assert.match(source, /useDiscardGuard\(JSON\.stringify\(draft\) !== JSON\.stringify\(seed\)/);
  assert.match(source, /setDraft\(next\);\n\s+setSeed\(next\);/);
});

/** Inline drafts on pushed screens: guarded, and released by a successful submit before the field clears. */
const INLINE: readonly { file: string; release: RegExp }[] = [
  { file: 'ui/github/ItemParts.tsx', release: /await onSend\(body\.trim\(\)\);\n\s+release\(\);\n\s+setBody\(''\);/ },
  { file: 'ui/admin/CloudAgentStart.tsx', release: /haptic\('success'\);\n\s+release\(\);\n\s+onStarted\(/ },
  { file: 'app/design.tsx', release: /await addComment\([^)]*\);\n\s+haptic\('success'\);\n\s+release\(\);/ },
  { file: 'app/bot-admin.tsx', release: /change\(d => withMemory\(d, memory\)\);\n\s+release\(\);\n\s+setDraft\(''\);/ },
];

test('inline comment, prompt and memory fields use the shared guard and release it on success', () => {
  for (const { file, release } of INLINE) {
    const source = read(file);
    assert.match(source, /import \{[^}]*useDiscardGuard[^}]*\} from '(\.\.\/)+(ui\/)?useDiscardGuard\.ts'/, file);
    assert.match(source, /const release = useDiscardGuard\(/, file);
    assert.doesNotMatch(source, /usePreventRemove/, file);
    assert.match(source, release, file);
  }
  // Dirty only with real text: a blank field or an untouched prompt leaves without asking.
  assert.match(read('ui/github/ItemParts.tsx'), /useDiscardGuard\(!!body\.trim\(\)/);
  assert.match(read('ui/admin/CloudAgentStart.tsx'), /useDiscardGuard\(!!edits\.prompt\?\.trim\(\)/);
  assert.match(read('app/design.tsx'), /useDiscardGuard\(!!draft && !!text\.trim\(\)/);
  assert.match(read('app/bot-admin.tsx'), /useDiscardGuard\(!!draft\.trim\(\)/);
});

test('the pull request Review card asks before Cancel drops typed text', () => {
  const source = read('app/pull.tsx');
  assert.match(source, /if \(!body\.trim\(\)\) return onCancel\(\);\n\s+Alert\.alert\(DISCARD_TITLE,/);
  assert.match(source, /\{ text: 'Discard', style: 'destructive', onPress: onCancel \}/);
  assert.match(source, /<Button label="Cancel"[^>]*onPress=\{cancel\} \/>/);
});
