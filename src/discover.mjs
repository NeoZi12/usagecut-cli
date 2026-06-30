// Discovery: locate every config surface Claude Code loads into context.
// Pure reads, no writes. Everything stays local.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, ".claude");

export function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  const t = readFileSafe(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// The slug Claude Code uses for a project's transcript directory:
// the absolute cwd with every non-alphanumeric char replaced by "-".
export function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function discover(cwd = process.cwd()) {
  const claudeJson = readJsonSafe(path.join(HOME, ".claude.json")) || {};
  const settings = readJsonSafe(path.join(CLAUDE_DIR, "settings.json")) || {};
  const settingsLocal = readJsonSafe(path.join(CLAUDE_DIR, "settings.local.json")) || {};
  const projectSettings = readJsonSafe(path.join(cwd, ".claude", "settings.json")) || {};

  const globalServers = Object.keys(claudeJson.mcpServers || {});
  const projectEntry = (claudeJson.projects || {})[cwd] || {};
  const projectServers = Object.keys(projectEntry.mcpServers || {});

  const projectMcp = readJsonSafe(path.join(cwd, ".mcp.json"));
  const projectMcpServers = projectMcp ? Object.keys(projectMcp.mcpServers || {}) : [];

  const pluginServers = discoverPluginServers();

  return {
    cwd,
    claudeJson,
    settings,
    settingsLocal,
    projectSettings,
    pluginUsage: claudeJson.pluginUsage || {},
    servers: {
      global: globalServers,
      project: projectServers,
      projectFile: projectMcpServers,
      plugin: pluginServers,
    },
    contextFiles: {
      globalClaudeMd: readFileSafe(path.join(CLAUDE_DIR, "CLAUDE.md")),
      projectClaudeMd: readFileSafe(path.join(cwd, "CLAUDE.md")),
      projectAgentsMd: readFileSafe(path.join(cwd, "AGENTS.md")),
    },
  };
}

// ---------------------------------------------------------------------------
// Skill + plugin discovery (used by the deadSkill lever).
// ---------------------------------------------------------------------------

const PLUGINS_DIR = path.join(CLAUDE_DIR, "plugins");

// Parse the `name:` field out of a SKILL.md YAML frontmatter block, falling back
// to the containing directory name. Pure read, no YAML dependency: we only need
// the one scalar field and the frontmatter is a simple `key: value` block.
function skillNameFromFile(file, dirName) {
  const text = readFileSafe(file);
  if (text) {
    const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const nm = m[1].match(/^\s*name\s*:\s*(.+?)\s*$/m);
      if (nm) {
        let v = nm[1].trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (v) return v;
      }
    }
  }
  return dirName;
}

// List the immediate skill subdirectories that contain a SKILL.md, in one of the
// two layouts we see in the wild: <root>/skills/<name>/SKILL.md (most plugins)
// and <root>/.claude/skills/<name>/SKILL.md (skill-style marketplaces). Returns
// [{ name, dir, file }].
function readSkillsUnder(root) {
  const found = [];
  for (const sub of ["skills", path.join(".claude", "skills")]) {
    const base = path.join(root, sub);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      const file = path.join(dir, "SKILL.md");
      let ok = false;
      try {
        ok = fs.statSync(file).isFile();
      } catch {
        ok = false;
      }
      if (ok) found.push({ name: skillNameFromFile(file, e.name), dir, file });
    }
  }
  return found;
}

// Read ~/.claude/plugins/installed_plugins.json (v2 shape: { plugins: { "<id>":
// [ { installPath, scope, ... } ] } }). Returns [{ id, name, marketplace,
// installPath, scope }] for every install record we can resolve to a directory.
export function discoverInstalledPlugins() {
  const j = readJsonSafe(path.join(PLUGINS_DIR, "installed_plugins.json"));
  const out = [];
  const plugins = (j && j.plugins) || {};
  for (const [id, records] of Object.entries(plugins)) {
    const list = Array.isArray(records) ? records : [records];
    const [name, marketplace] = id.split("@");
    for (const rec of list) {
      if (!rec || typeof rec !== "object") continue;
      out.push({
        id,
        name: name || id,
        marketplace: marketplace || "",
        installPath: rec.installPath || null,
        scope: rec.scope || "user",
      });
    }
  }
  return out;
}

// Discover every skill installed on disk, attributed to its owning plugin.
// Returns [{ skill, pluginId, pluginName, dir }]. The same skill name appearing
// under multiple install records is de-duplicated per (pluginId, skill).
export function discoverSkills() {
  const installed = discoverInstalledPlugins();
  const out = [];
  const seen = new Set();
  for (const plug of installed) {
    if (!plug.installPath) continue;
    for (const sk of readSkillsUnder(plug.installPath)) {
      const key = `${plug.id}::${sk.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        skill: sk.name,
        pluginId: plug.id,
        pluginName: plug.name,
        dir: sk.dir,
      });
    }
  }
  return out;
}

// Plugin-provided MCP servers: scan ~/.claude/plugins for any .mcp.json.
function discoverPluginServers() {
  const dir = path.join(CLAUDE_DIR, "plugins");
  const out = new Set();
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === ".mcp.json") {
        const j = readJsonSafe(full);
        if (j && j.mcpServers) for (const k of Object.keys(j.mcpServers)) out.add(k);
      }
    }
  };
  walk(dir, 0);
  return [...out];
}
