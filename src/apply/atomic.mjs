// Atomic, cross-platform-safe file writes for the apply engine.
//
// - same-directory temp file + fsync + rename (atomic on POSIX and Windows)
// - preserves the file's original newline style and permission bits
// - never rename-divorces a symlink or hardlink: symlinks write through to their
//   real target, hardlinks are rewritten in place so the inode (and the link)
//   survives. This matters because a synced global ~/.claude/CLAUDE.md can be a
//   OneDrive hardlink, and an atomic rename would silently break the link.
// - retries transient EPERM / EBUSY / EACCES (Windows AV or OneDrive file locks).

import fs from "node:fs";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function withRetry(fn, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err.code)) throw err;
      // brief synchronous backoff; these locks usually clear within ~100ms
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  throw lastErr;
}

// Detect CRLF vs LF from existing bytes (default LF).
export function detectNewline(text) {
  if (text == null) return "\n";
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

function toNewline(text, nl) {
  const lf = text.replace(/\r\n/g, "\n");
  return nl === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

// Classify a path's link status without following it.
export function linkInfo(filePath) {
  try {
    const lst = fs.lstatSync(filePath);
    return {
      exists: true,
      isSymlink: lst.isSymbolicLink(),
      isHardlink: lst.nlink > 1,
      mode: lst.mode & 0o777,
    };
  } catch {
    return { exists: false, isSymlink: false, isHardlink: false, mode: null };
  }
}

// Write `content` to `filePath`, preserving newline style + mode, link-safe.
// opts.raw skips newline normalization (used on revert to restore exact bytes).
// Returns { strategy, target } describing how it was written.
export function safeWrite(filePath, content, opts = {}) {
  const info = linkInfo(filePath);

  // follow a symlink to its real target so we update the target, not the link
  let target = filePath;
  if (info.isSymlink) {
    try {
      target = fs.realpathSync(filePath);
    } catch {
      target = filePath;
    }
  }

  let out = content;
  if (!opts.raw) {
    let existing = null;
    try {
      existing = fs.readFileSync(target, "utf8");
    } catch {
      /* new file */
    }
    out = toNewline(content, opts.newline || detectNewline(existing));
  }

  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  // hardlinked file: rewrite in place so the inode (and the link) survives
  if (info.isHardlink) {
    withRetry(() => fs.writeFileSync(target, out));
    return { strategy: "in-place (hardlink preserved)", target };
  }

  // normal file (or symlink target): atomic same-dir temp + fsync + rename
  const tmp = path.join(dir, `.usagecut.tmp.${process.pid}.${Date.now()}`);
  withRetry(() => {
    const fd = fs.openSync(tmp, "w", info.mode || 0o644);
    try {
      fs.writeFileSync(fd, out);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  });
  try {
    if (info.mode != null) fs.chmodSync(tmp, info.mode);
  } catch {
    /* chmod may be a no-op or fail on Windows; ignore */
  }
  withRetry(() => fs.renameSync(tmp, target));
  return { strategy: "atomic rename", target };
}
