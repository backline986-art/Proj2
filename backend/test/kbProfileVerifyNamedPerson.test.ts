// A HUMAN-VERIFIED KB PROFILE NAMES THE PERSON (#563, hard rule 3): POST /api/knowledge-base/ahj-profile
// and POST /api/knowledge-base/utility-profile, on a real server process over a temp database (stub
// LLM, no network).
//
// Both routes write a permit_utility_knowledge row with verified_at set: a row that outranks every
// research pass and is never automatically overwritten. "A person verified this" therefore needs a
// person, decided the same way code-profile verify decides it (server.ts namedPersonDecider) and with
// the placeholder check fee confirm uses (feeConfirm.isConfirmingPerson):
//   - auth OFF (how the live install runs): verified_by is the typed `verifiedBy`; missing, blank,
//     "human", "operator", "system", "bot"… is a 400 that writes nothing. It used to stamp "human".
//   - auth ON: verified_by is the SIGNED-IN person (a body name is ignored); an account whose display
//     name is a role ("Admin") is recorded by its email. It used to stamp the session's user id.
//     Signed out, or an org API key with no session, is a 401 that writes nothing.
// A refused verify leaves an existing row exactly as it was.
//
// Fixtures are synthetic.
//
//   npx tsx backend/test/kbProfileVerifyNamedPerson.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-profile-verify-named-"));

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const AHJ_ROUTE = "/api/knowledge-base/ahj-profile";
const UTILITY_ROUTE = "/api/knowledge-base/utility-profile";
const PLACEHOLDERS = ["human", "Operator", "system", "bot", "automation", "unknown", "n/a", "admin"];

/** Creates the schema, and (when given) an already human-verified AHJ row from before #563, stamped
 *  "human" the way the old route did with auth off. */
async function prepareDb(dbPath: string, legacy?: { state: string; ahj: string }): Promise<void> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  try {
    if (legacy) {
      const kb = await import("../src/knowledgeBase");
      kb.saveVerifiedAhjProfile(db, { ...legacy, portalName: "Legacy portal", notes: "Verified before #563." });
    }
  } finally { db.close(); }
}

/** An org API key (programmatic, no session) for the default org. */
async function apiKeyFor(dbPath: string): Promise<string> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const { createApiKey } = await import("../src/auth");
  const db = await openDatabase();
  try {
    const org = db.get<{ id: string }>("SELECT id FROM orgs ORDER BY created_at LIMIT 1");
    assert.ok(org, "fixture: no org");
    return createApiKey(db, org!.id, "kb-verify-test key").key;
  } finally { db.close(); }
}

function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* already gone */ } }
}

async function boot(dbPath: string, port: number, auth: boolean): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: dbPath,
    BACKUP_DIR: path.join(tmpDir, `backups-${port}`),
    AUTOPILOT_AUTO_START: "0",
    PORT: String(port),
    SEED_TEST_INSTALLER: "false",
    MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "warn",
    ANTHROPIC_API_KEY: "",
    CODE_RESEARCH: "off",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: auth ? "true" : "false",
    ADMIN_EMAIL: "admin@kbverify.test",
    ADMIN_PASSWORD: "kb-verify-test-password-1",
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
    // Its own process group: tsx runs the server in a CHILD process.
    env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return server; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(server);
  throw new Error(`server never came up. log tail:\n${log.slice(-2000)}`);
}

interface KbRow { profile_key: string; confidence: string; portal_name: string; notes: string; verified_by: string | null; verified_at: string | null; updated_at: string }
const rowsFor = (dbPath: string, column: "ahj" | "utility", name: string): KbRow[] => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT profile_key, confidence, portal_name, notes, verified_by, verified_at, updated_at FROM permit_utility_knowledge WHERE ${column} = ?`).all(name) as KbRow[];
  } finally { db.close(); }
};

// ── 1. auth OFF: the verifier is the name the caller sends — and it must be a person ────────────
{
  const dbPath = path.join(tmpDir, "auth-off.sqlite");
  await prepareDb(dbPath, { state: "ZH", ahj: "City of Legacyburg" });
  const PORT = 5845 + Math.floor(Math.random() * 15); // its own band
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = await boot(dbPath, PORT, false);
  const post = (p: string, b: Record<string, unknown>) => fetch(`${BASE}${p}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  });
  try {
    await run("auth off, AHJ profile: no name, a blank one or a placeholder/automation label is a 400 that writes nothing", async () => {
      for (const verifiedBy of [undefined, "   ", ...PLACEHOLDERS]) {
        const res = await post(AHJ_ROUTE, { state: "ZH", ahj: "City of Namelessville", portalName: "Synthetic portal", ...(verifiedBy === undefined ? {} : { verifiedBy }) });
        assert.equal(res.status, 400, `verifiedBy ${JSON.stringify(verifiedBy)}: ${await res.text()}`);
      }
      assert.deepEqual(rowsFor(dbPath, "ahj", "City of Namelessville"), [], "a refused verify wrote a KB row");
    });

    await run("auth off, utility profile: no name, a blank one or a placeholder/automation label is a 400 that writes nothing", async () => {
      for (const verifiedBy of [undefined, "   ", ...PLACEHOLDERS]) {
        const res = await post(UTILITY_ROUTE, { state: "ZH", utility: "Nameless Electric Co-op", portalName: "Synthetic NEM portal", ...(verifiedBy === undefined ? {} : { verifiedBy }) });
        assert.equal(res.status, 400, `verifiedBy ${JSON.stringify(verifiedBy)}: ${await res.text()}`);
      }
      assert.deepEqual(rowsFor(dbPath, "utility", "Nameless Electric Co-op"), [], "a refused verify wrote a KB row");
    });

    await run("auth off: a refused verify leaves an existing human-verified row exactly as it was", async () => {
      const [before] = rowsFor(dbPath, "ahj", "City of Legacyburg");
      assert.ok(before?.verified_at, "fixture: the legacy row is not verified");
      const res = await post(AHJ_ROUTE, { state: "ZH", ahj: "City of Legacyburg", portalName: "Changed portal", notes: "changed", verifiedBy: "human" });
      assert.equal(res.status, 400, await res.text());
      assert.deepEqual(rowsFor(dbPath, "ahj", "City of Legacyburg"), [before], "the existing row changed");
    });

    await run("auth off, AHJ profile: a named person's verify stamps that name", async () => {
      const res = await post(AHJ_ROUTE, { state: "ZH", ahj: "City of Namedburg", portalName: "Synthetic portal", verifiedBy: "  Pat Synthetic  " });
      assert.equal(res.status, 201, await res.text());
      const rows = rowsFor(dbPath, "ahj", "City of Namedburg");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].verified_by, "Pat Synthetic");
      assert.ok(rows[0].verified_at, "verified_at not stamped");
    });

    await run("auth off, utility profile: a named person's verify stamps that name", async () => {
      const res = await post(UTILITY_ROUTE, { state: "ZH", utility: "Named Electric Co-op", portalName: "Synthetic NEM portal", verifiedBy: "Robin Fixture" });
      assert.equal(res.status, 201, await res.text());
      const rows = rowsFor(dbPath, "utility", "Named Electric Co-op");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].verified_by, "Robin Fixture");
      assert.ok(rows[0].verified_at, "verified_at not stamped");
    });
  } finally {
    stop(server);
  }
}

// ── 2. auth ON: the verifier is the signed-in person ────────────────────────────────────────────
{
  const dbPath = path.join(tmpDir, "auth-on.sqlite");
  await prepareDb(dbPath);
  const apiKey = await apiKeyFor(dbPath);
  const PORT = 5860 + Math.floor(Math.random() * 15);
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = await boot(dbPath, PORT, true);
  const post = (p: string, b: Record<string, unknown>, headers: Record<string, string>) => fetch(`${BASE}${p}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b),
  });
  try {
    const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@kbverify.test", password: "kb-verify-test-password-1" }) });
    assert.equal(login.status, 200, await login.text());
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

    await run("auth on: signed out, or an org API key (no person), is a 401 on both routes and writes nothing", async () => {
      for (const headers of [{}, { "x-api-key": apiKey }]) {
        let res = await post(AHJ_ROUTE, { state: "ZJ", ahj: "City of Keyton", verifiedBy: "Forged Name" }, headers);
        assert.equal(res.status, 401, await res.text());
        res = await post(UTILITY_ROUTE, { state: "ZJ", utility: "Keyton Power", verifiedBy: "Forged Name" }, headers);
        assert.equal(res.status, 401, await res.text());
      }
      assert.deepEqual(rowsFor(dbPath, "ahj", "City of Keyton"), []);
      assert.deepEqual(rowsFor(dbPath, "utility", "Keyton Power"), []);
    });

    await run("auth on, AHJ profile: verified_by is the signed-in person (role-named account → its email), never a body name or a user id", async () => {
      const res = await post(AHJ_ROUTE, { state: "ZJ", ahj: "City of Sessionville", verifiedBy: "Forged Name" }, { cookie });
      assert.equal(res.status, 201, await res.text());
      const rows = rowsFor(dbPath, "ahj", "City of Sessionville");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].verified_by, "admin@kbverify.test");
      assert.ok(rows[0].verified_at);
    });

    await run("auth on, utility profile: verified_by is the signed-in person, never a body name or a user id", async () => {
      const res = await post(UTILITY_ROUTE, { state: "ZJ", utility: "Sessionville Power" }, { cookie });
      assert.equal(res.status, 201, await res.text());
      const rows = rowsFor(dbPath, "utility", "Sessionville Power");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].verified_by, "admin@kbverify.test");
      assert.ok(rows[0].verified_at);
    });
  } finally {
    stop(server);
  }
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures === 0 ? "\nkbProfileVerifyNamedPerson: all checks passed." : `\nkbProfileVerifyNamedPerson: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
