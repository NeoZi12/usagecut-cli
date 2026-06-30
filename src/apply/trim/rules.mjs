// The pure, DEPENDENCY-FREE trim rules - the heart of the moat.
//
// CRITICAL: this file must never import anything (only language builtins). Its
// exact source text is read verbatim and inlined into the installed PostToolUse
// hook (~/.usagecut/trim.mjs), which has to run as a self-contained zero-dep
// script. If you add an import here you break the live hook. Keep it pure.
//
// Everything here is "lossy but reconstructable": the hook stashes the full
// original and appends one retrieve ref whenever any rule fires, so nothing is
// ever truly lost - the model (or the user) can recover the exact bytes. These
// transforms only ever drop NOISE (passing-test spam, progress bars, identical
// repeats, the uniform middle of a huge listing) and ALWAYS keep errors,
// failures, warnings, and stderr verbatim. Cut the noise, never the substance.

// ---- lossless floor -------------------------------------------------------

// Strip ANSI / VT100 escape sequences (colors, cursor moves, progress redraws).
// They carry no meaning for the model, so removing them is lossless.
export function stripAnsi(text) {
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  return text.replace(ANSI, "");
}

// Collapse >= `min` consecutive identical lines to the first line + a marker.
export function collapseRepeats(text, min = 3) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= min && lines[i].trim() !== "") {
      out.push(lines[i]);
      out.push(`... [uc-trim: ${run - 1} more identical lines]`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out.join("\n");
}

// Squeeze a run of `min`+ blank lines down to a single marker.
export function collapseBlankRuns(text, min = 4) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const run = j - i;
      if (run >= min) out.push(`... [uc-trim: ${run} blank lines]`);
      else for (let k = i; k < j; k++) out.push(lines[k]);
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

// ---- error protection -----------------------------------------------------

// A line we must NEVER drop - it carries a failure, error, warning, or a diff.
export function isKeepLine(line) {
  return /(?:error|exception|traceback|fatal|panic|fail(?:ed|ure)?|warn(?:ing)?|✗|×|✕|✘|\bE\d{2,}\b|assert|denied|refused|cannot|unable to|not found|undefined|null pointer|segfault|\bnpm err\b)/i.test(
    line
  );
}

// ---- detectors ------------------------------------------------------------

export function looksLikeTestOutput(text) {
  const runner =
    /(\bPASS\b|\bFAIL\b|Test Suites:|Tests:\s|\bpassed\b.*\bfailed\b|=+\s*(test session starts|passed|failed)|\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b|\bgo test\b|\bRSpec\b|✓|✔)/i.test(
      text
    );
  if (!runner) return false;
  const passCount = (text.match(/(^|\s)(✓|✔|√|PASS\b|ok\s+\d)/gim) || []).length;
  return passCount >= 8;
}

export function looksLikeInstallLog(text) {
  return /(npm warn|npm notice|added \d+ packages|removed \d+ packages|\bpnpm\b|Downloading |Collecting |Resolving dependencies|Successfully installed|Installing dependencies|Compiling |Building |yarn install|Fetching packages|reused \d+, downloaded)/i.test(
    text
  );
}

// ---- structure-aware lossy rules ------------------------------------------

// Test output: keep every failing/error/summary line verbatim, collapse long
// runs of passing lines into a count. Only the noise (green passes) is dropped.
export function trimTestOutput(text) {
  const lines = text.split("\n");
  const out = [];
  let passRun = 0;
  const flush = () => {
    if (passRun > 0) {
      out.push(`  ... [uc-trim: ${passRun} passing checks]`);
      passRun = 0;
    }
  };
  for (const line of lines) {
    const isPass = /(^|\s)(✓|✔|√|PASS\b|ok\s+\d)/i.test(line) && !isKeepLine(line);
    const isSummary =
      /(Test Suites:|Tests:\s|Snapshots:|Time:\s|=+\s*\d+ (passed|failed)|\bpassed\b|\bfailed\b|\bskipped\b)/i.test(
        line
      );
    if (isPass && !isSummary) {
      passRun++;
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

// Install / build logs: keep results, warnings, errors, and the summary; drop
// the download / progress / "Collecting" noise.
export function trimInstallLog(text) {
  const lines = text.split("\n");
  const out = [];
  let noiseRun = 0;
  const flush = () => {
    if (noiseRun > 0) {
      out.push(`... [uc-trim: ${noiseRun} progress lines]`);
      noiseRun = 0;
    }
  };
  for (const line of lines) {
    const keep =
      isKeepLine(line) ||
      line.trim() === "" ||
      /(added \d+ packages|removed \d+|changed \d+|audited \d+|Successfully|done in|built in|Compiled|up to date|packages in \d|^\s*[+-] |\bDone\b|found \d+ vulnerabilit)/i.test(
        line
      );
    const noise =
      /^(\s*)(Downloading|Collecting|Fetching|Resolving|Progress|\[?\d+\/\d+\]?|\.+|#+|Reusing|reused|Building wheel|Preparing|Extracting)/i.test(
        line
      );
    if (noise && !keep) {
      noiseRun++;
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

// A very large, uniform listing (find/ls/grep with hundreds of lines, or a long
// JSON array). Keep a generous head and tail and elide the middle. Deliberately
// conservative thresholds so normal output is untouched, and any kept-line
// (error/fail/warn) in the middle is preserved. The full text is recoverable
// via the stash ref the hook appends.
export function trimLongListing(text) {
  const lines = text.split("\n");
  if (lines.length < 400 || text.length < 16000) return text;
  const HEAD = 80;
  const TAIL = 30;
  const head = lines.slice(0, HEAD);
  const tail = lines.slice(lines.length - TAIL);
  const middle = lines.slice(HEAD, lines.length - TAIL);
  // never elide an error/fail/warn line hiding in the middle
  const keptFromMiddle = middle.filter(isKeepLine);
  const elided = middle.length - keptFromMiddle.length;
  if (elided < 100) return text; // not worth it
  return [
    ...head,
    `... [uc-trim: ${elided} of ${lines.length} lines elided - full output recoverable]`,
    ...keptFromMiddle,
    ...tail,
  ].join("\n");
}

// ---- the dispatcher -------------------------------------------------------

// Apply the lossless floor always, then at most ONE structure-aware lossy rule
// based on confident detection. Returns the trimmed string (pure - the hook
// decides whether to stash + append a retrieve ref by comparing to the input).
export function applyTrim(text) {
  if (typeof text !== "string" || text.length === 0) return text || "";

  // lossless floor (safe on everything)
  let out = stripAnsi(text);
  out = collapseRepeats(out, 3);
  out = collapseBlankRuns(out, 4);

  // one structure-aware rule, most-specific first
  if (looksLikeTestOutput(out)) {
    out = trimTestOutput(out);
  } else if (looksLikeInstallLog(out)) {
    out = trimInstallLog(out);
  } else {
    out = trimLongListing(out);
  }
  return out;
}
