// Build the terminal teaser. The full, value-framed report lives on the web;
// the terminal shows just enough to make the user click through.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CLAY = "\x1b[38;5;173m";
const GREEN = "\x1b[38;5;107m";

function n(x) {
  return Number(x).toLocaleString("en-US");
}

export function terminalTeaser(payload, url) {
  const d = payload.derived;
  const lines = [];
  lines.push("");
  lines.push(`  ${BOLD}UsageCut${RESET} ${DIM}- scan complete${RESET}`);
  lines.push(
    `  ${DIM}${n(payload.sessions)} sessions analyzed, locally on your machine${RESET}`
  );
  lines.push("");
  lines.push(
    `  Current usage:   ${BOLD}${n(payload.now.tokensPerSession)}${RESET} tokens / session`
  );
  lines.push(
    `  Recoverable:     ${CLAY}${BOLD}-${d.overallPct}%${RESET}  ${DIM}(~${n(
      d.savedPerSession
    )} tokens / session)${RESET}`
  );
  lines.push("");
  lines.push(`  ${GREEN}Your full report:${RESET}`);
  lines.push(`  ${BOLD}${url}${RESET}`);
  lines.push("");
  return lines.join("\n");
}
