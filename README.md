# Otacruise ticket automation

Local TypeScript/Playwright automation for inspecting the Otacruise Kide.app event and preparing the four-person cabin variants.

## Current rules

The exact total-price thresholds for four-person variants are:

- €366.00 — Cabin C, 4 people
- €386.00 — Cabin B, 4 people
- €398.00 — Promenade or Cabin A, 4 people

Selecting every matching variant means four separate cabins for 16 people and a €1,548.00 subtotal before service fees. The browser adapter reports this summary and stops before any paid-order confirmation.

The adapter listens only to the Kide product API response for IDs, labels, prices, stock, and quantity limits, then cross-checks availability against the visible ticket rows. It never prints response bodies, cookies, tokens, passwords, OTPs, payment details, or screenshots.

The live page currently reports all nine ticket rows as sold out, using `Loppuun varattu` and `Loppuunmyyty`. The runner recognizes both live labels, returns the blocker in the structured `reason` field, and makes no cart change.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run typecheck
npm run lint
npm test
npm run browser-test
```

Authentication remains local. By default, the runner uses the persistent Chromium profile `.local/kide-profile`, which keeps the browser’s session cookies and local storage on this machine for future runs. The directory is gitignored, and the automation never extracts, prints, uploads, or commits those values. On the first run, sign in in the visible browser; later runs reuse that local session. Delete `.local/kide-profile` when you intentionally want to sign out and reset the session. A `KIDE_CDP_URL` uses the attached browser’s own profile instead, and `KIDE_STORAGE_STATE` is an optional local alternative. Never commit tokens, cookies, passwords, OTPs, or payment data.

The default mode keeps the visible browser open and refreshes the event page every 3 seconds until availability appears. It verifies that the visible Kide session is authenticated before the first watch cycle and immediately before every reload. If the session is logged out or cannot be verified, it stops without refreshing or touching the cart. It verifies the matching variants before the next reload, so it does not reload after a target ticket is found. It then adds the variants to the cart. Use `DRY_RUN=true` for a non-mutating check. The implementation stops before checkout/payment and avoids clicking an already-reserved row because Kide uses that click to cancel/edit the reservation. Press `Ctrl+C` to stop the watcher.

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

```powershell
cd C:\Users\Thien\Documents\Codex\2026-09-21\cr

$env:DRY_RUN="false"
$env:KIDE_WATCH_FOREVER="true"
$env:KIDE_KEEP_BROWSER_OPEN="true"
$env:KIDE_POLL_INTERVAL_MS="3000"
$env:HEADLESS="false"

npm run dev
```

The browser checks the visible login state before refreshing every three seconds. It stops with an authentication blocker if you are logged out or the state is unclear. Once a matching ticket is found, it adds it to the cart and remains open. Press `Ctrl+C` to stop the watcher.

### If the page appears stuck

Keep the terminal running `npm run dev` open. With `KIDE_WATCH_FOREVER=true`, a sold-out page is reloaded every 3 seconds; the browser-test suite verifies this polling behavior. If the process prints JSON immediately, read the `reason`: an authentication blocker means the session was not visibly verified, while `KIDE_WATCH_FOREVER=false` intentionally stops after the first sold-out check. The watcher also stops reloading as soon as a matching four-person ticket is found so it can verify and add that snapshot to the cart.
