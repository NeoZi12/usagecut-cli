// The MEASURED wrapper around the pure trim rules.
//
// The actual transforms live in rules.mjs (pure, zero-import, inlined into the
// live hook). This file adds token measurement on top, for the replay engine
// and the unit tests. Keep `trimToolOutput` and `trimText` stable - the replay
// (replay.mjs) imports them to compute the exact saved-token number we show.
//
// Cross-call concerns (deduping a re-read of an unchanged file, stashing the
// original for recovery) live in the hook wrapper + stash.mjs, not here. This
// file is the within-output transform, fully unit-testable on its own.

import { estimateTokens } from "../../tokens.mjs";
import {
  stripAnsi,
  collapseRepeats,
  collapseBlankRuns,
  applyTrim,
} from "./rules.mjs";

// Re-export the pure floor transforms so existing callers/tests keep working.
export { stripAnsi, collapseRepeats, collapseBlankRuns };

// The lossless floor only (ANSI strip + identical-line + blank-run collapse),
// measured. Kept for back-compat; `opts` can disable individual passes.
export function trimText(text, opts = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", before: 0, after: 0, saved: 0, changed: false };
  }
  const before = estimateTokens(text);
  let out = text;
  if (opts.ansi !== false) out = stripAnsi(out);
  if (opts.repeats !== false) out = collapseRepeats(out, opts.minRepeat ?? 3);
  if (opts.blanks !== false) out = collapseBlankRuns(out, opts.minBlank ?? 4);
  const after = estimateTokens(out);
  return { text: out, before, after, saved: Math.max(0, before - after), changed: out !== text };
}

// The FULL trim (lossless floor + one structure-aware lossy rule), measured.
// This is what the live hook applies and what the replay measures, so the
// number we show the user is the exact number the hook would have produced.
export function trimToolOutput(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", before: 0, after: 0, saved: 0, changed: false };
  }
  const before = estimateTokens(text);
  const out = applyTrim(text);
  const after = estimateTokens(out);
  return { text: out, before, after, saved: Math.max(0, before - after), changed: out !== text };
}
