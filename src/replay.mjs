// Measured replay - the proof spine.
//
// Streams the user's own Claude Code transcripts and runs every past tool output
// through the EXACT trimmer that the live hook installs (trimToolOutput), then
// sums the real tokens-before minus tokens-after. This replaces the old guessed
// TRIM_RATIO=0.35 projection with a number measured on the user's own bytes, so
// the headline savings the report shows is honest by construction: the same code,
// on your data. Nothing is written and nothing leaves the machine.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { estimateTokens } from "./tokens.mjs";
import { resultText } from "./usage.mjs";
import { trimToolOutput } from "./apply/trim/transform.mjs";

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

// The tools the live PostToolUse hook matches (Read|Bash|Grep|Glob|mcp__.*).
// Only these contribute trim savings; everything else (Edit/Write/Task/Agent)
// still counts toward the denominator so the percentage stays honest.
function isMatchedTool(name) {
  return /^(Read|Bash|Grep|Glob)$/.test(name) || (typeof name === "string" && name.startsWith("mcp__"));
}

function catFor(name) {
  if (name === "Read") return "read";
  if (name === "Bash") return "bash";
  if (typeof name === "string" && name.startsWith("mcp__")) return "mcp";
  if (name === "Grep" || name === "Glob") return "search";
  return "other";
}

async function replayFile(file, acc) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const toolNameById = new Map();

  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.isSidechain === true || obj.isMeta === true) continue;
    const msg = obj.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : null;
    if (!content) continue;

    if (obj.type === "assistant") {
      for (const block of content) {
        if (block && block.type === "tool_use" && block.id) toolNameById.set(block.id, block.name);
      }
    } else if (obj.type === "user") {
      for (const block of content) {
        if (!block || block.type !== "tool_result") continue;
        const text = resultText(block.content);
        if (typeof text !== "string" || text.length === 0) continue;
        const name = toolNameById.get(block.tool_use_id) || "other";
        const before = estimateTokens(text);
        acc.toolResultTokens += before;
        acc.resultCount += 1;
        if (!isMatchedTool(name)) continue;
        // Mirror the live hook: it ignores tiny outputs (< 200 chars).
        if (text.length < 200) continue;
        const r = trimToolOutput(text);
        if (r.saved > 0) {
          acc.savedTokens += r.saved;
          acc.trimmedCount += 1;
          const cat = catFor(name);
          acc.perCat[cat] = (acc.perCat[cat] || 0) + r.saved;
        }
      }
    }
  }
}

async function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      await replayFile(full, acc);
    } else if (e.isDirectory()) {
      // main project dir, or a session's subagents/ folder (its outputs are
      // trimmed live too) - recurse one level to catch subagents/*.jsonl.
      await walk(full, acc);
    }
  }
}

// Returns the measured trim result across all transcripts. `savedTokens` is the
// real total the live trimmer would have saved; `toolCutPct` is that over all
// tool-result tokens (the honest denominator).
export async function replayTrim() {
  const acc = {
    toolResultTokens: 0,
    savedTokens: 0,
    resultCount: 0,
    trimmedCount: 0,
    perCat: {},
  };
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    projectDirs = [];
  }
  for (const d of projectDirs) {
    if (d.isDirectory()) await walk(path.join(PROJECTS_DIR, d.name), acc);
  }

  const toolCutPct =
    acc.toolResultTokens > 0 ? Math.round((acc.savedTokens / acc.toolResultTokens) * 100) : 0;

  return {
    toolResultTokens: acc.toolResultTokens,
    savedTokens: acc.savedTokens,
    toolCutPct,
    resultCount: acc.resultCount,
    trimmedCount: acc.trimmedCount,
    perCat: acc.perCat,
    basis: "measured",
  };
}
