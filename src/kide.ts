import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright";

import {
  isFourPersonVariant,
  normalizeVariantName,
  selectFourPersonVariants,
  totalCents,
} from "./selector.js";
import type {
  AutomationOutput,
  DomVariantState,
  ProductInspection,
  TicketVariant,
} from "./types.js";

export const DEFAULT_EVENT_URL =
  "https://kide.app/fi/events/bd92ef0f-b02f-4a0b-b439-580b4c01bb2a";

const API_HOST = "api.kide.app";
const VARIANT_ROW_SELECTOR =
  'o-item[ng-repeat-start*="variant in product.productVariants"]';
const SOLD_OUT_TEXT = /loppuun varattu|sold out/i;
const RESERVED_TEXT = /varattu|reserved/i;
const EXPECTED_VARIANT_NAMES = [
  "Cabin A, 2 pers.",
  "Cabin A, 4 pers.",
  "Prom., 2 pers.",
  "Prom., 4 pers.",
  "Cabin B, 2 pers.",
  "Cabin B, 4 pers.",
  "Cabin C, 2 pers.",
  "Cabin C, 3 pers.",
  "Cabin C, 4 pers.",
];

type JsonRecord = Record<string, unknown>;

export type KideAutomationOptions = {
  eventUrl?: string;
  cdpUrl?: string;
  profileDir?: string;
  storageStatePath?: string;
  headless?: boolean;
  dryRun?: boolean;
  watchForever?: boolean;
  keepBrowserOpen?: boolean;
  maxWaitMs?: number;
  pollIntervalMs?: number;
};

type BrowserSession = {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

type ParsedProduct = {
  eventTitle: string | null;
  variants: TicketVariant[];
  saleCountdownText: string | null;
};

type PendingProductResponse = {
  promise: Promise<unknown>;
  cancel: () => void;
};

export class KideAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KideAutomationError";
  }
}

export type KideAuthenticationState =
  | "authenticated"
  | "unauthenticated"
  | "unknown";

function authenticationBlocker(
  state: Exclude<KideAuthenticationState, "authenticated">,
): string {
  if (state === "unauthenticated") {
    return "Kide session is not authenticated; no refresh or cart action was attempted. Sign in in the local browser and rerun.";
  }
  return "Could not verify Kide authentication state from the visible page; no refresh or cart action was attempted.";
}

export async function inspectAuthenticationState(
  page: Page,
): Promise<KideAuthenticationState> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText ?? "";
    let interactiveText = "";
    for (const element of Array.from(
      document.querySelectorAll("button, a, [role='button'], [ng-click]"),
    )) {
      const style = window.getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rectangle.width <= 0 ||
        rectangle.height <= 0
      ) continue;
      interactiveText += [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
        element.getAttribute("ng-click") ?? "",
        element.getAttribute("href") ?? "",
      ].join(" ");
    }
    const visibleText = `${bodyText} ${interactiveText}`.toLowerCase();

    let hasAccountControl = false;
    for (const element of Array.from(document.querySelectorAll("[ng-click]"))) {
      const style = window.getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      if (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        /account\.profile|account\.settings/i.test(
          element.getAttribute("ng-click") ?? "",
        )
      ) {
        hasAccountControl = true;
        break;
      }
    }
    const hasAuthenticatedControl =
      /logout|log out|sign out|kirjaudu ulos/.test(visibleText) ||
      hasAccountControl;
    const hasAuthenticatedGreeting =
      /\bhei\b/.test(bodyText.toLowerCase()) &&
      /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(bodyText);
    let hasLoginAction = false;
    for (const element of Array.from(document.querySelectorAll("[ng-click]"))) {
      const style = window.getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      if (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        /showlogin|login/i.test(element.getAttribute("ng-click") ?? "")
      ) {
        hasLoginAction = true;
        break;
      }
    }
    const hasLoginControl =
      /\blogin\b|\bsign in\b|\bkirjaudu\b/.test(visibleText) ||
      hasLoginAction;

    if (hasAuthenticatedControl || hasAuthenticatedGreeting) return "authenticated";
    if (hasLoginControl) return "unauthenticated";
    return "unknown";
  });
}

export async function assertAuthenticatedSession(page: Page): Promise<void> {
  const state = await inspectAuthenticationState(page);
  if (state !== "authenticated") {
    throw new KideAutomationError(authenticationBlocker(state));
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerOrNull(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0
    ? number
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readPriceCents(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number !== null && Number.isInteger(number) && number >= 0) {
    return number;
  }

  if (typeof value === "string") {
    const normalized = value
      .replace(/\u00a0/g, " ")
      .replace(/[^0-9,.-]/g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed * 100);
    }
  }

  const object = record(value);
  if (object) {
    for (const key of ["amount", "value", "pricePerItem", "totalPrice"]) {
      const parsed = readPriceCents(object[key]);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

function readStock(variant: JsonRecord): number | null {
  for (const key of [
    "stock",
    "availableStock",
    "availability",
    "inventoryQuantity",
    "quantityAvailable",
  ]) {
    const stock = integerOrNull(variant[key]);
    if (stock !== null) return stock;
  }
  return null;
}

function readMaxQuantity(variant: JsonRecord): number | null {
  for (const key of [
    "productVariantMaximumItemQuantityPerUser",
    "maximumItemQuantityPerUser",
    "maxQuantity",
    "maximumQuantity",
  ]) {
    const maxQuantity = integerOrNull(variant[key]);
    if (maxQuantity !== null) return maxQuantity;
  }
  return null;
}

function readNetworkAvailability(variant: JsonRecord): boolean {
  for (const key of ["available", "isAvailable", "isReservable"]) {
    const available = readBoolean(variant[key]);
    if (available !== null) return available;
  }

  const stock = readStock(variant);
  return stock === null || stock > 0;
}

function productFromPayload(payload: unknown): JsonRecord {
  const root = record(payload);
  const model = record(root?.model);
  const product = record(model?.product);
  if (!model || !product) {
    throw new KideAutomationError(
      "Kide product API response has no model.product object.",
    );
  }
  return product;
}

export function parseProductPayload(payload: unknown): ParsedProduct {
  const root = record(payload);
  const model = record(root?.model);
  const product = productFromPayload(payload);
  const rawVariants = Array.isArray(model?.variants) ? model.variants : [];

  const variants = rawVariants.map((rawVariant, index) => {
    const variant = record(rawVariant);
    const id = readString(variant?.id);
    const name = readString(variant?.name);
    const totalPriceCents = readPriceCents(variant?.pricePerItem ?? variant?.price);

    if (!variant || !id || !name || totalPriceCents === null) {
      throw new KideAutomationError(
        `Kide product API variant ${index} is missing id, name, or total price.`,
      );
    }

    return {
      id,
      name: normalizeVariantName(name),
      totalPriceCents,
      available: readNetworkAvailability(variant),
      stock: readStock(variant),
      maxQuantity: readMaxQuantity(variant),
    } satisfies TicketVariant;
  });

  let saleCountdownText: string | null = null;
  const salesStarted = readBoolean(product.salesStarted);
  const timeUntilSalesStart = finiteNumber(product.timeUntilSalesStart);
  const timeUntilNextSalesStart = finiteNumber(product.timeUntilNextSalesStart);
  if (salesStarted === false && timeUntilSalesStart !== null) {
    saleCountdownText = `sales start in ${Math.max(0, Math.ceil(timeUntilSalesStart))} seconds`;
  } else if (timeUntilNextSalesStart !== null && timeUntilNextSalesStart > 0) {
    saleCountdownText = `next sale starts in ${Math.ceil(timeUntilNextSalesStart)} seconds`;
  } else {
    const nextSalesFrom = readString(product.dateNextSalesFrom);
    const salesFrom = readString(product.dateSalesFrom);
    saleCountdownText = nextSalesFrom ?? (salesStarted === false ? salesFrom : null);
  }

  return {
    eventTitle: readString(product.name),
    variants,
    saleCountdownText,
  };
}

function extractVisibleVariantName(text: string): string {
  const normalizedText = normalizeVariantName(text);
  const knownMatch = EXPECTED_VARIANT_NAMES.filter((name) =>
    normalizedText.includes(name),
  ).sort((left, right) => right.length - left.length)[0];
  if (knownMatch) return knownMatch;

  return normalizedText
    .replace(/loppuun varattu|sold out|varattu|reserved/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readDomVariants(page: Page): Promise<DomVariantState[]> {
  const rows = await page.locator(VARIANT_ROW_SELECTOR).evaluateAll((elements) =>
    elements.map((element) => {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      const disabled =
        element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true";
      const reserved =
        element.querySelector(".o-color--validation-info") !== null ||
        /varattu|reserved/i.test(text);
      return { text, disabled, reserved };
    }),
  );

  return rows.map((row) => ({
    ...row,
    name: extractVisibleVariantName(row.text),
  }));
}

function mergeNetworkAndDom(
  networkVariants: TicketVariant[],
  domVariants: DomVariantState[],
): TicketVariant[] {
  if (domVariants.length === 0) {
    throw new KideAutomationError(
      "Kide ticket rows were not found in the live DOM; no variant was selected.",
    );
  }

  const domByName = new Map(
    domVariants.map((variant) => [normalizeVariantName(variant.name), variant]),
  );

  return networkVariants.map((variant) => {
    const domVariant = domByName.get(normalizeVariantName(variant.name));
    if (!domVariant) {
      throw new KideAutomationError(
        `Kide DOM has no ticket row for API variant "${variant.name}"; no variant was selected.`,
      );
    }

    return {
      ...variant,
      available: variant.available && !domVariant.disabled,
      stock: domVariant.disabled ? 0 : variant.stock,
    };
  });
}

export async function inspectProductPage(
  page: Page,
  payload: unknown,
): Promise<ProductInspection> {
  const parsed = parseProductPayload(payload);
  const domVariants = await readDomVariants(page);
  const variants = mergeNetworkAndDom(parsed.variants, domVariants);
  const eventTitle = parsed.eventTitle ?? (await page.title()) ?? null;

  return {
    variants,
    domVariants,
    saleCountdownText: parsed.saleCountdownText,
    eventTitle,
  };
}

function eventIdFromUrl(eventUrl: string): string {
  const parsed = new URL(eventUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "kide.app") {
    throw new KideAutomationError(
      "Kide event URL must be an HTTPS URL on kide.app.",
    );
  }

  const eventId = parsed.pathname.match(/\/events\/([^/]+)/)?.[1];
  if (!eventId) {
    throw new KideAutomationError("Kide event URL does not contain an event id.");
  }
  return eventId;
}

function isProductResponse(response: Response, eventId: string): boolean {
  const url = new URL(response.url());
  return (
    url.protocol === "https:" &&
    url.hostname === API_HOST &&
    url.pathname === `/api/products/${eventId}` &&
    ["xhr", "fetch"].includes(response.request().resourceType())
  );
}

function waitForProductResponse(
  page: Page,
  eventId: string,
  timeoutMs: number,
): PendingProductResponse {
  let cancelResponse: () => void = () => {};
  const promise = new Promise<unknown>((resolveResponse, reject) => {
    let settled = false;
    const clearResponse = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      page.off("response", onResponse);
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      page.off("response", onResponse);
      reject(
        new KideAutomationError(
          "The Kide product API response was not observed; live ticket data could not be verified.",
        ),
      );
    }, timeoutMs);

    const onResponse = async (response: Response) => {
      if (!isProductResponse(response, eventId)) return;
      try {
        const payload = await response.json();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          page.off("response", onResponse);
          resolveResponse(payload);
        }
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          page.off("response", onResponse);
          reject(
            new KideAutomationError(
              "The Kide product API response was not valid JSON; no ticket was selected.",
            ),
          );
        }
      }
    };

    cancelResponse = clearResponse;
    page.on("response", onResponse);
  });

  return { promise, cancel: cancelResponse };
}

async function loadProductPage(
  page: Page,
  eventUrl: string,
  eventId: string,
): Promise<ProductInspection> {
  const pendingProductResponse = waitForProductResponse(page, eventId, 30_000);
  try {
    const currentUrl = page.url();
    const targetUrl = new URL(eventUrl);
    let isSameEventPage = false;
    try {
      const parsedCurrentUrl = new URL(currentUrl);
      isSameEventPage =
        parsedCurrentUrl.origin === targetUrl.origin &&
        parsedCurrentUrl.pathname === targetUrl.pathname;
    } catch {
      isSameEventPage = false;
    }

    if (isSameEventPage) {
      // Check the visible session state immediately before every refresh.
      // This intentionally fails closed: an unknown state must never cause a
      // refresh that could discard a newly available ticket or reservation.
      await assertAuthenticatedSession(page);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } else {
      const parsedCurrentUrl = (() => {
        try {
          return new URL(currentUrl);
        } catch {
          return null;
        }
      })();
      if (parsedCurrentUrl?.hostname === "kide.app") {
        await assertAuthenticatedSession(page);
      }
      await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    const payload = await pendingProductResponse.promise;
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await assertAuthenticatedSession(page);
    return inspectProductPage(page, payload);
  } catch (error) {
    pendingProductResponse.cancel();
    throw error;
  }
}

function expectedStructureBlocker(inspection: ProductInspection): string | null {
  const names = new Set(inspection.variants.map((variant) => variant.name));
  const missing = EXPECTED_VARIANT_NAMES.filter((name) => !names.has(name));
  const unexpected = inspection.variants
    .map((variant) => variant.name)
    .filter((name) => !EXPECTED_VARIANT_NAMES.includes(name));

  if (missing.length === 0 && unexpected.length === 0) return null;
  return `Unexpected Kide ticket structure: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}].`;
}

function allTicketRowsSoldOut(inspection: ProductInspection): boolean {
  return (
    inspection.domVariants.length > 0 &&
    inspection.domVariants.every(
      (variant) => variant.disabled || SOLD_OUT_TEXT.test(variant.text),
    )
  );
}

function allFourPersonVariantsUnavailable(inspection: ProductInspection): boolean {
  const fourPersonVariants = inspection.variants.filter(isFourPersonVariant);
  return (
    fourPersonVariants.length > 0 &&
    fourPersonVariants.every((variant) => !variant.available)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isRetryableWatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /product API response was not observed|valid JSON|timeout|navigation|ERR_/i.test(
    message,
  );
}

export async function waitForAvailability(
  page: Page,
  options: Required<
    Pick<
      KideAutomationOptions,
      "eventUrl" | "maxWaitMs" | "pollIntervalMs" | "watchForever"
    >
  >,
): Promise<{ inspection: ProductInspection; blocker: string | null }> {
  const eventId = eventIdFromUrl(options.eventUrl);
  const deadline = Date.now() + options.maxWaitMs;
  let inspection: ProductInspection;

  while (true) {
    try {
      inspection = await loadProductPage(page, options.eventUrl, eventId);
      // The first navigation may start from about:blank, so the session check
      // happens after the event DOM exists and before any watch/reload cycle.
      await assertAuthenticatedSession(page);
      break;
    } catch (error) {
      if (!options.watchForever || !isRetryableWatchError(error)) throw error;
      await delay(options.pollIntervalMs);
    }
  }

  while (true) {
    const structureBlocker = expectedStructureBlocker(inspection);
    if (structureBlocker) return { inspection, blocker: structureBlocker };

    const selection = selectFourPersonVariants(inspection.variants);
    if (selection.ambiguous.length > 0) {
      return {
        inspection,
        blocker: `Four-person price matches have ambiguous visible labels: ${selection.ambiguous
          .map((variant) => `${variant.id} (${variant.name}, €${variant.totalPriceCents / 100})`)
          .join(", ")}.`,
      };
    }

    if (selection.selected.length > 0) {
      // Return before the next delay/reload. The page is now the verified
      // availability snapshot used for cart selection.
      return { inspection, blocker: null };
    }

    if (
      !options.watchForever &&
      allTicketRowsSoldOut(inspection) &&
      !inspection.saleCountdownText
    ) {
      const soldOutNames = inspection.domVariants
        .filter((variant) => variant.disabled || SOLD_OUT_TEXT.test(variant.text))
        .map((variant) => variant.name)
        .join(", ");
      return {
        inspection,
        blocker: `Kide reports all ticket rows sold out ("Loppuun varattu"): ${soldOutNames}.`,
      };
    }

    if (
      !options.watchForever &&
      allFourPersonVariantsUnavailable(inspection) &&
      !inspection.saleCountdownText
    ) {
      const unavailableNames = inspection.variants
        .filter(isFourPersonVariant)
        .map((variant) => variant.name)
        .join(", ");
      return {
        inspection,
        blocker: `All four-person price-threshold variants are unavailable: ${unavailableNames}.`,
      };
    }

    if (!options.watchForever && Date.now() >= deadline) {
      return {
        inspection,
        blocker: inspection.saleCountdownText
          ? `Availability did not open before the wait limit; the page reported ${inspection.saleCountdownText}.`
          : "No four-person ticket became available before the wait limit.",
      };
    }

    await delay(options.pollIntervalMs);
    try {
      inspection = await loadProductPage(page, options.eventUrl, eventId);
    } catch (error) {
      if (!options.watchForever || !isRetryableWatchError(error)) throw error;
    }
  }
}

export async function addVariantsToCart(
  page: Page,
  variants: TicketVariant[],
): Promise<void> {
  for (const variant of variants) {
    const rows = page.locator(VARIANT_ROW_SELECTOR).filter({ hasText: variant.name });
    if (await rows.count() !== 1) {
      throw new KideAutomationError(
        `Could not uniquely locate the verified Kide row for "${variant.name}"; no further cart action was attempted.`,
      );
    }

    const row = rows.first();
    if (await row.getAttribute("disabled") !== null || !(await row.isEnabled())) {
      throw new KideAutomationError(
        `Kide marked verified variant "${variant.name}" unavailable before cart selection; no further cart action was attempted.`,
      );
    }

    const initialRowText = await row.innerText();
    const initiallyReserved =
      (await row.locator(".o-color--validation-info").count()) > 0 ||
      RESERVED_TEXT.test(initialRowText);
    if (initiallyReserved) {
      // Kide treats a click on an already-reserved row as an edit/cancel
      // action. With the one-per-variant limit, the existing reservation is
      // already the desired cart quantity, so never click it again.
      continue;
    }

    if (!visibleTotalPriceMatches(initialRowText, variant.totalPriceCents)) {
      throw new KideAutomationError(
        `The visible total price for "${variant.name}" no longer matches the verified API price; no cart action was attempted.`,
      );
    }

    await row.click();
    await page.waitForTimeout(250);
    const rowText = await row.innerText();
    const reservedChipCount = await row.locator(".o-color--validation-info").count();
    if (reservedChipCount === 0 && !RESERVED_TEXT.test(rowText)) {
      throw new KideAutomationError(
        `Kide did not visibly confirm the reservation for "${variant.name}"; stopped before adding another variant.`,
      );
    }
  }
}

function visibleTotalPriceMatches(text: string, totalPriceCents: number): boolean {
  const euros = totalPriceCents / 100;
  const integerPart = Math.trunc(euros).toString();
  const decimalPart = Math.round((euros - Math.trunc(euros)) * 100)
    .toString()
    .padStart(2, "0");
  const normalizedText = text.replace(/\u00a0/g, " ");
  const pricePattern = new RegExp(
    `(?:${integerPart}(?:[,.]${decimalPart})?\\s*€|€\\s*${integerPart}(?:[,.]${decimalPart})?)`,
  );
  return pricePattern.test(normalizedText);
}

async function createBrowserSession(
  options: KideAutomationOptions,
): Promise<BrowserSession> {
  const headless = options.headless ?? false;
  const executablePath = resolveBrowserExecutable();

  if (options.cdpUrl) {
    const browser = await chromium.connectOverCDP(options.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages().find((candidate) => candidate.url().includes("kide.app")) ??
      (await context.newPage());
    return {
      browser,
      context,
      page,
      // For a CDP connection Playwright's close() disconnects from the
      // browser and clears only contexts created by this connection.
      close: async () => browser.close(),
    };
  }

  if (options.profileDir) {
    const context = await chromium.launchPersistentContext(resolve(options.profileDir), {
      headless,
      ...(executablePath ? { executablePath } : {}),
    });
    return {
      browser: null,
      context,
      page: context.pages()[0] ?? (await context.newPage()),
      close: async () => context.close(),
    };
  }

  const browser = await chromium.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext(
    options.storageStatePath ? { storageState: resolve(options.storageStatePath) } : undefined,
  );
  return {
    browser,
    context,
    page: await context.newPage(),
    close: async () => browser.close(),
  };
}

export function resolveBrowserExecutable(): string | undefined {
  const configured = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;

  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;

  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  return candidates.find((candidate) => existsSync(candidate));
}

function outputForSelection(
  selected: TicketVariant[],
  ambiguous: TicketVariant[],
  reason: string,
): AutomationOutput {
  return {
    selected_variant_ids: selected.map((variant) => variant.id),
    selected_names: selected.map((variant) => variant.name),
    selected_prices: selected.map((variant) => variant.totalPriceCents / 100),
    total_before_fees: totalCents(selected) / 100,
    ambiguous_variant_ids: ambiguous.map((variant) => variant.id),
    reason,
  };
}

export function emptyOutput(reason: string): AutomationOutput {
  return outputForSelection([], [], reason);
}

export async function runKideAutomation(
  options: KideAutomationOptions = {},
): Promise<AutomationOutput> {
  const eventUrl = options.eventUrl ?? DEFAULT_EVENT_URL;
  const maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
  const pollIntervalMs = Math.max(options.pollIntervalMs ?? 10_000, 1_000);
  const dryRun = options.dryRun ?? false;
  const watchForever = options.watchForever ?? true;
  const keepBrowserOpen = options.keepBrowserOpen ?? true;
  const session = await createBrowserSession({
    ...options,
    eventUrl,
    maxWaitMs,
    pollIntervalMs,
  });

  try {
    const { inspection, blocker } = await waitForAvailability(session.page, {
      eventUrl,
      maxWaitMs,
      pollIntervalMs,
      watchForever,
    });
    const selection = selectFourPersonVariants(inspection.variants);

    if (blocker) {
      return outputForSelection(
        [],
        selection.ambiguous,
        blocker,
      );
    }

    if (selection.selected.length === 0) {
      return emptyOutput("No available four-person variant matched the exact rules.");
    }

    const invalidLimit = selection.selected.find((variant) => variant.maxQuantity !== 1);
    if (invalidLimit) {
      return outputForSelection(
        [],
        [],
        `Could not verify the one-per-variant limit for "${invalidLimit.name}"; no cart action was attempted.`,
      );
    }

    const summary = `Cart summary: ${selection.selected.length} cabin(s), ${
      selection.selected.length * 4
    } people, €${totalCents(selection.selected) / 100} before fees.`;

    if (dryRun) {
      return outputForSelection(
        selection.selected,
        selection.ambiguous,
        `${summary} Dry run: variants were verified but not added to the cart. Stopped before checkout/payment.`,
      );
    }

    try {
      await addVariantsToCart(session.page, selection.selected);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cart confirmation failed.";
      return outputForSelection(
        [],
        [],
        `${message} The cart may contain a partial reservation; stopped before checkout/payment for manual review.`,
      );
    }

    return outputForSelection(
      selection.selected,
      selection.ambiguous,
      `${summary} All verified variants were added to the cart. Stopped before the final paid-order/payment action.`,
    );
  } finally {
    if (!keepBrowserOpen) await session.close();
  }
}
