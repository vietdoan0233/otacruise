# Otacruise ticket automation

Local TypeScript/Playwright automation for inspecting the Otacruise Kide.app event and preparing the four-person cabin variants.

## Current rules

The exact total-price thresholds for four-person variants are:

- €366.00 — Cabin C, 4 people
- €386.00 — Cabin B, 4 people
- €398.00 — Promenade or Cabin A, 4 people

Selecting every matching variant means four separate cabins for 16 people and a €1,548.00 subtotal before service fees. The browser adapter reports this summary and stops before any paid-order confirmation.

The adapter listens only to the Kide product API response for IDs, labels, prices, stock, and quantity limits, then cross-checks availability against the visible ticket rows. It never prints response bodies, cookies, tokens, passwords, OTPs, payment details, or screenshots.

The live page currently reports every one of the nine ticket rows as `Loppuun varattu` (sold out). The runner returns that exact blocker in the structured `reason` field and makes no cart change.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run typecheck
npm run lint
npm test
npm run browser-test
```

Authentication remains local to a CDP-connected browser, persistent profile, or ignored storage state. Do not commit tokens, cookies, passwords, OTPs, or payment data.

The default mode keeps the visible browser open and refreshes the event page every 3 seconds until availability appears. It verifies the matching variants before the next reload, so it does not reload after a target ticket is found. It then adds the variants to the cart. Use `DRY_RUN=true` for a non-mutating check. The implementation stops before checkout/payment and avoids clicking an already-reserved row because Kide uses that click to cancel/edit the reservation. Press `Ctrl+C` to stop the watcher.

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

Run the watcher with `npm run dev`. Configure `KIDE_CDP_URL` to attach to an already-authenticated local browser, or use `KIDE_PROFILE_DIR`/`KIDE_STORAGE_STATE` for an ignored local session store. Never place a credential-bearing URL in logs or prompts. The final paid order remains a manual action.
