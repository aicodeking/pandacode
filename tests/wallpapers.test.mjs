import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { wallpaperAt, nextWallpaperChange, normalizeWallpaperPreferences, migrateWallpaperPreferences, WALLPAPER_PREFERENCES_VERSION } from '../src/wallpapers.ts';

test('wallpaper preferences default safely and validate persisted fields independently', () => {
  const defaults = { enabled: false, visibility: 20, blur: 0, set: 'automatic', pinned: null };
  for (const invalid of [undefined, null, false, 'mon', 10, [], { visibility: '60', enabled: 'false', set: 'Monday', pinned: '../mon-night' }]) {
    assert.deepEqual(normalizeWallpaperPreferences(invalid), defaults);
  }
  assert.deepEqual(normalizeWallpaperPreferences({ enabled: false, visibility: 43.6, set: 'fri', pinned: 'tue-night', extra: 'ignored' }), {
    enabled: false, visibility: 44, blur: 0, set: 'fri', pinned: 'tue-night',
  });
  for (const visibility of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizeWallpaperPreferences({ visibility }).visibility, 20);
  }
  assert.equal(normalizeWallpaperPreferences({ visibility: -20 }).visibility, 0);
  assert.equal(normalizeWallpaperPreferences({ visibility: 150 }).visibility, 100);
});

test('wallpaper blur defaults for earlier preferences and validates independently of scene and visibility', () => {
  const earlier = { enabled: false, visibility: 65, set: 'sat', pinned: 'sat-night' };
  assert.deepEqual(normalizeWallpaperPreferences(earlier), { ...earlier, blur: 0 });
  for (const blur of [undefined, null, '12', NaN, Infinity, -Infinity, {}, []]) {
    assert.deepEqual(normalizeWallpaperPreferences({ ...earlier, blur }), { ...earlier, blur: 0 });
  }
  for (const [input, blur] of [[-5, 0], [0, 0], [12.6, 13], [24, 24], [100, 24]]) {
    assert.deepEqual(normalizeWallpaperPreferences({ ...earlier, blur: input }), { ...earlier, blur });
  }
});

test('wallpaper preferences accept only the bundled scene identifiers', () => {
  for (const set of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    for (const period of ['morning', 'afternoon', 'night']) {
      const pinned = `${set}-${period}`;
      assert.deepEqual(normalizeWallpaperPreferences({ set, pinned }), { enabled: false, visibility: 20, blur: 0, set, pinned });
    }
  }
  for (const pinned of ['mon-noon', 'mon-night.webp', 'MON-night', '/wallpapers/mon-night', 'mon-night?x=1', 1, {}, []]) {
    assert.equal(normalizeWallpaperPreferences({ pinned }).pinned, null);
  }
});

test('a selected wallpaper set follows local time while a pinned default remains fixed', () => {
  for (const day of [14, 15, 20]) {
    for (const [hour, period] of [[0, 'night'], [6, 'morning'], [12, 'afternoon'], [18, 'night']]) {
      const date = new Date(2026, 8, day, hour);
      assert.equal(wallpaperAt(date, { set: 'fri' }), `fri-${period}`);
      assert.equal(wallpaperAt(date, { set: 'fri', pinned: 'wed-morning' }), 'wed-morning');
    }
  }
  assert.equal(wallpaperAt(new Date(2026, 8, 15, 15), { set: 'automatic', pinned: null }), 'tue-afternoon');
});

test('selects all 21 weekday and time combinations using local calendar time', () => {
  const ids = new Set();
  for (let day = 0; day < 7; day++) {
    for (const [hour, period] of [[6, 'morning'], [12, 'afternoon'], [18, 'night']]) {
      const date = new Date(2026, 8, 14 + day, hour);
      const id = wallpaperAt(date);
      assert.equal(id, `${['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][day]}-${period}`);
      ids.add(id);
    }
  }
  assert.equal(ids.size, 21);
});

test('switches exactly at 6am, noon, 6pm, and midnight without changing the input date', () => {
  for (const [hour, minute, period, boundary] of [
    [0, 0, 'night', 6], [5, 59, 'night', 6], [6, 0, 'morning', 12],
    [11, 59, 'morning', 12], [12, 0, 'afternoon', 18], [17, 59, 'afternoon', 18],
    [18, 0, 'night', 24], [23, 59, 'night', 24],
  ]) {
    const date = new Date(2026, 8, 20, hour, minute), original = date.getTime();
    assert.equal(wallpaperAt(date), `sun-${period}`);
    assert.equal(nextWallpaperChange(date).getTime(), new Date(2026, 8, 20, boundary).getTime());
    assert.equal(date.getTime(), original);
  }
  assert.equal(wallpaperAt(nextWallpaperChange(new Date(2026, 8, 20, 23, 59))), 'mon-night');
});

test('uses local calendar boundaries through daylight saving changes', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal((nextWallpaperChange(new Date(2026, 2, 8)) - new Date(2026, 2, 8)) / 3600000, 5);
    assert.equal((nextWallpaperChange(new Date(2026, 10, 1)) - new Date(2026, 10, 1)) / 3600000, 7);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('ships 21 distinct local WebP scenes within a five MiB collection budget', async () => {
  const hashes = new Set();
  let bytes = 0;
  for (let day = 0; day < 7; day++) for (const hour of [6, 12, 18]) {
    const id = wallpaperAt(new Date(2026, 8, 14 + day, hour));
    const image = await readFile(new URL(`../public/wallpapers/${id}.webp`, import.meta.url));
    assert.equal(image.toString('ascii', 0, 4), 'RIFF');
    assert.equal(image.toString('ascii', 8, 12), 'WEBP');
    hashes.add(createHash('sha256').update(image).digest('hex'));
    bytes += image.length;
  }
  assert.equal(hashes.size, 21);
  assert.ok(bytes < 5 * 1024 * 1024);
});

test('wallpapers are off by default, and an older save starts off with its choices kept', () => {
  assert.equal(WALLPAPER_PREFERENCES_VERSION, 3);
  assert.equal(migrateWallpaperPreferences(null).enabled, false);
  // An older save starts off whatever it held, and keeps its choices for when the switch is turned on again.
  for (const version of [undefined, 1, 2]) {
    const migrated = migrateWallpaperPreferences({ version, enabled: true, visibility: 45, blur: 6, set: 'fri', pinned: 'tue-night' });
    assert.deepEqual(migrated, { enabled: false, visibility: 45, blur: 6, set: 'fri', pinned: 'tue-night' }, String(version));
  }
  assert.equal(migrateWallpaperPreferences({}).enabled, false);
  assert.equal(migrateWallpaperPreferences({ version: 3, enabled: true, visibility: 20 }).enabled, true, 'a current save is taken as it is');
  assert.equal(migrateWallpaperPreferences({ version: 3, visibility: 20 }).enabled, false);
});
