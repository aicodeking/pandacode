import test from 'node:test';
import assert from 'node:assert/strict';
import { canNestedScrollerConsume, captureTranscriptAnchor, createSmoothScroller, decideScrollTransition, onAnchorRestore, restoreScrollTop, scrollRemainder, shouldWheelRestick } from '../src/transcript-scroll.ts';

/* decideScrollTransition */

/** A transcript 1000px tall in a 400px viewport (maxTop 600), pinned at the bottom unless overridden. */
const at = overrides => ({ top: 600, lastTop: 600, scrollHeight: 1000, clientHeight: 400, stickToBottom: true, resumeFollow: true, programmatic: false, ...overrides });

test('a scroll of our own changes nothing but the last position', () => {
  assert.deepEqual(decideScrollTransition(at({ top: 300, programmatic: true })), { stickToBottom: true, resumeFollow: true, nextLastTop: 300, action: 'ignore' });
  assert.deepEqual(decideScrollTransition(at({ top: 300, stickToBottom: false, resumeFollow: false, programmatic: true })), { stickToBottom: false, resumeFollow: false, nextLastTop: 300, action: 'ignore' });
});

test('a programmatic scroll records the clamped position', () => {
  assert.equal(decideScrollTransition(at({ top: 900, programmatic: true })).nextLastTop, 600);
  assert.equal(decideScrollTransition(at({ top: -20, programmatic: true })).nextLastTop, 0);
});

test('a 1px nudge up from the bottom releases the follow instead of snapping back', () => {
  assert.deepEqual(decideScrollTransition(at({ top: 599 })), { stickToBottom: false, resumeFollow: true, nextLastTop: 599, action: 'release' });
});

test('a 2px nudge up from the bottom releases, even with resumeFollow set and within the restick gap', () => {
  const result = decideScrollTransition(at({ top: 598, stickToBottom: false, resumeFollow: true, lastTop: 600 }));
  assert.equal(result.action, 'release');
  assert.equal(result.stickToBottom, false);
  assert.equal(result.resumeFollow, true, 'moving up keeps resumeFollow, so coming back down follows again');
});

test('a 1px nudge up stays released while resting there, and re-sticks on the way back down', () => {
  const up = decideScrollTransition(at({ top: 599 }));
  assert.deepEqual(up, { stickToBottom: false, resumeFollow: true, nextLastTop: 599, action: 'release' });
  // Another scroll event at the same place (gap 1, within the restick gap) is not a move down.
  const resting = decideScrollTransition(at({ top: 599, lastTop: up.nextLastTop, stickToBottom: up.stickToBottom, resumeFollow: up.resumeFollow }));
  assert.deepEqual(resting, { stickToBottom: false, resumeFollow: true, nextLastTop: 599, action: 'keep' });
  const down = decideScrollTransition(at({ top: 600, lastTop: resting.nextLastTop, stickToBottom: resting.stickToBottom, resumeFollow: resting.resumeFollow }));
  assert.deepEqual(down, { stickToBottom: true, resumeFollow: true, nextLastTop: 600, action: 'restick' });
});

test('a move down to within the restick gap does not restick while resumeFollow is paused', () => {
  const result = decideScrollTransition(at({ top: 599, lastTop: 597, stickToBottom: false, resumeFollow: false }));
  assert.deepEqual(result, { stickToBottom: false, resumeFollow: false, nextLastTop: 599, action: 'keep' });
});

test('scrolling down by less than a rounding step near the bottom is not a return', () => {
  const result = decideScrollTransition(at({ top: 598.8, lastTop: 598.5, stickToBottom: false, resumeFollow: true }));
  assert.equal(result.action, 'keep');
  assert.equal(result.stickToBottom, false);
});

test('a scripted jump to the bottom after scrolling up re-sticks', () => {
  // The reader scrolled up (released, resumeFollow kept), then scrollTop = scrollHeight clamps to the end.
  const up = decideScrollTransition(at({ top: 200, lastTop: 600 }));
  assert.equal(up.action, 'release');
  const back = decideScrollTransition(at({ top: 1000, lastTop: up.nextLastTop, stickToBottom: up.stickToBottom, resumeFollow: up.resumeFollow }));
  assert.deepEqual(back, { stickToBottom: true, resumeFollow: true, nextLastTop: 600, action: 'restick' });
});

test('sub-pixel jitter at the bottom is not an upward scroll', () => {
  assert.equal(decideScrollTransition(at({ top: 599.7 })).action, 'keep');
  assert.equal(decideScrollTransition(at({ top: 599.7 })).stickToBottom, true);
});

test('elastic overscroll past the end clamps to the bottom and keeps following', () => {
  const result = decideScrollTransition(at({ top: 640 }));
  assert.deepEqual(result, { stickToBottom: true, resumeFollow: true, nextLastTop: 600, action: 'keep' });
});

test('elastic overscroll above the top clamps to 0', () => {
  const result = decideScrollTransition(at({ top: -35, lastTop: 0, stickToBottom: false, resumeFollow: false }));
  assert.deepEqual(result, { stickToBottom: false, resumeFollow: false, nextLastTop: 0, action: 'keep' });
});

test('the rubber band settling back from past the end is not a release', () => {
  // The last event reported 640 (clamped to 600 then); the band now settles at 600.
  assert.equal(decideScrollTransition(at({ top: 600, lastTop: 600 })).action, 'keep');
});

test('content shrinking under a follower re-pins rather than releasing', () => {
  // Content shrank from 1000 to 800: maxTop is now 400 while lastTop was 600.
  const result = decideScrollTransition(at({ top: 400, lastTop: 600, scrollHeight: 800 }));
  assert.deepEqual(result, { stickToBottom: true, resumeFollow: true, nextLastTop: 400, action: 'repin' });
});

test('WebKit shrinking content by half a pixel under a follower re-pins rather than releasing', () => {
  // scrollHeight 1000 -> 999.5: maxTop 599.5, and WebKit reports the clamped scrollTop rounded down to 599.
  const result = decideScrollTransition(at({ top: 599, lastTop: 600, scrollHeight: 999.5 }));
  assert.deepEqual(result, { stickToBottom: true, resumeFollow: true, nextLastTop: 599, action: 'repin' });
  // A whole pixel too.
  assert.equal(decideScrollTransition(at({ top: 599, lastTop: 600, scrollHeight: 999 })).action, 'repin');
  // Paused resumeFollow is carried through.
  assert.deepEqual(decideScrollTransition(at({ top: 599, lastTop: 600, scrollHeight: 999.5, resumeFollow: false })),
    { stickToBottom: true, resumeFollow: false, nextLastTop: 599, action: 'repin' });
});

test('content shrinking while the reader also moved well above the new end releases', () => {
  // maxTop drops to 500 but the reader is at 300: more than a clamp.
  const result = decideScrollTransition(at({ top: 300, lastTop: 600, scrollHeight: 900 }));
  assert.equal(result.action, 'release');
  assert.equal(result.stickToBottom, false);
});

test('a follower clamped by a reflow that grew back before the scroll event re-pins (recorded in WebKit)', () => {
  // Opening a 12-turn thread: pinned at 3620 of 4388 (maxTop 3620); the inspector's render laid the page out while the
  // transcript was momentarily shorter of room, WebKit clamped scrollTop to 3523, and the scroll event arrived with
  // scrollHeight 4430 (maxTop 3662), 139px short.
  const input = { top: 3523, lastTop: 3620, scrollHeight: 4430, clientHeight: 768, stickToBottom: true, resumeFollow: true, programmatic: false };
  assert.deepEqual(decideScrollTransition({ ...input, layoutChanged: true, userScrolling: false }),
    { stickToBottom: true, resumeFollow: true, nextLastTop: 3523, action: 'repin' });
  // The same move with the layout unchanged is the reader (a scrollbar drag, keys, a script): it releases.
  assert.equal(decideScrollTransition({ ...input, layoutChanged: false }).action, 'release');
  // So is one during a gesture of the reader's, whatever the layout did.
  assert.equal(decideScrollTransition({ ...input, layoutChanged: true, userScrolling: true }).action, 'release');
});

test('a follower clamped by a reflow that came back to the same extent re-pins when its surroundings changed (recorded in WebKit)', () => {
  // Back on a remembered page: pinned at 732 of 1500 in 768; the inspector redrew and WebKit clamped to 593 in a layout
  // between, and the scroll event arrived with the extent just as it was. Only the change around it tells it from a script.
  const input = { top: 593, lastTop: 732, scrollHeight: 1500, clientHeight: 768, stickToBottom: true, resumeFollow: true, programmatic: false };
  assert.equal(decideScrollTransition({ ...input, layoutChanged: true }).action, 'repin');
  assert.equal(decideScrollTransition({ ...input, layoutChanged: false }).action, 'release');
});

test('a layout change never re-pins a reader who already left, nor a move down', () => {
  assert.equal(decideScrollTransition(at({ top: 400, lastTop: 500, stickToBottom: false, layoutChanged: true })).action, 'release');
  assert.equal(decideScrollTransition(at({ top: 600, lastTop: 590, scrollHeight: 1000, layoutChanged: true })).action, 'keep');
});

test('a 1px nudge up from the bottom still releases while the layout holds still, even with a gesture noted', () => {
  assert.equal(decideScrollTransition(at({ top: 599, layoutChanged: false, userScrolling: false })).action, 'release');
  assert.equal(decideScrollTransition(at({ top: 599, layoutChanged: true, userScrolling: true })).action, 'release');
});

test('content shrinking while not following is an ordinary clamp, and may release', () => {
  const result = decideScrollTransition(at({ top: 400, lastTop: 600, scrollHeight: 800, stickToBottom: false, resumeFollow: false }));
  assert.equal(result.action, 'release');
  assert.equal(result.stickToBottom, false);
});

test('returning to the bottom resticks when resumeFollow is set', () => {
  const result = decideScrollTransition(at({ top: 599, lastTop: 500, stickToBottom: false, resumeFollow: true }));
  assert.deepEqual(result, { stickToBottom: true, resumeFollow: true, nextLastTop: 599, action: 'restick' });
});

test('returning to the bottom does not restick when resumeFollow is off', () => {
  const result = decideScrollTransition(at({ top: 600, lastTop: 500, stickToBottom: false, resumeFollow: false }));
  assert.deepEqual(result, { stickToBottom: false, resumeFollow: false, nextLastTop: 600, action: 'keep' });
});

test('scrolling down short of the bottom does not restick', () => {
  const result = decideScrollTransition(at({ top: 590, lastTop: 500, stickToBottom: false, resumeFollow: true }));
  assert.deepEqual(result, { stickToBottom: false, resumeFollow: true, nextLastTop: 590, action: 'keep' });
});

test('scrolling up far from the bottom releases and keeps resumeFollow as it was', () => {
  assert.deepEqual(decideScrollTransition(at({ top: 100, lastTop: 300, stickToBottom: false, resumeFollow: true })),
    { stickToBottom: false, resumeFollow: true, nextLastTop: 100, action: 'release' });
  assert.deepEqual(decideScrollTransition(at({ top: 100, lastTop: 300, stickToBottom: false, resumeFollow: false })),
    { stickToBottom: false, resumeFollow: false, nextLastTop: 100, action: 'release' });
});

test('content shorter than the viewport keeps a follower, and a released reader stays released without moving down', () => {
  const following = decideScrollTransition(at({ top: 0, lastTop: 0, scrollHeight: 300 }));
  assert.deepEqual(following, { stickToBottom: true, resumeFollow: true, nextLastTop: 0, action: 'keep' });
  const released = decideScrollTransition(at({ top: 0, lastTop: 0, scrollHeight: 300, stickToBottom: false, resumeFollow: true }));
  assert.deepEqual(released, { stickToBottom: false, resumeFollow: true, nextLastTop: 0, action: 'keep' });
});

test('a gesture of the reader\'s never re-pins: a move up during one always releases', () => {
  // A layout change noted mid-gesture (the old surroundings watch fired on the dock, the sky, the composer).
  assert.deepEqual(decideScrollTransition(at({ top: 500, layoutChanged: true, userScrolling: true })),
    { stickToBottom: false, resumeFollow: true, nextLastTop: 500, action: 'release' });
  // Content shrinking under the reader as they scroll up a pixel from the end: still the reader leaving.
  assert.deepEqual(decideScrollTransition(at({ top: 599, lastTop: 600, scrollHeight: 999.5, userScrolling: true })),
    { stickToBottom: false, resumeFollow: true, nextLastTop: 599, action: 'release' });
  assert.equal(decideScrollTransition(at({ top: 599, lastTop: 600, scrollHeight: 999, layoutChanged: true, userScrolling: true })).action, 'release');
  // The same shrink with no gesture is a clamp, and re-pins.
  assert.equal(decideScrollTransition(at({ top: 599, lastTop: 600, scrollHeight: 999.5, userScrolling: false })).action, 'repin');
});

test('no input combination with a gesture under way answers repin', () => {
  for (const top of [-20, 0, 300, 598, 599, 599.7, 600, 640]) {
    for (const lastTop of [0, 300, 599, 600, 640]) {
      for (const scrollHeight of [800, 999, 999.5, 1000, 1200]) {
        for (const layoutChanged of [false, true]) {
          const result = decideScrollTransition(at({ top, lastTop, scrollHeight, layoutChanged, userScrolling: true }));
          assert.notEqual(result.action, 'repin', JSON.stringify({ top, lastTop, scrollHeight, layoutChanged }));
        }
      }
    }
  }
});

/* shouldWheelRestick */

/** A released reader at the end (gap 0), 1s after their last upward wheel, with nothing accumulated. */
const wheel = overrides => ({ deltaY: 40, now: 2000, lastUpwardWheelAt: 1000, downAccum: 0, gap: 0, stickToBottom: false, ...overrides });

test('an upward or zero wheel never resticks and resets the downward travel', () => {
  assert.deepEqual(shouldWheelRestick(wheel({ deltaY: -10, downAccum: 30 })), { restick: false, deliberate: false, nextDownAccum: 0 });
  assert.deepEqual(shouldWheelRestick(wheel({ deltaY: 0, downAccum: 30 })), { restick: false, deliberate: false, nextDownAccum: 0 });
});

test('tiny trackpad jitter right after an upward swipe does not restick, even at the end', () => {
  for (const deltaY of [0.01, 0.5, 2, 3]) {
    const result = shouldWheelRestick(wheel({ deltaY, now: 1050, lastUpwardWheelAt: 1000 }));
    assert.equal(result.restick, false, `+${deltaY}`);
    assert.equal(result.deliberate, false, `+${deltaY} must not arm resumeFollow either`);
  }
  // Several jitters adding up past the intent threshold inside the cooldown still do not.
  let downAccum = 0;
  for (let i = 0; i < 8; i++) {
    const result = shouldWheelRestick(wheel({ deltaY: 2, now: 1000 + i * 20, lastUpwardWheelAt: 1000, downAccum }));
    assert.equal(result.restick, false);
    downAccum = result.nextDownAccum;
  }
  assert.equal(downAccum, 16);
});

test('elastic overscroll past the end does not restick', () => {
  assert.equal(shouldWheelRestick(wheel({ gap: -15 })).restick, false);
  assert.equal(shouldWheelRestick(wheel({ gap: -15, deltaY: 120 })).restick, false);
  // Within half a pixel past the end is rounding, not a bounce.
  assert.equal(shouldWheelRestick(wheel({ gap: -0.4 })).restick, true);
});

test('a deliberate downward wheel at the end resticks', () => {
  // A big delta bypasses the cooldown (a fast scroll back down, or a scripted wheel right after one up).
  assert.deepEqual(shouldWheelRestick(wheel({ deltaY: 24, now: 1010, lastUpwardWheelAt: 1000 })), { restick: true, deliberate: true, nextDownAccum: 24 });
  // After the cooldown, accumulated travel of 12px is enough...
  assert.equal(shouldWheelRestick(wheel({ deltaY: 4, downAccum: 8, now: 1300, lastUpwardWheelAt: 1000 })).restick, true);
  // ...or a single 6px delta.
  assert.equal(shouldWheelRestick(wheel({ deltaY: 6, now: 1300, lastUpwardWheelAt: 1000 })).restick, true);
  // But a 3px delta alone after the cooldown is not yet intent.
  assert.equal(shouldWheelRestick(wheel({ deltaY: 3, now: 1300, lastUpwardWheelAt: 1000 })).restick, false);
  // Within the 2px restick gap counts as the end.
  assert.equal(shouldWheelRestick(wheel({ gap: 2 })).restick, true);
});

test('a deliberate wheel short of the end, or while already following, does not restick but is still deliberate', () => {
  assert.deepEqual(shouldWheelRestick(wheel({ gap: 2.5 })), { restick: false, deliberate: true, nextDownAccum: 40 });
  assert.deepEqual(shouldWheelRestick(wheel({ stickToBottom: true })), { restick: false, deliberate: true, nextDownAccum: 40 });
});

/* restoreScrollTop */

/** A scroller that clamps scrollTop to its extent and, with `round`, to whole pixels (as WKWebView does). */
function fakeScroller({ scrollHeight = 10000, clientHeight = 500, top = 0, round = false } = {}) {
  let scrollTop = top;
  return {
    scrollHeight, clientHeight,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) {
      const clamped = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value));
      scrollTop = round ? Math.round(clamped) : clamped;
    },
  };
}

test('restoreScrollTop carries only the rounding a webview dropped', () => {
  const scroller = fakeScroller({ round: true });
  restoreScrollTop(scroller, 100.4);
  assert.equal(scroller.scrollTop, 100);
  assert.ok(Math.abs(scrollRemainder(scroller) - 0.4) < 1e-9);
  // Something else scrolled since: the remainder no longer applies.
  scroller.scrollTop = 200;
  assert.equal(scrollRemainder(scroller), 0);
});

test('restoreScrollTop skips a write that would not move the scroller (it would end WKWebView momentum)', () => {
  let writes = 0, scrollTop = 300;
  const scroller = {
    scrollHeight: 10000, clientHeight: 500,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { writes++; scrollTop = Math.round(value); },
  };
  restoreScrollTop(scroller, 300);
  restoreScrollTop(scroller, 300.4);
  restoreScrollTop(scroller, 299.6);
  assert.equal(writes, 0);
  assert.equal(scroller.scrollTop, 300);
  // What was skipped is carried as the remainder, as a rounded write would have been.
  assert.ok(Math.abs(scrollRemainder(scroller) - -0.4) < 1e-9);
  restoreScrollTop(scroller, 300.5);
  assert.equal(writes, 1);
  restoreScrollTop(scroller, 310);
  assert.equal(writes, 2);
  assert.equal(scroller.scrollTop, 310);
});

test('restoreScrollTop never carries a clamp', () => {
  const scroller = fakeScroller({ round: true, scrollHeight: 1000, clientHeight: 500 });
  restoreScrollTop(scroller, 800);
  assert.equal(scroller.scrollTop, 500);
  assert.equal(scrollRemainder(scroller), 0);
});

/* onAnchorRestore */

test('onAnchorRestore hears every restore that moves the scroller, with the position it landed at', () => {
  const scroller = fakeScroller({ round: true, top: 300 }), heard = [];
  onAnchorRestore(scroller, top => heard.push(top));
  restoreScrollTop(scroller, 300.4);
  restoreScrollTop(scroller, 299.6);
  assert.deepEqual(heard, [], 'a write under half a pixel is skipped, so nothing is heard');
  restoreScrollTop(scroller, 1234.4);
  assert.deepEqual(heard, [1234], 'the actual (rounded) scrollTop, not the asked one');
  restoreScrollTop(scroller, 20000);
  assert.deepEqual(heard, [1234, 9500], 'a clamped write reports where it clamped to');
});

test('onAnchorRestore listeners are per scroller and all of them are called', () => {
  const one = fakeScroller(), two = fakeScroller(), heard = [];
  onAnchorRestore(one, top => heard.push(['a', top]));
  onAnchorRestore(one, top => heard.push(['b', top]));
  restoreScrollTop(two, 400);
  assert.deepEqual(heard, []);
  restoreScrollTop(one, 400);
  assert.deepEqual(heard, [['a', 400], ['b', 400]]);
});

/* captureTranscriptAnchor, in an engine that claims overflow-anchor but does not anchor (WebKit 26) */

/** A transcript of stacked rows (heights in px) in a 500px viewport at y=0; scrollTop never moves by itself. */
function fakeTranscript(heights, top = 0) {
  let scrollTop = top;
  const rows = [];
  const rowOf = (id, height) => {
    const row = {
      id, height,
      matches: () => true,
      querySelectorAll: () => [],
      querySelector: () => null,
      hasAttribute: name => name === 'data-message-id',
      getAttribute: () => id,
      getClientRects: () => [1],
      getBoundingClientRect() {
        const y = rows.slice(0, rows.indexOf(row)).reduce((sum, r) => sum + r.height, 0) - scrollTop;
        return { top: y, bottom: y + row.height, height: row.height };
      },
    };
    return row;
  };
  heights.forEach((height, index) => rows.push(rowOf(`m${index}`, height)));
  const transcript = {
    rows, rowOf,
    get children() { return rows; },
    get scrollHeight() { return rows.reduce((sum, r) => sum + r.height, 0); },
    clientHeight: 500,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)); },
    getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }),
    querySelector: selector => rows.find(row => selector === `[data-message-id="${row.id}"]`) ?? null,
  };
  return transcript;
}

function withLyingWebKit(run) {
  const saved = { CSS: globalThis.CSS, getComputedStyle: globalThis.getComputedStyle };
  globalThis.CSS = { supports: () => true, escape: value => value };
  globalThis.getComputedStyle = () => ({ height: '500px', scrollPaddingTop: '0px' });
  try { run(); } finally { Object.assign(globalThis, saved); }
}

test('captureTranscriptAnchor keeps the read row in place when rows land above it, though CSS.supports claims overflow-anchor', () => {
  withLyingWebKit(() => {
    const transcript = fakeTranscript(Array(10).fill(500), 2600);
    const restore = captureTranscriptAnchor(transcript);
    // Three older turns land above, each with a long reply that is clamped before the restore reads the layout.
    transcript.rows.unshift(transcript.rowOf('old0', 5000), transcript.rowOf('old1', 5000), transcript.rowOf('old2', 5000));
    transcript.rows.slice(0, 3).forEach(row => { row.height = 800; });
    restore();
    assert.equal(transcript.scrollTop, 2600 + 3 * 800);
    assert.equal(transcript.querySelector('[data-message-id="m5"]').getBoundingClientRect().top, -100);
  });
});

test('captureTranscriptAnchor counts what is still to come above the reader, however the engine reports overflow-anchor', () => {
  withLyingWebKit(() => {
    // No row in the band (an empty transcript region): the fallback is the change in extent plus `pending`.
    const transcript = fakeTranscript([], 0);
    let height = 4000;
    Object.defineProperty(transcript, 'scrollHeight', { get: () => height });
    transcript.scrollTop = 1000;
    const restore = captureTranscriptAnchor(transcript);
    height = 7000;
    restore(-2000);
    assert.equal(transcript.scrollTop, 1000 + 3000 - 2000, 'a negative pending (replies about to clamp) is never dropped');
  });
});

/* canNestedScrollerConsume */

const element = (props = {}) => ({ nodeType: 1, parentNode: null, overflowY: 'visible', scrollTop: 0, scrollHeight: 100, clientHeight: 100, ...props });

function withComputedStyle(run) {
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => ({ overflowY: node.overflowY });
  try { return run(); } finally { if (previous) globalThis.getComputedStyle = previous; else delete globalThis.getComputedStyle; }
}

/** boundary > block (a scrolling code block: 1000 tall in 200) > line > text. */
function nested(blockProps = {}) {
  const boundary = element({ overflowY: 'auto', scrollHeight: 5000, clientHeight: 500, scrollTop: 300 });
  const block = element({ parentNode: boundary, overflowY: 'auto', scrollHeight: 1000, clientHeight: 200, ...blockProps });
  const line = element({ parentNode: block });
  const text = { nodeType: 3, parentNode: line };
  return { boundary, block, line, text };
}

test('a nested scroller with room in the wheel direction consumes the wheel', () => withComputedStyle(() => {
  const { boundary, text } = nested({ scrollTop: 400 });
  assert.equal(canNestedScrollerConsume(text, boundary, 40), true);
  assert.equal(canNestedScrollerConsume(text, boundary, -40), true);
}));

test('a nested scroller at its top hands upward wheels to the transcript', () => withComputedStyle(() => {
  const { boundary, line } = nested({ scrollTop: 0 });
  assert.equal(canNestedScrollerConsume(line, boundary, -40), false);
  assert.equal(canNestedScrollerConsume(line, boundary, 40), true);
}));

test('a nested scroller at its bottom hands downward wheels to the transcript', () => withComputedStyle(() => {
  const { boundary, line } = nested({ scrollTop: 800 });
  assert.equal(canNestedScrollerConsume(line, boundary, 40), false);
  assert.equal(canNestedScrollerConsume(line, boundary, -40), true);
}));

test('an element that overflows but does not scroll (overflow visible or hidden) never consumes', () => withComputedStyle(() => {
  for (const overflowY of ['visible', 'hidden', 'clip']) {
    const { boundary, line } = nested({ overflowY, scrollTop: 400 });
    assert.equal(canNestedScrollerConsume(line, boundary, 40), false, overflowY);
  }
}));

test('scroll and overlay overflow count as scrolling', () => withComputedStyle(() => {
  for (const overflowY of ['scroll', 'overlay']) {
    const { boundary, line } = nested({ overflowY, scrollTop: 400 });
    assert.equal(canNestedScrollerConsume(line, boundary, 40), true, overflowY);
  }
}));

test('a scroller with no real overflow (within 1px) never consumes', () => withComputedStyle(() => {
  const { boundary, line } = nested({ scrollHeight: 201, clientHeight: 200, scrollTop: 0 });
  assert.equal(canNestedScrollerConsume(line, boundary, 40), false);
}));

test('the boundary itself is never counted', () => withComputedStyle(() => {
  const { boundary } = nested();
  assert.equal(canNestedScrollerConsume(boundary, boundary, 40), false);
}));

test('a nested scroller with no room lets an outer nested scroller consume', () => withComputedStyle(() => {
  const { boundary, block, line } = nested({ scrollTop: 400 });
  const inner = element({ parentNode: block, overflowY: 'auto', scrollHeight: 300, clientHeight: 100, scrollTop: 200 });
  line.parentNode = inner;
  assert.equal(canNestedScrollerConsume(line, boundary, 40), true);
}));

test('canNestedScrollerConsume is false without a target, a delta, or a DOM', () => {
  const { boundary, line } = nested({ scrollTop: 400 });
  withComputedStyle(() => {
    assert.equal(canNestedScrollerConsume(null, boundary, 40), false);
    assert.equal(canNestedScrollerConsume(line, boundary, 0), false);
  });
  assert.equal(typeof globalThis.getComputedStyle, 'undefined');
  assert.equal(canNestedScrollerConsume(line, boundary, 40), false);
});

/* createSmoothScroller */

/** A controllable clock and animation frame queue; `frame(ms)` advances the clock and runs one frame. */
function animationHarness(t, { reduced = false } = {}) {
  let clock = 1000, nextId = 1;
  const frames = new Map();
  const saved = {
    raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, matchMedia: globalThis.matchMedia,
    now: Object.getOwnPropertyDescriptor(performance, 'now'),
  };
  globalThis.requestAnimationFrame = callback => { const id = nextId++; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  globalThis.matchMedia = query => ({ matches: reduced && query.includes('reduce') });
  performance.now = () => clock;
  t.after(() => {
    for (const [name, value] of [['requestAnimationFrame', saved.raf], ['cancelAnimationFrame', saved.caf], ['matchMedia', saved.matchMedia]]) {
      if (value) globalThis[name] = value; else delete globalThis[name];
    }
    if (saved.now) Object.defineProperty(performance, 'now', saved.now); else delete performance.now;
  });
  return {
    pending: () => frames.size,
    frame(ms = 16) {
      clock += ms;
      const queued = [...frames.entries()];
      frames.clear();
      for (const [, callback] of queued) callback(clock);
    },
    /** Runs frames until none is queued (or `limit`), answering how many ran. */
    run(ms = 16, limit = 200) { let count = 0; while (frames.size && count < limit) { this.frame(ms); count++; } return count; },
  };
}

function recorder() {
  const steps = [], active = [], done = [];
  return { steps, active, done, options: { onStep: top => steps.push(top), onActiveChange: value => active.push(value) }, onDone: landed => done.push(landed) };
}

test('an instant scroll lands in one step without an animation frame', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  const smooth = createSmoothScroller(scroller, log.options);
  smooth.scrollTo(800, { instant: true, onDone: log.onDone });
  assert.equal(scroller.scrollTop, 800);
  assert.deepEqual(log.steps, [800]);
  assert.deepEqual(log.done, [true]);
  assert.deepEqual(log.active, []);
  assert.equal(harness.pending(), 0);
  assert.equal(smooth.isActive(), false);
});

test('reduced motion scrolls instantly', t => {
  const harness = animationHarness(t, { reduced: true }), scroller = fakeScroller(), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(800, { onDone: log.onDone });
  assert.equal(scroller.scrollTop, 800);
  assert.deepEqual(log.done, [true]);
  assert.equal(harness.pending(), 0);
});

test('a target within a pixel lands instantly', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ top: 500 }), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(500.8, { onDone: log.onDone });
  assert.equal(scroller.scrollTop, 500.8);
  assert.deepEqual(log.done, [true]);
  assert.equal(harness.pending(), 0);
});

test('a smooth scroll eases out monotonically and lands exactly within 280ms', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  const smooth = createSmoothScroller(scroller, log.options);
  smooth.scrollTo(900, { onDone: log.onDone });
  assert.equal(smooth.isActive(), true);
  assert.deepEqual(log.active, [true]);
  assert.equal(scroller.scrollTop, 0, 'nothing moves before the first frame');
  const frames = harness.run(16);
  assert.ok(frames * 16 >= 200 && frames * 16 <= 280 + 16, `took ${frames} frames`);
  assert.equal(scroller.scrollTop, 900);
  assert.deepEqual(log.done, [true]);
  assert.deepEqual(log.active, [true, false]);
  assert.equal(smooth.isActive(), false);
  for (let index = 1; index < log.steps.length; index++) assert.ok(log.steps[index] >= log.steps[index - 1]);
  // Ease-out: the first half of the time covers well over half the distance.
  const half = log.steps[Math.floor(log.steps.length / 2) - 1];
  assert.ok(half > 450, `halfway at ${half}`);
  assert.equal(log.steps.at(-1), 900);
});

test('a short smooth scroll takes the minimum duration, a longer one a little longer', t => {
  const harness = animationHarness(t);
  const short = fakeScroller(), long = fakeScroller();
  createSmoothScroller(short).scrollTo(100);
  const shortFrames = harness.run(10);
  createSmoothScroller(long).scrollTo(1000);
  const longFrames = harness.run(10);
  assert.ok(shortFrames >= 20 && shortFrames <= 21, `short took ${shortFrames}`);
  assert.ok(longFrames > shortFrames && longFrames <= 28, `long took ${longFrames}`);
});

test('a distant target is bridged at once, then eased for the final approach', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 50000, clientHeight: 500 }), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(20000, { onDone: log.onDone });
  // Bridge to max(500 * 1.1, 600) = 600 short of the target.
  assert.equal(scroller.scrollTop, 19400);
  assert.deepEqual(log.steps, [19400]);
  const frames = harness.run(10);
  assert.ok(frames >= 22 && frames <= 23, `approach took ${frames} frames`);
  assert.equal(scroller.scrollTop, 20000);
  assert.deepEqual(log.done, [true]);
});

test('a distant target upward is bridged from below it', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 50000, clientHeight: 1000, top: 30000 });
  createSmoothScroller(scroller).scrollTo(1000);
  // Bridge distance max(1000 * 1.1, 600) = 1100, and the jump threshold max(2200, 1200) is exceeded.
  assert.equal(scroller.scrollTop, 2100);
  harness.run();
  assert.equal(scroller.scrollTop, 1000);
});

test('a target just under the bridge threshold is not bridged', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 50000, clientHeight: 500 });
  createSmoothScroller(scroller).scrollTo(1200);
  assert.equal(scroller.scrollTop, 0);
  harness.run();
  assert.equal(scroller.scrollTop, 1200);
});

test('a reader scrolling during the animation cancels it', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  const smooth = createSmoothScroller(scroller, log.options);
  smooth.scrollTo(900, { onDone: log.onDone });
  harness.frame(); harness.frame();
  const reached = scroller.scrollTop;
  scroller.scrollTop = reached - 40; // the reader's wheel
  harness.frame();
  assert.equal(scroller.scrollTop, reached - 40, 'the animation leaves the reader where they scrolled');
  assert.deepEqual(log.done, [false]);
  assert.deepEqual(log.active, [true, false]);
  assert.equal(smooth.isActive(), false);
  assert.equal(harness.pending(), 0);
});

test('a small drift (within 3px) does not cancel', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(900, { onDone: log.onDone });
  harness.frame(); harness.frame();
  scroller.scrollTop += 2.5;
  harness.run();
  assert.equal(scroller.scrollTop, 900);
  assert.deepEqual(log.done, [true]);
});

test('content shrinking under the animation is a clamp, not the reader', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 2000, clientHeight: 500 }), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(1500, { onDone: log.onDone });
  harness.frame(100);
  assert.ok(scroller.scrollTop > 1000);
  // Content shrinks: maxTop is now 900, and the engine clamps scrollTop.
  scroller.scrollHeight = 1400;
  scroller.scrollTop = scroller.scrollTop;
  harness.run();
  assert.equal(scroller.scrollTop, 900);
  assert.deepEqual(log.done, [true]);
});

test('scroll anchoring moving scrollTop with a layout change mid-jump carries the animation along', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 50000, clientHeight: 500 }), log = recorder();
  // A row's top, which moves when far rows above it lay out: the target follows it, as a jump's does.
  let rowTop = 20000;
  createSmoothScroller(scroller, log.options).scrollTo(() => rowTop, { onDone: log.onDone });
  assert.equal(scroller.scrollTop, 19400, 'bridged');
  harness.frame(); harness.frame();
  const before = scroller.scrollTop;
  // Far rows above clamp under Read more: the content above shrinks by 180px, and Chromium's overflow-anchor moves
  // scrollTop by the same amount so the reader's line stays put.
  scroller.scrollHeight -= 180;
  scroller.scrollTop = before - 180;
  rowTop -= 180;
  harness.frame();
  assert.ok(scroller.scrollTop >= before - 180, `continued from the anchored position (at ${scroller.scrollTop})`);
  harness.run();
  assert.equal(scroller.scrollTop, 19820);
  assert.deepEqual(log.done, [true]);
  // After the shift, every step still moves toward the target.
  const after = log.steps.slice(log.steps.indexOf(before) + 1);
  for (let index = 1; index < after.length; index++) assert.ok(after[index] >= after[index - 1], `step ${index}: ${after[index - 1]} -> ${after[index]}`);
});

test('a layout change that grows content above mid-jump is carried too', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 5000, clientHeight: 500 }), log = recorder();
  let rowTop = 900;
  createSmoothScroller(scroller, log.options).scrollTo(() => rowTop, { onDone: log.onDone });
  harness.frame(); harness.frame();
  scroller.scrollHeight += 68;
  scroller.scrollTop += 68;
  rowTop += 68;
  harness.run();
  assert.equal(scroller.scrollTop, 968);
  assert.deepEqual(log.done, [true]);
});

test('an external scroll with no change in scrollHeight still cancels a jump', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 50000, clientHeight: 500 }), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(20000, { onDone: log.onDone });
  harness.frame(); harness.frame();
  const reached = scroller.scrollTop;
  scroller.scrollTop = reached - 180;
  harness.frame();
  assert.equal(scroller.scrollTop, reached - 180);
  assert.deepEqual(log.done, [false]);
  assert.deepEqual(log.active, [true, false]);
  assert.equal(harness.pending(), 0);
});

test('a webview rounding scrollTop to whole pixels never trips the drift check', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ round: true }), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(737, { onDone: log.onDone });
  harness.run(7);
  assert.equal(scroller.scrollTop, 737);
  assert.deepEqual(log.done, [true]);
  for (const top of log.steps) assert.equal(top, Math.round(top));
});

test('cancel() stops the animation and reports it did not land', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  const smooth = createSmoothScroller(scroller, log.options);
  smooth.scrollTo(900, { onDone: log.onDone });
  harness.frame();
  smooth.cancel();
  assert.deepEqual(log.done, [false]);
  assert.deepEqual(log.active, [true, false]);
  assert.equal(harness.pending(), 0);
  smooth.cancel();
  assert.deepEqual(log.done, [false], 'a second cancel reports nothing');
  assert.deepEqual(log.active, [true, false]);
});

test('a function target is asked every frame and followed as it moves', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  let goal = 500;
  createSmoothScroller(scroller, log.options).scrollTo(() => goal, { onDone: log.onDone });
  harness.frame(); harness.frame();
  goal = 1200;
  harness.run();
  assert.equal(scroller.scrollTop, 1200);
  assert.deepEqual(log.done, [true]);
});

test('a function target answering null abandons the scroll', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  let goal = 800;
  createSmoothScroller(scroller, log.options).scrollTo(() => goal, { onDone: log.onDone });
  harness.frame();
  goal = null;
  harness.frame();
  assert.deepEqual(log.done, [false]);
  assert.deepEqual(log.active, [true, false]);
  assert.equal(harness.pending(), 0);
});

test('a null target from the start never animates', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(() => null, { onDone: log.onDone });
  assert.deepEqual(log.done, [false]);
  assert.deepEqual(log.active, []);
  assert.equal(harness.pending(), 0);
});

test('a new scroll supersedes the one in flight without flickering the active state', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  const smooth = createSmoothScroller(scroller, log.options);
  const first = [], second = [];
  smooth.scrollTo(900, { onDone: landed => first.push(landed) });
  harness.frame(); harness.frame();
  smooth.scrollTo(300, { onDone: landed => second.push(landed) });
  assert.deepEqual(first, [false]);
  assert.deepEqual(log.active, [true]);
  harness.run();
  assert.equal(scroller.scrollTop, 300);
  assert.deepEqual(second, [true]);
  assert.deepEqual(log.active, [true, false]);
});

test('an instant scroll while one is in flight ends it', t => {
  const harness = animationHarness(t), scroller = fakeScroller(), log = recorder();
  const smooth = createSmoothScroller(scroller, log.options);
  const first = [];
  smooth.scrollTo(900, { onDone: landed => first.push(landed) });
  harness.frame();
  smooth.scrollTo(100, { instant: true, onDone: log.onDone });
  assert.equal(scroller.scrollTop, 100);
  assert.deepEqual(first, [false]);
  assert.deepEqual(log.done, [true]);
  assert.deepEqual(log.active, [true, false]);
  assert.equal(harness.pending(), 0);
});

test('a target past the end is clamped to the bottom', t => {
  const harness = animationHarness(t), scroller = fakeScroller({ scrollHeight: 1500, clientHeight: 500 }), log = recorder();
  createSmoothScroller(scroller, log.options).scrollTo(5000, { onDone: log.onDone });
  harness.run();
  assert.equal(scroller.scrollTop, 1000);
  assert.deepEqual(log.done, [true]);
});
