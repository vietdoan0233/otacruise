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

## How authentication is detected

The runner never trusts the refresh checkbox, cookies, or the absence of a login button as proof of sign-in. It reads the same visible markers a person would check, in this order, and treats a page as authenticated as soon as any one of them is confirmed:

- The literal Finnish log-out text `Kirjaudu ulos`, or `log out`/`sign out`, visible anywhere on the page.
- Kide's own account-menu button in the top-right corner of the header. On kide.app this button is only rendered for a signed-in user (or as a generic mobile navigation toggle at narrow widths — see below), so it is a reliable marker even while its dropdown is closed. Kide only creates that dropdown's contents in the page the first time it is opened, so the closed button is deliberately treated as sufficient on its own; the runner does not click it.
- A "Hei, …" greeting next to an email address, or a "Hei, …" greeting inside the account menu itself (scoped there so unrelated page text can't be mistaken for it).

If none of those are visible, the runner checks for a visible login prompt (`Kirjaudu`, `Kirjaudu sisään`, `login`, `sign in`) to report a clear "not authenticated" reason. If neither an authenticated nor a login marker is visible — for example while Angular is still rendering the header right after a reload — it polls the page for up to 15 seconds before giving up and reporting that authentication could not be verified. It never reloads, fetches another availability snapshot, selects a ticket, or touches the cart while any of this is unresolved.

The account-menu button check only trusts the button at a normal desktop browser width (matching Playwright's default 1280×720 window, which this project never overrides). If the visible Chromium window is resized very narrow — for example snapped to a small fraction of the screen — kide.app itself switches that same button into a generic mobile navigation toggle that appears whether or not you are signed in, so keep the watcher's window at a normal desktop size.

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

### Optional: automated sign-in

Signing in manually the first time (above) is the default and the safer option, since it never puts your password in a file. If you'd rather not do that by hand, you can instead add your Kide account name and password to `.env`:

```
KIDE_ACCOUNT_USERNAME=you@example.com
KIDE_ACCOUNT_PASSWORD=your-kide-password
```

Both must be set to turn this on; leaving either blank keeps the manual flow. `.env` is gitignored (only the blank `.env.example` is committed), so these values stay on this machine and are never pushed anywhere — but they do sit in plaintext in that file, unlike the default profile, which relies on Chromium's own cookie storage rather than a password the automation itself holds. Weigh that before choosing this over the default.

When both are set, the runner opens the sign-in form once at startup, before the watch loop begins, and only ever fills in those two fields and clicks the one sign-in button — it never touches the Facebook button, "remember me", or anything else in that dialog. It tries this exactly once per run, never inside the polling loop, so a wrong password can't turn into repeated attempts against your account. If Kide shows a Cloudflare challenge inside the sign-in dialog, the runner stops immediately without clicking anything further; it never attempts to solve or bypass that challenge. Either way, whether sign-in worked is still decided the same way as always: by reading the real, visible page afterward (the same checks described above), so a failed or blocked automated attempt just falls back to the usual "authentication could not be verified" reason, and you can sign in by hand instead.

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
- If you are visibly signed in (the account menu shows a greeting, an email, and "Kirjaudu ulos") but still see this blocker, check the size of the visible Chromium window. The runner recognizes Kide's account-menu button even while its dropdown is closed, but only at a normal desktop width; a window resized or snapped very narrow makes kide.app itself switch that button into a generic mobile menu toggle that no longer proves you are signed in. Restore the window to a normal desktop size and rerun — the default launch never shrinks it, so this only matters if you resized it yourself.
- The runner never opens checkout or clicks the final payment action. The fixture suite also asserts four cart rows, 16 people, and €1,548 before fees without reaching payment.

For a visible deterministic browser demonstration that uses only a temporary fixture and no real profile, run:

```powershell
npm run browser-fixture:headed
```
