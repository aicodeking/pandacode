/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import * as desktop from '../../src/wallpapers.ts';
import { nextWallpaperChange, normalizeWallpaperPreferences, patchWallpaperPreferences, PHONE_PREFERENCES_VERSION, phoneWallpaperPreferences, sceneIds, wallpaperAt } from '../src/ui/wallpaper.ts';

const dates = [
  new Date(2026, 9, 24, 0, 0), new Date(2026, 9, 24, 5, 59), new Date(2026, 9, 24, 6, 0), new Date(2026, 9, 25, 11, 59),
  new Date(2026, 9, 26, 12, 0), new Date(2026, 9, 27, 17, 59), new Date(2026, 9, 28, 18, 0), new Date(2026, 9, 29, 23, 59),
];
const choices = [undefined, { set: 'fri' as const }, { pinned: 'tue-night' }, { set: 'sun' as const, pinned: 'bogus' }];

test('the phone picks the same scene and next change as the desktop', () => {
  for (const date of dates) {
    assert.equal(nextWallpaperChange(date).getTime(), desktop.nextWallpaperChange(date).getTime());
    for (const choice of choices) assert.equal(wallpaperAt(date, choice), desktop.wallpaperAt(date, choice));
  }
  assert.equal(wallpaperAt(new Date(2026, 9, 24, 7), {}), 'sat-morning');
});

test('preferences normalize like the desktop', () => {
  for (const value of [undefined, null, 'mon', { visibility: 143, blur: -3, set: 'Monday', pinned: 'mon-night' }, { enabled: false, visibility: 43.6 }]) {
    assert.deepEqual(normalizeWallpaperPreferences(value), desktop.normalizeWallpaperPreferences(value));
  }
});

test('visibility alone switches the wallpaper on and off; every scene id has a file', () => {
  const base = normalizeWallpaperPreferences(null);
  assert.equal(patchWallpaperPreferences(base, { visibility: 0 }).enabled, false);
  assert.equal(patchWallpaperPreferences({ ...base, enabled: false }, { visibility: 40 }).enabled, true);
  assert.equal(patchWallpaperPreferences({ ...base, enabled: false }, { blur: 8 }).enabled, false);
  assert.equal(sceneIds.length, 21);
});

test('the phone starts at 26 % and 2 px and moves untouched old saves there', () => {
  const fresh = phoneWallpaperPreferences(null);
  assert.equal(fresh.visibility, 26);
  assert.equal(fresh.blur, 2);
  assert.equal(fresh.enabled, true);
  // An old save with the desktop's untouched defaults moves; its other choices stay.
  const old = phoneWallpaperPreferences({ enabled: false, visibility: 20, blur: 0, set: 'fri', pinned: null });
  assert.deepEqual([old.visibility, old.blur, old.enabled, old.set], [26, 2, false, 'fri']);
  // Explicit choices stay, including 20 / 0 once saved with the current version.
  assert.deepEqual([phoneWallpaperPreferences({ visibility: 20, blur: 5 }).visibility, phoneWallpaperPreferences({ visibility: 20, blur: 5 }).blur], [20, 5]);
  const chosen = phoneWallpaperPreferences({ visibility: 20, blur: 0, version: PHONE_PREFERENCES_VERSION });
  assert.deepEqual([chosen.visibility, chosen.blur], [20, 0]);
});
