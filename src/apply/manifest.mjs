// Backup + restore manifest. Before any write, snapshot each target file's exact
// bytes and link metadata into ~/.usagecut/backups/<ts>/. One manifest per apply
// makes `usagecut revert` an all-or-nothing restore. UsageCut state lives in a
// dir we own (~/.usagecut), never inside ~/.claude (which Claude Code rewrites
// constantly).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeWrite, linkInfo } from "./atomic.mjs";

export const USAGECUT_DIR = path.join(os.homedir(), ".usagecut");
const BACKUPS_DIR = path.join(USAGECUT_DIR, "backups");

// Filesystem-safe timestamp, e.g. 2026-06-27T15-04-05-123Z.
function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Snapshot the listed absolute paths. A file that does not exist is recorded as
// { existed: false } so revert can delete a file the apply created.
export function snapshot(files) {
  const stamp = stampNow();
  const dir = path.join(BACKUPS_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const entries = [];
  let i = 0;
  for (const file of files) {
    const info = linkInfo(file);
    let content = null;
    if (info.exists) {
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        content = null;
      }
    }
    const backup = content != null ? `${i}_${path.basename(file)}.bak` : null;
    if (backup) fs.writeFileSync(path.join(dir, backup), content);
    entries.push({
      path: file,
      existed: content != null,
      backup,
      isSymlink: info.isSymlink,
      isHardlink: info.isHardlink,
    });
    i++;
  }

  const manifest = { v: 1, stamp, createdAt: new Date().toISOString(), entries };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  return { stamp, dir, manifest };
}

// Backup stamps, newest first.
export function listManifests() {
  let dirs;
  try {
    dirs = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirs
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
}

export function readManifest(stamp) {
  return JSON.parse(
    fs.readFileSync(path.join(BACKUPS_DIR, stamp, "manifest.json"), "utf8")
  );
}

// Restore every entry in a manifest. Files that did not exist at snapshot time
// are removed. Bytes are restored verbatim (raw write, no newline reflow).
export function restore(stamp) {
  const dir = path.join(BACKUPS_DIR, stamp);
  const manifest = readManifest(stamp);
  const restored = [];
  for (const e of manifest.entries) {
    if (e.existed && e.backup) {
      const content = fs.readFileSync(path.join(dir, e.backup), "utf8");
      safeWrite(e.path, content, { raw: true });
      restored.push(e.path);
    } else {
      try {
        fs.rmSync(e.path);
        restored.push(e.path);
      } catch {
        /* already gone */
      }
    }
  }
  return { restored, manifest };
}
