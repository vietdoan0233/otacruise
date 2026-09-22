import { chromium as playwrightChromium } from "playwright";
import type { BrowserContext } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Keep one configured launcher for every browser/context creation path. The
// plugin is registered before any browser is launched so persistent contexts,
// normal contexts, and test fixtures all receive the same evasions.
export const chromium = addExtra(playwrightChromium);
chromium.use(StealthPlugin());

export const STEALTH_PLUGIN_ENABLED = true;

// Existing CDP contexts can predate playwright-extra's context hooks. Keep a
// small init-script fallback for those contexts while the full stealth plugin
// remains responsible for the broader evasions on every new launch/context.
const STEALTH_WEBDRIVER_FALLBACK_SCRIPT = `
try {
  Object.defineProperty(Navigator.prototype, "webdriver", {
    configurable: true,
    get: function () { return undefined; }
  });
} catch {}
`;

export async function installStealthContextInitScript(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript({ content: STEALTH_WEBDRIVER_FALLBACK_SCRIPT });
}
