// Minimal unified-style line diff for terminal preview. No dependencies.
// Used for small config files (e.g. settings.local.json); large reformatted
// files like ~/.claude.json are previewed semantically by the lever instead.

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// Classic LCS line diff -> ops of { t: " " | "-" | "+", line }.
export function diffLines(before, after) {
  const a = (before || "").replace(/\n$/, "").split("\n");
  const b = (after || "").replace(/\n$/, "").split("\n");
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: a[i] });
      i++;
    } else {
      ops.push({ t: "+", line: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ t: "-", line: a[i++] });
  while (j < n) ops.push({ t: "+", line: b[j++] });
  return ops;
}

// Render a compact colored diff, collapsing long unchanged runs to "...".
export function renderDiff(before, after, opts = {}) {
  const ops = diffLines(before, after);
  const ctx = opts.context ?? 2;
  const show = new Array(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t !== " ") {
      for (let d = -ctx; d <= ctx; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < ops.length) show[idx] = true;
      }
    }
  });

  const lines = [];
  let gapped = false;
  ops.forEach((o, k) => {
    if (!show[k]) {
      if (!gapped) {
        lines.push(`${DIM}      ...${RESET}`);
        gapped = true;
      }
      return;
    }
    gapped = false;
    if (o.t === "+") lines.push(`${GREEN}    + ${o.line}${RESET}`);
    else if (o.t === "-") lines.push(`${RED}    - ${o.line}${RESET}`);
    else lines.push(`${DIM}      ${o.line}${RESET}`);
  });
  return lines.join("\n");
}
