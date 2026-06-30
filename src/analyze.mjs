// Analyzer: turn raw discovery + usage + the MEASURED replay into the report
// payload.
//
// The headline tool-output saving used to be a guessed projection
// (TRIM_RATIO=0.35). It is now MEASURED: replay.mjs runs the user's own past
// tool outputs through the exact shipped trimmer and reports the real saved
// tokens, so the number the report shows is honest by construction. CLAUDE.md
// savings are measured too (the real relocatable token count from the slim
// lever's classifier). Server savings remain catalog-based estimates, labeled
// as such. The payload is numbers + short grade strings only - nothing
// identifying ever leaves the machine (see the /api/scan privacy check), so the
// measured/estimated provenance is carried as NUMERIC flags, never strings.

import { estimateTokens, normalizeServer, serverSessionCost } from "./tokens.mjs";

// Fallback ratios, used ONLY when a measured input is unavailable (e.g. replay
// found no tool output). Deliberately conservative - we under-promise.
const FALLBACK_TRIM_RATIO = 0.1;
const FALLBACK_CLAUDE_MD_KEEP = 0.7;
const DEFERRAL_ON = true; // assume tool-search on -> smaller per-server cost

function round(n) {
  return Math.round(n);
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function pct(from, to) {
  if (from <= 0) return 0;
  return round(((from - to) / from) * 100);
}

// Distinct configured MCP servers (by normalized name) across every surface.
function configuredServers(discovery) {
  const s = discovery.servers || {};
  const all = [
    ...(s.global || []),
    ...(s.project || []),
    ...(s.projectFile || []),
    ...(s.plugin || []),
  ];
  return [...new Set(all.map(normalizeServer))];
}

function gradeNow(overallPct) {
  if (overallPct >= 35) return "D";
  if (overallPct >= 28) return "C";
  if (overallPct >= 22) return "C+";
  if (overallPct >= 15) return "B-";
  if (overallPct >= 8) return "B";
  return "B+";
}

// `extra` carries the measured inputs: { replay, claudeMdSaved }.
export function analyze(discovery, usage, extra = {}) {
  const replay = extra.replay || null;
  const sessions = Math.max(1, usage.sessionCount);

  // --- servers (catalog-estimated) ---
  const configured = configuredServers(discovery);
  const called = new Set((usage.calledServers || []).map(normalizeServer));
  const dead = configured.filter((name) => !called.has(name));
  const serversNow = configured.length;
  const serversOpt = serversNow - dead.length;
  const serverCostNow = configured.reduce(
    (sum, name) => sum + serverSessionCost(name, DEFERRAL_ON),
    0
  );
  const serverSavings = dead.reduce(
    (sum, name) => sum + serverSessionCost(name, DEFERRAL_ON),
    0
  );

  // --- CLAUDE.md (measured if the slim classifier ran, else conservative) ---
  const claudeMdNow = estimateTokens(discovery.contextFiles?.globalClaudeMd);
  const claudeMdMeasured = typeof extra.claudeMdSaved === "number";
  const claudeMdSavings = claudeMdMeasured
    ? Math.min(Math.max(0, extra.claudeMdSaved), claudeMdNow)
    : round(claudeMdNow * (1 - FALLBACK_CLAUDE_MD_KEEP));
  const claudeMdOpt = Math.max(0, claudeMdNow - claudeMdSavings);

  // --- tool output: remove duplicate re-reads, then trim the rest (MEASURED) ---
  const toolOutNow = usage.toolOutputPerSession;
  const dupPerSession = Math.min(usage.duplicateReadTokensPerSession || 0, toolOutNow);
  const room = Math.max(0, toolOutNow - dupPerSession);
  // Measured per-session trim = total saved tokens across all transcripts / the
  // session count, clamped so it never exceeds the room actually available.
  const measuredTrimPerSession = replay ? round((replay.savedTokens || 0) / sessions) : null;
  const trimMeasured = measuredTrimPerSession != null;
  const toolTrim = Math.min(
    trimMeasured ? measuredTrimPerSession : round(room * FALLBACK_TRIM_RATIO),
    room
  );
  const toolOutOpt = Math.max(0, toolOutNow - dupPerSession - toolTrim);
  const toolOutSavings = toolOutNow - toolOutOpt;

  // --- session tokens = thread footprint: header + conversation + tool output ---
  const otherContext =
    estimateTokens(discovery.contextFiles?.projectClaudeMd) +
    estimateTokens(discovery.contextFiles?.projectAgentsMd);
  const headerNow = claudeMdNow + otherContext + serverCostNow;
  const tokensNow = headerNow + usage.conversationPerSession + toolOutNow;
  const totalSavings = toolOutSavings + serverSavings + claudeMdSavings;
  const tokensOpt = Math.max(0, tokensNow - totalSavings);

  const overallPct = pct(tokensNow, tokensOpt);
  const savedPerSession = tokensNow - tokensOpt;

  // --- monthly projection from the active date span ---
  const span = usage.spanDays > 0.5 ? usage.spanDays : usage.sessionCount;
  const sessionsPerMonth =
    usage.spanDays > 0.5 ? (usage.sessionCount / span) * 30 : usage.sessionCount;
  const savedPerMonth = savedPerSession * sessionsPerMonth;
  const savedPerMonthM = savedPerMonth / 1_000_000;

  return {
    v: 1,
    sessions: usage.sessionCount,
    toolBreakdown: usage.toolBreakdown,
    now: {
      tokensPerSession: tokensNow,
      toolOutputPerSession: toolOutNow,
      mcpServersLoaded: serversNow,
      claudeMdTokens: claudeMdNow,
      duplicateReads: usage.duplicateReads,
    },
    optimized: {
      tokensPerSession: tokensOpt,
      toolOutputPerSession: toolOutOpt,
      mcpServersLoaded: serversOpt,
      claudeMdTokens: claudeMdOpt,
      duplicateReads: 0,
    },
    derived: {
      overallPct,
      savedPerSession,
      savedPerMonthLoM: round1(savedPerMonthM * 0.85),
      savedPerMonthHiM: round1(savedPerMonthM * 1.2),
      perRowPct: {
        tokensPerSession: overallPct,
        toolOutputPerSession: pct(toolOutNow, toolOutOpt),
        mcpServersLoaded: pct(serversNow, serversOpt),
        claudeMdTokens: pct(claudeMdNow, claudeMdOpt),
        duplicateReads: usage.duplicateReads > 0 ? 100 : 0,
      },
      gradeNow: gradeNow(overallPct),
      gradeOptimized: overallPct >= 22 ? "A+" : "A",
      deadServers: dead.length,
      savings: {
        servers: Math.round(serverSavings),
        claudeMd: Math.round(claudeMdSavings),
        duplicates: Math.round(dupPerSession),
        toolTrim: Math.max(0, Math.round(toolTrim)),
      },
      // Provenance flags (NUMBERS only - 1 = measured on your bytes, 0 =
      // conservative estimate). The privacy filter rejects any non-grade
      // string, so we never ship a "measured"/"estimated" label here.
      basis: {
        toolTrim: trimMeasured ? 1 : 0,
        claudeMd: claudeMdMeasured ? 1 : 0,
        servers: 0,
        duplicates: 1,
      },
      // The replay's own measured numbers (for an honest "measured on N tool
      // results" line on the report).
      measured: {
        toolCutPct: replay ? replay.toolCutPct : 0,
        toolResultsScanned: replay ? replay.resultCount : 0,
        toolResultsTrimmed: replay ? replay.trimmedCount : 0,
      },
    },
  };
}
