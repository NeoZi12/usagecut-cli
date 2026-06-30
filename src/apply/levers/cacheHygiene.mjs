// Bonus lever: cache hygiene (lossless).
//
// The whole spend story is cache: ~94% of billed tokens are cache reads and
// ~80% of cost is input-side (see docs/usagecut-model-router-plan.md). Anything
// that protects the cache pays back far more than trimming output ever could.
// This lever does two strictly-lossless, observe-or-protect-only things:
//
//  1. Turn on the 1-hour prompt cache TTL (ENABLE_PROMPT_CACHING_1H=1) so a
//     thread that idles past the default 5-minute window does not pay a full
//     uncached re-read on the next turn. Pure win, no behavior change.
//  2. Install a cache-health statusline (cachewatch.mjs) so the user can SEE
//     their cache_read vs cache_creation ratio live. We only install it when
//     the user has no statusLine configured - never clobber an existing one.
//
// Settings writes are emitted declaratively as settingsMutations; the runtime
// statusline SCRIPT goes into ~/.usagecut (a dir we own) via safeWrite.

import os from "node:os";
import path from "node:path";
import { CLAUDE_DIR, readFileSafe } from "../../discover.mjs";
import { USAGECUT_DIR } from "../manifest.mjs";
import { safeWrite } from "../atomic.mjs";

const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const CACHE_ENV = "ENABLE_PROMPT_CACHING_1H";

// Self-contained Claude Code statusLine script. Reads the statusLine input JSON
// from stdin, finds the transcript, and prints a one-line cache-health summary.
// Observe-only: any failure prints a static reminder and exits 0, never errors.
function cachewatchSource() {
  return `#!/usr/bin/env node
// UsageCut cachewatch - observe-only cache-health statusline.
// Input: Claude Code statusLine JSON on stdin (has .transcript_path).
// Output: one line. Never throws, never exits non-zero.
import fs from "node:fs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    input = {};
  }
  const transcript = input.transcript_path || input.transcriptPath || null;
  const fallback = "cache: protecting your thread (1h TTL on)";
  if (!transcript) {
    process.stdout.write(fallback + "\\n");
    return;
  }
  let read = 0;
  let creation = 0;
  try {
    const text = fs.readFileSync(transcript, "utf8");
    const lines = text.split("\\n");
    for (const line of lines) {
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const u =
        (obj && obj.message && obj.message.usage) ||
        (obj && obj.usage) ||
        null;
      if (!u || typeof u !== "object") continue;
      if (typeof u.cache_read_input_tokens === "number") {
        read += u.cache_read_input_tokens;
      }
      if (typeof u.cache_creation_input_tokens === "number") {
        creation += u.cache_creation_input_tokens;
      }
    }
  } catch {
    process.stdout.write(fallback + "\\n");
    return;
  }
  const total = read + creation;
  if (total <= 0) {
    process.stdout.write(fallback + "\\n");
    return;
  }
  const hitPct = Math.round((read / total) * 100);
  const health = hitPct >= 85 ? "healthy" : hitPct >= 60 ? "ok" : "churning";
  process.stdout.write(
    "cache " + hitPct + "% hit (" + health + ") - read " + read + " / new " + creation + "\\n"
  );
}

main();
`;
}

// opts.home lets the self-test point HOME elsewhere; defaults to the real home.
export function planCacheHygiene(opts = {}) {
  const home = opts.home || os.homedir();
  const settingsPath = opts.settingsPath || SETTINGS;
  const usagecutDir = opts.usagecutDir || USAGECUT_DIR;

  const changes = [];
  const settingsMutations = [];
  const items = [];
  const advisories = [];

  // Read existing settings (do not clobber a malformed file).
  const before = readFileSafe(settingsPath);
  let settings = {};
  let readable = true;
  if (before) {
    try {
      settings = JSON.parse(before);
    } catch {
      readable = false;
    }
  }

  // 1. Enable the 1-hour cache TTL only if it is not already set to "1".
  const curEnv = (settings.env || {})[CACHE_ENV];
  if (curEnv !== "1") {
    settingsMutations.push({ op: "ensureEnv", key: CACHE_ENV, value: "1" });
    items.push({
      kind: "env",
      key: CACHE_ENV,
      detail: "1-hour prompt cache TTL - idle threads avoid a full uncached re-read",
    });
  } else {
    advisories.push(`${CACHE_ENV} is already on - 1-hour cache TTL active.`);
  }

  // 2. Statusline: install ours only when none exists. Never clobber.
  const hasStatusLine =
    readable &&
    settings.statusLine !== undefined &&
    settings.statusLine !== null &&
    !(typeof settings.statusLine === "object" && Object.keys(settings.statusLine).length === 0);

  if (!readable) {
    advisories.push(
      "settings.json is unreadable - leaving statusLine untouched. Fix the JSON, then re-run to add the cache-health statusline."
    );
  } else if (hasStatusLine) {
    advisories.push(
      "You already have a statusLine - leaving it as-is. To see live cache health, you can swap in: node " +
        path.join(home, ".usagecut", "cachewatch.mjs")
    );
  } else {
    const scriptPath = path.join(usagecutDir, "cachewatch.mjs");
    safeWrite(scriptPath, cachewatchSource());
    settingsMutations.push({
      op: "ensureStatusLine",
      command: `node ${scriptPath}`,
    });
    items.push({
      kind: "statusline",
      key: "cachewatch",
      detail: "live cache_read vs cache_creation ratio in your statusline (observe-only)",
    });
  }

  return { changes, settingsMutations, items, advisories };
}
