import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import {
  addVariantsToCart,
  inspectAuthenticationState,
  inspectProductPage,
  installWatchControl,
  parseProductPayload,
  resolveBrowserExecutable,
  WATCH_CONTROL_CHECKBOX_ID,
  WATCH_CONTROL_ID,
  WATCH_CONTROL_LABEL,
  WATCH_ENABLED_STORAGE_KEY,
  waitForAvailability,
} from "../src/kide.js";
import { chromium, STEALTH_PLUGIN_ENABLED } from "../src/browser.js";
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

const fixtureVariants: Array<[string, number]> = [
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

function fixtureHtml(): string {
  return `<!doctype html><header><o-item ng-click="body.onNavigate(origin.constants.states.account.profile, null, true)"><o-text__description>Hei, user@example.test</o-text__description></o-item></header><main>${fixtureVariants
    .map(
      ([name, price]) =>
        `<o-item ng-repeat-start="variant in product.productVariants" class="o-align-items--flex-start"><o-text><o-text__heading>${name}</o-text__heading><o-chip class="o-chip--sm">${price}€</o-chip></o-text></o-item>`,
    )
    .join("")}</main><button id="payment">Proceed to payment</button><script>
      window.paymentAttempts = 0;
      document.querySelector('#payment').addEventListener('click', () => window.paymentAttempts += 1);
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

function payloadWithAvailability(availability: number) {
  return {
    model: {
      product: { name: "Otacruise 2026", salesStarted: true },
      variants: payload.model.variants.map((variant) => ({
        ...variant,
        availability,
        productVariantMaximumItemQuantityPerUser: 1,
      })),
    },
  };
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...(resolveBrowserExecutable()
      ? { executablePath: resolveBrowserExecutable() }
      : {}),
  });
}

async function routeEventWithProduct(
  page: Page,
  eventId: string,
  responsePayload: () => unknown,
): Promise<{ requestCount: () => number }> {
  let productRequestCount = 0;
  const eventUrl = `https://kide.app/fi/events/${eventId}`;
  await page.route(eventUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `${fixtureHtml()}<script>window.fetch("https://api.kide.app/api/products/${eventId}");</script>`,
    }),
  );
  await page.route(`https://api.kide.app/api/products/${eventId}`, (route) => {
    productRequestCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(responsePayload()),
    });
  });
  return { requestCount: () => productRequestCount };
}

test("stealth Playwright is initialized and does not expose raw webdriver flags", async () => {
  assert.equal(STEALTH_PLUGIN_ENABLED, true);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const fingerprint = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
    }));
    assert.notEqual(fingerprint.webdriver, true);
    assert.equal(/HeadlessChrome/i.test(fingerprint.userAgent), false);
  } finally {
    await browser.close();
  }
});

test("detects only an authenticated or unauthenticated state from visible UI markers", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent("<button>Kirjaudu</button>");
    assert.equal(await inspectAuthenticationState(page), "unauthenticated");

    await page.setContent(
      '<o-item ng-click="account.profile"><span>Hei, user@example.test</span></o-item>',
    );
    assert.equal(await inspectAuthenticationState(page), "authenticated");

    await page.setContent("<main>Otacruise 2026</main>");
    assert.equal(await inspectAuthenticationState(page), "unknown");
  } finally {
    await browser.close();
  }
});

test("the refresh checkbox starts unchecked, toggles immediately, and persists both states", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://kide.app/fi/events/control-state", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><main>Otacruise 2026</main>",
      }),
    );
    await page.goto("https://kide.app/fi/events/control-state");
    await installWatchControl(page);

    const control = page.locator(`#${WATCH_CONTROL_ID}`);
    const checkbox = page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`);
    assert.equal(await control.innerText(), WATCH_CONTROL_LABEL);
    assert.equal(await checkbox.isVisible(), true);
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(
      await page.evaluate((key) => sessionStorage.getItem(key), WATCH_ENABLED_STORAGE_KEY),
      "true",
    );
    await checkbox.uncheck();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(
      await page.evaluate((key) => sessionStorage.getItem(key), WATCH_ENABLED_STORAGE_KEY),
      "false",
    );
  } finally {
    await browser.close();
  }
});

test("checked and unchecked state survive a full page reload", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://kide.app/fi/events/control", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><main>Otacruise 2026</main>",
      }),
    );
    await page.goto("https://kide.app/fi/events/control");
    await installWatchControl(page);
    const checkbox = page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`);
    await checkbox.check();
    await page.reload();
    await installWatchControl(page);
    assert.equal(await page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`).isChecked(), true);
    await page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`).uncheck();
    await page.reload();
    await installWatchControl(page);
    assert.equal(await page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`).isChecked(), false);
  } finally {
    await browser.close();
  }
});

test("restores the control after body replacement without duplicates or duplicate handlers", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://kide.app/fi/events/replace", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><main>Otacruise 2026</main>",
      }),
    );
    await page.goto("https://kide.app/fi/events/replace");
    await installWatchControl(page);
    await installWatchControl(page);
    const checkbox = page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`);
    await checkbox.check();
    await page.evaluate(() => document.body.replaceChildren(document.createElement("main")));
    await page.waitForFunction(
      (controlId) => document.querySelectorAll(`#${controlId}`).length === 1,
      WATCH_CONTROL_ID,
    );
    assert.equal(await page.locator(`#${WATCH_CONTROL_ID}`).count(), 1);
    assert.equal(await page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`).isChecked(), true);
    await page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`).uncheck();
    assert.equal(
      await page.evaluate((key) => sessionStorage.getItem(key), WATCH_ENABLED_STORAGE_KEY),
      "false",
    );
  } finally {
    await browser.close();
  }
});

test("treats both Finnish sold-out labels as unavailable", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><main>${payload.model.variants
      .map(
        (variant) =>
          `<o-item ng-repeat-start="variant in product.productVariants">${variant.name} Loppuunmyyty</o-item>`,
      )
      .join("")}</main>`);

    const inspection = await inspectProductPage(page, payload);
    assert.equal(inspection.variants.every((variant) => !variant.available), true);
    assert.equal(selectFourPersonVariants(inspection.variants).selected.length, 0);
  } finally {
    await browser.close();
  }
});

test("does not reload or fetch another snapshot while unchecked", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const fixture = await routeEventWithProduct(page, "paused", () => payloadWithAvailability(0));
    const resultPromise = waitForAvailability(page, {
      eventUrl: "https://kide.app/fi/events/paused",
      maxWaitMs: 2_000,
      pollIntervalMs: 30,
      watchForever: false,
    });
    const checkbox = page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`);
    await checkbox.waitFor({ state: "visible" });
    assert.equal(await checkbox.isChecked(), false);
    await page.waitForTimeout(150);
    assert.equal(fixture.requestCount(), 1);
    await checkbox.check();
    const result = await resultPromise;
    assert.match(result.blocker ?? "", /unavailable|sold out/i);
    assert.equal(fixture.requestCount(), 1);
  } finally {
    await browser.close();
  }
});

test("resumes after checking and handles sold-out first response followed by availability", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript((key) => sessionStorage.setItem(key, "true"), WATCH_ENABLED_STORAGE_KEY);
    let responseNumber = 0;
    const fixture = await routeEventWithProduct(page, "resume", () => {
      responseNumber += 1;
      return payloadWithAvailability(responseNumber === 1 ? 0 : 1);
    });
    const result = await waitForAvailability(page, {
      eventUrl: "https://kide.app/fi/events/resume",
      maxWaitMs: 2_000,
      pollIntervalMs: 50,
      watchForever: true,
    });
    assert.equal(result.blocker, null);
    assert.equal(fixture.requestCount(), 2);
    assert.deepEqual(
      selectFourPersonVariants(result.inspection.variants).selected.map((variant) => variant.id),
      ["a4", "p4", "b4", "c4"],
    );
  } finally {
    await browser.close();
  }
});

test("pauses before interpreting a response when the checkbox is turned off mid-response", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript((key) => sessionStorage.setItem(key, "true"), WATCH_ENABLED_STORAGE_KEY);
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route("https://kide.app/fi/events/race", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `${fixtureHtml()}<script>window.fetch("https://api.kide.app/api/products/race");</script>`,
      }),
    );
    await page.route("https://api.kide.app/api/products/race", async (route) => {
      await responseReleased;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(payloadWithAvailability(1)),
      });
    });
    const resultPromise = waitForAvailability(page, {
      eventUrl: "https://kide.app/fi/events/race",
      maxWaitMs: 2_000,
      pollIntervalMs: 50,
      watchForever: true,
    });
    const checkbox = page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`);
    await checkbox.waitFor({ state: "visible" });
    await checkbox.uncheck();
    releaseResponse?.();
    const raceState = await Promise.race([
      resultPromise.then(() => "finished", () => "failed"),
      page.waitForTimeout(150).then(() => "pending"),
    ]);
    assert.equal(raceState, "pending");
    await checkbox.check();
    const result = await resultPromise;
    assert.equal(result.blocker, null);
  } finally {
    await browser.close();
  }
});

test("still requires visible authentication before refreshing or touching the cart", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript((key) => sessionStorage.setItem(key, "true"), WATCH_ENABLED_STORAGE_KEY);
    await page.route("https://kide.app/fi/events/auth", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<button>Kirjaudu</button><script>window.fetch("https://api.kide.app/api/products/auth");</script>`,
      }),
    );
    await page.route("https://api.kide.app/api/products/auth", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(payloadWithAvailability(1)),
      }),
    );
    await assert.rejects(
      waitForAvailability(page, {
        eventUrl: "https://kide.app/fi/events/auth",
        maxWaitMs: 1_000,
        pollIntervalMs: 20,
        watchForever: false,
      }),
      /not authenticated|Could not verify/i,
    );
  } finally {
    await browser.close();
  }
});

test("stops reloading as soon as matching tickets are available", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript((key) => sessionStorage.setItem(key, "true"), WATCH_ENABLED_STORAGE_KEY);
    const fixture = await routeEventWithProduct(page, "available", () => payloadWithAvailability(1));
    const result = await waitForAvailability(page, {
      eventUrl: "https://kide.app/fi/events/available",
      maxWaitMs: 2_000,
      pollIntervalMs: 50,
      watchForever: true,
    });
    assert.equal(result.blocker, null);
    assert.equal(fixture.requestCount(), 1);
  } finally {
    await browser.close();
  }
});

test("selects all exact four-person variants, verifies four cart rows, and never reaches payment", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://kide.app/fi/events/cart", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixtureHtml(),
      }),
    );
    await page.goto("https://kide.app/fi/events/cart");
    await page.evaluate((key) => sessionStorage.setItem(key, "true"), WATCH_ENABLED_STORAGE_KEY);
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
    assert.equal(selection.selected[0]?.totalPriceCents, 39800);
    assert.match(
      await page.locator('o-item[ng-repeat-start*="variant in product.productVariants"]').filter({ hasText: "Cabin A, 4 pers." }).first().innerText(),
      /398/,
    );

    await addVariantsToCart(page, selection.selected);
    assert.equal(await page.locator(".o-color--validation-info").count(), 4);
    assert.equal(
      await page.evaluate(() => (window as { paymentAttempts?: number }).paymentAttempts),
      0,
    );
    assert.equal(await page.url(), "https://kide.app/fi/events/cart");
  } finally {
    await browser.close();
  }
});

test("does not add a variant while the checkbox is off immediately before cart selection", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(fixtureHtml());
    await installWatchControl(page);
    const selection = selectFourPersonVariants((await inspectProductPage(page, payload)).variants);
    const addPromise = addVariantsToCart(page, selection.selected);
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".o-color--validation-info").count(), 0);
    await page.locator(`#${WATCH_CONTROL_CHECKBOX_ID}`).check();
    await addPromise;
    assert.equal(await page.locator(".o-color--validation-info").count(), 4);
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
