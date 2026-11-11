// THE COMPANY SETUP ROUTES ON THE REAL SERVER, SIGN-IN ON (clientOnboarding.ts, server.ts).
//
//   MUST PASS    — the page and its token-scoped API open with no session (requireAuth's carve-out);
//                  staff routes under /api/clients/:id stay behind sign-in; a staff mint → client
//                  draft → submit → staff accept round trip works over HTTP, upload included.
//   MUST EXCLUDE — a 404 that says whether a token ever existed; a probe that is not slowed (the rate
//                  limit answers 429 after a few bad tokens); the token, a password or a typed answer
//                  in the server log (rule 2: nothing in it is logged).
//
//   npx tsx backend/test/clientOnboardingRoutes.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./_tmpdir";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-routes-test-"));

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
let total = 0;
const run = async (label: string, fn: () => Promise<void> | void) => {
  total++;
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Own band: 6150-6159 (nothing else sits between 6040 and 6610).
const PORT = freePortInBand(6150, 10);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = { email: "pat.owner@keelix.example.test", password: "owner-test-password-1" };
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(tmpDir, "test.sqlite"),
  PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
  BACKUP_DIR: path.join(tmpDir, "backups"),
  BATCH_UPLOAD_DIR: path.join(tmpDir, "batch-uploads"),
  BATCH_REPORT_DIR: path.join(tmpDir, "batch-reports"),
  AUTOPILOT_LOG_FILE: path.join(tmpDir, "backend.log"),
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "info",
  ANTHROPIC_API_KEY: "",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true",
  ADMIN_EMAIL: OWNER.email,
  ADMIN_PASSWORD: OWNER.password,
  PUBLIC_BASE_URL: "https://keelix.example.test",
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "SMTP_HOST"]) delete env[k];

const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never answered ${BASE}/health within 90s\nlog tail:\n${serverLog.slice(-2000)}`);
}

const as = (cookie: string, ip?: string) => (p: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (ip) headers.set("x-forwarded-for", ip);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers, redirect: "manual" });
};

try {
  await waitForServer();
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  assert.equal(login.status, 200, `login: ${await login.text()}`);
  const owner = as(String(login.headers.get("set-cookie") || "").split(";")[0]);
  const anon = as("");

  const made = await (await owner("/api/clients", { method: "POST", body: JSON.stringify({ companyName: "Routeway Solar (TEST)", businessCity: "Old Town" }) })).json();
  const clientId = String(made.id);
  let token = "";
  const SUBMITTED_DBA = "Routeway Distinctive DBA";

  await run("staff routes stay behind sign-in; the mint works for a signed-in person and names them", async () => {
    const r = await anon(`/api/clients/${clientId}/onboarding-links`, { method: "POST", body: "{}" });
    await r.text();
    assert.equal(r.status, 401);
    const d = await anon(`/api/clients/${clientId}/onboarding/filing-statements/anything/dismiss`, { method: "POST", body: "{}" });
    await d.text();
    assert.equal(d.status, 401);
    const m = await owner(`/api/clients/${clientId}/onboarding-links`, { method: "POST", body: "{}" });
    const body = await m.json();
    assert.equal(m.status, 200, JSON.stringify(body));
    token = new URL(body.url).searchParams.get("token") || "";
    assert.ok(token.length >= 40);
    assert.equal(body.linkProblem, null);
    const list = await (await owner(`/api/clients/${clientId}/onboarding`)).json();
    assert.equal(list.links[0].createdBy, OWNER.email);
  });

  await run("the page and its API open with no session; the API is never cached", async () => {
    const page = await anon(`/onboarding?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Set up your company/);
    const r = await anon(`/api/public/onboarding/${token}`);
    const v = await r.json();
    assert.equal(r.status, 200, JSON.stringify(v));
    assert.equal(v.companyName, "Routeway Solar (TEST)");
    // "How you file in each place" is wired: the page is told which authorities to ask about (none
    // yet: this client has no service area on file).
    assert.deepEqual(v.filingAuthorities, []);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  await run("a password in the body is refused over HTTP; a clean draft and submit write proposals only", async () => {
    const bad = await anon(`/api/public/onboarding/${token}/draft`, { method: "POST", body: JSON.stringify({ fields: { dba: "x", password: "hunter2-not-real" } }) });
    assert.equal(bad.status, 400, await bad.text());
    const pdf = await anon(`/api/public/onboarding/${token}/files?kind=insurance_certificate&name=coi.pdf`, { method: "POST", headers: { "content-type": "application/pdf" }, body: "%PDF-1.4\n% synthetic\n" });
    assert.equal(pdf.status, 200, await pdf.text());
    const draft = await anon(`/api/public/onboarding/${token}/draft`, { method: "POST", body: JSON.stringify({ fields: { dba: SUBMITTED_DBA } }) });
    assert.equal(draft.status, 200, await draft.text());
    const sub = await anon(`/api/public/onboarding/${token}/submit`, { method: "POST", body: JSON.stringify({ fields: { dba: SUBMITTED_DBA, businessCity: "New Town" } }) });
    const out = await sub.json();
    assert.equal(sub.status, 200, JSON.stringify(out));
    assert.equal(out.proposals, 2);
    const clients = await (await owner("/api/clients")).json();
    const row = (clients.clients || []).find((x: { id: string }) => x.id === clientId);
    assert.equal(row.dba, "", "the submit wrote the record");
    const again = await anon(`/api/public/onboarding/${token}/draft`, { method: "POST", body: JSON.stringify({ fields: { dba: "late" } }) });
    assert.equal(again.status, 409, await again.text());
  });

  await run("a signed-in person's accept writes the record; the certificate downloads only through the client's route", async () => {
    const list = await (await owner(`/api/clients/${clientId}/onboarding`)).json();
    assert.equal(list.proposals.length, 2);
    const r = await owner(`/api/clients/${clientId}/onboarding/decide`, { method: "POST", body: JSON.stringify({ acceptAll: true }) });
    const out = await r.json();
    assert.equal(r.status, 200, JSON.stringify(out));
    assert.equal(out.client.dba, SUBMITTED_DBA);
    assert.equal(out.client.businessCity, "New Town");
    const f = list.files[0];
    const dl = await owner(`/api/clients/${clientId}/onboarding/files/${f.id}`);
    assert.equal(dl.status, 200);
    assert.match(await dl.text(), /^%PDF-/);
    const anonDl = await anon(`/api/clients/${clientId}/onboarding/files/${f.id}`);
    await anonDl.text();
    assert.equal(anonDl.status, 401);
  });

  await run("an unknown token is 404 with the same message as an expired one, and a prober is slowed to 429", async () => {
    const probe = as("", "203.0.113.77");
    const first = await probe(`/api/public/onboarding/${"q".repeat(43)}`);
    const msg = (await first.json()).error;
    assert.equal(first.status, 404);
    assert.match(msg, /no longer valid/);
    let last = 0;
    for (let i = 0; i < 22; i++) { const r = await probe(`/api/public/onboarding/${"z".repeat(40)}${i}abc`); await r.text(); last = r.status; }
    assert.equal(last, 429, "a run of bad tokens was never slowed");
    // Another caller is not punished for the prober.
    const other = await as("", "198.51.100.9")(`/api/public/onboarding/${token}`);
    await other.text();
    assert.equal(other.status, 200);
  });

  await run("nothing in it is logged: no token, no password, no typed answer in the server log", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const log = serverLog + (fs.existsSync(env.AUTOPILOT_LOG_FILE!) ? fs.readFileSync(env.AUTOPILOT_LOG_FILE!, "utf8") : "");
    assert.ok(log.includes("/api/public/onboarding/[token]"), "the requests were not logged at all (the check would prove nothing)");
    assert.ok(!log.includes(token), "the token is in the log");
    assert.ok(!log.includes("hunter2"), "the refused password is in the log");
    assert.ok(!log.includes(SUBMITTED_DBA), "a typed answer is in the log");
  });
} catch (err) {
  failures++;
  console.error(`  FAIL - setup\n         ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  server.kill();
  removeTempDir(tmpDir);
}
console.log(failures === 0 ? `\nclientOnboardingRoutes: all ${total} checks passed.` : `\nclientOnboardingRoutes: ${failures}/${total} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
