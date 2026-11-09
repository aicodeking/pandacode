import test from 'node:test';
import assert from 'node:assert/strict';
import { wallpaperAt, nextWallpaperChange } from '../src/wallpapers.ts';
import { applyHostClockMetadata, validatedHostClockOffset } from '../src/web-preferences.ts';

test('host offset crosses weekday and UTC midnight',()=>{assert.equal(wallpaperAt(new Date('2026-09-20T23:30:00Z'),undefined,120),'mon-night');assert.equal(wallpaperAt(new Date('2026-09-21T03:30:00Z'),undefined,-240),'sun-night');});
test('host offset honors six noon and eighteen boundaries',()=>{for(const [iso,id] of [['2026-09-20T03:59:59.999Z','sun-night'],['2026-09-20T04:00:00Z','sun-morning'],['2026-09-20T10:00:00Z','sun-afternoon'],['2026-09-20T16:00:00Z','sun-night']])assert.equal(wallpaperAt(new Date(iso),undefined,120),id);});
test('next change preserves original epoch and native default',()=>{assert.equal(nextWallpaperChange(new Date('2026-09-20T23:59:00Z'),120).toISOString(),'2026-09-21T04:00:00.000Z');const date=new Date(2026,8,20,6);assert.equal(wallpaperAt(date),'sun-morning');});
test('invalid offsets use native behavior',()=>{const date=new Date('2026-09-20T04:00:00Z');assert.equal(wallpaperAt(date,undefined,999),wallpaperAt(date));});

test('host metadata accepts only bounded integer offsets and keeps the last valid host clock', () => {
  globalThis.document = { documentElement: { dataset: {} } };
  assert.equal(validatedHostClockOffset(), undefined);
  applyHostClockMetadata({ utcOffsetMinutes: -240 });
  assert.equal(validatedHostClockOffset(), -240);
  for (const value of [null, {}, { utcOffsetMinutes: 841 }, { utcOffsetMinutes: -841 }, { utcOffsetMinutes: 1.5 }, { utcOffsetMinutes: '120' }]) {
    applyHostClockMetadata(value); assert.equal(validatedHostClockOffset(), -240);
  }
  document.documentElement.dataset.pandacodeHostUtcOffsetMinutes = 'junk';
  assert.equal(validatedHostClockOffset(), undefined);
});
test('fixed host offsets are independent of the client process timezone', () => {
  const date = new Date('2026-11-07T22:00:00Z');
  // Explicit host offset uses UTC getters, even if local Date getters differ.
  date.getHours = () => { throw Error('client timezone was read'); };
  date.getDay = () => { throw Error('client timezone was read'); };
  assert.equal(wallpaperAt(date, undefined, 180), 'sun-night');
  assert.equal(nextWallpaperChange(date, 180).toISOString(), '2026-11-08T03:00:00.000Z');
});

test('night transitions at the next host midnight exactly once', () => {
  assert.equal(nextWallpaperChange(new Date('2026-11-07T18:00:00Z'), 120).toISOString(), '2026-11-07T22:00:00.000Z');
  assert.equal(nextWallpaperChange(new Date('2026-11-07T23:00:00Z'), -240).toISOString(), '2026-11-08T04:00:00.000Z');
});
