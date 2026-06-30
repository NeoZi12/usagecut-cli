// Bonus lever: terse output style (opt-in, OFF by default).
//
// Output tokens are a small slice of spend (~0.8% of billed tokens; see
// docs/usagecut-model-router-plan.md), so this is a minor, comfort lever, not a
// moat. It writes a disciplined-concision output style to
// ~/.claude/output-styles/uc-terse.md that drops filler and pleasantries while
// keeping code, paths, and errors verbatim - and explicitly falls back to full
// prose for security warnings and multi-step sequences. It is NOT a "caveman"
// style; it just stops padding.
//
// It is INACTIVE on disk: writing the file does NOT make it the active output
// style. The user opts in with `/output-style uc-terse`. And we only WRITE the
// file when the caller passes opts.optIn (an --terse flag); otherwise we just
// advertise it.

import path from "node:path";
import { CLAUDE_DIR, readFileSafe } from "../../discover.mjs";

const STYLE_NAME = "uc-terse";

// Output styles use the same Claude Code frontmatter convention (name +
// description), then a markdown body that replaces the default style guidance.
function styleSource() {
  return `---
name: UsageCut Terse
description: Disciplined concision - drops filler and pleasantries, keeps code/paths/errors verbatim, falls back to full prose for security warnings and multi-step work.
---

You are Claude Code operating in a disciplined-concise output style. The goal is to save the reader's time and tokens WITHOUT losing any information they need. This is concision, not terseness for its own sake - never drop a fact to be brief.

Default behavior:

- Lead with the answer or the result. No preamble ("Great question", "Sure, let me", "I'll now"), no postamble ("Let me know if", "Hope this helps").
- Drop pleasantries, hedging, and self-narration. Do not announce what you are about to do unless the user needs the plan first.
- Prefer tight sentences and short lists over paragraphs. One idea per line.
- Quote code, file paths, commands, identifiers, error messages, and shell output VERBATIM. Never paraphrase or truncate these to save space - they are the payload.
- When you make a change, state what changed and where (file and line) in one line each. Skip restating code you just wrote unless asked.
- Answer only what was asked. Do not volunteer adjacent tangents.

Always fall back to FULL prose (clarity wins over brevity) when:

- You are warning about a security, data-loss, destructive, or irreversible action - explain the risk fully.
- You are walking through a multi-step sequence the user must follow in order - number the steps and keep each one complete.
- The user explicitly asks for detail, an explanation, or your reasoning.
- A subtle correctness caveat or edge case matters - state it plainly even if it costs words.

Never sacrifice correctness, completeness of required facts, or safety to be brief.
`;
}

// opts.optIn (the --terse flag) gates whether the file is written at all.
// opts.stylesDir lets the self-test point HOME elsewhere.
export function planTerseOutput(opts = {}) {
  const stylesDir = opts.stylesDir || path.join(CLAUDE_DIR, "output-styles");
  const file = path.join(stylesDir, `${STYLE_NAME}.md`);

  const changes = [];
  const items = [];
  const advisories = [];

  if (!opts.optIn) {
    advisories.push(
      `A terse output style is available but OFF by default. Re-run with --terse to install it, then activate it yourself with \`/output-style ${STYLE_NAME}\`.`
    );
    return { changes, items, advisories };
  }

  const after = styleSource();
  const before = readFileSafe(file);
  if (before === after) {
    advisories.push(
      `Terse output style already installed. It stays INACTIVE until you run \`/output-style ${STYLE_NAME}\`.`
    );
    return { changes, items, advisories };
  }

  changes.push({ file, before: before ?? null, after });
  items.push({
    kind: "output-style",
    name: STYLE_NAME,
    detail: "disciplined-concision output style (inactive until you opt in)",
  });
  advisories.push(
    `Installed but INACTIVE. Activate it yourself with \`/output-style ${STYLE_NAME}\`. It keeps code, paths, and errors verbatim and falls back to full prose for security warnings and multi-step work.`
  );

  return { changes, items, advisories };
}
