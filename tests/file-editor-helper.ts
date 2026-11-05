import { expect, type Page } from '@playwright/test';

export const editorModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
export async function replaceEditor(page: Page, path: string, content: string) {
  const editor = page.locator('#file-panel').getByRole('textbox', { name: path, exact: true });
  await editor.press(`${editorModifier}+a`);
  await page.keyboard.insertText(content);
  await expect(editor).toContainText(content.split('\n')[0]);
  return editor;
}
