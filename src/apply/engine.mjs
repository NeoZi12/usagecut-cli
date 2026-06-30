// The apply engine. Gathers every lever, prints a plan + diffs, and (unless
// --dry-run) takes the single-writer lock, snapshots a backup manifest, and
// writes every approved change atomically. Dry-run is the default-safe path;
// every write is reversible with `usagecut revert`.
//
// All settings.json edits from every lever are funneled through ONE merge of a
// single settings object (settings-merge.mjs), so two levers can never clobber
// each other's edit. Levers are applied in a cache-safe order: tool-search and
// the cache-1h env first, then MCP/skill/CLAUDE.md, then the live trimmer arms
// last (it hot-reloads without rebuilding the prompt-cache prefix).

import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { planDeadMcp } from "./levers/deadMcp.mjs";
import { planToolSearch } from "./levers/toolSearch.mjs";
import { planClaudeMd } from "./levers/claudeMd.mjs";
import { planDeadSkill } from "./levers/deadSkill.mjs";
import { planCacheHygiene } from "./levers/cacheHygiene.mjs";
import { planBinaryPreproc } from "./levers/binaryPreproc.mjs";
import { planSubagentPin } from "./levers/subagentPin.mjs";
import { planTerseOutput } from "./levers/terseOutput.mjs";
import { planTrimmer } from "./trim/install.mjs";

import { snapshot } from "./manifest.mjs";
import { safeWrite } from "./atomic.mjs";
import { renderDiff } from "./diff.mjs";
import { acquireLock } from "./lock.mjs";
import { loadSettingsObject, serializeSettings, applyMutation } from "./settings-merge.mjs";

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CLAY = "\x1b[38;5;173m";
const GREEN = "\x1b[38;5;107m";

function out(s) {
  process.stdout.write(s + "\n");
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

function printAdvisories(advisories) {
  for (const a of advisories || []) out(`  ${DIM}note: ${a}${RESET}`);
}

// Returns a realized summary so the caller can build the web "after" aggregate.
export async function runApply(opts = {}) {
  const cwd = process.cwd();
  const only = opts.only ? new Set(opts.only.split(",").map((s) => s.trim())) : null;
  const want = (k) => !only || only.has(k);

  out("");
  out(`  ${BOLD}UsageCut - optimize${RESET}`);

  // Low-risk file changes (batch-approved) vs CLAUDE.md changes (its own gate).
  const lowRiskChanges = new Map(); // file -> change
  const claudeMdChanges = new Map();
  const settingsMutations = [];
  const realized = {
    leversApplied: 0,
    deadServersDisabled: 0,
    claudeMdSaved: 0,
    trimmerActive: 0,
    agentsInstalled: 0,
  };

  // ---- (c) tool-search: re-enable deferral only if explicitly disabled ----
  if (want("toolsearch")) {
    const ts = planToolSearch();
    out("");
    out(`  ${BOLD}Deferred tool loading${RESET}`);
    if (ts.alreadyOptimal) {
      out(`  ${GREEN}Already on${RESET} ${DIM}- ${ts.note}.${RESET}`);
    } else {
      settingsMutations.push({ op: "removeEnv", key: "ENABLE_TOOL_SEARCH" });
      out(`  ${ts.change.note}.`);
    }
  }

  // ---- cache hygiene: 1h TTL + (optional) cache-health statusline ----
  if (want("cache")) {
    const ch = planCacheHygiene();
    out("");
    out(`  ${BOLD}Cache protection${RESET}`);
    for (const m of ch.settingsMutations || []) settingsMutations.push(m);
    for (const it of ch.items || []) out(`    ${CLAY}+${RESET} ${it.detail}`);
    if (!(ch.items || []).length) out(`  ${GREEN}Already protected.${RESET}`);
    printAdvisories(ch.advisories);
  }

  // ---- (a) unused MCP servers ----
  if (want("mcp")) {
    const dead = await planDeadMcp(cwd);
    out("");
    out(`  ${BOLD}Unused MCP servers${RESET}`);
    if (!dead.items.length) {
      out(`  ${GREEN}No idle servers${RESET} ${DIM}- all ${dead.counts.configured} configured servers were used.${RESET}`);
    } else {
      out(`  ${dead.items.length} of ${dead.counts.configured} configured servers were never called - set aside (reversible):`);
      for (const it of dead.items) out(`    ${CLAY}-${RESET} ${BOLD}${it.name}${RESET} ${DIM}[${it.scope}]${RESET}`);
      for (const ch of dead.changes) lowRiskChanges.set(ch.file, ch);
      realized.deadServersDisabled = dead.items.length;
    }
    for (const tf of dead.toolFilters || []) {
      out(`    ${DIM}~ ${tf.server}: ${tf.unusedCount ?? "some"} tools never called (advisory)${RESET}`);
    }
    printAdvisories(dead.advisories);
  }

  // ---- dead skills / plugins ----
  if (want("skills")) {
    const ds = await planDeadSkill(cwd);
    out("");
    out(`  ${BOLD}Idle skills / plugins${RESET}`);
    if (!(ds.items || []).length) {
      out(`  ${GREEN}Nothing idle.${RESET}`);
    } else {
      for (const it of ds.items) {
        if (it.kind === "plugin") out(`    ${CLAY}-${RESET} plugin ${BOLD}${it.plugin}${RESET} ${DIM}(disable, reversible)${RESET}`);
      }
    }
    for (const m of ds.settingsMutations || []) settingsMutations.push(m);
    printAdvisories(ds.advisories);
  }

  // ---- subagent model pinning (cheaper-model delegates) ----
  if (want("subagents")) {
    const sp = planSubagentPin();
    out("");
    out(`  ${BOLD}Cheaper-model subagents${RESET}`);
    for (const ch of sp.changes || []) lowRiskChanges.set(ch.file, ch);
    for (const it of sp.items || []) out(`    ${CLAY}+${RESET} ${BOLD}${it.name}${RESET} ${DIM}(${it.model})${RESET}`);
    realized.agentsInstalled = (sp.changes || []).length;
    printAdvisories(sp.advisories);
  }

  // ---- binary preprocessing (markitdown) ----
  if (want("binprep")) {
    const bp = planBinaryPreproc();
    out("");
    out(`  ${BOLD}Binary file preprocessing${RESET}`);
    for (const m of bp.settingsMutations || []) settingsMutations.push(m);
    for (const it of bp.items || []) out(`    ${CLAY}+${RESET} ${it.detail}`);
    printAdvisories(bp.advisories);
  }

  // ---- terse output style (opt-in) ----
  if (want("terse")) {
    const te = planTerseOutput({ optIn: opts.terse });
    if ((te.changes || []).length || opts.terse) {
      out("");
      out(`  ${BOLD}Terse output style${RESET}`);
      for (const ch of te.changes || []) lowRiskChanges.set(ch.file, ch);
      printAdvisories(te.advisories);
    }
  }

  // ---- the live trimmer (arms last; cache-safe) ----
  let trimmer = null;
  if (want("trimmer")) {
    trimmer = planTrimmer();
    out("");
    out(`  ${BOLD}Live tool-output trimmer${RESET} ${DIM}(the engine)${RESET}`);
    for (const it of trimmer.items || []) out(`    ${CLAY}+${RESET} ${it.note}`);
    for (const m of trimmer.settingsMutations || []) settingsMutations.push(m);
    realized.trimmerActive = trimmer.active ? 1 : 0;
    printAdvisories(trimmer.advisories);
  }

  // ---- (b) slim CLAUDE.md (deterministic relocate; its own approval gate) ----
  if (want("claudemd")) {
    const cm = planClaudeMd();
    out("");
    out(`  ${BOLD}Slim global CLAUDE.md${RESET}`);
    if (!(cm.changes || []).length) {
      out(`  ${GREEN}Left as-is.${RESET}`);
    } else {
      out(`  Relocate ${cm.counts.sectionsRelocated} path-scoped section(s) to ~/.claude/rules/ ${DIM}(~${cm.counts.claudeMdTokensSaved} tokens/session, reversible)${RESET}:`);
      for (const ch of cm.changes || []) {
        claudeMdChanges.set(ch.file, ch);
        // Show the diff of your own prose being moved (verbatim, never reworded).
        if (ch.before) out(renderDiff(ch.before, ch.after));
      }
      realized.claudeMdSaved = cm.counts.claudeMdTokensSaved || 0;
    }
    printAdvisories(cm.advisories);
  }

  // ---- fold all settings.json mutations into ONE change ----
  if (settingsMutations.length) {
    const { before, obj } = loadSettingsObject(SETTINGS);
    if (obj == null) {
      out("");
      out(`  ${DIM}note: ~/.claude/settings.json is not valid JSON - skipping settings changes to avoid clobbering it.${RESET}`);
    } else {
      let changed = false;
      for (const m of settingsMutations) changed = applyMutation(obj, m) || changed;
      if (changed) {
        const after = serializeSettings(obj);
        if (after !== (before || "")) lowRiskChanges.set(SETTINGS, { file: SETTINGS, before: before || null, after, reformatsWholeFile: true });
      }
    }
  }

  // ---- plan summary ----
  const lowRiskFiles = [...lowRiskChanges.keys()];
  const claudeMdFiles = [...claudeMdChanges.keys()];
  if (!lowRiskFiles.length && !claudeMdFiles.length) {
    out("");
    out(`  ${GREEN}Nothing to change - your setup is already lean here.${RESET}`);
    out("");
    return { applied: false, realized };
  }

  out("");
  out(`  ${BOLD}Files that would change:${RESET}`);
  for (const f of [...lowRiskFiles, ...claudeMdFiles]) {
    const tag = (lowRiskChanges.get(f) || claudeMdChanges.get(f)).reformatsWholeFile ? `  ${DIM}(reformatted)${RESET}` : "";
    out(`    ${f}${tag}`);
  }

  if (opts.dryRun) {
    out("");
    out(`  ${DIM}Dry run - no changes were written to your Claude Code config. Re-run without --dry-run to apply.${RESET}`);
    out("");
    return { applied: false, realized };
  }

  // ---- approvals: low-risk batch, then CLAUDE.md on its own ----
  const approved = new Map();
  let lowRiskApproved = false;
  let claudeMdApproved = false;
  if (lowRiskFiles.length) {
    let ok = opts.yes;
    if (!ok) {
      out("");
      out(`  ${DIM}Tip: close other Claude Code sessions first - they write ~/.claude.json.${RESET}`);
      ok = await confirm(`  Apply these ${lowRiskFiles.length} change(s)? [y/N] `);
    }
    if (ok) {
      for (const f of lowRiskFiles) approved.set(f, lowRiskChanges.get(f));
      lowRiskApproved = true;
    } else out(`  ${DIM}Skipped the setup changes.${RESET}`);
  }
  if (claudeMdFiles.length) {
    let ok = opts.yes && opts.yesClaudemd;
    if (!ok && !opts.yesClaudemd) {
      out("");
      out(`  ${DIM}CLAUDE.md is your own instructions - relocations are verbatim (no rewording) and reversible.${RESET}`);
      ok = await confirm(`  Relocate the CLAUDE.md section(s)? [y/N] `);
    } else if (opts.yesClaudemd) {
      ok = true;
    }
    if (ok) {
      for (const f of claudeMdFiles) approved.set(f, claudeMdChanges.get(f));
      claudeMdApproved = true;
    } else out(`  ${DIM}Left CLAUDE.md untouched.${RESET}`);
  }

  const files = [...approved.keys()];
  if (!files.length) {
    out(`  Nothing applied.`);
    out("");
    return { applied: false, realized };
  }

  // ---- lock, backup, then write atomically ----
  const lock = acquireLock();
  let snap;
  try {
    snap = snapshot(files);
    for (const f of files) safeWrite(f, approved.get(f).after);
  } finally {
    lock.release();
  }

  // Finalize `realized` to reflect what was ACTUALLY approved, not what was
  // planned. The low-risk levers (MCP, trimmer, subagents) land all-or-nothing
  // with one approval; CLAUDE.md is its own gate. A declined group contributes
  // zero, so the web "after" report can never claim an unrealized saving.
  if (!lowRiskApproved) {
    realized.deadServersDisabled = 0;
    realized.agentsInstalled = 0;
    realized.trimmerActive = 0;
  }
  if (!claudeMdApproved) realized.claudeMdSaved = 0;
  realized.leversApplied = files.length;
  realized.fullPlan =
    !opts.only &&
    (lowRiskFiles.length === 0 || lowRiskApproved) &&
    (claudeMdFiles.length === 0 || claudeMdApproved);

  out("");
  out(`  ${GREEN}Applied.${RESET} Backed up to ${DIM}${snap.dir}${RESET}`);
  out(`  ${DIM}Roll it all back anytime:${RESET} ${BOLD}npx usagecut revert${RESET}`);
  out(`  ${DIM}Restart Claude Code sessions for the changes to take effect.${RESET}`);
  if (trimmer && !trimmer.active) {
    out(`  ${DIM}The live trimmer is armed in observe-only mode on this version; run ${RESET}${BOLD}usagecut probe${RESET}${DIM} to confirm the output hook.${RESET}`);
  }
  out("");
  return { applied: true, realized };
}
