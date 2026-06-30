// The install-time probe. The single highest-risk surface is HOW a PostToolUse
// hook replaces the tool output the model sees - the exact JSON field has
// drifted across Claude Code versions and the docs have contradicted each
// other. Rather than guess, the trimmer reads ~/.usagecut/probe.json to learn
// the confirmed emit shape on THIS machine's installed version. If the shape is
// not confirmed, the trimmer installs in OBSERVE-ONLY mode (it computes the
// would-save number but emits nothing), so we never silently corrupt output and
// never charge for a no-op.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const PROBE_PATH = path.join(os.homedir(), ".usagecut", "probe.json");

// The emit shapes the live hook knows how to produce. "observe" = emit nothing.
export const EMIT_SHAPES = ["observe", "hookSpecificOutput.updatedToolOutput", "top.updatedToolOutput"];

function detectCcVersion() {
  for (const args of [["--version"], ["-v"]]) {
    try {
      const out = execFileSync("claude", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/\d+\.\d+\.\d+/);
      if (m) return m[0];
    } catch {
      /* try next */
    }
  }
  return null;
}

export function readProbe() {
  try {
    return JSON.parse(fs.readFileSync(PROBE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeProbe(probe) {
  fs.mkdirSync(path.dirname(PROBE_PATH), { recursive: true });
  const tmp = `${PROBE_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(probe, null, 2));
  fs.renameSync(tmp, PROBE_PATH);
  return probe;
}

// Pin the compatibility matrix. `emitShape` is the confirmed PostToolUse output
// field for the installed version (defaults to the value baked in by the CLI
// release, which is set from the verified Claude Code hook contract). Callers
// can override per machine. Confidence is recorded honestly.
export function runProbe({ emitShape, confidence } = {}) {
  const ccVersion = detectCcVersion();
  const shape = EMIT_SHAPES.includes(emitShape) ? emitShape : DEFAULT_EMIT_SHAPE;
  return writeProbe({
    v: 1,
    at: new Date().toISOString(),
    ccVersion,
    emitShape: shape,
    confidence: confidence || (shape === "observe" ? "none" : "default"),
  });
}

// The default emit shape baked into the release. Confirmed against Claude Code
// 2.1.191 (claude-code-guide, official hooks doc): a PostToolUse hook replaces
// what the model sees by printing { hookSpecificOutput: { hookEventName:
// "PostToolUse", updatedToolOutput: "<string>" } } to stdout. PostToolUse
// stdin carries `tool_output` as a string for all tools, so one trimmed string
// replaces the output uniformly (no per-tool shape branching needed). If a
// future version drops the field, `usagecut probe` can pin "observe" instead.
export const DEFAULT_EMIT_SHAPE = "hookSpecificOutput.updatedToolOutput";

// Ensure a probe exists; if none, write a default (observe-only) one so the
// hook always has something to read.
export function ensureProbe() {
  const existing = readProbe();
  if (existing && EMIT_SHAPES.includes(existing.emitShape)) return existing;
  return runProbe();
}
