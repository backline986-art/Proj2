// SEVERAL STAFF ON ONE SERVER: WHO DID WHAT, AND ONE PERSON'S TYPOS DON'T LOCK OUT THE OTHERS.
//
// Boots the real server on a temp sqlite with sign-in on (recorderTokens.test.ts shape). The owner
// adds two staff logins; both sign in from the same address (127.0.0.1), as staff behind one office
// line or one remote session do.
//
// Pinned:
//   LOCKOUT    eight wrong passwords for one account lock THAT account (429), and a colleague signing
//              in from the same address still gets in (200). Spraying many accounts from one address
//              still locks the address.
//   ACTOR      signed in, a recorded staff action names the signed-in person, never a name the browser
//              sends and never "operator"/"dashboard": mark a track submitted (its audit row and the
//              submission's submitted_by), assign a job (with the assignee), add a note, edit a job,
//              delete a job.
//
// KILL: key the login counter by address alone → "a colleague on the same address still signs in"
// fails; drop the track.marked_submitted audit row or read submittedBy from the body → the
// mark-submitted rows fail; drop staffActorName from assign/note/edit/delete → those rows fail.
//
// Run: tsx backend/test/staffActorAttribution.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./_tmpdir";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "staff-actor-test-"));

function freePortInBand(start: number, count: number): number {
  for (let i = 0; i < count; i++) {
    const candidate = start + i;
    try {
      execFileSync(process.execPath, ["-e", `require("net").createServer().listen(${candidate},"0.0.0.0",function(){this.close()}).on("error",()=>process.exit(1))`], { stdio: "ignore" });
      return candidate;
    } catch { /* held — try the next */ }
  }
  return start + Math.floor(Math.random() * count);
}

let failures = 0;
const run = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Synthetic people only.
const OWNER = { email: "owner@operator.test", password: "owner-test-password-1" };
const ANNA = { name: "Anna Staff", email: "anna@team.test", password: "anna-test-password-1" };
const BEN = { name: "Ben Staff", email: "ben@team.test", password: "ben-test-password-1" };

// Own band: 5930-5939.
const PORT = freePortInBand(5930, 5);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(tmpDir, "staff-actor.sqlite");

// Fixtures written BEFORE boot (a test-process write beside a spawned server flakes with SQLITE_BUSY).
let projectId = "";
let doomedId = "";
{
  process.env.AUTOPILOT_DB_PATH = DB_PATH;
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const repo = await import("../src/repository");
  const db = await openDatabase();
  const client = createClient(db, { companyName: "Actor Test Co (synthetic)", legalName: "Actor Test Co (synthetic)", businessEmail: "test@example.invalid" } as never);
  const base = { clientId: client.id, owner: "Test Owner", street: "1 Test St", city: "Testville", state: "ZZ", zip: "00000", ahj: "Test City", utility: "Test Power", dcKw: "6", acKw: "5" };
  const a = repo.createProject(db, base as never) as { project?: { id: string }; id?: string };
  projectId = String(a.project?.id ?? a.id);
  const b = repo.createProject(db, { ...base, street: "2 Test St" } as never) as { project?: { id: string }; id?: string };
  doomedId = String(b.project?.id ?? b.id);
  db.close();
}

function boot(): { server: ChildProcess; log: () => string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: DB_PATH,
    PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
    BACKUP_DIR: path.join(tmpDir, "backups"),
    AUTOPILOT_AUTO_START: "0",
    BACKGROUND_WORKERS: "off",
    PORT: String(PORT),
    SEED_TEST_INSTALLER: "false",
    MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "info",
    ANTHROPIC_API_KEY: "",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: "true",
    ADMIN_EMAIL: OWNER.email,
    ADMIN_PASSWORD: OWNER.password,
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  return { server, log: () => log };
}

async function waitForServer(log: () => string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never answered ${BASE}/health within 60s\nlog tail:\n${log().slice(-2000)}`);
}

type Call = (p: string, init?: RequestInit) => Promise<Response>;
const withCookie = (cookie: string): Call => (p, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers });
};
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const tryLogin = async (email: string, password: string): Promise<{ status: number; cookie: string }> => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  await res.text();
  return { status: res.status, cookie: String(res.headers.get("set-cookie") || "").split(";")[0] };
};
const loginAs = async (email: string, password: string): Promise<Call> => {
  const { status, cookie } = await tryLogin(email, password);
  assert.equal(status, 200, `login ${email} failed with ${status}`);
  return withCookie(cookie);
};
const ok = async (res: Response, what: string): Promise<any> => {
  const body = await res.text();
  assert.ok(res.ok, `${what}: HTTP ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
};
const readDb = async <T>(fn: (db: import("../src/db").AppDb) => T): Promise<T> => {
  process.env.AUTOPILOT_DB_PATH = DB_PATH;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  try { return fn(db); } finally { db.close(); }
};
const auditRows = (action: string) => readDb((db) => db.query<{ actor_name: string; actor_type: string; project_id: string | null; details: string }>(
  "SELECT actor_name, actor_type, project_id, details FROM audit_logs WHERE action = ? ORDER BY created_at ASC, rowid ASC", [action],
));

const one = boot();
try {
  await waitForServer(one.log);
  const owner = await loginAs(OWNER.email, OWNER.password);
  for (const p of [ANNA, BEN]) {
    await ok(await owner("/api/staff/logins", json("POST", { ...p, role: "operator" })), `create ${p.email}`);
  }
  const anna = await loginAs(ANNA.email, ANNA.password);

  await run("LOCKOUT: eight wrong passwords lock that account, and a colleague on the same address still signs in", async () => {
    for (let i = 0; i < 8; i++) assert.equal((await tryLogin(BEN.email, "not-the-password")).status, 401, `wrong password ${i + 1}`);
    assert.equal((await tryLogin(BEN.email, BEN.password)).status, 429, "Ben's account is locked, even with the right password");
    assert.equal((await tryLogin(ANNA.email, ANNA.password)).status, 200, "Anna, same address, is not locked out");
  });

  await run("LOCKOUT: spraying many accounts from one address still locks the address", async () => {
    let locked = false;
    for (let i = 0; i < 40 && !locked; i++) locked = (await tryLogin(`spray${i}@nowhere.test`, "guess-guess-guess")).status === 429;
    assert.ok(locked, "the address locks after its wider cap");
  });

  await run("ACTOR: marking a track submitted names the signed-in person, not a name the browser sends", async () => {
    await ok(await anna(`/api/projects/${projectId}/submittal-tracks/nem/mark-submitted`, json("POST", { permitNumber: "TEST-0001", submittedBy: "Someone Else" })), "mark submitted");
    const rows = await auditRows("track.marked_submitted");
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].actor_name, ANNA.name);
    assert.equal(rows[0].actor_type, "human");
    assert.equal(rows[0].project_id, projectId);
    assert.match(rows[0].details, /"track":"nem"/);
    const sub = await readDb((db) => db.get<{ submitted_by: string }>("SELECT submitted_by FROM submissions WHERE project_id = ? AND status = 'submitted' ORDER BY created_at DESC LIMIT 1", [projectId]));
    assert.equal(sub?.submitted_by, ANNA.name);
  });

  await run("ACTOR: assigning a job is audited with who assigned it and to whom", async () => {
    const users = await ok(await owner("/api/staff/logins"), "list logins");
    const list: Array<{ id: string; email: string }> = Array.isArray(users) ? users : (users.logins ?? users.users ?? []);
    const ben = list.find((u) => u.email === BEN.email);
    assert.ok(ben, `Ben in the login list: ${JSON.stringify(users).slice(0, 300)}`);
    await ok(await anna(`/api/projects/${projectId}/assign`, json("POST", { userId: ben!.id })), "assign");
    const rows = await auditRows("project.assigned");
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].actor_name, ANNA.name);
    assert.match(rows[0].details, /"assignee":"Ben Staff"/);
  });

  await run("ACTOR: a note names its author", async () => {
    await ok(await anna(`/api/projects/${projectId}/notes`, json("POST", { body: "Called the city.", createdBy: "ops user" })), "add note");
    const rows = await auditRows("project_note.added");
    assert.equal(rows.at(-1)?.actor_name, ANNA.name);
    const note = await readDb((db) => db.get<{ created_by: string }>("SELECT created_by FROM project_notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId]));
    assert.equal(note?.created_by, ANNA.name);
  });

  await run("ACTOR: a job edit is the signed-in person's, not the front-end parser's", async () => {
    await ok(await anna(`/api/projects/${projectId}`, json("PUT", { utility: "Test Power Co-op" })), "edit");
    const rows = await auditRows("project.updated_from_parser_snapshot");
    const last = rows.filter((r) => r.project_id === projectId).at(-1);
    assert.equal(last?.actor_name, ANNA.name);
    assert.equal(last?.actor_type, "human");
  });

  await run("ACTOR: deleting a job names who deleted it", async () => {
    await ok(await anna(`/api/projects/${doomedId}`, { method: "DELETE" }), "delete");
    const rows = await auditRows("project.deleted");
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].actor_name, ANNA.name);
  });
} finally {
  one.server.kill();
  await new Promise((r) => setTimeout(r, 500));
  removeTempDir(tmpDir);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nstaffActorAttribution: all checks passed.");
