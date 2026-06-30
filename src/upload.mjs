// Upload the aggregate payload to the web app, which stores it and returns a
// short id. The payload is numbers + grade strings only - see analyze.mjs.

const DEFAULT_API = "https://www.usagecut.com";

export function apiBase() {
  return (process.env.USAGECUT_API_URL || DEFAULT_API).replace(/\/+$/, "");
}

// POST the payload. Returns { url } on success, throws on failure. An optional
// claim token (from the /scan page) is sent as a header so that page can poll
// for and display this scan; it never goes in the numbers-only payload body.
export async function upload(payload, token) {
  const base = apiBase();
  const headers = { "content-type": "application/json" };
  if (token) headers["x-usagecut-token"] = token;
  const res = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error ? ` - ${body.error}` : "";
    } catch {
      // ignore
    }
    throw new Error(`upload failed (${res.status})${detail}`);
  }
  const body = await res.json();
  if (!body || typeof body.id !== "string") {
    throw new Error("upload succeeded but returned no id");
  }
  return { url: `${base}/r/${body.id}`, id: body.id };
}

// POST the numbers-only "after" aggregate so the hosted report flips from the
// before view to the optimized view live. Keyed by the same claim token the
// scan used (carried in a header, never in the body). Best-effort: a failure
// here never breaks the apply - it just means the web report does not flip.
export async function uploadAfter(afterAgg, token) {
  if (!token) return { ok: false, skipped: "no token" };
  const base = apiBase();
  const res = await fetch(`${base}/api/scan/after`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-usagecut-token": token },
    body: JSON.stringify(afterAgg),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const b = await res.json();
      detail = b?.error ? ` - ${b.error}` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`after-upload failed (${res.status})${detail}`);
  }
  return { ok: true };
}
