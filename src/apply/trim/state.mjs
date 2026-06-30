// The ONE shared per-session runtime state for the live hooks. Both the
// PostToolUse trimmer (content-hash dedup of repeated tool output) and the
// PreToolUse read guard (has this exact file+range been read already?) key off
// the same file: ~/.usagecut/state/<session_id>.json.
//
// IMPORTANT: the installed hook scripts (~/.usagecut/trim.mjs, readguard.mjs)
// are emitted as self-contained, zero-dependency files - they inline an exact
// copy of this logic rather than importing it (the npx cache path is not stable
// across runs). This module is the in-process reference used by replay and unit
// tests, and the canonical source the installer mirrors. Keep the two in sync.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = path.join(os.homedir(), ".usagecut", "state");

const STATE_VERSION = 1;
// A session file older than this is treated as a new session (handles a missing
// or reused session_id without leaking state across unrelated runs).
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function stateFile(sessionId) {
  const safe = String(sessionId || "nosession").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(STATE_DIR, `${safe}.json`);
}

export function loadState(sessionId) {
  const file = stateFile(sessionId);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    raw = null;
  }
  const fresh = raw && raw.v === STATE_VERSION && Date.now() - (raw.at || 0) < SESSION_TTL_MS;
  return fresh
    ? raw
    : { v: STATE_VERSION, sessionId: String(sessionId || "nosession"), at: Date.now(), reads: {}, hashes: {} };
}

export function saveState(state) {
  state.at = Date.now();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${stateFile(state.sessionId)}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile(state.sessionId));
  } catch {
    /* state is an optimization, never fatal */
  }
}

// --- read-guard helpers (PreToolUse) ---------------------------------------

// Has this exact (path, mtime, range) read already been served this session?
// `range` is a coarse key like "0-2000" or "full". A re-read only counts as a
// duplicate when the file is UNCHANGED (same mtime) and the range is a subset.
export function lookupRead(state, filePath, mtimeMs, rangeKey) {
  const e = state.reads[filePath];
  if (!e) return null;
  if (e.mtimeMs !== mtimeMs) return null; // file changed -> not a dup
  if (e.range !== "full" && e.range !== rangeKey) return null;
  return e; // { mtimeMs, range, turn }
}

export function recordRead(state, filePath, mtimeMs, rangeKey, turn) {
  const prev = state.reads[filePath];
  // "full" subsumes any narrower range once a whole-file read happens.
  const range = prev && prev.range === "full" ? "full" : rangeKey;
  state.reads[filePath] = { mtimeMs, range, turn: turn ?? prev?.turn ?? 0 };
}

// A write/edit invalidates the cached read for a file.
export function invalidateRead(state, filePath) {
  delete state.reads[filePath];
}

// --- trimmer dedup helpers (PostToolUse) ------------------------------------

// Has this exact output content (by hash) been seen already this session?
export function lookupHash(state, hash) {
  return state.hashes[hash] || null;
}

export function recordHash(state, hash, turn) {
  if (!state.hashes[hash]) state.hashes[hash] = { turn: turn ?? 0 };
}
