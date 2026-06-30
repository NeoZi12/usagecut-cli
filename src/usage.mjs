// Transcript scanner. Streams every Claude Code session transcript on this
// machine and computes aggregate usage stats. Reads only - nothing is written,
// and nothing leaves the machine from here (the caller decides what to upload).
//
// Layout (verified 2026-06):
//   ~/.claude/projects/<slug>/<session-id>.jsonl                       main session
//   ~/.claude/projects/<slug>/<session-id>/subagents/agent-*.jsonl     sub-agent
//
// Main transcripts drive the token / tool-output / duplicate-read numbers.
// Sub-agent transcripts are scanned only to learn which MCP servers were
// actually called - a server used solely inside a sub-agent (e.g. tavily/exa
// inside a web-researcher) must NOT be flagged as dead.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { estimateTokens } from "./tokens.mjs";

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

// Pull the readable text out of a tool_result `content`, which is either a
// plain string or an array of blocks ([{ type: "text", text }], images, ...).
// Exported as the ONE canonical extractor so the replay measurement and the
// live trimmer hook size identical bytes.
export function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

function isMcpName(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

// The plain conversation text in a message (user prompts + assistant prose),
// excluding tool_use/tool_result blocks which we count separately. `content`
// is either a string or an array of blocks.
function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

// Scan a single transcript file line by line. `mode` is "main" or "subagent".
// Mutates the shared `acc` accumulator. Sub-agent files contribute only to the
// called-servers set.
async function scanFile(file, mode, acc) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Per-session state (one main file == one session). We model "tokens / session"
  // as the thread footprint - the unique content that gets re-sent each turn:
  // conversation text + tool output (+ a fixed header added later in analyze).
  // This matches the build-plan's validated ~31.6k base, and keeps the savings
  // percentages meaningful (summing the real per-turn usage would balloon ~30x
  // because every turn re-sends the whole thread and cache writes re-count).
  let sessionConvText = 0;
  let sessionToolOutput = 0;
  let sawAssistant = false;
  const seenReadPaths = new Set();
  const toolNameById = new Map(); // tool_use.id -> tool name (to attribute output)
  const dupReadIds = new Set(); // tool_use.id of duplicate Reads (to size them)

  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Hygiene (verified 2026-06 against real transcripts): skip sidechain and
    // meta lines so image-coordinate notes, skill-base-dir markers, and any
    // stray subagent echoes never inflate the main-session token counts. These
    // flags are negligible in practice but the guard keeps the numbers honest.
    if (mode === "main" && (obj.isSidechain === true || obj.isMeta === true)) {
      continue;
    }

    // Track the active date span across all transcripts (for the monthly
    // projection). Timestamps are ISO strings on most lines.
    if (mode === "main" && obj.timestamp) {
      const ms = Date.parse(obj.timestamp);
      if (!Number.isNaN(ms)) {
        if (ms < acc.minTs) acc.minTs = ms;
        if (ms > acc.maxTs) acc.maxTs = ms;
      }
    }

    const msg = obj.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : null;

    if (obj.type === "assistant" && msg) {
      sawAssistant = true;
      if (mode === "main") sessionConvText += estimateTokens(messageText(msg.content));
      // Tool calls: record names (for server detection + output attribution).
      if (content) {
        for (const block of content) {
          if (block && block.type === "tool_use") {
            const name = block.name;
            if (isMcpName(name)) acc.calledServers.add(name);
            // Every tool name actually called (used by per-tool MCP filtering and
            // the dead-skill audit). Captured in both main and sub-agent modes so
            // a tool used only inside a sub-agent still counts as "used".
            if (typeof name === "string") {
              acc.calledTools.add(name);
              if (name === "Skill") {
                const sk =
                  block.input?.command || block.input?.skill || block.input?.name;
                if (typeof sk === "string" && sk) acc.calledSkills.add(sk);
              }
            }
            if (mode === "main") {
              if (block.id) toolNameById.set(block.id, name);
              // Duplicate Read detection: same file_path read more than once.
              if (name === "Read") {
                const p = block.input && block.input.file_path;
                if (typeof p === "string") {
                  if (seenReadPaths.has(p)) {
                    acc.duplicateReadCount += 1;
                    if (block.id) dupReadIds.add(block.id);
                  } else {
                    seenReadPaths.add(p);
                  }
                }
              }
            }
          }
        }
      }
    } else if (obj.type === "user" && msg && mode === "main") {
      sessionConvText += estimateTokens(messageText(msg.content));
      if (!content) continue;
      // Tool results carry the bulky output we want to measure.
      for (const block of content) {
        if (block && block.type === "tool_result") {
          const tokens = estimateTokens(resultText(block.content));
          sessionToolOutput += tokens;
          const name = toolNameById.get(block.tool_use_id) || "other";
          acc.toolBreakdown[name] = (acc.toolBreakdown[name] || 0) + tokens;
          // Tokens we could recover by not re-reading the same file.
          if (dupReadIds.has(block.tool_use_id)) acc.duplicateReadTokens += tokens;
        }
      }
    }
  }

  if (mode === "main" && sawAssistant) {
    acc.sessionCount += 1;
    acc.totalConvText += sessionConvText;
    acc.totalToolOutput += sessionToolOutput;
  }
}

// Walk a project's directory: top-level *.jsonl are main sessions; any nested
// subagents/*.jsonl are sub-agent transcripts.
async function scanProjectDir(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      await scanFile(full, "main", acc);
    } else if (e.isDirectory()) {
      // Look for a subagents/ folder one level down.
      const subDir = path.join(full, "subagents");
      let subs;
      try {
        subs = fs.readdirSync(subDir, { withFileTypes: true });
      } catch {
        subs = [];
      }
      for (const s of subs) {
        if (s.isFile() && s.name.endsWith(".jsonl")) {
          await scanFile(path.join(subDir, s.name), "subagent", acc);
        }
      }
    }
  }
}

// Scan every project's transcripts. Returns aggregates only (no paths/content).
export async function scanUsage() {
  const acc = {
    sessionCount: 0,
    totalConvText: 0,
    totalToolOutput: 0,
    duplicateReadCount: 0,
    duplicateReadTokens: 0,
    toolBreakdown: {},
    calledServers: new Set(),
    calledTools: new Set(),
    calledSkills: new Set(),
    minTs: Infinity,
    maxTs: -Infinity,
  };

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    projectDirs = [];
  }

  for (const d of projectDirs) {
    if (d.isDirectory()) {
      await scanProjectDir(path.join(PROJECTS_DIR, d.name), acc);
    }
  }

  const n = acc.sessionCount || 1;
  const spanDays =
    acc.maxTs > acc.minTs ? (acc.maxTs - acc.minTs) / 86400000 : 0;

  // Where tool-output tokens go, grouped into the few categories worth naming
  // in an insight (per session, so it lines up with the other metrics).
  const cats = { read: 0, bash: 0, agent: 0, other: 0 };
  for (const [name, tok] of Object.entries(acc.toolBreakdown)) {
    if (name === "Read") cats.read += tok;
    else if (name === "Bash") cats.bash += tok;
    else if (name === "Agent" || name === "Task") cats.agent += tok;
    else cats.other += tok;
  }

  return {
    sessionCount: acc.sessionCount,
    conversationPerSession: Math.round(acc.totalConvText / n),
    toolOutputPerSession: Math.round(acc.totalToolOutput / n),
    duplicateReads: acc.duplicateReadCount,
    duplicateReadTokensPerSession: Math.round(acc.duplicateReadTokens / n),
    toolBreakdown: {
      read: Math.round(cats.read / n),
      bash: Math.round(cats.bash / n),
      agent: Math.round(cats.agent / n),
      other: Math.round(cats.other / n),
    },
    calledServers: [...acc.calledServers],
    calledTools: [...acc.calledTools],
    calledSkills: [...acc.calledSkills],
    spanDays,
  };
}
