import type { Page } from 'playwright';

/** Switches from the guided Form-First view to the raw Live browser tab when a login form was detected. */
export async function switchToLiveBrowser(page: Page) {
  const liveTab = page.getByRole('tab', { name: 'Live browser', exact: true });
  await liveTab.waitFor({ state: 'visible' });
  await liveTab.click();
  await page.locator('.remote-screen img').waitFor({ state: 'visible' });
}
