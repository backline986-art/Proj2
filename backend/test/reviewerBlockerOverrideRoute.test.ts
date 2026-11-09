// THE REVIEWER-BLOCKER OVERRIDE / WITHDRAW ROUTES: A NAMED PERSON, THIS ORG'S PROJECT ONLY (#640).
//
// Owner rulings 2026-11-09: any signed-in staff account may override a reviewer blocker on one
// project, recorded BY NAME from the session (never the request body when sign-in is on); with sign-in
// off, the typed name, and a placeholder is refused (feeConfirm.isConfirmingPerson — the
// structural-letter rule). A non-empty reason is required. city.struct.stamped-engineering-missing is
// refused with 409 naming its own door. The routes sit under /api/projects/:id, so the tenant scope
// guard answers 404 for another org's project (hard rule 6). Pinned against a real server process:
//   1. signed out → 401, nothing written; an org API key alone → 401 (a key names an org, never a person);
//   2. signed in → 200, WHO is the session's person (a body name is ignored), the user id is kept, the
//      response's gate shows the blocker as an overridden callout; with no page token (seenAs) → 400,
//      with a token that no longer matches the finding → 409, nothing written either way;
//   3. MUST-EXCLUDE another org's project → 404 (never 403) for override AND withdraw, nothing written;
//   4. the stamped-structural finding and its tile twin → 409 naming /structural-letter/confirm; an
//      empty reason → 400;
//   5. withdraw → 200 under the session's person; again → 409;
//   6. sign-in OFF: a placeholder ("Operator", "N/A", blank, "Admin") → 400 and nothing written;
//      "Jane Example" → 200, recorded by that typed name.
// The gate behaviour (every reader, approval ordering, voiding) is pinned in reviewerBlockerOverride.test.ts.
//
// Synthetic data only. Run: npx tsx backend/test/reviewerBlockerOverrideRoute.test.ts
import "./_isolate";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-override-route-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, getProjectDetail, reviewerGateReportFor } = await import("../src/repository");
const { createApiKey } = await import("../src/auth");
const db = await openDatabase();
const apiKey = createApiKey(db, DEFAULT_ORG_ID, "override-route key").key;

const STRUCT = "city.struct.stamped-engineering-missing";
const TILE_STRUCT = "city.struct.tile-stamped-engineering-missing";
const OTHER_ORG = "org-override-beta";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [OTHER_ORG, "Beta Solar", new Date().toISOString()]);
const client = createClient(db, {
  companyName: "Override Route Solar LLC", legalBusinessName: "Override Route Solar LLC", ccbLicenseNumber: "240136",
  electricalLicenseNumber: "C1235", businessEmail: "ops@override-route.test", businessPhone: "(503) 555-0143",
});
/** A bare project: nothing attached, so the gate raises blockers. Returns one overridable blocker and
 *  the page token the gate shows for it (overrideSeenAs, which the dashboard echoes). */
const mk = (owner: string) => {
  const d = createProject(db, { clientId: client.id, owner, street: "1 Example St", city: "Testville", state: "UT", zip: "84000", ahj: "City of Testville", utility: "Rocky Mountain Power" } as never);
  const blockers = reviewerGateReportFor(db, getProjectDetail(db, d.project.id).project).findings.filter((f) => f.severity === "blocker" && f.overrideSeenAs);
  if (!blockers.length) throw new Error("setup: a bare project raised no overridable reviewer blocker");
  return { projectId: d.project.id, findingId: blockers[0].id, seenAs: blockers[0].overrideSeenAs! };
};
const mine = mk("Jane Example");
const second = mk("Jim Example");
const theirs = mk("John Example");
db.run("UPDATE projects SET org_id = ? WHERE id = ?", [OTHER_ORG, theirs.projectId]);
db.close();

const PORT = 5250 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const boot = (port: number, authOn: boolean) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, "backups"), AUTOPILOT_AUTO_START: "0", PORT: String(port),
    SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: authOn ? "true" : "false", ADMIN_EMAIL: "admin@override.test", ADMIN_PASSWORD: "override-test-password-1", NO_PROXY: "*", no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  return spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
    env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
  });
};
const waitUp = async (base: string, log: () => string): Promise<void> => {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${log().slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const read = (sql: string, args: unknown[] = []): Array<Record<string, unknown>> => {
  const h = new Database(dbPath, { readonly: true });
  try { return h.prepare(sql).all(...args) as Array<Record<string, unknown>>; } finally { h.close(); }
};
const rowsFor = (pid: string) => read("SELECT finding_id, overridden_by, overridden_by_user_id, reason, withdrawn_by, withdrawn_by_user_id, withdrawn_at FROM reviewer_blocker_overrides WHERE project_id = ?", [pid]);
const postTo = (base: string) => (projectId: string, findingId: string, action: string, body: unknown, cookie = "", extra: Record<string, string> = {}) =>
  fetch(`${base}/api/projects/${projectId}/reviewer-blockers/${encodeURIComponent(findingId)}/${action}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(body),
  });
const REASON = "Utility engineer accepted the one-line by email";

const server = boot(PORT, true);
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  await waitUp(BASE, () => serverLog);
  const post = postTo(BASE);

  const keyOnly = await post(mine.projectId, mine.findingId, "override", { reason: REASON, overriddenBy: "Jane Example", seenAs: mine.seenAs }, "", { "x-api-key": apiKey });
  check("1a. an org API key alone (no session): 401, and nothing written", keyOnly.status === 401 && rowsFor(mine.projectId).length === 0, String(keyOnly.status));
  const anon = await post(mine.projectId, mine.findingId, "override", { reason: REASON, overriddenBy: "Mallory Forger", seenAs: mine.seenAs });
  check("1b. signed out: 401, and nothing written", anon.status === 401 && rowsFor(mine.projectId).length === 0, String(anon.status));

  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@override.test", password: "override-test-password-1" }) });
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const adminId = String(read("SELECT id FROM users WHERE email = 'admin@override.test'")[0]?.id ?? "");

  const noToken = await post(mine.projectId, mine.findingId, "override", { reason: REASON }, cookie);
  check("2-. no page token (seenAs) → 400, nothing written: the route never binds to content the caller did not fetch",
    noToken.status === 400 && rowsFor(mine.projectId).length === 0, String(noToken.status));
  const staleToken = await post(mine.projectId, mine.findingId, "override", { reason: REASON, seenAs: "0".repeat(32) }, cookie);
  const staleText = await staleToken.text();
  check("2-. a token that no longer matches the finding on file → 409 'changed since you looked', nothing written",
    staleToken.status === 409 && /changed since you looked/.test(staleText) && rowsFor(mine.projectId).length === 0, `${staleToken.status} ${staleText.slice(0, 200)}`);
  const res = await post(mine.projectId, mine.findingId, "override", { reason: REASON, overriddenBy: "Mallory Forger", seenAs: mine.seenAs }, cookie);
  const body = await res.json().catch(() => ({})) as { outcome?: { override?: { by?: string } }; reviewerReport?: { findings?: Array<{ id: string; severity: string; override?: { by?: string; reason?: string } }> } };
  const rows = rowsFor(mine.projectId);
  check("2a. signed in: 200, WHO is the session's person, never the body's name, with the user id",
    res.status === 200 && body.outcome?.override?.by === "admin@override.test" && rows.length === 1
    && rows[0].overridden_by === "admin@override.test" && rows[0].overridden_by_user_id === adminId && rows[0].reason === REASON,
    `${res.status} ${JSON.stringify(body).slice(0, 300)} ${JSON.stringify(rows)}`);
  const shown = body.reviewerReport?.findings?.find((f) => f.id === mine.findingId);
  check("2b. the response's gate shows the blocker as an overridden callout", shown?.severity === "callout" && shown?.override?.by === "admin@override.test" && shown?.override?.reason === REASON, JSON.stringify(shown));
  const audit = read("SELECT actor_name, details FROM audit_logs WHERE project_id = ? AND action = 'reviewer_gate.blocker_overridden'", [mine.projectId]);
  check("2c. the override is in the audit trail under the person, with the finding and the reason",
    audit.length === 1 && audit[0].actor_name === "admin@override.test" && (JSON.parse(String(audit[0].details)) as { findingId?: string; reason?: string }).findingId === mine.findingId
    && (JSON.parse(String(audit[0].details)) as { reason?: string }).reason === REASON, JSON.stringify(audit));

  const foreign = await post(theirs.projectId, theirs.findingId, "override", { reason: REASON, seenAs: theirs.seenAs }, cookie);
  check("3a. MUST-EXCLUDE another org's project → 404 (never 403), nothing written there", foreign.status === 404 && rowsFor(theirs.projectId).length === 0, String(foreign.status));
  const foreignWithdraw = await post(theirs.projectId, theirs.findingId, "withdraw", {}, cookie);
  check("3b. MUST-EXCLUDE …and its withdraw → 404", foreignWithdraw.status === 404, String(foreignWithdraw.status));
  const missing = await post("no-such-project", mine.findingId, "override", { reason: REASON, seenAs: mine.seenAs }, cookie);
  check("3c. a project that does not exist → 404", missing.status === 404, String(missing.status));

  for (const fid of [STRUCT, TILE_STRUCT]) {
    const structural = await post(second.projectId, fid, "override", { reason: REASON, seenAs: second.seenAs }, cookie);
    const structuralText = await structural.text();
    check(`4a. ${fid} → 409 naming its own door, nothing written`,
      structural.status === 409 && /structural-letter\/confirm/.test(structuralText) && rowsFor(second.projectId).length === 0, `${structural.status} ${structuralText.slice(0, 300)}`);
  }
  const noReason = await post(second.projectId, second.findingId, "override", { reason: "  ", seenAs: second.seenAs }, cookie);
  check("4b. an empty reason → 400, nothing written", noReason.status === 400 && rowsFor(second.projectId).length === 0, String(noReason.status));

  const w = await post(mine.projectId, mine.findingId, "withdraw", { withdrawnBy: "Mallory Forger" }, cookie);
  const wAudit = read("SELECT actor_name FROM audit_logs WHERE project_id = ? AND action = 'reviewer_gate.blocker_override_withdrawn'", [mine.projectId]);
  const wRows = rowsFor(mine.projectId);
  check("5a. withdraw → 200, the row is withdrawn by the session's person (and user id), and audited",
    w.status === 200 && wRows.every((r) => Boolean(r.withdrawn_at) && r.withdrawn_by === "admin@override.test" && r.withdrawn_by_user_id === adminId)
    && wAudit.length === 1 && wAudit[0].actor_name === "admin@override.test", `${w.status} ${JSON.stringify(wRows)} ${JSON.stringify(wAudit)}`);
  const again = await post(mine.projectId, mine.findingId, "withdraw", {}, cookie);
  check("5b. withdrawing with nothing standing → 409", again.status === 409, String(again.status));
} finally {
  server.kill("SIGTERM");
}

// 6. Sign-in OFF: the typed name is the person, and a placeholder is refused.
await new Promise((r) => setTimeout(r, 500));
const OFF_PORT = PORT + 40;
const OFF_BASE = `http://127.0.0.1:${OFF_PORT}`;
const offServer = boot(OFF_PORT, false);
let offLog = "";
offServer.stdout?.on("data", (d) => { offLog += String(d); });
offServer.stderr?.on("data", (d) => { offLog += String(d); });
try {
  await waitUp(OFF_BASE, () => offLog);
  const post = postTo(OFF_BASE);
  const before = rowsFor(second.projectId).length;
  const refused: string[] = [];
  for (const name of ["Operator", "N/A", "", "Admin"]) refused.push(`${name || "(blank)"}=${(await post(second.projectId, second.findingId, "override", { reason: REASON, overriddenBy: name, seenAs: second.seenAs })).status}`);
  check("6a. sign-in off: a placeholder name (Operator, N/A, blank, Admin) → 400, and nothing written",
    refused.every((r) => r.endsWith("=400")) && rowsFor(second.projectId).length === before, refused.join(" "));
  const typed = await post(second.projectId, second.findingId, "override", { reason: REASON, overriddenBy: "Jane Example", seenAs: second.seenAs });
  const typedBody = await typed.json().catch(() => ({})) as { outcome?: { override?: { by?: string } } };
  const typedRow = rowsFor(second.projectId).find((r) => !r.withdrawn_at);
  check("6b. sign-in off: \"Jane Example\" typed → 200, recorded by that name",
    typed.status === 200 && typedBody.outcome?.override?.by === "Jane Example" && typedRow?.overridden_by === "Jane Example",
    `${typed.status} ${JSON.stringify(typedBody).slice(0, 200)}`);
} finally {
  offServer.kill("SIGTERM");
}

await new Promise((r) => setTimeout(r, 500));
try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* the OS temp dir is reaped */ }
if (failures) { console.error(`\nreviewerBlockerOverrideRoute: ${failures} failure(s)`); process.exit(1); }
console.log("\nreviewerBlockerOverrideRoute: all checks passed");
process.exit(0);
