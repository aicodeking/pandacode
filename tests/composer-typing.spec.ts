import { expect, test, type Locator, type Page } from '@playwright/test';

/* Typing in the composer must not lay the pane out twice a keystroke: one line of plain text writes no height and reads
 * no layout after its first character, text added at the end writes only when the box grows, and every height stays
 * exactly the one a full measurement gives. */

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });

type Counted = Window & { __heightWrites?: number; __layoutReads?: number };

/** Counts every write of the prompt's inline height (an 'auto' and back is two), and scrollHeight reads on it. */
async function count(field: Locator): Promise<void> {
  await field.evaluate(el => {
    const w = window as Counted;
    w.__heightWrites = 0; w.__layoutReads = 0;
    // CSS properties are not plain accessors in every engine, so the box's style object is wrapped instead.
    const style = (el as HTMLElement).style;
    const counted = new Proxy(style, {
      get: (target, key) => { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; },
      set: (target, key, value) => { if (key === 'height') w.__heightWrites!++; return Reflect.set(target, key, value, target); },
    });
    Object.defineProperty(el, 'style', { configurable: true, get: () => counted });
    const own = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get() { w.__layoutReads!++; return own.get!.call(this); } });
  });
}
const counters = (page: Page) => page.evaluate(() => ({ writes: (window as Counted).__heightWrites ?? 0, reads: (window as Counted).__layoutReads ?? 0 }));
const resetCounters = (page: Page) => page.evaluate(() => { (window as Counted).__heightWrites = 0; (window as Counted).__layoutReads = 0; });

/** The prompt's height and the height a full measurement (box released) gives, capped like the app's. */
function heights(field: Locator): Promise<{ shown: number; exact: number }> {
  return field.evaluate(el => {
    const box = el as HTMLTextAreaElement, kept = box.style.height;
    const read = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!.get!;
    box.style.height = 'auto';
    const natural = read.call(box) as number;
    box.style.height = kept;
    return { shown: parseFloat(kept), exact: Math.min(natural, 180) };
  });
}
async function expectExact(field: Locator): Promise<number> {
  const { shown, exact } = await heights(field);
  expect(shown).toBe(exact);
  return shown;
}

async function openComposer(page: Page): Promise<Locator> {
  await page.goto('/');
  const field = prompt(page);
  await expect(field).toBeEnabled();
  await field.click();
  return field;
}

test('single-line typing writes the height no more after the first keystroke, and reads no layout', async ({ page }) => {
  const field = await openComposer(page);
  await count(field);
  const empty = await expectExact(field);
  await field.press('h');
  await resetCounters(page);
  await field.pressSequentially('ello world, one plain line');
  await expect(field).toHaveValue('hello world, one plain line');
  expect(await counters(page)).toEqual({ writes: 0, reads: 0 });
  // Deleting within the line is still one line: nothing written, nothing laid out.
  await field.press('Backspace'); await field.press('Backspace');
  expect(await counters(page)).toEqual({ writes: 0, reads: 0 });
  expect(await expectExact(field)).toBe(empty);
  await expect(field).toHaveValue('hello world, one plain li');
  // The counters do see a change: a paste of several lines releases the box and writes its new height.
  await field.fill('a\nb\nc\nd\ne');
  expect((await counters(page)).writes).toBeGreaterThan(0);
  await expectExact(field);
});

test('multi-line text grows and shrinks the box exactly, typed or pasted', async ({ page }) => {
  const field = await openComposer(page);
  const oneLine = await expectExact(field);
  await field.fill('one\ntwo\nthree\nfour');
  const four = await expectExact(field);
  expect(four).toBeGreaterThan(oneLine);
  // Typed at the end: the box grows line by line, never past the cap, and stays exact.
  await field.press('End');
  for (let line = 0; line < 6; line++) {
    await field.press('Shift+Enter');
    await field.pressSequentially('more');
  }
  const tall = await expectExact(field);
  expect(tall).toBeGreaterThan(four);
  expect(tall).toBeLessThanOrEqual(180);
  // A long line typed at the end wraps and grows the box like a measurement does.
  await field.fill('x');
  await field.press('End');
  // Long enough to wrap past the box's two-row floor at any desktop width.
  await field.pressSequentially('word '.repeat(90));
  expect(await expectExact(field)).toBeGreaterThan(oneLine);
  // Deleting back to one line shrinks it to the one-line height.
  await field.fill('back to one');
  expect(await expectExact(field)).toBe(oneLine);
  await field.fill('');
  expect(await expectExact(field)).toBe(oneLine);
});

test('appending to multi-line text writes the height only when it changes', async ({ page }) => {
  const field = await openComposer(page);
  await field.fill('first\nsecond');
  await expectExact(field);
  await field.press('End');
  await count(field);
  await field.pressSequentially(' and a few more words');
  expect((await counters(page)).writes).toBe(0);
  await expectExact(field);
});

test('a window resize and the interface scale keep the height exact', async ({ page }) => {
  const field = await openComposer(page);
  await field.fill('word '.repeat(30));
  await expectExact(field);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => { const { shown, exact } = await heights(field); return shown === exact; }).toBe(true);
  await field.press('End');
  await field.pressSequentially(' tail');
  await expectExact(field);
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; window.dispatchEvent(new Event('pandacode-ui-scale-change')); });
  await expectExact(field);
  await field.pressSequentially(' more');
  await expectExact(field);
});

test('IME composition still types, commits and keeps the height exact', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME is driven through the Chrome DevTools protocol');
  const field = await openComposer(page);
  await field.pressSequentially('abc ');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: '日本' });
  await expect(field).toHaveValue('abc 日本');
  await expectExact(field);
  // Text no canvas measures (CJK) still grows exactly once it wraps.
  await cdp.send('Input.insertText', { text: '語'.repeat(120) });
  await expectExact(field);
  // Nothing was sent.
  await expect(field).toHaveValue(`abc 日本${'語'.repeat(120)}`);
});

test('typing resolves the prompt\'s styles once, not on every keystroke', async ({ page }) => {
  const field = await openComposer(page);
  await field.fill('first\nsecond');
  await field.press('End');
  await field.evaluate(el => {
    const w = window as Window & { __styleReads?: number };
    w.__styleReads = 0;
    const own = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((target: Element, pseudo?: string | null) => { if (target === el) w.__styleReads!++; return own(target, pseudo); }) as typeof window.getComputedStyle;
  });
  const reads = () => page.evaluate(() => (window as Window & { __styleReads?: number }).__styleReads ?? 0);
  // Multi-line text typed at the end, then one plain line: each keystroke fits the box without resolving its styles.
  await field.pressSequentially(' and a few more words');
  await field.fill('');
  await field.pressSequentially('one plain line of text');
  const typed = await reads();
  expect(typed, 'style reads while typing 43 characters').toBeLessThanOrEqual(2);
  await expectExact(field);
  // A resize still re-reads them, and the height stays exact.
  await page.setViewportSize({ width: 900, height: 800 });
  await field.pressSequentially(' and more');
  await expectExact(field);
});
