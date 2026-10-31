import type { Locator, Page } from '@playwright/test';

export const pickerTrigger = (page: Page) => page.getByRole('button', { name: 'Choose harness and model', exact: true });
export const pickerOf = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
export const pickerSearch = (page: Page) => pickerOf(page).getByRole('combobox', { name: 'Search harnesses and models', exact: true });

/** Open the picker from the composer's model button. */
export async function openPicker(page: Page): Promise<Locator> {
  await pickerTrigger(page).click();
  const picker = pickerOf(page);
  await picker.waitFor();
  return picker;
}

/** Show one harness's models by clicking its rail tab (`h:<provider>`, or `c:<id>` for a connection). */
export async function showHarness(page: Page, key: string): Promise<void> {
  const tab = pickerOf(page).locator(`[role="tab"][data-view="${key.includes(':') ? key : `h:${key}`}"]`);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
}

/** A model row; the harness must be shown (see showHarness) unless a query is active. */
export const modelOption = (page: Page, provider: string, model: string) =>
  pickerOf(page).locator(`.model-menu-option[data-provider="${provider}"][data-model="${model}"]`);

/** Switch to the harness, then pick the model. */
export async function pickModel(page: Page, provider: string, model: string): Promise<void> {
  await showHarness(page, provider);
  await modelOption(page, provider, model).click();
}
