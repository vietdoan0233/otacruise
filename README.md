# Otacruise ticket automation

Local TypeScript/Playwright automation for inspecting the Otacruise Kide.app event and preparing the four-person cabin variants.

## Current rules

The exact total-price thresholds for four-person variants are:

- €366.00 — Cabin C, 4 people
- €386.00 — Cabin B, 4 people
- €398.00 — Promenade or Cabin A, 4 people

Selecting every matching variant means four separate cabins for 16 people and a €1,548.00 subtotal before service fees. The browser adapter reports this summary and stops before any paid-order confirmation.

The adapter listens only to the Kide product API response for IDs, labels, prices, stock, and quantity limits, then cross-checks availability against the visible ticket rows. It never prints response bodies, cookies, tokens, passwords, OTPs, payment details, or screenshots.

The browser is created through a single `playwright-extra` launcher with `puppeteer-extra-plugin-stealth` registered before any browser or context is opened. This keeps the headless Playwright contexts consistent across regular, persistent-profile, and fixture runs, including webdriver, WebGL/canvas, language, plugin, and related automation evasions. Stealth does not replace authentication: a real visible Kide session is still required.

If the live page reports all nine ticket rows as sold out, using `Loppuun varattu` and `Loppuunmyyty`, the runner recognizes both labels, returns the exact blocker in the structured `reason` field, and makes no cart change.

## Get the repository

Anyone with Git and Node.js can install it in their own directory:

```powershell
git clone https://github.com/vietdoan0233/otacruise.git
Set-Location .\otacruise
```

The commands below assume the terminal is inside the cloned `otacruise` directory. No user-specific path is required.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run browser-test
```

Authentication remains local. By default, the runner uses the persistent Chromium profile `.local/kide-profile`, which keeps the browser’s session cookies and local storage on this machine for future runs. The directory is gitignored, and the automation never extracts, prints, uploads, or commits those values. On the first run, sign in in the visible browser; later runs reuse that local session. Delete `.local/kide-profile` when you intentionally want to sign out and reset the session. A `KIDE_CDP_URL` uses the attached browser’s own profile instead, and `KIDE_STORAGE_STATE` is an optional local alternative. Never commit tokens, cookies, passwords, OTPs, or payment data.

## Start the watcher

Run `npm run dev` with `HEADLESS=false`. After the Kide event page loads, a visible top-left checkbox labeled exactly `I’m logged in — enable refresh` appears. It starts unchecked:

1. Sign in manually in that browser if the session is not already authenticated.
2. Confirm the Kide account is visible, then turn the checkbox on.
3. Leave it on while you want one-second availability polling.
4. Turn it off to pause before the next reload or availability interpretation; turn it back on to resume.

The checkbox is only a start/pause control. Its checked and unchecked values are saved immediately in `sessionStorage` under `otacruise.watch.enabled` and restored after a reload. The control is reinstalled if Kide/Angular replaces `document.body`, without creating duplicate controls or handlers, and it is pointer-transparent outside its own checkbox hit area. The automation still verifies the actual visible Kide login state before every reload and cart action, and stops safely if authentication cannot be confirmed. If it reports an authentication blocker, fix the session in the visible browser and run `npm run dev` again.

The default mode keeps the visible browser open, verifies the matching variants before each cart action, and stops before checkout/payment. Use `DRY_RUN=true` for a non-mutating check. The implementation avoids clicking an already-reserved row because Kide uses that click to cancel/edit the reservation. Press `Ctrl+C` to stop the watcher.

The command emits only this JSON shape on stdout:

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

Run the watcher with `npm run dev`. The default `.local/kide-profile` session is reused automatically. Configure `KIDE_CDP_URL` only when you want to attach to an already-authenticated local browser; that browser must not be incognito or otherwise ephemeral. `KIDE_PROFILE_DIR` can point to another ignored local profile, while `KIDE_STORAGE_STATE` is an alternative local session-state file. Never place a credential-bearing URL in logs or prompts. The final paid order remains a manual action.

### Run the watcher from PowerShell

Use this complete block in the same PowerShell window where you start the watcher. The checkbox starts unchecked; checking it enables the loop. `KIDE_WATCH_FOREVER="true"` is what keeps checking sold-out responses, and `KIDE_POLL_INTERVAL_MS="1000"` sets the minimum one-second interval. These settings are already included below—do not add a second copy elsewhere.

```powershell
$env:DRY_RUN="false"
$env:KIDE_WATCH_FOREVER="true"
$env:KIDE_KEEP_BROWSER_OPEN="true"
$env:KIDE_POLL_INTERVAL_MS="1000"
$env:HEADLESS="false"

npm run dev
```

The browser checks the visible login state before each refresh. After a reload, it allows Kide/Angular up to 15 seconds to render a definitive account marker; it still fails closed if authentication remains unclear. With the block above, a sold-out response is followed by another reload every second until you pause the checkbox, stop the process, authentication becomes unclear, or a matching ticket is found. Once a matching ticket is found, it adds it to the cart and remains open. Press `Ctrl+C` to stop the watcher. If it refreshes once and then stops, read the JSON `reason` printed by the process; `KIDE_WATCH_FOREVER="false"`, an authentication blocker, or a matching ticket are the expected explanations.

### If the page appears stuck

Keep the terminal running `npm run dev` open. Turn on the top-left refresh checkbox after confirming you are logged in. With `KIDE_WATCH_FOREVER=true`, a sold-out page is reloaded every second; turning the checkbox off prevents the next reload, API snapshot interpretation, selection, or cart action. If the process prints JSON immediately, read the `reason`: an authentication blocker means the session was not visibly verified, while `KIDE_WATCH_FOREVER=false` intentionally stops after the first sold-out check. The watcher also stops reloading as soon as a matching four-person ticket is found so it can verify and add that snapshot to the cart.

### Troubleshooting the checkbox or authentication

- If the checkbox is missing, confirm the browser is on the configured HTTPS `kide.app/fi/events/<event-id>` page and wait for the page body to finish rendering. The control is recreated after full reloads and Angular body replacements. A temporary profile can be reset by deleting the ignored `.local/kide-profile` directory, then signing in again in the visible browser.
- If it appears but is unchecked, that is the safe default. Click the checkbox itself; its visual state and `sessionStorage` value change immediately. Leave it unchecked to pause.
- If the output says authentication is missing or unclear, do not try to bypass the blocker. Confirm you signed in inside the browser/profile used by the watcher, wait for Kide to show a visible account/logout/profile marker, then rerun. The watcher allows Angular up to 15 seconds to render that marker, but the checkbox never counts as proof of authentication.
- The runner never opens checkout or clicks the final payment action. The fixture suite also asserts four cart rows, 16 people, and €1,548 before fees without reaching payment.

For a visible deterministic browser demonstration that uses only a temporary fixture and no real profile, run:

```powershell
npm run browser-fixture:headed
```
