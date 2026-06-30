// The ONE non-clobbering merge utility for ~/.claude/settings.json. Every hook
// installer (the PostToolUse trimmer, the PreToolUse read guard, the cache-bust
// statusLine, the retrieve MCP server, env writes) composes through these pure
// helpers so that two levers applied in one run never overwrite each other.
//
// These functions mutate a parsed settings OBJECT in place and report whether
// they changed anything (idempotent: applying twice is a no-op). The engine
// reads the file once, runs every helper, then writes once - so there is a
// single read-modify-write per apply, never one per lever.

import { readFileSafe } from "../discover.mjs";

// Parse a settings.json into an object (empty object if missing/!valid).
export function loadSettingsObject(filePath) {
  const before = readFileSafe(filePath);
  if (!before) return { before: null, obj: {} };
  try {
    return { before, obj: JSON.parse(before) };
  } catch {
    // A malformed settings.json must never be clobbered - signal the caller.
    return { before, obj: null };
  }
}

// Serialize the way the rest of the codebase does (2-space + trailing newline).
export function serializeSettings(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

// Ensure a command hook exists under hooks[event] for `matcher`. Idempotent.
// Returns true if it added the hook, false if it was already present.
export function ensureHook(settings, event, matcher, command, { timeout } = {}) {
  settings.hooks = settings.hooks || {};
  const arr = (settings.hooks[event] = settings.hooks[event] || []);
  let group = arr.find((g) => g && g.matcher === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    arr.push(group);
  }
  group.hooks = group.hooks || [];
  if (group.hooks.some((h) => h && h.command === command)) return false;
  group.hooks.push({ type: "command", command, ...(timeout ? { timeout } : {}) });
  return true;
}

// Remove every command hook whose command contains `substr` (used by revert /
// uninstall). Prunes emptied groups and events. Returns true if anything changed.
export function removeHookByCommand(settings, substr) {
  if (!settings.hooks || typeof settings.hooks !== "object") return false;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const arr = settings.hooks[event];
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(
        (h) => !(h && typeof h.command === "string" && h.command.includes(substr))
      );
      if (group.hooks.length !== before) changed = true;
    }
    settings.hooks[event] = arr.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}

// Ensure settings.env[key] === value. Returns true if it changed the value.
export function ensureEnv(settings, key, value) {
  settings.env = settings.env || {};
  if (settings.env[key] === value) return false;
  settings.env[key] = value;
  return true;
}

// Remove settings.env[key] if present. Returns true if it changed anything.
export function removeEnv(settings, key) {
  if (!settings.env || !(key in settings.env)) return false;
  delete settings.env[key];
  if (Object.keys(settings.env).length === 0) delete settings.env;
  return true;
}

// Ensure an MCP server entry exists in settings.mcpServers[name]. Idempotent.
export function ensureMcpServer(settings, name, spec) {
  settings.mcpServers = settings.mcpServers || {};
  if (settings.mcpServers[name]) return false;
  settings.mcpServers[name] = spec;
  return true;
}

export function removeMcpServer(settings, name) {
  if (!settings.mcpServers || !(name in settings.mcpServers)) return false;
  delete settings.mcpServers[name];
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  return true;
}

// Set settings.statusLine only when the user has none (never clobber an existing
// one). Returns true if it set ours, false if one was already configured.
export function ensureStatusLine(settings, command) {
  if (settings.statusLine) return false;
  settings.statusLine = { type: "command", command };
  return true;
}

export function removeStatusLine(settings, command) {
  if (
    settings.statusLine &&
    typeof settings.statusLine === "object" &&
    settings.statusLine.command === command
  ) {
    delete settings.statusLine;
    return true;
  }
  return false;
}

// Disable a plugin by id (the "<name>@<marketplace>" form Claude Code uses).
// Sets enabledPlugins[id] = false. Returns true if it changed the value.
export function ensureDisabledPlugin(settings, id) {
  settings.enabledPlugins = settings.enabledPlugins || {};
  if (settings.enabledPlugins[id] === false) return false;
  settings.enabledPlugins[id] = false;
  return true;
}

export function ensureEnabledPlugin(settings, id) {
  if (!settings.enabledPlugins || !(id in settings.enabledPlugins)) return false;
  delete settings.enabledPlugins[id];
  if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
  return true;
}

// Apply one declarative settings mutation (the {op, ...} shape levers emit).
// Returns true if it changed the settings object. The engine collects every
// lever's mutations and applies them all to ONE settings object, then writes
// once - so two levers can never clobber each other's settings.json edit.
export function applyMutation(settings, m) {
  switch (m.op) {
    case "ensureEnv":
      return ensureEnv(settings, m.key, m.value);
    case "removeEnv":
      return removeEnv(settings, m.key);
    case "ensureHook":
      return ensureHook(settings, m.event, m.matcher, m.command, { timeout: m.timeout });
    case "ensureStatusLine":
      return ensureStatusLine(settings, m.command);
    case "ensureMcpServer":
      return ensureMcpServer(settings, m.name, m.spec);
    case "ensureDisabledPlugin":
      return ensureDisabledPlugin(settings, m.name);
    default:
      return false;
  }
}
