// The reversible stash - what makes aggressive trimming safe.
//
// Whenever the live hook trims a tool output, it stashes the FULL original here
// keyed by a content hash, and appends one retrieve ref to the trimmed text.
// Nothing is ever truly lost: `usagecut retrieve <ref>` (and the retrieve hook)
// hand back the exact original bytes. Anthropic's own clear_tool_uses pattern
// validates this safety model (re-fetchable placeholders).
//
// This module is the in-process reference (used by `usagecut retrieve` and the
// tests). The live hook inlines an equivalent minimal copy so it stays zero-dep.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const STASH_DIR = path.join(os.homedir(), ".usagecut", "stash");

// A ref looks like "uc:<16 hex>". The hash is content-addressed, so identical
// outputs share one blob.
export function refFor(text) {
  const h = crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  return `uc:${h}`;
}

function blobPath(ref) {
  const hex = String(ref).replace(/^uc:/, "");
  if (!/^[0-9a-f]{8,64}$/.test(hex)) return null;
  return path.join(STASH_DIR, `${hex}.txt`);
}

// Stash the original text, return its ref. Never throws - on any failure it
// returns null and the caller simply does not append a ref (still safe: the
// trimmed text stands on its own, just without a recovery handle).
export function stashOriginal(text) {
  try {
    if (typeof text !== "string" || text.length === 0) return null;
    const ref = refFor(text);
    const file = blobPath(ref);
    if (!file) return null;
    fs.mkdirSync(STASH_DIR, { recursive: true });
    if (!fs.existsSync(file)) {
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    }
    return ref;
  } catch {
    return null;
  }
}

// Recover the exact original bytes for a ref, or null if unknown/expired.
export function retrieve(ref) {
  try {
    const file = blobPath(ref);
    if (!file) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Garbage-collect old / oversized blobs so the stash never grows unbounded.
export function gcStash({ maxAgeDays = 7, maxBytes = 200e6 } = {}) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(STASH_DIR, { withFileTypes: true });
  } catch {
    return { removed };
  }
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 86400000;
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".txt")) continue;
    const full = path.join(STASH_DIR, e.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > maxAgeMs) {
      try {
        fs.rmSync(full);
        removed++;
      } catch {
        /* ignore */
      }
    } else {
      files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  // enforce the byte cap, oldest first
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total > maxBytes) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (total <= maxBytes) break;
      try {
        fs.rmSync(f.full);
        total -= f.size;
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return { removed };
}
