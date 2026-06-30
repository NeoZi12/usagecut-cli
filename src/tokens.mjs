// Approximate token estimation + a curated catalog of well-known MCP servers.
//
// Every number here is an ESTIMATE. We use the standard chars/4 heuristic for
// free text and curated per-server figures for tool schemas. The report labels
// these as approximate everywhere - we would rather under-promise than inflate.

const CHARS_PER_TOKEN = 4;

// Stable identifier for the tokenizer used everywhere a before/after count is
// produced. The absolute counts are approximate (chars/4), but because the scan,
// the replay measurement, and the live hook all run the IDENTICAL function, the
// before/after RATIO is exact. Bump this id if the heuristic ever changes.
export const TOKENIZER_ID = "chars-4-v1";

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.round(text.length / CHARS_PER_TOKEN);
}

// Tool-name tokens loaded per tool even when schemas are deferred (the name plus
// a small wrapper). Deferred loading (tool-search) hides full schemas but still
// surfaces every tool name into context.
const NAME_TOKENS_PER_TOOL = 8;

// Curated estimates captured 2026-06 for the servers we see most often.
//   toolCount         approx number of tools the server exposes
//   instructionTokens the server's "instructions" block injected every session
//   fullSchemaTokens  approx cost of ALL tool schemas (loaded when deferral is OFF)
export const MCP_CATALOG = {
  github: { toolCount: 70, instructionTokens: 120, fullSchemaTokens: 14000 },
  playwright: { toolCount: 30, instructionTokens: 80, fullSchemaTokens: 5200 },
  supabase: { toolCount: 28, instructionTokens: 320, fullSchemaTokens: 5000 },
  sentry: { toolCount: 10, instructionTokens: 200, fullSchemaTokens: 2200 },
  context7: { toolCount: 2, instructionTokens: 180, fullSchemaTokens: 600 },
  tavily: { toolCount: 5, instructionTokens: 60, fullSchemaTokens: 1500 },
  exa: { toolCount: 2, instructionTokens: 40, fullSchemaTokens: 700 },
  vercel: { toolCount: 3, instructionTokens: 40, fullSchemaTokens: 900 },
  xcodebuildmcp: { toolCount: 45, instructionTokens: 360, fullSchemaTokens: 9000 },
  posthog: { toolCount: 110, instructionTokens: 700, fullSchemaTokens: 20000 },
};

// Fallback profile for servers we do not recognise. Deliberately conservative.
const GENERIC = { toolCount: 12, instructionTokens: 80, fullSchemaTokens: 2500 };

export function serverProfile(name) {
  const norm = normalizeServer(name);
  const key = Object.keys(MCP_CATALOG).find((k) => norm === k || norm.includes(k));
  const base = key ? MCP_CATALOG[key] : GENERIC;
  return { ...base, known: Boolean(key) };
}

// Tokens a server costs PER SESSION given whether deferral / tool-search is on.
// Deferral on  -> instructions + tool names only.
// Deferral off -> instructions + every full tool schema.
export function serverSessionCost(name, deferralOn) {
  const p = serverProfile(name);
  const nameTokens = p.toolCount * NAME_TOKENS_PER_TOOL;
  return deferralOn
    ? p.instructionTokens + nameTokens
    : p.instructionTokens + p.fullSchemaTokens;
}

// Normalise a raw server identifier to a comparable key.
// Handles plugin-prefixed names like "plugin_posthog_posthog" -> "posthog"
// and the transcript form "mcp__plugin_posthog_posthog__exec".
export function normalizeServer(name) {
  let n = String(name || "").toLowerCase();
  n = n.replace(/^mcp__/, "").replace(/__.*$/, "");
  if (n.startsWith("plugin_")) {
    const parts = n.split("_").filter(Boolean);
    n = parts[parts.length - 1];
  }
  return n;
}
