# Otacruise ticket automation

Local TypeScript/Playwright automation for inspecting the Otacruise Kide.app event and preparing the four-person cabin variants. It watches the event page, verifies you are visibly signed in before every action, and stops before the final paid-order confirmation — placing the order remains a manual step.

## Quick start

```powershell
git clone https://github.com/vietdoan0233/otacruise.git
Set-Location .\otacruise
npm install
Copy-Item .env.example .env
npx playwright install chromium
```

Open `.env` and check the values — the defaults are already set for the Otacruise event with a visible browser and continuous polling. See [Configuration](#configuration) below for what each line does. Then start it:

```powershell
npm run dev
```

A visible Chromium window opens on the event page.

1. If you're not already signed in, sign in by hand in that window. (First run only — the session is saved to `.local/kide-profile` and reused automatically after that.)
2. Once the Kide account is visibly showing (or you've just signed in), check the small top-left box labeled **"I’m logged in — enable refresh"**. It starts unchecked on purpose.
3. Leave it checked and leave the terminal running. The watcher reloads the page, checks for an available four-person cabin, and — the moment one appears — verifies it and adds it to the cart, then stops before checkout/payment.
4. `Ctrl+C` in the terminal stops the watcher at any time. Unchecking the box just pauses it instead.

The process prints one JSON object to stdout when it stops:

```json
{
  "selected_variant_ids": [],
  "selected_names": [],
  "selected_prices": [],
  "total_before_fees": 0,
  "ambiguous_variant_ids": [],
  "reason": ""
}
```

Read `reason` to see why it stopped — a match found, everything sold out, the wait limit reached, or an authentication problem. See [Troubleshooting](#troubleshooting) if `reason` reports an authentication problem while you're visibly signed in.

## Configuration

Everything is read from `.env` (copied from `.env.example`) plus whatever you export in the shell before `npm run dev`; a shell value overrides `.env`. None of this is required beyond what `.env.example` already ships with — the table below is a reference for what each line does and when you'd change it.

| Variable | Default | What it does |
| --- | --- | --- |
| `KIDE_EVENT_URL` | the Otacruise 2026 event | The `kide.app/fi/events/<id>` page to watch. Change this to point at a different Kide event. |
| `HEADLESS` | `false` | `false` shows the browser window, which you need to sign in and to use the checkbox. Only set `true` once a session is already authenticated via `KIDE_CDP_URL` or a pre-authenticated profile. |
| `DRY_RUN` | `false` | `true` verifies a matching variant but never adds it to the cart — useful for a non-mutating check. |
| `KIDE_WATCH_FOREVER` | `true` | `true` keeps reloading (once a second, see below) until a match appears, the checkbox is turned off, or you stop the process. `false` stops after one pass if nothing matches or everything is sold out. |
| `KIDE_KEEP_BROWSER_OPEN` | `true` | `true` leaves the visible browser open after the process reports its result, so you can see the cart. |
| `KIDE_POLL_INTERVAL_MS` | `1000` | Minimum delay between reloads while watching. The code enforces a floor of `1000` regardless of what you set. |
| `KIDE_MAX_WAIT_MS` | `1800000` (30 min) | Only relevant when `KIDE_WATCH_FOREVER=false`: how long to keep retrying a retryable error (a slow page, a missed API response) before giving up. |
| `KIDE_PROFILE_DIR` | `.local/kide-profile` | A persistent, gitignored Chromium profile directory. Sign in here once; cookies and local storage are reused on every later run. Delete this directory to sign out and start fresh. |
| `KIDE_STORAGE_STATE` | unset | An alternative to the profile directory: a local Playwright storage-state file. Only used if `KIDE_PROFILE_DIR` is left unset. Keep it out of version control. |
| `KIDE_CDP_URL` | unset | Attach to an already-running, already-authenticated local browser over the Chrome DevTools Protocol instead of launching a new one. That browser must not be incognito or otherwise ephemeral. Takes priority over the profile directory and storage state. |
| `PLAYWRIGHT_EXECUTABLE_PATH` | unset | Overrides which Chrome/Edge/Chromium executable is launched. Otherwise the runner looks for a system Chrome or Edge install, then falls back to Playwright's own bundled Chromium (installed by `npx playwright install chromium` above). |
| `KIDE_ACCOUNT_USERNAME` / `KIDE_ACCOUNT_PASSWORD` | unset | Optional automated sign-in, instead of signing in by hand. See [Optional: automated sign-in](#optional-automated-sign-in) — read that before using it, since it's a real security tradeoff. |

Never commit `.env` (it's gitignored already) or paste its contents anywhere outside this machine — it can end up holding your Kide session profile path and, if you opt into automated sign-in, your password.

## Current rules

The exact total-price thresholds for four-person variants are:

- €366.00 — Cabin C, 4 people
- €386.00 — Cabin B, 4 people
- €398.00 — Promenade or Cabin A, 4 people

Selecting every matching variant means four separate cabins for 16 people and a €1,548.00 subtotal before service fees. The browser adapter reports this summary and stops before any paid-order confirmation.

The adapter listens only to the Kide product API response for IDs, labels, prices, stock, and quantity limits, then cross-checks availability against the visible ticket rows. It never prints response bodies, cookies, tokens, passwords, OTPs, payment details, or screenshots.

The browser is created through a single `playwright-extra` launcher with `puppeteer-extra-plugin-stealth` registered before any browser or context is opened. This keeps the headless Playwright contexts consistent across regular, persistent-profile, and fixture runs, including webdriver, WebGL/canvas, language, plugin, and related automation evasions. Stealth does not replace authentication: a real visible Kide session is still required.

If the live page reports all nine ticket rows as sold out, using `Loppuun varattu` and `Loppuunmyyty`, the runner recognizes both labels, returns the exact blocker in the structured `reason` field, and makes no cart change.

## How authentication is detected

The runner never trusts the refresh checkbox, cookies, or the absence of a login button as proof of sign-in. It reads the same visible markers a person would check, in this order, and treats a page as authenticated as soon as any one of them is confirmed:

- The literal Finnish log-out text `Kirjaudu ulos`, or `log out`/`sign out`, visible anywhere on the page.
- Kide's own account-menu button in the top-right corner of the header. On kide.app this button is only rendered for a signed-in user (or as a generic mobile navigation toggle at narrow widths — see below), so it is a reliable marker even while its dropdown is closed. Kide only creates that dropdown's contents in the page the first time it is opened, so the closed button is deliberately treated as sufficient on its own; the runner does not click it.
- A "Hei, …" greeting next to an email address, or a "Hei, …" greeting inside the account menu itself (scoped there so unrelated page text can't be mistaken for it).

If none of those are visible, the runner checks for a visible login prompt (`Kirjaudu`, `Kirjaudu sisään`, `login`, `sign in`) to report a clear "not authenticated" reason. If neither an authenticated nor a login marker is visible — for example while Angular is still rendering the header right after a reload — it polls the page for up to 15 seconds before giving up and reporting that authentication could not be verified. It never reloads, fetches another availability snapshot, selects a ticket, or touches the cart while any of this is unresolved.

The account-menu button check only trusts the button at a normal desktop browser width (matching Playwright's default 1280×720 window, which this project never overrides). If the visible Chromium window is resized very narrow — for example snapped to a small fraction of the screen — kide.app itself switches that same button into a generic mobile navigation toggle that appears whether or not you are signed in, so keep the watcher's window at a normal desktop size.

## Optional: automated sign-in

Signing in manually the first time (in [Quick start](#quick-start)) is the default and the safer option, since it never puts your password in a file. If you'd rather not do that by hand, you can instead add your Kide account name and password to `.env`:

```
KIDE_ACCOUNT_USERNAME=you@example.com
KIDE_ACCOUNT_PASSWORD=your-kide-password
```

Both must be set to turn this on; leaving either blank keeps the manual flow. `.env` is gitignored (only the blank `.env.example` is committed), so these values stay on this machine and are never pushed anywhere — but they do sit in plaintext in that file, unlike the default profile, which relies on Chromium's own cookie storage rather than a password the automation itself holds. Weigh that before choosing this over the default.

When both are set, the runner opens the sign-in form once at startup, before the watch loop begins, and only ever fills in those two fields and clicks the one sign-in button — it never touches the Facebook button, "remember me", or anything else in that dialog. It tries this exactly once per run, never inside the polling loop, so a wrong password can't turn into repeated attempts against your account. If Kide shows a Cloudflare challenge inside the sign-in dialog, the runner stops immediately without clicking anything further; it never attempts to solve or bypass that challenge. Either way, whether sign-in worked is still decided the same way as always: by reading the real, visible page afterward (the same checks described above), so a failed or blocked automated attempt just falls back to the usual "authentication could not be verified" reason, and you can sign in by hand instead.

## More about the checkbox

The checkbox is only a start/pause control, not proof of authentication. Its checked and unchecked values are saved immediately in `sessionStorage` under `otacruise.watch.enabled` and restored after a reload. The control is reinstalled if Kide/Angular replaces `document.body`, without creating duplicate controls or handlers, and it is pointer-transparent outside its own checkbox hit area. The runner still verifies the actual visible Kide login state before every reload and cart action, and stops safely if authentication cannot be confirmed, checkbox or not.

## Troubleshooting

- **The process prints JSON immediately and nothing seems to happen.** Read the `reason` field: an authentication blocker means the visible session wasn't verified; `KIDE_WATCH_FOREVER=false` intentionally stops after one pass if nothing matched; everything sold out is reported explicitly.
- **The checkbox is missing.** Confirm the browser is on the configured HTTPS `kide.app/fi/events/<event-id>` page and wait for the page body to finish rendering. The control is recreated after full reloads and Angular body replacements. Reset a stuck profile by deleting the gitignored `.local/kide-profile` directory, then sign in again in the visible browser.
- **The checkbox is there but unchecked.** That's the safe default. Click it — its visual state and `sessionStorage` value change immediately. Leave it unchecked to pause.
- **"Authentication is missing or unclear" while you're actually signed in.** Don't try to bypass this — confirm you signed in inside the same browser/profile the watcher is using, and wait for Kide to show a visible account/logout/profile marker (the runner already allows Angular up to 15 seconds for this). If you can see a greeting, an email, and "Kirjaudu ulos" in the account menu but still get this, check the size of the visible Chromium window: the account-menu icon is only trusted as proof of sign-in at a normal desktop width, and a window resized or snapped very narrow makes kide.app switch that same icon into a generic mobile menu toggle. The default launch never shrinks the window, so this only matters if you resized it yourself.
- **It keeps reloading and I want it to stop.** Uncheck the box to pause before the next reload, snapshot interpretation, selection, or cart action, or `Ctrl+C` the process. The watcher also stops reloading on its own as soon as a matching four-person ticket is found, so it can verify and add that snapshot to the cart.
- **The runner never opens checkout or clicks the final payment button.** That's by design — placing the order is a manual step. The fixture suite also asserts four cart rows, 16 people, and €1,548 before fees without ever reaching payment.

## Development

```powershell
npm run typecheck
npm run lint
npm test
npm run browser-test
```

`npm test` runs the full suite (unit tests plus real-browser fixture tests, headless). `npm run browser-test` runs just the browser-based suite. Both use only temporary browser profiles and local, deterministic fixtures — never `.local/kide-profile` or the real Kide site.

For a visible deterministic browser demonstration that uses only a temporary fixture and no real profile, run:

```powershell
npm run browser-fixture:headed
```
