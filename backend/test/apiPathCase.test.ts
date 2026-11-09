// /API/... IS /api/... TO THE ROUTER, SO IT MUST BE /api/... TO THE GATES (issue #477).
//
// Express routes case-insensitively (this app never turns on `case sensitive routing`), so
// `GET /API/projects` reaches the `/api/projects` handler. The sign-in gate and the licensing gate
// asked `req.path.startsWith("/api/")`, which the upper-case spelling fails:
//
//   requireAuth      no session on /API/... got the PAGE answer (302 to /login), not 401 JSON.
//   entitlementGate  treated /API/... as a page and SKIPPED the licence check, so a signed-in user
//                    of a form-filler-only org read the autopilot's project list (rule 6: the
//                    licensing gate is deny-by-default and this walked round it).
//
// Pinned here, against the real server with AUTH_ENABLED=true:
//   DENY       any letter case of an /api/ path meets both gates: no session → 401 JSON; an org
//              without the product → 403; and a variant spelling of a route the org DOES hold
//              fails closed (the allow-lists stay exact), never open.
//   UNCHANGED  lower-case paths answer as before; licensed users still reach /API/... (the
//              router sends it to the same handler); pages still redirect to /login.
//   ROUTER     the other spellings the issue worries about (doubled slash, percent-encoded prefix,
//              dot segments) reach NO handler on this Express, checked against a bare router, so
//              an upgrade that starts normalizing them fails here before it opens a hole.
//
// KILL: put `req.path.startsWith("/api/")` back in entitlementGate → "a form-filler org gets 403
// on /API/projects" fails (200 + the project list); put it back in requireAuth → "no session gets
// 401 JSON on /API/..." fails (302 to /login).
//
// Run: npx tsx backend/test/apiPathCase.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { isApiPath } from "../src/auth";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-path-case-test-"));

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

// ---------------------------------------------------------------------------
// 1. The predicate itself.
// ---------------------------------------------------------------------------
await run("isApiPath matches every letter case of /api and /api/..., and nothing that only starts with 'api'", () => {
  for (const p of ["/api/projects", "/API/projects", "/Api/Projects/", "/aPI/x", "/api", "/API", "/api/"]) {
    assert.equal(isApiPath(p), true, p);
  }
  for (const p of ["/", "/login", "/dashboard.html", "/apis", "/api-docs", "/APIx/projects", "/x/api/projects", "", "api/projects"]) {
    assert.equal(isApiPath(p), false, p);
  }
});

// ---------------------------------------------------------------------------
// 2. Which spellings the router actually sends to an /api/ handler. Letter case: yes (that is the
//    bug). Doubled slashes, a percent-encoded prefix and dot segments: no, so the gates need not
//    normalize them. Raw http.request, because fetch would normalize the dot segments away.
// ---------------------------------------------------------------------------
await run("the router sends letter-case variants to the /api/ handler and the other spellings to nothing", async () => {
  const app = express();
  app.get("/api/projects", (_req, res) => { res.json({ hit: true }); });
  app.use((_req, res) => { res.status(404).json({ hit: false }); });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => srv.once("listening", () => ok()));
  const port = (srv.address() as AddressInfo).port;
  const raw = (p: string) => new Promise<boolean>((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.on("data", (d) => { body += String(d); });
      res.on("end", () => ok(res.statusCode === 200 && JSON.parse(body).hit === true));
    });
    req.on("error", fail);
    req.end();
  });
  try {
    for (const p of ["/api/projects", "/API/projects", "/Api/Projects/"]) assert.equal(await raw(p), true, `${p} should route (and isApiPath must agree)`);
    for (const p of ["//api/projects", "/api//projects", "/%61pi/projects", "/api%2Fprojects", "/api/%70rojects", "/./api/projects", "/x/../api/projects"]) {
      assert.equal(await raw(p), false, `${p} reached the /api/projects handler: this Express normalizes it, so the gates must too`);
    }
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// 3. The real server, sign-in on.
// ---------------------------------------------------------------------------
// Own band: 5960-5969 (recorderTokens holds 5880-5889; nothing else sits above 5900).
const PORT = freePortInBand(5960, 10);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = { email: "owner@operator.test", password: "owner-test-password-1" };
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(tmpDir, "test.sqlite"),
  PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
  BACKUP_DIR: path.join(tmpDir, "backups"),
  BATCH_UPLOAD_DIR: path.join(tmpDir, "batch-uploads"),
  BATCH_REPORT_DIR: path.join(tmpDir, "batch-reports"),
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
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
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never answered ${BASE}/health within 60s\nlog tail:\n${serverLog.slice(-2000)}`);
}

const as = (cookie: string) => (p: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers, redirect: "manual" });
};
const loginAs = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login ${email}: ${await res.text()}`);
  return String(res.headers.get("set-cookie") || "").split(";")[0];
};

try {
  await waitForServer();
  const owner = as(await loginAs(OWNER.email, OWNER.password));
  const anon = as("");

  // A synthetic project in the owner's (autopilot) org, so a leaked list would have something in it.
  const clientRes = await owner("/api/clients", { method: "POST", body: JSON.stringify({ companyName: "Example Installers" }) });
  const clientBody = await clientRes.json();
  const clientId = clientBody?.id;
  assert.ok(clientId, `seed client: ${clientRes.status} ${JSON.stringify(clientBody).slice(0, 200)}`);
  const created = await owner("/api/projects", { method: "POST", body: JSON.stringify({
    owner: "Casey Example", street: "1 Test Way", city: "Salem", state: "OR", zip: "97301",
    ahj: "City of Salem", utility: "PGE", dcKw: "7.5", clientId,
  }) });
  assert.ok(created.status < 300, `seed project: ${created.status} ${await created.text()}`);

  // A form-filler-only org: holds no autopilot licence.
  const orgRes = await owner("/api/orgs", { method: "POST", body: JSON.stringify({ name: "Filler Only", edition: "full", products: ["form_filler"] }) });
  const fillerOrg = (await orgRes.json()).org;
  assert.ok(fillerOrg?.id, "form-filler org created");
  const userRes = await owner(`/api/orgs/${fillerOrg.id}/users`, { method: "POST", body: JSON.stringify({ name: "F", email: "f@filler.test", password: "tenant-pass-12345" }) });
  assert.ok(userRes.status < 300, `form-filler user: ${userRes.status} ${await userRes.text()}`);
  const filler = as(await loginAs("f@filler.test", "tenant-pass-12345"));

  await run("no session gets 401 JSON on every letter case of an /api/ path (not the page redirect)", async () => {
    for (const p of ["/api/projects", "/API/projects", "/Api/Projects/", "/API/PROJECTS/abc", "/API/portal-credentials", "/API"]) {
      const res = await anon(p);
      const body = await res.text();
      assert.equal(res.status, 401, `${p}: ${res.status} ${res.headers.get("location") || ""} ${body.slice(0, 120)}`);
      assert.match(String(res.headers.get("content-type")), /application\/json/, `${p}: not JSON`);
    }
  });

  await run("a variant spelling of a no-login public API fails closed (401), never opens a different route", async () => {
    // The carve-outs stay exact. /API/public/status/x is routed to the public status handler by
    // Express, but the gate does not open it: refused, which is the safe direction.
    const res = await anon("/API/public/status/some-token");
    assert.equal(res.status, 401, `${res.status} ${(await res.text()).slice(0, 120)}`);
  });

  await run("pages still redirect to /login with no session", async () => {
    for (const p of ["/", "/dashboard.html"]) {
      const res = await anon(p);
      await res.text();
      assert.equal(res.status, 302, `${p}: ${res.status}`);
      assert.equal(res.headers.get("location"), "/login", p);
    }
    const login = await anon("/login");
    await login.text();
    assert.equal(login.status, 200, "/login itself still opens");
  });

  await run("a form-filler org gets 403 on /API/projects (the licence gate is not skipped by letter case)", async () => {
    for (const p of ["/api/projects", "/API/projects", "/Api/Projects/", "/API/PROJECTS", "/API/review/work-types", "/aPi/portal-credentials"]) {
      const res = await filler(p);
      const body = await res.text();
      assert.equal(res.status, 403, `${p}: ${res.status} ${body.slice(0, 160)}`);
      assert.ok(!body.includes("Casey Example"), `${p}: leaked the autopilot project list`);
    }
  });

  await run("a form-filler org still reaches its own tool; a variant spelling of it fails closed", async () => {
    const own = await filler("/api/tools/form-fill/inspect", { method: "POST", headers: { "content-type": "application/pdf" }, body: "not-a-pdf" });
    await own.text();
    assert.notEqual(own.status, 403, "the licensed lower-case route must still answer");
    const variant = await filler("/API/tools/form-fill/inspect", { method: "POST", headers: { "content-type": "application/pdf" }, body: "not-a-pdf" });
    await variant.text();
    assert.equal(variant.status, 403, "the product allow-list is exact: a variant spelling is refused, not opened");
  });

  await run("the other spellings reach no handler on the real server either", async () => {
    // fetch would collapse dot segments, so only the ones it sends as written are tried here; the
    // router check above covers the rest.
    for (const p of ["//api/projects", "/api//projects", "/%61pi/projects", "/api%2Fprojects"]) {
      const res = await filler(p);
      const body = await res.text();
      assert.ok(!body.includes("Casey Example"), `${p}: ${res.status} leaked the autopilot project list`);
      assert.notEqual(res.status, 200, `${p}: ${res.status} ${body.slice(0, 120)}`);
    }
  });

  await run("a licensed (autopilot) user still reaches the handler through /API/... and /api/...", async () => {
    for (const p of ["/api/projects", "/API/projects"]) {
      const res = await owner(p);
      const body = await res.text();
      assert.equal(res.status, 200, `${p}: ${res.status} ${body.slice(0, 120)}`);
      assert.ok(body.includes("Casey Example"), `${p}: the owner's own project is missing`);
    }
  });
} catch (err) {
  failures++;
  console.error(`  FAIL - setup\n         ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  server.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\napiPathCase: all checks passed");
