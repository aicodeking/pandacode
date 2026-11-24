import { expect, test, type Locator, type Page } from '@playwright/test';

/* Shared probes for the design-role specs (design-roles*.spec.ts). */

/** Compare one computed property with a probe element styled by the token. Leading and tracking use the element's font-size. */
export async function expectToken(locator: Locator, prop: string, token: string, size = false, allowNormal = false): Promise<void> {
  await expect(locator).toBeAttached();
  const detail = await locator.evaluate((el, arg) => {
    const cs = getComputedStyle(el);
    const value = cs.getPropertyValue(arg.token).trim();
    if (!value) return `missing ${arg.token}`;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
    if (arg.size) probe.style.fontSize = cs.fontSize;
    document.body.append(probe);
    (probe.style as unknown as Record<string, string>)[arg.prop] = value;
    const want = String(getComputedStyle(probe)[arg.prop as keyof CSSStyleDeclaration] ?? '');
    probe.remove();
    const got = String(cs[arg.prop as keyof CSSStyleDeclaration] ?? '');
    if (arg.corner && /\s/.test(got.trim()) && !/\s/.test(want.trim())) return `${arg.prop} elliptical ${got} != ${want}`;
    // Identical used values match before parsing. `normal` is not a number, so parseFloat would reject `normal` == `normal`.
    if (got === want) return '';
    if (arg.prop === 'fontWeight' || arg.prop === 'color') return `${arg.prop} ${got} != ${want} (${arg.token})`;
    // --tracking-tight is about 0.11–0.19px. A 0.6px band would accept that leak on a zero-tracking label.
    const band = arg.prop === 'letterSpacing' ? 0.05 : 0.6;
    const near = (left: string, right: string) => Math.abs(parseFloat(left) - parseFloat(right)) < band;
    if (near(got, want)) return '';
    const zero = (value: string) => value === 'normal' || value === '0px' || Math.abs(parseFloat(value)) < band;
    if (arg.prop === 'letterSpacing' && zero(got) && zero(want)) return '';
    if (arg.allowNormal && zero(got) && zero(want)) return '';
    return `${arg.prop} ${got} != ${want} (${arg.token})`;
  }, { prop, token, size, allowNormal, corner: corners.includes(prop as typeof corners[number]) });
  expect(detail, await locator.evaluate(el => `${el.tagName}.${el.className}`)).toBe('');
}

/** Size, weight, leading and tracking for one type role. */
export async function expectRole(locator: Locator, role: string, weight = '', allowNormal = false, overrides: { leading?: string; tracking?: string } = {}): Promise<void> {
  await expect(locator).toBeVisible();
  await expectToken(locator, 'fontSize', `--type-${role}`);
  await expectToken(locator, 'fontWeight', weight || `--type-${role}-weight`);
  await expectToken(locator, 'lineHeight', overrides.leading ?? `--type-${role}-leading`, true);
  const tracking = role === 'display' || role === 'title' || role === 'heading' ? '--tracking-tight' : '--tracking-none';
  await expectToken(locator, 'letterSpacing', overrides.tracking ?? tracking, true, allowNormal);
}

export async function expectLeading(locator: Locator, token: string): Promise<void> {
  await expect(locator).toBeVisible();
  await expectToken(locator, 'lineHeight', token, true);
}

export async function expectSharedChevron(select: Locator): Promise<void> {
  await expect(select).toBeVisible();
  await expect(select).toHaveCSS('appearance', 'none');
  await expect(select).toHaveCSS('background-image', /data:image\/svg\+xml/);
  await expectToken(select, 'backgroundImage', '--select-chevron');
  const padding = await select.evaluate(el => parseFloat(getComputedStyle(el).paddingInlineEnd));
  expect(padding, 'inline-end space for the chevron').toBeGreaterThanOrEqual(30);
}

export const corners = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const;

export async function expectRadius(locator: Locator, ...tokens: [string] | [string, string, string, string]): Promise<void> {
  await expect(locator).toBeVisible();
  for (const [index, prop] of corners.entries()) {
    await expectToken(locator, prop, tokens[index] ?? tokens[0]);
  }
}

export async function expectNestedRadius(inner: Locator, outer: Locator, innerToken: string, outerToken: string, outerPseudo?: string): Promise<void> {
  if (outerPseudo) {
    await expect(outer).toBeVisible();
    for (const prop of corners) {
      const detail = await outer.evaluate((el, arg) => {
        const cs = getComputedStyle(el, arg.pseudo);
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
        document.body.append(probe);
        (probe.style as unknown as Record<string, string>)[arg.prop] = `var(${arg.token})`;
        const want = String(getComputedStyle(probe)[arg.prop as keyof CSSStyleDeclaration] ?? '');
        probe.remove();
        const got = String(cs[arg.prop as keyof CSSStyleDeclaration] ?? '');
        if (/\s/.test(got.trim()) && !/\s/.test(want.trim())) return `${arg.prop} elliptical ${got} != ${want}`;
        return Math.abs(parseFloat(got) - parseFloat(want)) < 0.6 ? '' : `${arg.prop} ${got} != ${want} (${arg.token})`;
      }, { prop, token: outerToken, pseudo: outerPseudo });
      expect(detail, `${outerPseudo} ${prop}`).toBe('');
    }
  } else {
    await expectRadius(outer, outerToken);
  }
  await expectRadius(inner, innerToken);
  const [innerValues, outerValues] = await Promise.all([
    inner.evaluate((el, props) => props.map(p => parseFloat(getComputedStyle(el)[p])), corners),
    outer.evaluate((el, arg) => arg.props.map(p => parseFloat(getComputedStyle(el, arg.pseudo)[p])), { props: corners, pseudo: outerPseudo }),
  ]);
  for (let i = 0; i < corners.length; i += 1) {
    expect(innerValues[i], `${corners[i]} inner (${innerValues[i]}) < outer (${outerValues[i]})`).toBeLessThan(outerValues[i]);
  }
}

export async function openWorkspace(page: Page, url = '/'): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('.sidebar .task-item.selected .task-title')).toBeVisible({ timeout: 30_000 });
}

export async function openTaskMenu(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  const rename = page.getByRole('menuitem', { name: 'Rename task', exact: true });
  await expect(rename).toBeVisible({ timeout: 30_000 });
  return rename;
}

export async function openModelPicker(page: Page): Promise<Locator> {
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(async () => {
    if (!await picker.isVisible()) await page.locator('#model-picker-trigger').click();
    await expect(picker.locator('.model-menu-name').first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  return picker;
}

export async function expectSelectStates(page: Page, select: Locator): Promise<string> {
  const expectStyle = async () => {
    await expectRadius(select, '--ds-control-radius');
    await expect(select).toHaveCSS('appearance', 'none');
    await expect(select).toHaveCSS('background-repeat', 'no-repeat');
    const { padding, image } = await select.evaluate(el => {
      const style = getComputedStyle(el);
      return { padding: parseFloat(style.paddingInlineEnd), image: style.backgroundImage };
    });
    expect(padding, 'inline-end space for the chevron').toBeGreaterThanOrEqual(30);
    expect(image).toContain('svg');
    await expectToken(select, 'backgroundImage', '--select-chevron');
    return image;
  };

  await expect(select).toBeVisible({ timeout: 30_000 });
  await expect(select).toBeEnabled({ timeout: 30_000 });
  await page.mouse.move(0, 0);
  const image = await test.step('At rest', expectStyle);
  await test.step('Hovered after the color transition', async () => {
    // Re-hover until the pointer state registers: a single hover can miss under host load.
    await expect.poll(async () => {
      await select.hover();
      return select.evaluate(el => el.matches(':hover'));
    }, { timeout: 10_000 }).toBe(true);
    // Let the color transition settle, then confirm the hover held.
    await page.waitForTimeout(250);
    // Re-hover if heavy load dropped the pointer state during the wait.
    await expect.poll(async () => {
      if (!(await select.evaluate(el => el.matches(':hover')))) await select.hover();
      return select.evaluate(el => el.matches(':hover'));
    }, { timeout: 10_000 }).toBe(true);
    await expectStyle();
  });
  await test.step('Focused', async () => {
    await page.mouse.move(0, 0);
    await select.focus();
    await expect(select).toBeFocused();
    await expectStyle();
  });
  await test.step('Disabled', async () => {
    await select.evaluate(el => el.setAttribute('disabled', ''));
    await expect(select).toBeDisabled();
    await expectStyle();
  });
  return image;
}

/** Font-size ratio of an element to its parent element (or a given ancestor). */
export async function codeRatio(code: Locator): Promise<number> {
  await expect(code).toBeAttached();
  return code.evaluate(el => parseFloat(getComputedStyle(el).fontSize) / parseFloat(getComputedStyle(el.parentElement!).fontSize));
}
