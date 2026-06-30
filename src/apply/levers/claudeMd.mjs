// Lever (b): slim the always-loaded global ~/.claude/CLAUDE.md.
//
// Mechanism (verified against the build plan, 2026-06):
//  - The global CLAUDE.md is injected into EVERY session, every project. Rules
//    that only apply to certain file types / dirs / tasks are pure overhead the
//    rest of the time. Claude Code supports path-scoped lazy rules at
//    ~/.claude/rules/<slug>.md with `paths:` frontmatter - those load only when a
//    matching file is touched. Moving a conditional section there is a real,
//    lossless saving. (Do NOT use @import - imported files still load fully.)
//
// This lever is DETERMINISTIC and NEVER paraphrases. It classifies each heading
// section by heading + content heuristics only, and when it relocates a section
// it copies the VERBATIM bytes. If it cannot derive confident path globs for a
// section, it leaves that section in place (safer to under-deliver).
//
// Safety rails:
//  - HARDLINK/SYMLINK guard: a synced OneDrive hardlink (or any symlink) must not
//    be rewritten - we advise the user to trim it manually and touch nothing.
//  - Honesty: if the file is mostly unconditional, we say so and relocate little
//    or nothing, reporting the genuine always-loaded token count.

import path from "node:path";
import { CLAUDE_DIR, readFileSafe } from "../../discover.mjs";
import { linkInfo } from "../atomic.mjs";
import { estimateTokens } from "../../tokens.mjs";

const GLOBAL_CLAUDE_MD = path.join(CLAUDE_DIR, "CLAUDE.md");
const RULES_DIR = path.join(CLAUDE_DIR, "rules");

// ---------------------------------------------------------------------------
// Section parsing. Split the markdown into top-level (## / #) heading sections.
// Anything before the first heading is the "preamble" and is always kept.
// ---------------------------------------------------------------------------

function parseSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let preamble = [];
  let current = null;
  let inFence = false;

  for (const line of lines) {
    // Track fenced code blocks so a "#" inside a code fence is not a heading.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const headingMatch = !inFence ? line.match(/^(#{1,3})\s+(.+?)\s*$/) : null;
    // Only treat level-1/2 headings as section boundaries; level-3 stays inside
    // its parent section (sub-rules travel with the rule they belong to).
    if (headingMatch && headingMatch[1].length <= 2) {
      if (current) sections.push(current);
      current = { heading: headingMatch[2], level: headingMatch[1].length, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  for (const s of sections) {
    s.text = s.lines.join("\n");
    s.body = s.lines.slice(1).join("\n");
  }
  return { preamble: preamble.join("\n"), sections };
}

// ---------------------------------------------------------------------------
// Path-glob derivation. We only relocate a section when its OWN text names a
// concrete file type, extension, or directory we can turn into a glob. No glob
// -> no relocate.
// ---------------------------------------------------------------------------

// Common language/framework -> file-extension globs. Kept small and explicit;
// when in doubt we under-deliver rather than guess.
const LANG_GLOBS = {
  typescript: ["**/*.ts", "**/*.tsx"],
  ts: ["**/*.ts", "**/*.tsx"],
  tsx: ["**/*.tsx"],
  javascript: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  js: ["**/*.js", "**/*.mjs", "**/*.cjs"],
  jsx: ["**/*.jsx"],
  python: ["**/*.py"],
  py: ["**/*.py"],
  rust: ["**/*.rs"],
  go: ["**/*.go"],
  golang: ["**/*.go"],
  java: ["**/*.java"],
  kotlin: ["**/*.kt", "**/*.kts"],
  swift: ["**/*.swift"],
  ruby: ["**/*.rb"],
  php: ["**/*.php"],
  css: ["**/*.css"],
  scss: ["**/*.scss", "**/*.css"],
  html: ["**/*.html"],
  sql: ["**/*.sql"],
  markdown: ["**/*.md"],
  md: ["**/*.md"],
  yaml: ["**/*.yml", "**/*.yaml"],
  json: ["**/*.json"],
};

function uniq(arr) {
  return [...new Set(arr)];
}

// Derive globs from a section's own heading + body. Returns a sorted, de-duped
// array (possibly empty). Sources, in order of confidence:
//   1. explicit extensions written as `.ts`, `*.py`, `src/**/*.ts`
//   2. directory-ish tokens like `src/api/`, `lib/`, `tests/`
//   3. a language/framework name in the heading mapped via LANG_GLOBS
function deriveGlobs(section) {
  const hay = `${section.heading}\n${section.body}`;
  const globs = [];

  // 1. Already-glob or extension tokens. Capture `foo/**/*.ts`, `*.py`, `.tsx`.
  const globToken = /(?:[\w./*-]*\*\*?[\w./*-]*\.[a-z0-9]+|(?:^|[\s(`'"])\*?\.[a-z0-9]{1,5})(?=$|[\s),.`'"])/gim;
  let mm;
  while ((mm = globToken.exec(hay)) !== null) {
    let tok = mm[0].trim().replace(/^[("'`]+/, "").replace(/[)"'`]+$/, "");
    if (!tok) continue;
    if (tok.startsWith(".")) tok = `**/*${tok}`; // ".ts" -> "**/*.ts"
    else if (tok.startsWith("*.")) tok = `**/${tok}`; // "*.py" -> "**/*.py"
    if (/\.[a-z0-9]+$/i.test(tok)) globs.push(tok);
  }

  // 2. Directory tokens written with a trailing slash, e.g. `src/api/`, `lib/`.
  const dirToken = /(?:^|[\s(`'"])((?:[\w-]+\/){1,5})(?=[\s),.`'"]|$)/gim;
  while ((mm = dirToken.exec(hay)) !== null) {
    const dir = mm[1].replace(/\/+$/, "");
    if (dir && !/^https?:/.test(dir)) globs.push(`${dir}/**/*`);
  }

  // 3. Language/framework named in the HEADING (most reliable signal).
  const headingWords = section.heading.toLowerCase().split(/[^a-z0-9+]+/);
  for (const w of headingWords) {
    if (LANG_GLOBS[w]) globs.push(...LANG_GLOBS[w]);
  }

  return uniq(globs).sort();
}

// ---------------------------------------------------------------------------
// Classification. Heading + content heuristics only.
//   "conditional"       applies only to certain paths/file types/tasks
//   "verbose-reference" long reference text - a pointer candidate
//   "duplicate"         near-identical heading to an earlier section
//   "unconditional"     always-on; stays put
// ---------------------------------------------------------------------------

const CONDITIONAL_PHRASES = [
  "when working on",
  "when working with",
  "when editing",
  "when you work on",
  "for files",
  "for .",
  "for the frontend",
  "for the backend",
  "in this directory",
  "in this folder",
  "applies to",
  "applies only",
  "only applies",
  "only when",
  "files in",
  "when touching",
  "when modifying",
];

function normalizeHeading(h) {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function classifySections(sections) {
  const seenHeadings = new Map();
  for (const s of sections) {
    const key = normalizeHeading(s.heading);
    const hayLower = `${s.heading}\n${s.body}`.toLowerCase();
    const globs = deriveGlobs(s);

    // Duplicate: an earlier section shares the normalized heading.
    if (seenHeadings.has(key)) {
      s.kind = "duplicate";
      s.globs = globs;
      s.duplicateOf = seenHeadings.get(key);
      continue;
    }
    seenHeadings.set(key, s.heading);

    const hasConditionalPhrase = CONDITIONAL_PHRASES.some((p) => hayLower.includes(p));
    // A section is conditional ONLY if we can also derive globs - otherwise we
    // cannot scope it safely, so it is treated as unconditional (kept).
    if (globs.length && (hasConditionalPhrase || headingNamesScope(s.heading))) {
      s.kind = "conditional";
      s.globs = globs;
      continue;
    }

    // Verbose reference: long section with no actionable conditional scope.
    if (estimateTokens(s.text) >= 400) {
      s.kind = "verbose-reference";
      s.globs = globs;
      continue;
    }

    s.kind = "unconditional";
    s.globs = globs;
  }
  return sections;
}

// Heading itself names a language/framework/path scope (e.g. "TypeScript style",
// "src/api conventions"). This plus derivable globs makes a confident relocate.
function headingNamesScope(heading) {
  const words = heading.toLowerCase().split(/[^a-z0-9+]+/);
  if (words.some((w) => LANG_GLOBS[w])) return true;
  if (/[\w-]+\//.test(heading)) return true; // a path token in the heading
  if (/\.[a-z0-9]{1,5}\b/.test(heading)) return true; // an extension in the heading
  return false;
}

// ---------------------------------------------------------------------------
// Slug + frontmatter for the relocated rule file.
// ---------------------------------------------------------------------------

function slugify(heading) {
  const base = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "rule";
}

// EXACT verified-working lazy frontmatter form. paths is a single unquoted line.
function ruleFileContent(globs, sectionText) {
  const front =
    "---\n" +
    "alwaysApply: false\n" +
    `paths: ${globs.join(", ")}\n` +
    "---\n";
  // Keep the section's verbatim text. Strip a leading blank line only.
  const body = sectionText.replace(/^\n+/, "");
  return `${front}\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Plan.
// ---------------------------------------------------------------------------

export function planClaudeMd() {
  const advisories = [];
  const before = readFileSafe(GLOBAL_CLAUDE_MD);

  if (before == null || before.trim() === "") {
    return {
      changes: [],
      items: [],
      advisories: ["No global ~/.claude/CLAUDE.md found - nothing to slim."],
      counts: { sectionsRelocated: 0, claudeMdTokensBefore: 0, claudeMdTokensSaved: 0 },
    };
  }

  const tokensBefore = estimateTokens(before);

  // Hardlink / symlink guard: never rewrite a synced file in place.
  const info = linkInfo(GLOBAL_CLAUDE_MD);
  if (info.isHardlink || info.isSymlink) {
    const kind = info.isSymlink ? "a symlink" : "a hardlink (e.g. a OneDrive-synced copy)";
    advisories.push(
      `Your global CLAUDE.md is ${kind}, so UsageCut will not rewrite it (an atomic ` +
        `rewrite could break the sync link). It loads ~${tokensBefore} tokens into every ` +
        `session. To slim it safely, move path-specific rules into ~/.claude/rules/<name>.md ` +
        `with "alwaysApply: false" frontmatter by hand.`
    );
    return {
      changes: [],
      items: [],
      advisories,
      counts: { sectionsRelocated: 0, claudeMdTokensBefore: tokensBefore, claudeMdTokensSaved: 0 },
    };
  }

  const { sections } = parseSections(before);
  classifySections(sections);

  const relocatable = sections.filter((s) => s.kind === "conditional" && s.globs.length);

  // Honesty: if little/nothing is relocatable, say so plainly.
  if (relocatable.length === 0) {
    const conditionalCount = sections.filter((s) => s.kind === "conditional").length;
    advisories.push(
      `Your global CLAUDE.md is mostly always-on rules - it loads ~${tokensBefore} tokens ` +
        `into every session and almost all of it genuinely applies everywhere, so relocating ` +
        `saves little. Nothing was moved.` +
        (conditionalCount > relocatable.length
          ? ` (Some sections looked conditional but no confident file globs could be derived, ` +
            `so they were left in place.)`
          : "")
    );
    return {
      changes: [],
      items: [],
      advisories,
      counts: { sectionsRelocated: 0, claudeMdTokensBefore: tokensBefore, claudeMdTokensSaved: 0 },
    };
  }

  // Build the trimmed CLAUDE.md by removing each relocated section's exact text.
  let after = before;
  const changes = [];
  const items = [];
  const usedSlugs = new Set();
  let tokensSaved = 0;

  for (const s of relocatable) {
    // Remove the verbatim block. We remove the section's own text plus one
    // trailing blank line if present, to avoid leaving double blanks.
    const idx = after.indexOf(s.text);
    if (idx === -1) continue; // section text not found verbatim (defensive)
    const end = idx + s.text.length;
    let removeEnd = end;
    // swallow a single following blank line
    if (after.slice(end, end + 2) === "\n\n") removeEnd = end + 1;
    after = after.slice(0, idx) + after.slice(removeEnd);

    let slug = slugify(s.heading);
    let candidate = slug;
    let n = 2;
    while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
    usedSlugs.add(candidate);
    slug = candidate;

    const ruleFile = path.join(RULES_DIR, `${slug}.md`);
    const ruleContent = ruleFileContent(s.globs, s.text);

    changes.push({ file: ruleFile, before: null, after: ruleContent });

    const saved = estimateTokens(s.text);
    tokensSaved += saved;
    items.push({
      heading: s.heading,
      kind: s.kind,
      globs: s.globs,
      ruleFile,
      tokensSaved: saved,
    });
  }

  // Normalize accidental triple-newlines left by removals; keep a trailing \n.
  after = after.replace(/\n{3,}/g, "\n\n");
  if (!after.endsWith("\n")) after += "\n";

  if (after !== before) {
    changes.unshift({
      file: GLOBAL_CLAUDE_MD,
      before,
      after,
      reformatsWholeFile: true,
    });
  }

  advisories.push(
    `Moved ${items.length} path-scoped section(s) out of the always-loaded CLAUDE.md into ` +
      `~/.claude/rules/ - they now load only when a matching file is in play.`
  );

  return {
    changes,
    items,
    advisories,
    counts: {
      sectionsRelocated: items.length,
      claudeMdTokensBefore: tokensBefore,
      claudeMdTokensSaved: tokensSaved,
    },
  };
}
