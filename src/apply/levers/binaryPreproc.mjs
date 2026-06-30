// Bonus lever: binary file preprocessing (niche, lossless-to-context).
//
// When Claude is about to Read a .pdf/.docx/.pptx/.xlsx or an image, the raw
// bytes are useless and expensive (a PDF read can dump tens of thousands of
// garbage tokens). markitdown converts those to clean markdown. This lever
// installs a PreToolUse(Read) hook that, when the target is one of those types,
// produces a markdown sidecar via markitdown and is otherwise a pure pass-through.
//
// SAFETY BY DESIGN: if markitdown / uvx is not installed, the hook is a NO-OP
// pass-through (it just exits 0 and lets the original Read proceed). So it is
// always safe to install; it simply does nothing until markitdown exists. We
// emit the hook declaratively as a settingsMutation and write the self-contained
// hook SCRIPT into ~/.usagecut.

import path from "node:path";
import { USAGECUT_DIR } from "../manifest.mjs";
import { safeWrite } from "../atomic.mjs";

// Self-contained PreToolUse(Read) hook. Pure node builtins + an optional shell
// out to `markitdown`/`uvx markitdown`. Never blocks a Read, never errors.
function binprepSource() {
  return `#!/usr/bin/env node
// UsageCut binprep - PreToolUse(Read) binary-to-markdown preprocessor.
// Input: Claude Code PreToolUse JSON on stdin (has .tool_input.file_path).
// Behavior: for a binary doc/image, build a sibling .md sidecar via markitdown
// if available; otherwise a pure pass-through. Always exits 0. Never blocks.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BINARY_EXT = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".webp",
]);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Resolve how to invoke markitdown: direct binary, then \`uvx markitdown\`.
function resolveMarkitdown() {
  const probe = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 });
      return r.status === 0;
    } catch {
      return false;
    }
  };
  if (probe("markitdown", ["--help"])) return { cmd: "markitdown", pre: [] };
  if (probe("uvx", ["markitdown", "--help"])) return { cmd: "uvx", pre: ["markitdown"] };
  return null;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return; // malformed input -> pass through
  }
  const ti = input.tool_input || input.toolInput || {};
  const filePath = ti.file_path || ti.filePath || ti.path || null;
  if (!filePath) return;

  const ext = path.extname(String(filePath)).toLowerCase();
  if (!BINARY_EXT.has(ext)) return; // not a binary we handle -> pass through

  let exists = false;
  try {
    exists = fs.statSync(filePath).isFile();
  } catch {
    exists = false;
  }
  if (!exists) return;

  const mk = resolveMarkitdown();
  if (!mk) {
    // markitdown absent -> observe-only no-op. Let the original Read proceed.
    return;
  }

  const sidecar = filePath + ".uc.md";
  // Skip if a fresh sidecar already exists (older than source -> rebuild).
  try {
    const s = fs.statSync(sidecar);
    const src = fs.statSync(filePath);
    if (s.mtimeMs >= src.mtimeMs) {
      emitContext(sidecar);
      return;
    }
  } catch {
    /* no sidecar yet */
  }

  const r = spawnSync(mk.cmd, [...mk.pre, filePath, "-o", sidecar], {
    stdio: "ignore",
    timeout: 60000,
  });
  if (r.status === 0) {
    let ok = false;
    try {
      ok = fs.statSync(sidecar).size > 0;
    } catch {
      ok = false;
    }
    if (ok) emitContext(sidecar);
  }
  // Any failure -> silently pass through (original Read still runs).
}

// Surface the sidecar path back to Claude as additional context (non-blocking).
function emitContext(sidecar) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            "UsageCut: a text markdown version of this binary is available at " +
            sidecar +
            " (cheaper to read than the raw bytes).",
        },
      }) + "\\n"
    );
  } catch {
    /* never error */
  }
}

main();
`;
}

// opts.home / opts.usagecutDir for the self-test. opts.binaryReadCount, when
// provided, lets the caller suppress the advisory churn for users who never read
// binaries (we still install the harmless pass-through and say so honestly).
export function planBinaryPreproc(opts = {}) {
  const usagecutDir = opts.usagecutDir || USAGECUT_DIR;

  const changes = [];
  const settingsMutations = [];
  const items = [];
  const advisories = [];

  const scriptPath = path.join(usagecutDir, "binprep.mjs");
  safeWrite(scriptPath, binprepSource());

  settingsMutations.push({
    op: "ensureHook",
    event: "PreToolUse",
    matcher: "Read",
    command: `node ${scriptPath}`,
    timeout: 70,
  });

  items.push({
    kind: "hook",
    key: "binprep",
    detail:
      "PreToolUse(Read): converts .pdf/.docx/.pptx/.xlsx/images to a markdown sidecar via markitdown",
  });

  // Honest framing: always-safe pass-through; only does real work if markitdown
  // is present. We do not probe for markitdown here (the hook probes at runtime),
  // so state it plainly.
  advisories.push(
    "binprep is installed as a harmless pass-through: it only converts binaries when `markitdown` (or `uvx markitdown`) is available, and is a no-op otherwise. Install markitdown (`uv tool install markitdown` or `pipx install markitdown`) to activate it."
  );

  if (typeof opts.binaryReadCount === "number") {
    if (opts.binaryReadCount === 0) {
      advisories.push(
        "Your recent sessions show no binary file reads - this lever will sit idle until you do read one, at zero cost."
      );
    } else {
      advisories.push(
        `Your recent sessions read ~${opts.binaryReadCount} binary file(s) - this lever targets exactly that waste.`
      );
    }
  }

  return { changes, settingsMutations, items, advisories };
}
