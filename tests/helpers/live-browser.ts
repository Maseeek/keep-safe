import type { Page } from 'playwright';

/** Switches from the guided Form-First view to the raw Live browser tab when a login form was detected. */
export async function switchToLiveBrowser(page: Page) {
  const liveTab = page.getByRole('tab', { name: 'Live browser', exact: true });
  await liveTab.waitFor({ state: 'visible' });
  await liveTab.click();
  await page.locator('.remote-screen img').waitFor({ state: 'visible' });
}

/** Opens the overflow tools drawer (`More browser tools`) in the minimal live browser dock if not already open. */
export async function openMoreTools(page: Page) {
  const trigger = page.getByRole('button', { name: 'More browser tools', exact: true });
  await trigger.waitFor({ state: 'visible' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
}
