// Builds and installs the live runtime hook scripts into ~/.usagecut, and
// returns the settings.json mutations the engine applies. The hooks are emitted
// as SELF-CONTAINED, zero-dependency .mjs files: the pure rules.mjs source is
// inlined verbatim (it has no imports), wrapped with a small runtime that reads
// the PostToolUse stdin, trims, stashes the original, and emits the trimmed
// output in the probe-confirmed shape. On ANY error the hook is a no-op
// pass-through (fail-open), and until the emit shape is confirmed it runs
// observe-only (measures, emits nothing) so it can never corrupt a tool result.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeWrite } from "../atomic.mjs";
import { ensureProbe, readProbe } from "./probe.mjs";

export const USAGECUT_DIR = path.join(os.homedir(), ".usagecut");
const TRIM_SCRIPT = path.join(USAGECUT_DIR, "trim.mjs");
const READGUARD_SCRIPT = path.join(USAGECUT_DIR, "readguard.mjs");

const TRIM_MATCHER = "Read|Bash|Grep|Glob|mcp__.*";

function rulesSource() {
  const rulesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "rules.mjs");
  return fs.readFileSync(rulesPath, "utf8");
}

const BUILTIN_IMPORTS = [
  'import fs from "node:fs";',
  'import os from "node:os";',
  'import path from "node:path";',
  'import crypto from "node:crypto";',
].join("\n");

// The PostToolUse runtime wrapper (no import lines - they are prepended once).
const TRIM_WRAPPER = `
// ---- UsageCut live trimmer runtime (generated; do not edit) ----
const UC = path.join(os.homedir(), ".usagecut");
const STASH = path.join(UC, "stash");

function ucReadJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function ucLog(rec) { try { fs.appendFileSync(path.join(UC, "trim-metrics.jsonl"), JSON.stringify(rec) + "\\n"); } catch { /* best effort */ } }
function ucStash(text) {
  try {
    const h = crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
    fs.mkdirSync(STASH, { recursive: true });
    const f = path.join(STASH, h + ".txt");
    if (!fs.existsSync(f)) { const t = f + ".tmp." + process.pid; fs.writeFileSync(t, text); fs.renameSync(t, f); }
    return "uc:" + h;
  } catch { return null; }
}
function ucExtract(resp) {
  if (resp == null) return null;
  if (typeof resp === "string") return { text: resp, kind: "string" };
  if (Array.isArray(resp)) {
    const text = resp.map((b) => (typeof b === "string" ? b : b && typeof b.text === "string" ? b.text : "")).join("");
    return { text, kind: "blocks" };
  }
  if (typeof resp === "object") {
    if (typeof resp.stdout === "string" || typeof resp.stderr === "string") return { text: resp.stdout || "", kind: "bash" };
    if (typeof resp.text === "string") return { text: resp.text, kind: "objtext" };
    if (Array.isArray(resp.content)) return ucExtract(resp.content);
  }
  return null;
}

(function ucMain() {
  try {
    let raw = ""; try { raw = fs.readFileSync(0, "utf8"); } catch { return; }
    if (!raw) return;
    let input; try { input = JSON.parse(raw); } catch { return; }
    const cfg = ucReadJson(path.join(UC, "trim-config.json")) || {};
    if (cfg.active === false) return; // killswitch (revert / disarm)
    const probe = ucReadJson(path.join(UC, "probe.json")) || {};
    const emitShape = probe.emitShape || "observe";

    const tool = input.tool_name || input.toolName || "";
    // PostToolUse stdin carries tool_output as a string on current Claude Code;
    // fall back to tool_response (string | blocks | object) for other shapes.
    let text = typeof input.tool_output === "string" ? input.tool_output : null;
    if (text == null) {
      const resp = input.tool_response !== undefined ? input.tool_response : input.toolResponse;
      const ex = ucExtract(resp);
      text = ex && typeof ex.text === "string" ? ex.text : null;
    }
    if (text == null || text.length < 200) return;

    const trimmed = applyTrim(text);
    if (trimmed === text || trimmed.length >= text.length) return;
    ucLog({ t: Date.now(), tool, before: text.length, after: trimmed.length, emit: emitShape });

    if (emitShape === "observe") return; // observe-only: measured, output unchanged

    const ref = ucStash(text);
    const note = ref
      ? "\\n\\n[uc-trim: noise removed losslessly. Full original recoverable: run \\\`npx usagecut retrieve " + ref + "\\\`]"
      : "";
    const finalText = trimmed + note;

    if (emitShape === "hookSpecificOutput.updatedToolOutput") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: finalText } }));
    } else if (emitShape === "top.updatedToolOutput") {
      process.stdout.write(JSON.stringify({ updatedToolOutput: finalText }));
    }
  } catch {
    // fail-open: a trimmer error must never break a tool result
  }
})();
`;

// The PreToolUse read-guard runtime. Observe-only by default: it records when a
// file is re-read unchanged (so we can measure the recoverable duplicate-read
// tokens) but does NOT block, so it can never starve Claude of a read it needs.
// Deny mode is opt-in via trim-config.json { readGuardDeny: true }.
const READGUARD_SCRIPT_SRC = `// ---- UsageCut read guard (generated; do not edit) ----
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UC = path.join(os.homedir(), ".usagecut");
const STATE_DIR = path.join(UC, "state");
function ucReadJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function ucLog(rec) { try { fs.appendFileSync(path.join(UC, "readguard-metrics.jsonl"), JSON.stringify(rec) + "\\n"); } catch {} }

(function main() {
  try {
    let raw = ""; try { raw = fs.readFileSync(0, "utf8"); } catch { return; }
    if (!raw) return;
    let input; try { input = JSON.parse(raw); } catch { return; }
    const cfg = ucReadJson(path.join(UC, "trim-config.json")) || {};
    if (cfg.active === false) return;
    const tool = input.tool_name || input.toolName || "";
    if (tool !== "Read") return;
    const fp = input.tool_input && input.tool_input.file_path;
    if (typeof fp !== "string") return;

    let mtimeMs = 0; try { mtimeMs = Math.round(fs.statSync(fp).mtimeMs); } catch { return; }
    const sid = (input.session_id || "nosession").replace(/[^A-Za-z0-9._-]/g, "_");
    const file = path.join(STATE_DIR, sid + ".reads.json");
    const state = ucReadJson(file) || { reads: {} };
    const prev = state.reads[fp];
    const dup = prev && prev.mtimeMs === mtimeMs;
    state.reads[fp] = { mtimeMs };
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); const t = file + ".tmp." + process.pid; fs.writeFileSync(t, JSON.stringify(state)); fs.renameSync(t, file); } catch {}

    if (dup) {
      ucLog({ t: Date.now(), file: fp, event: "dup-read" });
      if (cfg.readGuardDeny === true) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "UsageCut: this file was already read unchanged this session - reuse the earlier content instead of re-reading." }
        }));
      }
    }
  } catch {
    // fail-open
  }
})();
`;

export function buildTrimHookSource() {
  return [
    "// UsageCut live trimmer - generated, do not edit. Self-contained, zero-dep.",
    BUILTIN_IMPORTS,
    "",
    rulesSource(),
    "",
    TRIM_WRAPPER,
  ].join("\n");
}

export function buildReadGuardSource() {
  return READGUARD_SCRIPT_SRC;
}

// Write the runtime scripts to ~/.usagecut and make sure a probe exists.
export function writeRuntimeScripts() {
  fs.mkdirSync(USAGECUT_DIR, { recursive: true });
  safeWrite(TRIM_SCRIPT, buildTrimHookSource(), { raw: true });
  safeWrite(READGUARD_SCRIPT, buildReadGuardSource(), { raw: true });
  // default config: armed and active (active:false is the killswitch).
  const cfgPath = path.join(USAGECUT_DIR, "trim-config.json");
  if (!fs.existsSync(cfgPath)) safeWrite(cfgPath, JSON.stringify({ active: true, readGuardDeny: false }, null, 2), { raw: true });
  ensureProbe();
  return { trim: TRIM_SCRIPT, readguard: READGUARD_SCRIPT };
}

// Plan the trimmer install: write scripts, return the settings mutations + a
// human-readable status that is honest about active vs observe-only.
export function planTrimmer() {
  const scripts = writeRuntimeScripts();
  const probe = readProbe() || {};
  const active = probe.emitShape && probe.emitShape !== "observe";
  const node = "node";
  const settingsMutations = [
    { op: "ensureHook", event: "PostToolUse", matcher: TRIM_MATCHER, command: `${node} ${scripts.trim}`, timeout: 30 },
    { op: "ensureHook", event: "PreToolUse", matcher: "Read", command: `${node} ${scripts.readguard}`, timeout: 15 },
  ];
  const items = [
    {
      name: "live trimmer",
      scope: active ? "active" : "observe-only",
      note: active
        ? "Trims bulky tool output as you work, losslessly (full output recoverable via `usagecut retrieve`)."
        : "Installed in observe-only mode: it measures your real savings but does not modify output until the Claude Code output-hook field is confirmed on your version (run `usagecut probe`).",
    },
  ];
  const advisories = active
    ? []
    : [
        "The live trimmer is armed in observe-only mode on this Claude Code version. It records the exact tokens it would save; flip it on once `usagecut probe` confirms the output field.",
      ];
  return { settingsMutations, scripts, items, advisories, active };
}

// Hook commands we own, for revert/uninstall matching.
export const OWNED_HOOK_MARKERS = [".usagecut/trim.mjs", ".usagecut/readguard.mjs"];
