// THE SECOND-STAGE ROUTES ON THE REAL SERVER, SIGN-IN ON (#28 part 1; secondStage.ts, server.ts).
//
// Each route records what a PERSON did or decided, so the person must be the signed-in one:
//   - no session → 401 on every route, the screenshot read included;
//   - the name on the record is the session's, NEVER a `by` typed into the body or the query;
//   - Confirm → "the application was made by hand" → the track reads staged and not filed; the
//     ordinary "I submitted it" route answers 409 while the plan upload is owed;
//   - the mark needs the confirmation number or a screenshot; a screenshot is a PNG/JPEG body and is
//     served back only to a signed-in person; the mark files the track and is audited under the
//     session's name;
//   - the utility's track has no second stage (400); an unknown project is a 404.
// Invented agency (a synthetic reference file). Nothing opens a browser or sends anything.
//
//   npx tsx backend/test/secondStageRoutes.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./_tmpdir";
import { captureOutput, waitForServer } from "./_serverBoot";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "second-stage-routes-test-"));

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

const flags = {
  timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", sourceSheet: "synthetic test rows",
};
const AHJ = "City of Twostep";
const refPath = path.join(tmpDir, "synthetic-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify({ generatedFrom: "test", redaction: "", count: 1, profiles: [
  { ...flags, state: "OR", ahj: AHJ, submissionMethod: "https://permits.twostep.example.gov/apply", reviewerNotes: "",
    citations: [{ field: "secondStage", value: "PlanDesk Review", trigger: "an invite email after the fee is paid", sourceUrl: "https://www.twostep.example.gov/solar",
      quote: "After the fee is paid you will receive an email invitation to upload your plans in PlanDesk Review.", fetchedAt: "2026-11-11T08:00:00Z" }] },
] }));

// Own band: 6170-6179 (nothing else sits between 6160 and 6610).
const PORT = freePortInBand(6170, 10);
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
  AHJ_PROCESS_REFERENCE_PATH: refPath,
  PERMIT_PROCESS_LOOKUP: "off",
  AUTOPILOT_AUTO_START: "0",
  PORTAL_AUTOSEED: "0",
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
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "SMTP_HOST", "PORTAL_ALLOW_FINAL_SUBMIT"]) delete env[k];

const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
const output = captureOutput(server);

const as = (cookie: string) => (p: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers, redirect: "manual" });
};
type Track = { type: string; status: string; statusLabel: string; secondStage?: { basis: string; state: string; pending: boolean; verifiedBy?: string; uploaded?: { by: string; confirmationNumber: string }; screenshotUrl?: string } };
const building = (tracks: Track[]) => tracks.find((t) => t.type === "building")!;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

try {
  await waitForServer(server, `${BASE}/health`, { output });
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  assert.equal(login.status, 200, `login: ${await login.text()}`);
  const owner = as(String(login.headers.get("set-cookie") || "").split(";")[0]);
  const anon = as("");
  const me = await (await owner("/api/auth/me")).json();
  const ownerName = String(me?.user?.name || me?.user?.email || OWNER.email);

  const client = await (await owner("/api/clients", { method: "POST", body: JSON.stringify({ companyName: "Twostep Installers (TEST)" }) })).json();
  const created = await owner("/api/projects", { method: "POST", body: JSON.stringify({
    owner: "Casey Example", street: "1 Test Way", city: "Twostep", state: "OR", zip: "97301", ahj: AHJ, utility: "PGE", dcKw: "7.5", clientId: client.id,
  }) });
  const createdBody = await created.json();
  assert.ok(created.status < 300, `seed project: ${created.status} ${JSON.stringify(createdBody).slice(0, 300)}`);
  const pid = String(createdBody.project?.id || createdBody.id);
  const base = `/api/projects/${pid}/submittal-tracks/building/second-stage`;

  await run("no session: every second-stage route answers 401 and nothing is recorded", async () => {
    for (const [method, p] of [["POST", "confirm"], ["POST", "remove"], ["POST", "application-made"], ["POST", "uploaded"], ["POST", "screenshot"], ["GET", "screenshot"]] as const) {
      const r = await anon(`${base}/${p}`, { method, ...(method === "POST" ? { body: JSON.stringify({ by: "Mallory", system: "PlanDesk Review", recordNumber: "BLD-1", confirmationNumber: "X" }) } : {}) });
      await r.text();
      assert.equal(r.status, 401, `${method} ${p}`);
    }
    const tracks = await (await owner(`/api/projects/${pid}/submittal-tracks`)).json();
    assert.equal(building(tracks.tracks ?? tracks).secondStage?.basis, "described");
  });

  await run("Confirm is recorded under the SESSION's name, never a name typed into the body", async () => {
    const r = await owner(`${base}/confirm`, { method: "POST", body: JSON.stringify({ by: "Mallory" }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.stage.verifiedBy, ownerName);
    assert.equal(building(body.tracks).secondStage?.basis, "verified");
    assert.equal(building(body.tracks).secondStage?.verifiedBy, ownerName);
  });

  await run("the utility's track has no second stage (400); an unknown project is a 404", async () => {
    const nem = await owner(`/api/projects/${pid}/submittal-tracks/nem/second-stage/confirm`, { method: "POST", body: JSON.stringify({ system: "PlanDesk Review" }) });
    await nem.text();
    assert.equal(nem.status, 400);
    const none = await owner(`/api/projects/00000000-0000-4000-8000-000000000000/submittal-tracks/building/second-stage/confirm`, { method: "POST", body: "{}" });
    await none.text();
    assert.equal(none.status, 404);
  });

  await run("the application made by hand: staged and NOT filed; \"I submitted it\" answers 409 while the upload is owed", async () => {
    const empty = await owner(`${base}/application-made`, { method: "POST", body: JSON.stringify({}) });
    await empty.text();
    assert.equal(empty.status, 400, "no record number");
    const r = await owner(`${base}/application-made`, { method: "POST", body: JSON.stringify({ recordNumber: "BLD-26-07770", by: "Mallory" }) });
    const body = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body));
    const t = building(body.tracks);
    assert.equal(t.status, "staged");
    assert.equal(t.secondStage?.state, "waiting_invite");
    assert.equal(t.secondStage?.pending, true);
    const mark = await owner(`/api/projects/${pid}/submittal-tracks/building/mark-submitted`, { method: "POST", body: JSON.stringify({ applicationNumber: "BLD-26-07770" }) });
    const markBody = await mark.json();
    assert.equal(mark.status, 409, JSON.stringify(markBody));
    assert.match(String(markBody.error), /plans are not marked as uploaded/);
  });

  await run("the mark needs the number or a screenshot; a screenshot is an image body, read back only by a signed-in person", async () => {
    const bare = await owner(`${base}/uploaded`, { method: "POST", body: JSON.stringify({}) });
    await bare.text();
    assert.equal(bare.status, 400, "no number and no screenshot");
    const text = await owner(`${base}/screenshot`, { method: "POST", headers: { "content-type": "text/plain" }, body: "not an image" });
    await text.text();
    assert.equal(text.status, 400, "a body that is not an image");
    const fake = await owner(`${base}/screenshot`, { method: "POST", headers: { "content-type": "image/png" }, body: "not an image either" });
    await fake.text();
    assert.equal(fake.status, 400, "image/png by its header, not by its bytes");
    const up = await owner(`${base}/screenshot`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    assert.equal(up.status, 201, await up.text());
    const got = await owner(`${base}/screenshot`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await got.arrayBuffer()).equals(PNG), true);
    const stranger = await anon(`${base}/screenshot`);
    await stranger.text();
    assert.equal(stranger.status, 401);
  });

  await run("the mark files the track and is audited under the SESSION's name", async () => {
    const r = await owner(`${base}/uploaded`, { method: "POST", body: JSON.stringify({ by: "Mallory" }) });
    const body = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body));
    const t = building(body.tracks);
    assert.equal(t.status, "submitted");
    assert.equal(t.secondStage?.state, "uploaded");
    assert.equal(t.secondStage?.uploaded?.by, ownerName);
    const detail = await (await owner(`/api/projects/${pid}`)).json();
    const audit = (detail.auditLogs as Array<{ action: string; actorName: string }>).filter((a) => a.action.startsWith("second_stage."));
    assert.ok(audit.some((a) => a.action === "second_stage.upload_marked_done" && a.actorName === ownerName), JSON.stringify(audit));
    assert.equal(audit.some((a) => a.actorName === "Mallory"), false, "a typed name reached the record");
    assert.equal(/Mallory/.test(JSON.stringify(detail.submissions)), false);
    const again = await owner(`${base}/uploaded`, { method: "POST", body: JSON.stringify({ confirmationNumber: "PD-1" }) });
    await again.text();
    assert.equal(again.status, 409, "marked once");
  });
} catch (err) {
  failures++;
  console.error(`  FAIL - setup\n         ${err instanceof Error ? err.message : String(err)}\nlog tail:\n${output().slice(-1500)}`);
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  removeTempDir(tmpDir);
}

if (failures) { console.error(`\n${failures} secondStageRoutes test(s) failed.`); process.exit(1); }
console.log("\nAll secondStageRoutes tests passed.");
process.exit(0);
