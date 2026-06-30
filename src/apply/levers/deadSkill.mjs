// Lever: find on-disk skills/plugins that the transcripts show were never used.
//
// Mechanism (verified against real Claude Code layout, 2026-06):
//  - Installed plugins are listed in ~/.claude/plugins/installed_plugins.json,
//    each with an installPath that contains skills/<name>/SKILL.md (or, for
//    skill-style marketplaces, .claude/skills/<name>/SKILL.md). discover.mjs
//    enumerates both via discoverSkills() / discoverInstalledPlugins().
//  - usage.calledSkills lists every skill invoked through the "Skill" tool across
//    all transcripts (main + sub-agent), so a skill used only inside a sub-agent
//    is NOT counted as dead.
//  - ~/.claude.json pluginUsage[<plugin>@<marketplace>] carries a usageCount the
//    harness maintains; a plugin with usageCount 0 AND no invoked skills is idle.
//
// Actions, conservative + reversible:
//  - A WHOLLY-DEAD PLUGIN (every one of its skills unused and pluginUsage shows
//    no use) -> a declarative settingsMutation {op:"ensureDisabledPlugin",name}.
//    The integrator applies all settings.json mutations through one merge.
//  - INDIVIDUAL dead skills inside an otherwise-used plugin -> advisory only. We
//    never delete a user's skill files.

import { discover, discoverSkills, discoverInstalledPlugins } from "../../discover.mjs";
import { scanUsage } from "../../usage.mjs";

// Normalise a skill identifier for comparison. calledSkills may carry either the
// bare skill name ("brainstorming") or a plugin-qualified form
// ("superpowers:brainstorming" / "plugin:skill"); we compare on the bare tail.
function bareSkill(name) {
  const s = String(name || "").toLowerCase().trim();
  const colon = s.lastIndexOf(":");
  return colon >= 0 ? s.slice(colon + 1) : s;
}

export async function planDeadSkill(cwd = process.cwd()) {
  const discovery = discover(cwd);
  const usage = await scanUsage();

  const installedSkills = discoverSkills(); // [{ skill, pluginId, pluginName, dir }]
  const installedPlugins = discoverInstalledPlugins(); // [{ id, name, ... }]
  const pluginUsage = discovery.pluginUsage || {};

  // Set of skill names actually invoked (bare, lowercased).
  const calledSkills = new Set((usage.calledSkills || []).map(bareSkill));

  // A plugin is "used" if its pluginUsage count is > 0.
  const pluginUsed = (id) => {
    const u = pluginUsage[id];
    return Boolean(u && typeof u.usageCount === "number" && u.usageCount > 0);
  };

  // Per-plugin: collect its skills and whether any were invoked.
  const byPlugin = new Map(); // pluginId -> { name, skills:[{skill,used}], anyUsed }
  for (const s of installedSkills) {
    const entry =
      byPlugin.get(s.pluginId) ||
      { id: s.pluginId, name: s.pluginName, skills: [], anyUsed: false };
    const used = calledSkills.has(bareSkill(s.skill));
    entry.skills.push({ skill: s.skill, used });
    if (used) entry.anyUsed = true;
    byPlugin.set(s.pluginId, entry);
  }

  const settingsMutations = [];
  const items = [];
  const advisories = [];
  let deadSkillCount = 0;
  let deadPluginCount = 0;

  // De-dupe plugin names across the (id-keyed) byPlugin map and the install list,
  // since a plugin may have install records but no discoverable skills.
  const handledPlugins = new Set();

  for (const [id, entry] of byPlugin) {
    handledPlugins.add(id);
    const skillsUsedAnywhere = entry.anyUsed;
    const pluginInvoked = pluginUsed(id);
    const wholeDead = !skillsUsedAnywhere && !pluginInvoked;

    if (wholeDead) {
      deadPluginCount += 1;
      // ensureDisabledPlugin keys on the plugin id (the same "<name>@<market>"
      // form Claude Code uses in enabledPlugins/pluginUsage).
      settingsMutations.push({ op: "ensureDisabledPlugin", name: id });
      items.push({
        kind: "plugin",
        plugin: id,
        skills: entry.skills.map((s) => s.skill),
        action: "disable plugin (reversible via settings)",
      });
    } else {
      // Plugin is used overall, but flag its individual never-invoked skills.
      const deadSkills = entry.skills.filter((s) => !s.used).map((s) => s.skill);
      if (deadSkills.length) {
        deadSkillCount += deadSkills.length;
        items.push({
          kind: "skill",
          plugin: id,
          skills: deadSkills,
          action: "advisory only",
        });
        advisories.push(
          `Plugin "${id}" is used, but ${deadSkills.length} of its skill(s) were never ` +
            `invoked (${deadSkills.join(", ")}). UsageCut will not delete skill files; ` +
            `remove them by hand if you want the disk + listing trimmed.`
        );
      }
    }
  }

  // Plugins with install records but no discoverable skills: only judge them via
  // pluginUsage so we never falsely flag a plugin we could not introspect.
  for (const plug of installedPlugins) {
    if (handledPlugins.has(plug.id)) continue;
    handledPlugins.add(plug.id);
    if (pluginUsage[plug.id] === undefined) continue; // unknown to harness, skip
    if (!pluginUsed(plug.id)) {
      deadPluginCount += 1;
      settingsMutations.push({ op: "ensureDisabledPlugin", name: plug.id });
      items.push({
        kind: "plugin",
        plugin: plug.id,
        skills: [],
        action: "disable plugin (reversible via settings)",
      });
    }
  }

  return {
    changes: [],
    settingsMutations,
    items,
    advisories,
    counts: { deadSkills: deadSkillCount, deadPlugins: deadPluginCount },
  };
}
