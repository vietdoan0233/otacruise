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

const storageStatePath = process.env.KIDE_STORAGE_STATE;
const profileDir = process.env.KIDE_PROFILE_DIR ??
  (storageStatePath ? undefined : resolve(".local/kide-profile"));

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
    pollIntervalMs: integerEnvironment("KIDE_POLL_INTERVAL_MS", 10_000),
  });
} catch (error) {
  output = emptyOutput(errorReason(error));
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
