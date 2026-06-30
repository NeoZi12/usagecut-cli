// `usagecut status` - a quick read on the local optimize state: whether the
// live trimmer hook is installed and active (vs observe-only), the stash size,
// and the most recent backup.

import fs from "node:fs";
import path from "node:path";
import { USAGECUT_DIR, listManifests } from "./manifest.mjs";
import { CLAUDE_DIR, readFileSafe } from "../discover.mjs";
import { readProbe } from "./trim/probe.mjs";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[38;5;107m";
const CLAY = "\x1b[38;5;173m";

function out(s) {
  process.stdout.write(s + "\n");
}

function stashSize() {
  try {
    const dir = path.join(USAGECUT_DIR, "stash");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"));
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += fs.statSync(path.join(dir, f)).size;
      } catch {
        /* ignore */
      }
    }
    return { count: files.length, kb: Math.round(bytes / 1024) };
  } catch {
    return { count: 0, kb: 0 };
  }
}

export function runStatus() {
  const settings = readFileSafe(path.join(CLAUDE_DIR, "settings.json")) || "";
  const installed = settings.includes(".usagecut/trim.mjs") || (/usagecut/.test(settings) && /PostToolUse/.test(settings));
  const probe = readProbe();
  const active = installed && probe && probe.emitShape && probe.emitShape !== "observe";
  const manifests = listManifests();
  const stash = stashSize();

  out("");
  out(`  ${BOLD}UsageCut status${RESET}`);
  out(`  cost:              ${DIM}free - scan and every fix${RESET}`);
  if (!installed) {
    out(`  live trimmer:      ${DIM}not installed${RESET}`);
  } else if (active) {
    out(`  live trimmer:      ${GREEN}active${RESET} ${DIM}(Claude Code ${probe.ccVersion || "?"}, ${probe.emitShape})${RESET}`);
  } else {
    out(`  live trimmer:      ${CLAY}observe-only${RESET} ${DIM}(run usagecut probe to confirm the output hook)${RESET}`);
  }
  out(`  recovery stash:    ${DIM}${stash.count} item(s), ${stash.kb} KB${RESET}`);
  out(`  last apply backup: ${manifests.length ? manifests[0] : `${DIM}none${RESET}`}`);
  out(`  backups dir:       ${DIM}${path.join(USAGECUT_DIR, "backups")}${RESET}`);
  out("");
}
