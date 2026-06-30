// `usagecut revert` - restore the most recent apply (or a specific backup) from
// its manifest. All-or-nothing, exact bytes.

import { listManifests, restore } from "./manifest.mjs";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[38;5;107m";

function out(s) {
  process.stdout.write(s + "\n");
}

export function runRevert(opts = {}) {
  const manifests = listManifests();

  if (opts.list) {
    if (!manifests.length) {
      out("  No backups yet.");
      return;
    }
    out("");
    out(`  ${BOLD}UsageCut backups${RESET} ${DIM}(newest first)${RESET}`);
    manifests.forEach((s, i) => out(`    ${i === 0 ? `${GREEN}*${RESET}` : " "} ${s}`));
    out("");
    return;
  }

  if (!manifests.length) {
    out("  Nothing to revert.");
    return;
  }

  const stamp = opts.id || manifests[0];
  const { restored } = restore(stamp);
  out("");
  out(`  ${GREEN}Reverted${RESET} ${restored.length} file(s) from ${DIM}${stamp}${RESET}.`);
  out(`  ${DIM}Restart Claude Code sessions to pick up the restored config.${RESET}`);
  out("");
}
