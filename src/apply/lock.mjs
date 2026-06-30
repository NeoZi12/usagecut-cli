// A single-writer lock for the apply engine. The safety contract promises that
// two `usagecut apply` runs can never race on ~/.claude.json or settings.json;
// this is where that promise is actually kept (engine.mjs previously named a
// flock it did not implement).
//
// Mechanism: an O_EXCL create of ~/.usagecut/.lock. If the lock already exists
// we reclaim it only when it is provably stale (the holder pid is dead, or the
// lock is older than STALE_MS), otherwise we refuse. Release removes the file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_PATH = path.join(os.homedir(), ".usagecut", ".lock");
const STALE_MS = 10 * 60 * 1000; // a real apply never runs longer than this

function pidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we cannot signal it - still alive.
    return err.code === "EPERM";
  }
}

// Remove the lock if its holder is dead or it is older than STALE_MS.
// Returns true if it reclaimed (so the caller can retry the create).
function reclaimIfStale() {
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    info = null;
  }
  const stale = !info || Date.now() - (info.at || 0) > STALE_MS || !pidAlive(info.pid);
  if (stale) {
    try {
      fs.rmSync(LOCK_PATH);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// Acquire the lock. Returns { release }. Throws if another live apply holds it.
export function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx"); // O_CREAT | O_EXCL
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return { release };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!reclaimIfStale()) {
        throw new Error(
          "Another `usagecut apply` is already running. If you are sure it is not, delete ~/.usagecut/.lock and retry."
        );
      }
    }
  }
  throw new Error("Could not acquire the usagecut apply lock.");
}

function release() {
  try {
    fs.rmSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

// Run `fn` while holding the lock, always releasing it (even on throw).
export async function withLock(fn) {
  const lock = acquireLock();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
