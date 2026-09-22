import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_EVENT_URL,
  emptyOutput,
  runKideAutomation,
} from "./kide.js";
import type { AutomationOutput } from "./types.js";

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function integerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Kide automation failed unexpectedly.";
  return message.replace(
    /((?:token|cookie|auth|session|password|otp|secret|payment|card)[=:])[^\s&]+/gi,
    "$1[redacted]",
  );
}

function loadLocalEnvironment(): void {
  const envPath = resolve(".env");
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnvironment();

const storageStatePath = process.env.KIDE_STORAGE_STATE;
const configuredProfileDir = process.env.KIDE_PROFILE_DIR?.trim();
const profileDir = configuredProfileDir ||
  (storageStatePath ? undefined : resolve(".local/kide-profile"));

// Optional one-time automated sign-in; both must be set to attempt it. See
// attemptCredentialLogin() in kide.ts for exactly what this does and does
// not do. Leaving either unset (the default) keeps signing in manually in
// the visible browser instead.
const accountUsername = process.env.KIDE_ACCOUNT_USERNAME?.trim() || undefined;
const accountPassword = process.env.KIDE_ACCOUNT_PASSWORD || undefined;

let output: AutomationOutput;
try {
  output = await runKideAutomation({
    eventUrl: process.env.KIDE_EVENT_URL ?? DEFAULT_EVENT_URL,
    cdpUrl: process.env.KIDE_CDP_URL,
    profileDir,
    storageStatePath,
    headless: booleanEnvironment("HEADLESS", false),
    dryRun: booleanEnvironment("DRY_RUN", false),
    watchForever: booleanEnvironment("KIDE_WATCH_FOREVER", true),
    keepBrowserOpen: booleanEnvironment("KIDE_KEEP_BROWSER_OPEN", true),
    maxWaitMs: integerEnvironment("KIDE_MAX_WAIT_MS", 30 * 60 * 1000),
    pollIntervalMs: integerEnvironment("KIDE_POLL_INTERVAL_MS", 1_000),
    accountUsername,
    accountPassword,
  });
} catch (error) {
  output = emptyOutput(errorReason(error));
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
