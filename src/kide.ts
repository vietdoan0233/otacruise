import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright";

import { chromium, installStealthContextInitScript } from "./browser.js";

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
const SOLD_OUT_TEXT = /loppuun\s*(?:varattu|myyty)|sold\s*out/i;
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
  // Optional one-time automated sign-in. Both must be set to attempt it;
  // leaving either unset keeps the existing manual-sign-in-then-reuse-profile
  // behavior unchanged. See attemptCredentialLogin() for what this does and
  // does not do.
  accountUsername?: string;
  accountPassword?: string;
};

export type KideAccountCredentials = {
  username: string;
  password: string;
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

export const WATCH_CONTROL_ID = "otacruise-watch-control";
export const WATCH_CONTROL_CHECKBOX_ID = `${WATCH_CONTROL_ID}-checkbox`;
export const WATCH_CONTROL_LABEL = "I’m logged in — enable refresh";
export const WATCH_ENABLED_STORAGE_KEY = "otacruise.watch.enabled";

type WatchControlPageOptions = {
  controlId: string;
  checkboxId: string;
  storageKey: string;
  label: string;
};

const pagesWithWatchControlInitScript = new WeakSet<Page>();

const WATCH_CONTROL_PAGE_SCRIPT = String.raw`
function otacruiseWatchControl(options) {
  if (window.top !== window) return;
  const pageWindow = window;
  const observerKey = "__otacruiseWatchObserver";
  const handlerFlag = "__otacruiseWatchChangeHandler";
  const styles = [
    "position:fixed", "top:12px", "left:12px", "z-index:2147483647",
    "display:flex", "align-items:center", "gap:6px",
    "max-width:calc(100vw - 24px)", "padding:7px 9px",
    "border:1px solid #777", "border-radius:5px", "background:#fff",
    "color:#111", "font:12px/1.2 sans-serif",
    "box-shadow:0 1px 5px rgba(0,0,0,.25)", "cursor:pointer",
    "user-select:none"
  ].join(";");

  function readStoredState() {
    try { return window.sessionStorage.getItem(options.storageKey) === "true"; }
    catch { return false; }
  }

  function persistState(checkbox) {
    try {
      window.sessionStorage.setItem(options.storageKey, checkbox.checked ? "true" : "false");
    } catch {
      // The current checkbox remains the source of truth if storage is unavailable.
    }
  }

  function bindCheckbox(checkbox) {
    checkbox.id = options.checkboxId;
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", options.label);
    checkbox.title = options.label;
    if (!checkbox[handlerFlag]) {
      checkbox.addEventListener("change", function () { persistState(checkbox); });
      checkbox.addEventListener("click", function (event) { event.stopPropagation(); });
      checkbox[handlerFlag] = true;
    }
  }

  function ensureControl() {
    const body = document.body;
    if (!body) return;
    const candidates = Array.from(document.querySelectorAll(
      '[data-otacruise-control="true"], #' + options.controlId
    ));
    const control = candidates[0] || document.createElement("label");
    candidates.slice(1).forEach(function (duplicate) { duplicate.remove(); });
    control.id = options.controlId;
    control.setAttribute("data-otacruise-control", "true");
    control.style.cssText = styles;
    control.style.pointerEvents = "none";
    control.title = options.label;

    let checkbox = control.querySelector("input[type='checkbox']");
    if (!checkbox) {
      checkbox = document.createElement("input");
      checkbox.checked = readStoredState();
      control.prepend(checkbox);
    }
    bindCheckbox(checkbox);
    checkbox.style.pointerEvents = "auto";

    let text = control.querySelector("[data-otacruise-control-label]");
    if (!text) {
      text = document.createElement("span");
      text.setAttribute("data-otacruise-control-label", "true");
      control.append(text);
    }
    text.style.pointerEvents = "none";
    if (text.textContent !== options.label) text.textContent = options.label;
    if (!control.isConnected || control.parentElement !== body) body.append(control);
  }

  if (!pageWindow[observerKey]) {
    let scheduled = false;
    function scheduleEnsure() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(function () {
        scheduled = false;
        ensureControl();
      });
    }
    const documentElement = document.documentElement;
    if (documentElement) {
      const observer = new MutationObserver(scheduleEnsure);
      observer.observe(documentElement, { childList: true, subtree: true });
      pageWindow[observerKey] = observer;
    } else {
      document.addEventListener("DOMContentLoaded", scheduleEnsure, { once: true });
    }
  }
  ensureControl();
}
`;

export type KideAuthenticationState =
  | "authenticated"
  | "unauthenticated"
  | "unknown";

const AUTHENTICATION_WAIT_TIMEOUT_MS = 15_000;
const AUTHENTICATION_POLL_INTERVAL_MS = 250;

// Kide's header renders this sprite only inside its own account-menu toggle
// (<o-menu-button><button><svg><use xlink:href="#o-account">...). Below
// ACCOUNT_MENU_DESKTOP_MIN_WIDTH the same button also opens a generic mobile
// nav drawer regardless of login state, so it is only trusted as proof of
// authentication at desktop widths -- which is what this automation actually
// launches, since it never overrides Playwright's default viewport.
const ACCOUNT_MENU_ICON_HREF = "#o-account";
const ACCOUNT_MENU_DESKTOP_MIN_WIDTH = 1024;

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
  // Every predicate below is written as a bare inline arrow, never assigned
  // to a local name (not even `const isVisible = ...`). tsx/esbuild rewrites
  // a *named* helper declared in this scope into a call to a `__name(...)`
  // runtime helper that lives outside this function; Playwright serializes
  // only this function's own source for the browser, so that helper is
  // undefined there and every call throws "ReferenceError: __name is not
  // defined". Bare, unnamed function expressions passed directly as
  // arguments are not rewritten and serialize cleanly, so any visibility
  // check that needs to run more than once is duplicated inline instead of
  // factored out.
  return page.evaluate(
    ({ accountIconHref, desktopMinWidth }) => {
      const bodyText = document.body?.innerText ?? "";
      const interactiveText = Array.from(
        document.querySelectorAll("button, a, [role='button'], [ng-click]"),
      )
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rectangle = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rectangle.width > 0 &&
            rectangle.height > 0
          );
        })
        .map((element) =>
          [
            element.textContent ?? "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("title") ?? "",
            element.getAttribute("ng-click") ?? "",
            element.getAttribute("href") ?? "",
          ].join(" "),
        )
        .join(" ");
      const visibleText = `${bodyText} ${interactiveText}`.toLowerCase();

      const hasLogoutMarker =
        /\bkirjaudu\s+ulos\b/.test(visibleText) ||
        /\blog\s*out\b|\bsign\s*out\b/.test(visibleText);

      // The dropdown behind Kide's account-menu button (o-menu-container /
      // o-menu-content) is not created in the DOM at all until it is opened
      // at least once, so it never appears while the session is merely
      // sitting authenticated with the menu closed. The toggle button itself
      // is the one marker that is actually present at that point.
      const hasAccountMenuControl =
        window.innerWidth >= desktopMinWidth &&
        Array.from(document.querySelectorAll("o-menu-button button, o-menu-button a"))
          .filter((element) => element.innerHTML.includes(accountIconHref))
          .some((element) => {
            const style = window.getComputedStyle(element);
            const rectangle = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rectangle.width > 0 &&
              rectangle.height > 0
            );
          });

      const hasEmailGreeting =
        /\bhei\b/.test(bodyText.toLowerCase()) &&
        /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(bodyText);

      // Some accounts greet by first name rather than e-mail. Scope that
      // reading to the account menu itself so unrelated page copy that
      // happens to contain "Hei" is never mistaken for a login greeting.
      const hasScopedNameGreeting = Array.from(
        document.querySelectorAll("o-menu-item, o-menu-content"),
      ).some((element) => {
        const style = window.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          /\bhei\b/i.test(element.textContent ?? "")
        );
      });

      const hasAuthenticatedMarker =
        hasLogoutMarker ||
        hasAccountMenuControl ||
        hasEmailGreeting ||
        hasScopedNameGreeting;

      const hasLoginAction = Array.from(document.querySelectorAll("[ng-click]")).some(
        (element) => {
          const style = window.getComputedStyle(element);
          const rectangle = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rectangle.width > 0 &&
            rectangle.height > 0 &&
            /showlogin|login/i.test(element.getAttribute("ng-click") ?? "")
          );
        },
      );
      // "Kirjaudu" alone is ambiguous in Finnish: it is also the first word
      // of "Kirjaudu ulos" (log out). Exclude that phrase so a visible
      // logout control can never be misread as a login prompt.
      const hasLoginControl =
        /\blogin\b|\bsign in\b|\bkirjaudu\b(?!\s+ulos)/.test(visibleText) ||
        hasLoginAction;

      if (hasAuthenticatedMarker) return "authenticated";
      if (hasLoginControl) return "unauthenticated";
      return "unknown";
    },
    { accountIconHref: ACCOUNT_MENU_ICON_HREF, desktopMinWidth: ACCOUNT_MENU_DESKTOP_MIN_WIDTH },
  );
}

export async function assertAuthenticatedSession(
  page: Page,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? AUTHENTICATION_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? AUTHENTICATION_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let state: KideAuthenticationState = "unknown";
  do {
    state = await inspectAuthenticationState(page);
    if (state === "authenticated") return;
    if (state === "unauthenticated") {
      throw new KideAutomationError(authenticationBlocker(state));
    }
    if (Date.now() >= deadline) break;
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);

  throw new KideAutomationError(authenticationBlocker(state));
}

// Verified against the real kide.app login dialog (unauthenticated; no
// credentials were entered). The controller name is a stable Angular
// identifier, unlikely to change with styling.
const LOGIN_DIALOG_SELECTOR = 'o-dialog[ng-controller="LoginController as login"]';
const LOGIN_MENU_ITEM_TEXT = "Kirjaudu sisään";
const LOGIN_SUBMIT_TIMEOUT_MS = 5_000;
const LOGIN_RESULT_TIMEOUT_MS = 15_000;

async function openLoginDialog(page: Page, submitTimeoutMs: number): Promise<boolean> {
  if ((await page.locator(LOGIN_DIALOG_SELECTOR).count()) > 0) return true;

  // Kide only creates the "Kirjaudu sisään" menu item -- and the dialog
  // behind it -- once the account menu has been opened at least once, the
  // same lazy-render behavior documented for inspectAuthenticationState().
  const menuToggle = page.locator("o-menu-button button, o-menu-button o-action-chip").first();
  if ((await menuToggle.count()) === 0) return false;
  await menuToggle.click();

  const loginMenuItem = page.locator("o-menu-item", { hasText: LOGIN_MENU_ITEM_TEXT }).first();
  try {
    await loginMenuItem.waitFor({ state: "visible", timeout: submitTimeoutMs });
  } catch {
    // No login item appeared -- most likely already authenticated (the item
    // only renders when `!body.user.isAuthenticated`) or the menu markup
    // has changed. Either way, leave verification to
    // assertAuthenticatedSession() rather than guessing here.
    return false;
  }
  await loginMenuItem.click();

  try {
    await page.locator(LOGIN_DIALOG_SELECTOR).waitFor({ state: "visible", timeout: submitTimeoutMs });
  } catch {
    return false;
  }
  return true;
}

/**
 * Attempts a single, one-time automated sign-in using the given credentials,
 * then returns -- it never asserts that sign-in actually succeeded. Callers
 * must still call assertAuthenticatedSession() (as runKideAutomation()
 * already does) to verify the real, visible result; that remains the single
 * source of truth and fails closed exactly as it would without this
 * function, including when this attempt did nothing or was blocked.
 *
 * Deliberately conservative:
 * - Only ever fills the two credential fields and clicks the one submit
 *   button; never touches the Facebook button, "remember me", or any other
 *   control in the dialog.
 * - If Kide presents a Cloudflare challenge inside the dialog, this stops
 *   immediately without clicking submit or interacting with the challenge
 *   in any way -- solving or bypassing bot-detection challenges is out of
 *   scope, regardless of whose account this is.
 * - Never throws, never logs, and never includes the username or password
 *   in any value it returns. A failed or blocked attempt just leaves the
 *   page in whatever state it was in for the normal fail-closed checks to
 *   report.
 * - Must only be called once per run, before the watch loop starts (see
 *   runKideAutomation()), never from inside a retry loop -- repeated
 *   attempts against a login form risk a lockout or rate limit on the real
 *   account.
 */
export async function attemptCredentialLogin(
  page: Page,
  credentials: KideAccountCredentials,
  options: { submitTimeoutMs?: number; resultTimeoutMs?: number } = {},
): Promise<void> {
  const submitTimeoutMs = options.submitTimeoutMs ?? LOGIN_SUBMIT_TIMEOUT_MS;
  const resultTimeoutMs = options.resultTimeoutMs ?? LOGIN_RESULT_TIMEOUT_MS;

  const state = await inspectAuthenticationState(page);
  if (state === "authenticated") return;

  const opened = await openLoginDialog(page, submitTimeoutMs);
  if (!opened) return;

  const dialog = page.locator(LOGIN_DIALOG_SELECTOR);
  try {
    await dialog.locator("#username").fill(credentials.username);
    await dialog.locator("#password").fill(credentials.password);

    if ((await dialog.locator("o-cloudflare iframe").count()) > 0) return;

    await dialog.locator("button", { hasText: LOGIN_MENU_ITEM_TEXT }).first().click();

    if ((await dialog.locator("o-cloudflare iframe").count()) > 0) return;

    // Success closes the dialog; a wrong password or an unresolved
    // challenge leaves it open. Either way, stop waiting here and let
    // assertAuthenticatedSession() read the real, visible outcome.
    await dialog.waitFor({ state: "hidden", timeout: resultTimeoutMs });
  } catch {
    return;
  }
}

export async function installWatchControl(page: Page): Promise<void> {
  const options: WatchControlPageOptions = {
    controlId: WATCH_CONTROL_ID,
    checkboxId: WATCH_CONTROL_CHECKBOX_ID,
    storageKey: WATCH_ENABLED_STORAGE_KEY,
    label: WATCH_CONTROL_LABEL,
  };
  if (!pagesWithWatchControlInitScript.has(page)) {
    await page.addInitScript({
      content: `${WATCH_CONTROL_PAGE_SCRIPT}\notacruiseWatchControl(${JSON.stringify(options)});`,
    });
    pagesWithWatchControlInitScript.add(page);
  }
  await page.evaluate(
    ({ script, scriptOptions }) => {
      const execute = new Function("options", `${script}\notacruiseWatchControl(options);`);
      execute(scriptOptions);
    },
    { script: WATCH_CONTROL_PAGE_SCRIPT, scriptOptions: options },
  );
}

async function watchControlIsEnabled(page: Page): Promise<boolean> {
  await installWatchControl(page);
  const checkbox = page.locator(`#${WATCH_CONTROL_ID}-checkbox`);
  if (await checkbox.count() !== 1) {
    throw new KideAutomationError(
      "The refresh control could not be installed; no page refresh or cart action was attempted.",
    );
  }
  return checkbox.isChecked();
}

async function persistWatchControlState(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(({ storageKey, value }) => {
    try {
      window.sessionStorage.setItem(storageKey, value ? "true" : "false");
    } catch {
      // The checkbox remains the source of truth for this page if storage is unavailable.
    }
  }, { storageKey: WATCH_ENABLED_STORAGE_KEY, value: enabled });
}

async function waitForWatchEnabled(page: Page): Promise<void> {
  while (true) {
    if (await watchControlIsEnabled(page)) {
      await persistWatchControlState(page, true);
      return;
    }
    await delay(250);
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
    .replace(/loppuun\s*(?:varattu|myyty)|sold\s*out|varattu|reserved/gi, "")
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
      available:
        variant.available &&
        !domVariant.disabled &&
        !SOLD_OUT_TEXT.test(domVariant.text),
      stock:
        domVariant.disabled || SOLD_OUT_TEXT.test(domVariant.text)
          ? 0
          : variant.stock,
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
  const currentUrl = page.url();
  const targetUrl = new URL(eventUrl);
  let isSameEventPage = false;
  let parsedCurrentUrl: URL | null = null;
  try {
    parsedCurrentUrl = new URL(currentUrl);
    isSameEventPage =
      parsedCurrentUrl.origin === targetUrl.origin &&
      parsedCurrentUrl.pathname === targetUrl.pathname;
  } catch {
    isSameEventPage = false;
  }

  if (isSameEventPage) {
    await waitForWatchEnabled(page);
    // Check the visible session state immediately before every refresh.
    // This intentionally fails closed: an unknown state must never cause a
    // refresh that could discard a newly available ticket or reservation.
    await assertAuthenticatedSession(page);
  } else if (parsedCurrentUrl?.hostname === "kide.app") {
    await assertAuthenticatedSession(page);
  }

  const pendingProductResponse = waitForProductResponse(page, eventId, 30_000);
  try {
    if (isSameEventPage) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } else {
      await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    // Install immediately after navigation so the control is visible while
    // Angular finishes rendering and before the API response is interpreted.
    await installWatchControl(page);
    const payload = await pendingProductResponse.promise;
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    // A pause must take effect before the response is interpreted. This also
    // prevents a checkbox race from reaching selection or cart code.
    await waitForWatchEnabled(page);
    await assertAuthenticatedSession(page);
    await page.locator(VARIANT_ROW_SELECTOR).first().waitFor({
      state: "attached",
      timeout: 15_000,
    });
    const inspection = await inspectProductPage(page, payload);
    return inspection;
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
      // and user confirmation happen after the event DOM exists and before any
      // watch/reload cycle.
      await waitForWatchEnabled(page);
      await assertAuthenticatedSession(page);
      break;
    } catch (error) {
      if (!options.watchForever || !isRetryableWatchError(error)) throw error;
      await delay(options.pollIntervalMs);
    }
  }

  while (true) {
    // The checkbox is also a pause control for the verified snapshot. If the
    // user turns it off while a response is being processed, wait before
    // interpreting that snapshot or touching the cart.
    await waitForWatchEnabled(page);
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
        blocker: `Kide reports all ticket rows sold out ("Loppuun varattu"/"Loppuunmyyty"): ${soldOutNames}.`,
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
  await waitForWatchEnabled(page);
  await assertAuthenticatedSession(page);

  for (const variant of variants) {
    // Re-check both gates before every click. A pause or logout between rows
    // must stop the cart sequence before another reservation is attempted.
    await waitForWatchEnabled(page);
    await assertAuthenticatedSession(page);
    const rows = page.locator(VARIANT_ROW_SELECTOR).filter({ hasText: variant.name });
    if (await rows.count() !== 1) {
      throw new KideAutomationError(
        `Could not uniquely locate the verified Kide row for "${variant.name}"; no further cart action was attempted.`,
      );
    }

    const row = rows.first();
    if (
      (await row.getAttribute("disabled")) !== null ||
      (await row.getAttribute("aria-disabled")) === "true" ||
      !(await row.isEnabled())
    ) {
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

    await waitForWatchEnabled(page);
    await assertAuthenticatedSession(page);

    const latestRowText = await row.innerText();
    if (
      (await row.getAttribute("disabled")) !== null ||
      (await row.getAttribute("aria-disabled")) === "true" ||
      !(await row.isEnabled()) ||
      SOLD_OUT_TEXT.test(latestRowText) ||
      !visibleTotalPriceMatches(latestRowText, variant.totalPriceCents)
    ) {
      throw new KideAutomationError(
        `Kide changed verified variant "${variant.name}" before cart selection; no further cart action was attempted.`,
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
    await installStealthContextInitScript(context);
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
    await installStealthContextInitScript(context);
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
  await installStealthContextInitScript(context);
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

  const installedBrowser = candidates.find((candidate) => existsSync(candidate));
  if (installedBrowser) return installedBrowser;

  const bundled = chromium.executablePath();
  return existsSync(bundled) ? bundled : undefined;
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
  const pollIntervalMs = Math.max(options.pollIntervalMs ?? 1_000, 1_000);
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
    if (options.accountUsername && options.accountPassword) {
      // Best-effort and one-time, before the watch loop below ever starts.
      // Errors here are swallowed on purpose: waitForAvailability() below
      // still performs its own navigation and its own
      // assertAuthenticatedSession() checks, which remain the only source
      // of truth for whether the session is actually authenticated.
      await session.page
        .goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => undefined);
      await attemptCredentialLogin(session.page, {
        username: options.accountUsername,
        password: options.accountPassword,
      }).catch(() => undefined);
    }
    const { inspection, blocker } = await waitForAvailability(session.page, {
      eventUrl,
      maxWaitMs,
      pollIntervalMs,
      watchForever,
    });
    await waitForWatchEnabled(session.page);
    await assertAuthenticatedSession(session.page);
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
