import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridge } from "../packages/bridge/src/server";

const deviceKey = "keep-safe.device.v1";
const sessionKey = "keep-safe.connection.v1";
const phone = { width: 390, height: 844 };

describe("remembered phone interface", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("keeps mobile request focus inside the session, returns it on Escape, and resets completion scroll", async () => {
    const bridge = await createBridge({
      ownerToken: "focus-owner",
      agentToken: "focus-agent",
      port: 0,
      staticDir: resolve("apps/web/dist"),
    });
    const context = await browser.newContext({
      viewport: phone,
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await page.goto(bridge.url);
      const opener = page.getByRole("button", {
        name: /Claude Code github.com/,
      });
      await opener.click();
      const session = page.getByRole("dialog", { name: "Browser request" });
      expect(
        await session.evaluate((element) => document.activeElement === element),
      ).toBe(true);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe(
        "hidden",
      );
      await page.keyboard.press("Tab");
      expect(
        await session.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      expect(await session.count()).toBe(0);
      expect(
        await opener.evaluate((element) => document.activeElement === element),
      ).toBe(true);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
      await opener.click();
      await page.getByRole("button", { name: "Approve & open" }).click();
      await page.getByRole("button", { name: /Simulate signing in/ }).click();
      await page.getByRole("button", { name: /Done, hand back/ }).click();
      await expect
        .poll(() => session.evaluate((element) => element.scrollTop))
        .toBe(0);
      expect(
        (await page.locator(".panel-topline").boundingBox())!.y,
      ).toBeGreaterThanOrEqual(70);
    } finally {
      await context.close();
      await bridge.close();
    }
  });

  it("only persists an issued device key, restores a fresh phone window, and forgets and revokes access", async () => {
    const owner = "device-ui-master-owner";
    const bridge = await createBridge({
      ownerToken: owner,
      agentToken: "device-ui-agent",
      port: 0,
      staticDir: resolve("apps/web/dist"),
    });
    const first = await browser.newContext({
      viewport: phone,
      isMobile: true,
      hasTouch: true,
    });
    let second: Awaited<ReturnType<Browser["newContext"]>> | undefined;
    let stale: Awaited<ReturnType<Browser["newContext"]>> | undefined;
    try {
      const page = await first.newPage();
      await page.goto(
        `${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: owner })}`,
      );
      await expect
        .poll(() => page.getByText("Bridge connected", { exact: true }).count())
        .toBe(1);
      await page
        .getByRole("navigation", { name: "Mobile navigation" })
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Remember this phone", exact: true })
        .click();
      await page
        .getByLabel("Name this phone", { exact: true })
        .fill("Test phone");
      await page
        .getByRole("button", { name: "Remember for 7 days", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate((key) => localStorage.getItem(key), deviceKey),
        )
        .not.toBeNull();
      await expect
        .poll(() =>
          page.getByText("Test phone is remembered", { exact: true }).count(),
        )
        .toBe(1);
      const saved = (await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        deviceKey,
      )) as { token: string; device: { id: string; expiresAt: string } };
      expect(saved.token).not.toBe(owner);
      expect(Date.parse(saved.device.expiresAt)).toBeGreaterThan(Date.now());
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), sessionKey),
      ).not.toContain(owner);
      const state = await first.storageState();
      expect(JSON.stringify(state)).not.toContain(owner);
      await first.close();

      // Browser storageState excludes sessionStorage. A new context proves durable pairing works.
      second = await browser.newContext({
        viewport: phone,
        storageState: state,
        isMobile: true,
        hasTouch: true,
      });
      const restored = await second.newPage();
      await restored.goto(bridge.url);
      await expect
        .poll(() =>
          restored.getByText("Bridge connected", { exact: true }).count(),
        )
        .toBe(1);
      await restored
        .getByRole("navigation", { name: "Mobile navigation" })
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      await expect
        .poll(() =>
          restored
            .getByText("Test phone is remembered", { exact: true })
            .count(),
        )
        .toBe(1);
      await restored
        .getByRole("button", { name: "Forget this phone", exact: true })
        .click();
      await restored
        .getByRole("dialog", { name: "Forget this phone?" })
        .getByRole("button", { name: "Forget this phone", exact: true })
        .click();
      await expect
        .poll(() =>
          restored.evaluate((key) => localStorage.getItem(key), deviceKey),
        )
        .toBeNull();
      await expect
        .poll(
          async () =>
            (
              await fetch(`${bridge.url}/api/info`, {
                headers: { Authorization: `Bearer ${saved.token}` },
              })
            ).status,
        )
        .toBe(401);
      const devices = (await fetch(`${bridge.url}/api/devices`, {
        headers: { Authorization: `Bearer ${owner}` },
      }).then((response) => response.json())) as { devices: unknown[] };
      expect(devices.devices).toEqual([]);

      // A separate stale copy must discard its revoked key and explain how to reconnect.
      stale = await browser.newContext({
        viewport: phone,
        storageState: state,
      });
      const revoked = await stale.newPage();
      await revoked.goto(bridge.url);
      await expect
        .poll(() =>
          revoked.evaluate((key) => localStorage.getItem(key), deviceKey),
        )
        .toBeNull();
      await expect
        .poll(() =>
          revoked
            .getByText(/This phone’s pairing expired or was revoked/)
            .count(),
        )
        .toBeGreaterThan(0);
    } finally {
      await first.close().catch(() => {});
      await second?.close();
      await stale?.close();
      await bridge.close();
    }
  }, 45000);

  it("keeps fragment owner pairing tab-only and discards expired remembered records", async () => {
    const owner = "tab-only-master-owner";
    const bridge = await createBridge({
      ownerToken: owner,
      agentToken: "tab-only-agent",
      port: 0,
      staticDir: resolve("apps/web/dist"),
    });
    const context = await browser.newContext({ viewport: phone });
    let fresh: Awaited<ReturnType<Browser["newContext"]>> | undefined;
    try {
      const page = await context.newPage();
      await page.goto(
        `${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: owner })}`,
      );
      await expect
        .poll(() => page.getByText("Bridge connected", { exact: true }).count())
        .toBe(1);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), deviceKey),
      ).toBeNull();
      const state = await context.storageState();
      expect(JSON.stringify(state)).not.toContain(owner);
      fresh = await browser.newContext({
        viewport: phone,
        storageState: state,
      });
      const freshPage = await fresh.newPage();
      await freshPage.goto(bridge.url);
      expect(
        await freshPage.getByText("Demo mode", { exact: true }).count(),
      ).toBe(1);
      await freshPage.evaluate(
        ({ key, url }) =>
          localStorage.setItem(
            key,
            JSON.stringify({
              version: 1,
              url,
              token: "expired-device-key",
              device: {
                id: "expired",
                name: "Old phone",
                expiresAt: new Date(Date.now() - 1000).toISOString(),
              },
            }),
          ),
        { key: deviceKey, url: bridge.url },
      );
      await freshPage.reload();
      await expect
        .poll(() =>
          freshPage.evaluate((key) => localStorage.getItem(key), deviceKey),
        )
        .toBeNull();
      expect(
        await freshPage.getByText(/This phone’s pairing expired/).count(),
      ).toBe(1);
    } finally {
      await context.close();
      await fresh?.close();
      await bridge.close();
    }
  });
});
