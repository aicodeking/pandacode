/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { BRANCH_MIN, MODEL_FLOOR, trayFit } from '../src/ui/tray-fit.ts';

const w = { model: 110, effort: 50, mode: 85, branch: 160 };

test('everything at full width when there is room', () => {
  assert.deepEqual(trayFit(500, w, false), { model: 110, branch: 160, effortIcon: false, modeIcon: false });
});

test('the model and the setting words stay whole; the branch shows only when readable', () => {
  const tight = trayFit(430, w, false);
  assert.equal(tight.model, 110);
  assert.ok(!tight.effortIcon && !tight.modeIcon);
  assert.ok(tight.branch! >= BRANCH_MIN && tight.branch! < 160, 'narrower than natural, still readable');
  const noBranch = trayFit(330, w, false);
  assert.equal(noBranch.branch, null, 'too little room to read it: dropped, not cropped');
  assert.equal(noBranch.model, 110);
  assert.ok(!noBranch.effortIcon && !noBranch.modeIcon);
  assert.equal(trayFit(400, { ...w, branch: 70 }, false).branch, 70, 'a short branch fits whole');
});

test('icons only when the words cannot fit, Full access always named, the model last', () => {
  const icons = trayFit(255, w, false);
  assert.ok(icons.effortIcon && !icons.modeIcon && icons.model === 110);
  const both = trayFit(210, w, false);
  assert.ok(both.effortIcon && both.modeIcon && both.model === 110);
  assert.equal(trayFit(210, w, true).modeIcon, false, 'Full access is always named');
  const squeezed = trayFit(150, w, false);
  assert.ok(squeezed.model < 110 && squeezed.model >= MODEL_FLOOR);
});
