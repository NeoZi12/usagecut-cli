#!/usr/bin/env node
// UsageCut - free local scan of your Claude Code setup, plus a free optimize.
//
// Reads your config + session transcripts locally, computes how many tokens you
// waste and where (now MEASURED by replaying your own tool outputs through the
// exact shipped trimmer), and uploads ONLY aggregate counts to render your web
// report. Raw code and logs never leave this machine. By ClockedCode. Not
// affiliated with Anthropic.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discover } from "./discover.mjs";
import { scanUsage } from "./usage.mjs";
import { replayTrim } from "./replay.mjs";
import { analyze } from "./analyze.mjs";
import { planClaudeMd } from "./apply/levers/claudeMd.mjs";
import { terminalTeaser } from "./report.mjs";
import { upload, uploadAfter } from "./upload.mjs";
import { runApply } from "./apply/engine.mjs";
import { runRevert } from "./apply/revert.mjs";
import { runStatus } from "./apply/status.mjs";
import { retrieve } from "./apply/trim/stash.mjs";
import { runProbe } from "./apply/trim/probe.mjs";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function log(msg) {
  process.stdout.write(msg + "\n");
}

// The claim token ties a scan to its hosted report row. The scan run knows it
// (env/arg); `apply` later needs the SAME token to post the realized "after"
// aggregate so the web report flips to the optimized view (and the result email
// fires). The plain `npx usagecut apply` shown on the report carries no token,
// so we persist it locally at scan time and read it back here as a fallback.
const TOKEN_FILE = path.join(os.tmpdir(), "usagecut-token");
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

function persistToken(token) {
  if (!token || !TOKEN_RE.test(String(token))) return;
  try {
    fs.writeFileSync(TOKEN_FILE, String(token), { mode: 0o600 });
  } catch {
    /* best effort - a missing persisted token just means the report won't flip */
  }
}

function readPersistedToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return TOKEN_RE.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

// Run the full local scan: discovery + usage + the measured trim replay + the
// CLAUDE.md classifier, folded into the report payload. Pure reads.
async function computeScan(cwd) {
  const discovery = discover(cwd);
  const usage = await scanUsage();
  const replay = await replayTrim();
  let claudeMdSaved;
  try {
    claudeMdSaved = planClaudeMd().counts.claudeMdTokensSaved;
  } catch {
    claudeMdSaved = undefined;
  }
  const payload = analyze(discovery, usage, { replay, claudeMdSaved });
  return { discovery, usage, replay, payload };
}

const COMMANDS = new Set(["apply", "revert", "status", "retrieve", "probe"]);

async function dispatch() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!COMMANDS.has(cmd)) return false;

  const has = (name) => argv.includes(`--${name}`);
  const val = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // first positional after the command (a claim token), if any
  const positional = argv.slice(1).find((a) => !a.startsWith("-"));

  if (cmd === "apply") {
    await runApplyAndReport({
      token: process.env.USAGECUT_TOKEN || positional || readPersistedToken(),
      dryRun: has("dry-run"),
      yes: has("yes"),
      yesClaudemd: has("yes-claudemd"),
      terse: has("terse"),
      only: val("only"),
    });
  } else if (cmd === "revert") {
    runRevert({ list: has("list"), id: val("id") });
  } else if (cmd === "status") {
    runStatus();
  } else if (cmd === "retrieve") {
    const ref = positional;
    if (!ref) {
      log("usage: usagecut retrieve <uc:ref>");
      process.exitCode = 1;
      return true;
    }
    const text = retrieve(ref);
    if (text == null) {
      log(`No stashed output for ${ref} (it may have expired).`);
      process.exitCode = 1;
    } else {
      process.stdout.write(text);
    }
  } else if (cmd === "probe") {
    const p = runProbe();
    log("");
    log(`  ${BOLD}UsageCut probe${RESET}`);
    log(`  Claude Code:   ${p.ccVersion || "unknown"}`);
    log(`  output field:  ${p.emitShape}`);
    log(`  confidence:    ${p.confidence}`);
    log(`  ${DIM}The live trimmer uses this to decide whether to actively trim or observe-only.${RESET}`);
    log("");
  }
  return true;
}

// The optimize flow: apply the levers, then (if a claim token is known) post the
// numbers-only "after" aggregate so the hosted report flips to the optimized
// view. The after-upload is best-effort - a failure never undoes the apply.
async function runApplyAndReport(opts) {
  const cwd = process.cwd();
  // The before snapshot powers the realized "after" aggregate.
  let payload = null;
  try {
    ({ payload } = await computeScan(cwd));
  } catch {
    payload = null;
  }

  const result = await runApply(opts);

  if (result.applied && opts.token && payload) {
    const r = result.realized;
    const s = payload.derived.savings;
    const tokensBefore = payload.now.tokensPerSession;
    // Honest "after": sum ONLY the levers that actually took effect. The dead
    // servers, the live trimmer, and the CLAUDE.md relocation each deliver their
    // measured saving going forward; the duplicate-read guard ships observe-only
    // (it logs but does not block), so its potential saving is NOT claimed here.
    let realizedSaved = 0;
    if (r.deadServersDisabled > 0) realizedSaved += s.servers;
    if (r.trimmerActive === 1) realizedSaved += s.toolTrim;
    if (r.claudeMdSaved > 0) realizedSaved += s.claudeMd;
    const tokensAfter = Math.max(0, tokensBefore - realizedSaved);
    const cutPct = tokensBefore > 0 ? Math.round((realizedSaved / tokensBefore) * 100) : 0;
    const toolOutBefore = payload.now.toolOutputPerSession;
    const toolOutAfter = Math.max(0, toolOutBefore - (r.trimmerActive === 1 ? s.toolTrim : 0));
    const afterAgg = {
      afterV: 1,
      realized: {
        tokensBefore,
        tokensAfter,
        savedTokens: realizedSaved,
        cutPct,
        toolOutputBefore: toolOutBefore,
        toolOutputAfter: toolOutAfter,
        leversApplied: r.leversApplied || 0,
        deadServersDisabled: r.deadServersDisabled || 0,
        claudeMdSaved: r.claudeMdSaved || 0,
        trimmerActive: r.trimmerActive || 0,
      },
      gradeBefore: payload.derived.gradeNow,
      // Only claim the optimized grade jump when the FULL plan was applied.
      gradeAfter: r.fullPlan ? payload.derived.gradeOptimized : payload.derived.gradeNow,
    };
    try {
      await uploadAfter(afterAgg, opts.token);
      log(`  ${DIM}Your web report has been updated with the optimized result.${RESET}`);
      log("");
    } catch (err) {
      log(`  ${DIM}(Could not update the web report: ${err.message}. Your local changes are applied.)${RESET}`);
      log("");
    }
  }
}

async function main() {
  if (await dispatch()) return;

  const jsonOnly = process.argv.includes("--json");
  if (!jsonOnly) log(`${DIM}UsageCut - scanning your Claude Code setup...${RESET}`);

  const { usage, payload } = await computeScan(process.cwd());

  if (usage.sessionCount === 0) {
    log("No Claude Code sessions found to analyze. Nothing to scan yet.");
    return;
  }

  if (jsonOnly) {
    log(JSON.stringify(payload, null, 2));
    return;
  }

  const outFile = path.join(os.tmpdir(), "usagecut-scan.json");
  try {
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  } catch {
    /* ignore */
  }

  try {
    const argToken = process.argv.slice(2).find((a) => !a.startsWith("-"));
    const token = process.env.USAGECUT_TOKEN || argToken;
    const { url } = await upload(payload, token);
    // Persist the token so a later bare `npx usagecut apply` can find the same
    // scan row and flip the hosted report (and trigger the result email).
    persistToken(token);
    log(terminalTeaser(payload, url));
  } catch (err) {
    log("");
    log(`  Could not upload your report: ${err.message}`);
    log(`  Your scan was saved locally at: ${outFile}`);
    log(`  Run again to retry, or set USAGECUT_API_URL to your endpoint.`);
    log("");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`usagecut: ${err?.stack || err}\n`);
  process.exitCode = 1;
});
