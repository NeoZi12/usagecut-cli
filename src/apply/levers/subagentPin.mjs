// Bonus lever: subagent model pinning.
//
// The one automatic, cache-safe, net-positive routing lever (see
// docs/usagecut-model-router-plan.md): instead of flipping the main Opus loop's
// model per turn (impossible without a proxy, and unprofitable because of the
// cache re-read penalty), we give the main Opus agent cheaper-model subagents to
// delegate mechanical work to. Each subagent runs in ITS OWN cache, so the
// parent Opus thread is never disturbed, and Opus ratifies every diff before it
// lands. Savings envelope is honestly single digits to ~10-15% of spend,
// concentrated in delegation-heavy users and largest for legacy-Opus users.
//
// These are NORMAL new-file changes under ~/.claude/agents/ ({file, before:null,
// after:content}), NOT settings mutations.

import path from "node:path";
import { CLAUDE_DIR, readFileSafe } from "../../discover.mjs";

// Bodies share these guardrails verbatim so the rules can never drift apart.
const SAFETY = `Hard rules (never break these):
- Stay strictly in the scope you were handed. Do not refactor, rename, or "improve" anything you were not asked to touch.
- NEVER touch authentication, crypto, secrets, payments, billing, database migrations, or schema changes. If the task drifts into any of these, stop and hand back to the Opus parent with a one-line reason.
- Make the smallest change that satisfies the task. No drive-by edits.
- Return a tight summary: what you changed, which files, and anything you were unsure about. Do not narrate.
- The Opus parent ratifies every diff you produce before it lands. Your job is to do the mechanical work correctly, not to make judgement calls reserved for Opus.`;

function mechanicBody() {
  return `You are uc-mechanic, a focused implementation subagent the main Opus agent delegates mechanical edits to. You run on Sonnet to keep cost down while Opus reviews your output.

Use you for: renames, formatting, applying type hints/annotations, boilerplate, repetitive edits across files, and writing tests that mirror existing, already-understood code. Not for: novel design, ambiguous debugging, cross-file architecture, or anything requiring a judgement call.

${SAFETY}`;
}

function runnerBody() {
  return `You are uc-runner, a minimal execution subagent the main Opus agent delegates command and test runs to. You run on Haiku because your job is to run something and report the result, not to reason.

Use you for: running a build, a test suite, a linter, a script, or a single command, then reporting just the outcome (pass/fail, the key error lines, the exit status). Do not diagnose, do not fix, do not edit code - report cleanly and hand back.

${SAFETY}`;
}

function scoutBody() {
  return `You are uc-scout, a read-heavy exploration subagent the main Opus agent delegates searches to. You run on Haiku so broad reads do not burn Opus tokens.

Use you for: locating where something lives, tracing how files relate, gathering the facts needed to answer a question, then returning a SHORT summary (paths, key snippets, the conclusion) - not file dumps. You are read-only: never edit, never run destructive commands. If you cannot find something, say so plainly rather than guessing.

${SAFETY}`;
}

const AGENTS = [
  {
    name: "uc-mechanic",
    model: "sonnet",
    color: "cyan",
    description:
      "Mechanical implementation subagent (renames, formatting, type hints, boilerplate, tests-from-existing-code). Opus delegates well-scoped edits here; Opus ratifies every diff.",
    body: mechanicBody,
  },
  {
    name: "uc-runner",
    model: "haiku",
    color: "yellow",
    description:
      "Runs commands/tests/builds and reports just the result. Opus delegates execution here so cheap, no-reasoning runs do not spend Opus tokens.",
    body: runnerBody,
  },
  {
    name: "uc-scout",
    model: "haiku",
    color: "green",
    description:
      "Read-heavy exploration subagent. Opus delegates broad searches here; returns a short summary (paths, key snippets, conclusion), never file dumps. Read-only.",
    body: scoutBody,
  },
];

// Build one agent .md with the standard Claude Code frontmatter, matching the
// shape of the shipped agents under ~/.claude/agents/ (name, description, tools,
// model, color), falling back to the minimal frontmatter the spec names.
function renderAgent({ name, description, model, color, tools, body }) {
  const fm = [`name: ${name}`, `description: ${description}`];
  if (tools) fm.push(`tools: ${tools}`);
  fm.push(`model: ${model}`);
  if (color) fm.push(`color: ${color}`);
  return `---\n${fm.join("\n")}\n---\n\n${body()}\n`;
}

// opts.agentsDir lets the self-test point HOME elsewhere.
export function planSubagentPin(opts = {}) {
  const agentsDir = opts.agentsDir || path.join(CLAUDE_DIR, "agents");

  // uc-scout/uc-runner are read/run-only; give them a tight tool set. uc-mechanic
  // needs edit tools. We only set `tools` if we know the format is honored;
  // matched against the shipped agents which all carry a `tools:` line.
  const toolsByName = {
    "uc-mechanic": "Read, Grep, Glob, Edit, Write, Bash",
    "uc-runner": "Read, Grep, Glob, Bash",
    "uc-scout": "Read, Grep, Glob",
  };

  const changes = [];
  const items = [];
  const advisories = [];

  for (const agent of AGENTS) {
    const file = path.join(agentsDir, `${agent.name}.md`);
    const after = renderAgent({ ...agent, tools: toolsByName[agent.name] });
    const before = readFileSafe(file);
    if (before === after) {
      advisories.push(`${agent.name} is already installed and current.`);
      continue;
    }
    changes.push({ file, before: before ?? null, after });
    items.push({
      kind: "agent",
      name: agent.name,
      model: agent.model,
      detail: agent.description,
    });
  }

  advisories.push(
    "Honest savings: delegating mechanical work to these cheaper-model subagents cuts total spend by single digits to roughly 10-15%, concentrated in delegation-heavy use. It is largest for anyone still on legacy Opus (the 5x price gap). The main Opus thread is never disturbed - each subagent runs in its own cache and Opus ratifies every diff."
  );

  return { changes, items, advisories };
}
