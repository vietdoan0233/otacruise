import assert from "node:assert/strict";

import { chromium } from "../src/browser.js";
import {
  addVariantsToCart,
  resolveBrowserExecutable,
  WATCH_CONTROL_CHECKBOX_ID,
  WATCH_ENABLED_STORAGE_KEY,
  waitForAvailability,
} from "../src/kide.js";
import { selectFourPersonVariants } from "../src/selector.js";

const eventUrl = "https://kide.app/fi/events/headed-fixture";
const apiUrl = "https://api.kide.app/api/products/headed-fixture";
const variants = [
  ["Cabin A, 2 pers.", 239],
  ["Cabin A, 4 pers.", 398],
  ["Prom., 2 pers.", 239],
  ["Prom., 4 pers.", 398],
  ["Cabin B, 2 pers.", 226],
  ["Cabin B, 4 pers.", 386],
  ["Cabin C, 2 pers.", 216],
  ["Cabin C, 3 pers.", 294],
  ["Cabin C, 4 pers.", 366],
] as const;

const payload = (availability: number) => ({
  model: {
    product: { name: "Otacruise headed fixture", salesStarted: true },
    variants: variants.map(([name, price], index) => ({
      id: `fixture-${index}`,
      name,
      pricePerItem: price * 100,
      availability,
      productVariantMaximumItemQuantityPerUser: 1,
    })),
  },
});

function fixtureHtml(): string {
  return `<!doctype html><header><o-item ng-click="account.profile"><span>Hei, fixture@example.test</span></o-item></header><main>${variants
    .map(
      ([name, price]) =>
        `<o-item ng-repeat-start="variant in product.productVariants"><o-text>${name}</o-text><o-chip>${price}€</o-chip></o-item>`,
    )
    .join("")}</main><button id="payment">Proceed to payment</button><script>
      window.paymentAttempts = 0;
      document.querySelector('#payment').addEventListener('click', () => window.paymentAttempts += 1);
      document.querySelectorAll('o-item[ng-repeat-start]').forEach((row) => row.addEventListener('click', () => {
        const chip = document.createElement('o-chip');
        chip.className = 'o-color--validation-info';
        chip.textContent = 'Varattu 1';
        row.append(chip);
      }));
    </script>`;
}

const browser = await chromium.launch({
  headless: false,
  ...(resolveBrowserExecutable()
    ? { executablePath: resolveBrowserExecutable() }
    : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let productRequestCount = 0;
  await page.route(eventUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `${fixtureHtml()}<script>window.fetch("${apiUrl}");</script>`,
    }),
  );
  await page.route(apiUrl, (route) => {
    productRequestCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(payload(productRequestCount === 1 ? 0 : 1)),
    });
  });

  const watch = waitForAvailability(page, {
    eventUrl,
    maxWaitMs: 5_000,
    pollIntervalMs: 1_000,
    watchForever: true,
  });
  const checkbox = page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`);
  await checkbox.waitFor({ state: "visible" });
  console.log("[headed fixture] 1. checkbox visible:", await checkbox.isVisible());
  console.log("[headed fixture] initial state unchecked:", !(await checkbox.isChecked()));
  await page.waitForTimeout(400);
  console.log("[headed fixture] 2. unchecked pauses; product requests:", productRequestCount);
  assert.equal(productRequestCount, 1);

  await checkbox.check();
  console.log("[headed fixture] 3. checked starts polling:", await checkbox.isChecked());
  const result = await watch;
  console.log("[headed fixture] 4. state after watcher reload:", await checkbox.isChecked());
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), WATCH_ENABLED_STORAGE_KEY), "true");
  assert.equal(productRequestCount, 2);

  const selection = selectFourPersonVariants(result.inspection.variants);
  assert.equal(selection.selected.length, 4);
  await addVariantsToCart(page, selection.selected);
  const cartRows = await page.locator(".o-color--validation-info").count();
  const paymentAttempts = await page.evaluate(() =>
    (window as { paymentAttempts?: number }).paymentAttempts ?? 0,
  );
  console.log("[headed fixture] 5. stealth webdriver:", await page.evaluate(() => navigator.webdriver));
  console.log("[headed fixture] 6. matching ticket appeared; cart rows:", cartRows);
  console.log("[headed fixture] 7. stopped before payment; payment attempts:", paymentAttempts);
  assert.equal(cartRows, 4);
  assert.equal(paymentAttempts, 0);

  const holdMs = Number(process.env.HEADFUL_FIXTURE_HOLD_MS ?? 750);
  await page.waitForTimeout(Number.isFinite(holdMs) && holdMs >= 0 ? holdMs : 750);
} finally {
  await browser.close();
}
