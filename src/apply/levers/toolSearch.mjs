// Lever (c): make sure deferred MCP tool loading ("tool search") is on.
//
// Tool search is default-on in current Claude Code, so for almost everyone this
// is a no-op we REPORT as already-good, not a fabricated win. The only real fix
// is when the user explicitly turned it off in ~/.claude/settings.json env.
//
// NOTE: the exact env var name is to be pinned by `usagecut probe` (PR1). Since
// the default path is a no-op, acting wrongly here is low-risk.

import path from "node:path";
import { CLAUDE_DIR, readFileSafe } from "../../discover.mjs";

const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const VAR = "ENABLE_TOOL_SEARCH";

export function planToolSearch() {
  const before = readFileSafe(SETTINGS);
  if (!before) return { alreadyOptimal: true, note: "deferred loading is on by default" };

  let obj;
  try {
    obj = JSON.parse(before);
  } catch {
    return { alreadyOptimal: true, note: "settings.json is unreadable, leaving it untouched" };
  }

  const v = (obj.env || {})[VAR];
  const disabled = v === "0" || v === "false" || v === false;
  if (!disabled) return { alreadyOptimal: true, note: "deferred loading is on (default)" };

  const obj2 = JSON.parse(before);
  delete obj2.env[VAR];
  if (obj2.env && Object.keys(obj2.env).length === 0) delete obj2.env;
  const after = JSON.stringify(obj2, null, 2) + "\n";
  return {
    alreadyOptimal: false,
    change: {
      file: SETTINGS,
      before,
      after,
      note: "Re-enable deferred tool loading (it was explicitly disabled)",
    },
  };
}
