// Lever (a): disable MCP servers that the transcripts show were never called.
//
// Mechanism (verified against real Claude Code config, 2026-06):
//  - .mcp.json (project-file) servers  -> add the name to disabledMcpjsonServers
//    in <cwd>/.claude/settings.local.json (the supported, reversible toggle).
//  - user-scope servers in ~/.claude.json mcpServers, and project-entry servers
//    in ~/.claude.json projects[cwd].mcpServers -> MOVE the block aside into a
//    UsageCut-owned key __usagecut_disabledMcpServers (Claude Code ignores
//    unknown top-level keys). Never delete and never `claude mcp remove`, so the
//    exact config is recoverable. Restore = move the block back.
//  - plugin-provided servers -> never auto-touch; advise disabling the plugin.
//
// "Dead" = configured but not present in calledServers (which already includes
// sub-agent transcripts, so a server used only inside a sub-agent is NOT dead).

import os from "node:os";
import path from "node:path";
import { discover, readFileSafe } from "../../discover.mjs";
import { scanUsage } from "../../usage.mjs";
import { normalizeServer, serverProfile } from "../../tokens.mjs";

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");

// From the full set of called tool names, return the per-tool map for MCP tools:
//   { <normalizedServer>: Set("<toolName>", ...) }
// A called name looks like "mcp__<server>__<tool>" (server may itself contain a
// plugin_ prefix, which normalizeServer collapses).
function calledToolsByServer(calledTools) {
  const map = new Map();
  for (const raw of calledTools || []) {
    if (typeof raw !== "string" || !raw.startsWith("mcp__")) continue;
    const rest = raw.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep < 0) continue;
    const serverPart = rest.slice(0, sep);
    const tool = rest.slice(sep + 2);
    if (!tool) continue;
    const key = normalizeServer(serverPart);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(tool);
  }
  return map;
}

// De-dupe server identifiers while preserving first-seen order.
function uniqueServers(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// Mask secret-ish values (env, headers) before previewing a server block.
function maskServer(block) {
  if (!block || typeof block !== "object") return block;
  const clone = JSON.parse(JSON.stringify(block));
  for (const key of ["env", "headers"]) {
    if (clone[key] && typeof clone[key] === "object") {
      for (const k of Object.keys(clone[key])) clone[key][k] = "***";
    }
  }
  return clone;
}

export async function planDeadMcp(cwd = process.cwd()) {
  const discovery = discover(cwd);
  const usage = await scanUsage();
  const called = new Set((usage.calledServers || []).map(normalizeServer));
  const isDead = (name) => !called.has(normalizeServer(name));

  const globalDead = (discovery.servers.global || []).filter(isDead);
  const projectDead = (discovery.servers.project || []).filter(isDead);
  const fileDead = (discovery.servers.projectFile || []).filter(isDead);
  const pluginDead = (discovery.servers.plugin || []).filter(isDead);

  const changes = [];
  const items = [];

  // ~/.claude.json : move user-scope + project-entry dead servers aside
  if (globalDead.length || projectDead.length) {
    const before = readFileSafe(CLAUDE_JSON);
    if (before) {
      const obj = JSON.parse(before);
      obj.__usagecut_disabledMcpServers = obj.__usagecut_disabledMcpServers || {};

      for (const name of globalDead) {
        const block = (obj.mcpServers || {})[name];
        if (block === undefined) continue;
        obj.__usagecut_disabledMcpServers[name] = { scope: "user", server: block };
        delete obj.mcpServers[name];
        items.push({ name, scope: "user (global)", block: maskServer(block) });
      }
      for (const name of projectDead) {
        const proj = (obj.projects || {})[cwd] || {};
        const block = (proj.mcpServers || {})[name];
        if (block === undefined) continue;
        obj.__usagecut_disabledMcpServers[`${cwd}::${name}`] = {
          scope: "project-entry",
          project: cwd,
          server: block,
        };
        delete proj.mcpServers[name];
        items.push({ name, scope: "project entry", block: maskServer(block) });
      }

      const after = JSON.stringify(obj, null, 2) + "\n";
      if (after !== before) {
        changes.push({ file: CLAUDE_JSON, before, after, reformatsWholeFile: true });
      }
    }
  }

  // .claude/settings.local.json : disable dead .mcp.json servers
  if (fileDead.length) {
    const p = path.join(cwd, ".claude", "settings.local.json");
    const before = readFileSafe(p);
    const obj = before ? JSON.parse(before) : {};
    const set = new Set(obj.disabledMcpjsonServers || []);
    const added = [];
    for (const name of fileDead) {
      if (!set.has(name)) {
        set.add(name);
        added.push(name);
      }
    }
    if (added.length) {
      obj.disabledMcpjsonServers = [...set];
      const after = JSON.stringify(obj, null, 2) + "\n";
      changes.push({ file: p, before: before || null, after });
      added.forEach((name) => items.push({ name, scope: ".mcp.json (project)", block: null }));
    }
  }

  const advisories = [];
  if (pluginDead.length) {
    advisories.push(
      `Plugin servers look idle (${pluginDead.join(", ")}). Disable the plugin itself in settings rather than the server - UsageCut will not auto-touch these.`
    );
  }

  // ---- per-tool filtering for IN-USE servers ----------------------------
  // A server that IS used but where only a subset of its tools were ever called
  // is loading dead tool schemas every session. We can name the called subset
  // exactly (from calledTools); whether ALL its remaining tools are dead can
  // only be known if we can enumerate the full tool set. We do NOT have a
  // verified-safe settings key for per-tool MCP filtering yet, so this is
  // emitted as an ADVISORY (the exact called tools, plus the recommended
  // reversible move), never a risky write.
  const calledByServer = calledToolsByServer(usage.calledTools);
  const usedServerNames = uniqueServers([
    ...(discovery.servers.global || []),
    ...(discovery.servers.project || []),
    ...(discovery.servers.projectFile || []),
    ...(discovery.servers.plugin || []),
  ]).filter((name) => called.has(normalizeServer(name)));

  const toolFilterItems = [];
  for (const name of usedServerNames) {
    const key = normalizeServer(name);
    const used = calledByServer.get(key);
    if (!used || used.size === 0) continue; // server flagged used via subagent-only path
    const profile = serverProfile(name);
    // Only suggest trimming when the server is known-broad AND we saw strictly
    // fewer distinct tools than it exposes (otherwise we cannot claim any are
    // dead without guessing).
    if (!profile.known || profile.toolCount <= used.size) continue;
    const unusedCount = profile.toolCount - used.size;
    const usedList = [...used].sort();
    toolFilterItems.push({ server: key, usedTools: usedList, unusedCount });
    advisories.push(
      `Server "${key}" is used, but only ${used.size} of ~${profile.toolCount} tools were ever ` +
        `called (${usedList.join(", ")}). The other ~${unusedCount} load their schemas every ` +
        `session for nothing. If your client supports an allowed-tools filter, restrict ${key} ` +
        `to just those tools to stop the rest from loading - UsageCut leaves this to you because ` +
        `the safe, reversible key is not yet pinned.`
    );
  }

  const configured =
    (discovery.servers.global || []).length +
    (discovery.servers.project || []).length +
    (discovery.servers.projectFile || []).length +
    (discovery.servers.plugin || []).length;

  return {
    changes,
    items,
    advisories,
    toolFilters: toolFilterItems,
    counts: {
      configured,
      dead: items.length,
      toolFilterCandidates: toolFilterItems.length,
    },
  };
}
