import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import {
  addVariantsToCart,
  inspectProductPage,
  parseProductPayload,
  resolveBrowserExecutable,
  waitForAvailability,
} from "../src/kide.js";
import { selectFourPersonVariants, totalCents } from "../src/selector.js";

const payload = {
  model: {
    product: { id: "event", name: "Otacruise 2026", salesStarted: true },
    variants: [
      { id: "a2", name: "Cabin A, 2 pers.", pricePerItem: 23900 },
      { id: "a4", name: "Cabin A, 4 pers.", pricePerItem: 39800 },
      { id: "p2", name: "Prom., 2 pers.", pricePerItem: 23900 },
      { id: "p4", name: "Prom., 4 pers.", pricePerItem: 39800 },
      { id: "b2", name: "Cabin B, 2 pers.", pricePerItem: 22600 },
      { id: "b4", name: "Cabin B, 4 pers.", pricePerItem: 38600 },
      { id: "c2", name: "Cabin C, 2 pers.", pricePerItem: 21600 },
      { id: "c3", name: "Cabin C, 3 pers.", pricePerItem: 29400 },
      { id: "c4", name: "Cabin C, 4 pers.", pricePerItem: 36600 },
    ],
  },
};

function fixtureHtml(): string {
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
  ];
  return `<!doctype html><main>${variants
    .map(
      ([name, price]) =>
        `<o-item ng-repeat-start="variant in product.productVariants" class="o-align-items--flex-start"><o-text><o-text__heading>${name}</o-text__heading><o-chip class="o-chip--sm">${price}€</o-chip></o-text></o-item>`,
    )
    .join("")}</main><script>
      document.querySelectorAll('o-item[ng-repeat-start]').forEach((row) => {
        row.addEventListener('click', () => {
          const chip = document.createElement('o-chip');
          chip.className = 'o-color--validation-info';
          chip.textContent = 'Varattu 1';
          row.append(chip);
        });
      });
    </script>`;
}

test("dry-run browser fixture selects exact four-person variants and verifies cart rows", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(resolveBrowserExecutable() ? { executablePath: resolveBrowserExecutable() } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fixtureHtml());
    const inspection = await inspectProductPage(page, payload);
    const selection = selectFourPersonVariants(inspection.variants);

    assert.deepEqual(selection.selected.map((variant) => variant.id), ["a4", "p4", "b4", "c4"]);
    assert.deepEqual(selection.selected.map((variant) => variant.name), [
      "Cabin A, 4 pers.",
      "Prom., 4 pers.",
      "Cabin B, 4 pers.",
      "Cabin C, 4 pers.",
    ]);
    assert.equal(totalCents(selection.selected), 154800);

    await addVariantsToCart(page, selection.selected);
    assert.equal(await page.locator(".o-color--validation-info").count(), 4);
  } finally {
    await browser.close();
  }
});

test("does not reload after a matching ticket is available", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(resolveBrowserExecutable() ? { executablePath: resolveBrowserExecutable() } : {}),
  });
  try {
    const page = await browser.newPage();
    let productRequestCount = 0;
    await page.route("https://kide.app/fi/events/test", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `${fixtureHtml()}<script>window.fetch("https://api.kide.app/api/products/test");</script>`,
      }),
    );
    await page.route("https://api.kide.app/api/products/test", (route) => {
      productRequestCount += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(payload),
      });
    });
    const result = await waitForAvailability(page, {
      eventUrl: "https://kide.app/fi/events/test",
      maxWaitMs: 10_000,
      pollIntervalMs: 3_000,
      watchForever: true,
    });

    assert.equal(result.blocker, null);
    assert.equal(productRequestCount, 1);
  } finally {
    await browser.close();
  }
});

test("parses Kide availability as numeric stock", () => {
  const parsed = parseProductPayload({
    model: {
      product: { name: "Otacruise 2026", salesStarted: true },
      variants: [{
        id: "sold-out-c4",
        name: "Cabin C, 4 pers.",
        pricePerItem: 36600,
        availability: 0,
        productVariantMaximumItemQuantityPerUser: 1,
      }],
    },
  });

  assert.equal(parsed.variants[0].stock, 0);
  assert.equal(parsed.variants[0].available, false);
  assert.equal(parsed.variants[0].maxQuantity, 1);
});
