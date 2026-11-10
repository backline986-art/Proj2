// DRAFT 16 A — A NAMED PERSON ACCEPTS THAT THE PROJECT AHJ FILES FOR THIS PARCEL.
//
// The parcel check (draft 09) blocks a permit track when the county's own parcel service places the job
// in another jurisdiction than the project AHJ. A wrong blocker used to clear only by correcting the
// AHJ, recording the delegation on the permit-process lookup, or downgrading the record. Now a named
// person can record, on the job, "this AHJ files for this parcel" with a reason: the gate shows a pass
// naming them instead of the blocker. Never automatic; only against a CURRENT disagreement; bound to
// the address, AHJ and parcel answer it was given against (any change and the blocker is back);
// audited; withdrawable.
//
// Synthetic data only (every county, city, street and host is invented); scratch DB; NO NETWORK: the
// parcel answers are seeded by the fake service through the fetch seam, and the real-server part reads
// only the cache those answers left.
//   npx tsx backend/test/parcelJurisdictionAccept.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parcel-accept-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.SKIP_CODE_RESEARCH = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP", "PARCEL_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

// The synthetic county record, as a data FILE: the real server below reads it through the same env var.
const GOV_HOST = "gis.examplecounty.gov";
const RECORD = {
  state: "ID", county: "Example County", covers: { cities: ["Sampleton"], zips: ["83999"] },
  queryUrl: `https://${GOV_HOST}/arcgis/rest/services/Parcels/MapServer/0/query?where=SITE_ADDR%3D%27{street}%27&outFields=JURIS&returnGeometry=false&f=json`,
  recordsPath: "features", jurisdictionField: "attributes.JURIS", unincorporatedValues: ["UNINCORPORATED"],
  sourceName: "Example County GIS", sourceUrl: "https://www.examplecounty.gov/gis",
  quote: `Parcel services are published at ${GOV_HOST}/arcgis/rest/services/Parcels`, fetchedAt: "2026-11-10T00:00:00Z",
  tier: "verified", verifiedBy: "Synthetic Reviewer",
};
const sourcesFile = path.join(tmpDir, "sources.json");
fs.writeFileSync(sourcesFile, JSON.stringify({ records: [RECORD] }));
process.env.JURISDICTION_LOOKUP_SOURCES_PATH = sourcesFile;

const { openDatabase } = await import("../src/db");
const PJ = await import("../src/parcelJurisdiction");
const repo = await import("../src/repository");
const { createClient } = await import("../src/clients");
import type { ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const PARCELS: Record<string, string> = { "1200 N EXAMPLE ST": "SAMPLETON", "77 FARMSTEAD RD": "UNINCORPORATED", "78 FARMSTEAD RD": "UNINCORPORATED" };
PJ.setParcelFetchForTests(async (url) => {
  const u = new URL(url);
  if (u.hostname !== GOV_HOST) throw new Error(`the test reached a non-fake host: ${u.hostname}`);
  const street = (/^SITE_ADDR='(.*)'$/.exec(u.searchParams.get("where") ?? "")?.[1] ?? "").replace(/''/g, "'");
  const v = PARCELS[street];
  return { status: 200, text: JSON.stringify({ features: v === undefined ? [] : [{ attributes: { JURIS: v } }] }) };
});

const client = createClient(db, { companyName: "Synthetic Solar Co" });
let seq = 0;
function makeProject(street: string, over: Record<string, unknown> = {}): ProjectRecord {
  seq++;
  const id = repo.createProject(db, {
    clientId: client.id, owner: `Parcel Owner ${seq}`, street, city: "Sampleton", state: "ID", zip: "83999",
    ahj: "City of Sampleton", utility: "Example Power", dcKw: "8", acKw: "7.6", ...over,
  } as never).project.id;
  return repo.getProjectDetail(db, id).project;
}
const fresh = (p: ProjectRecord) => repo.getProjectDetail(db, p.id).project;
const gate = (p: ProjectRecord) => repo.buildReviewerReportFor(db, fresh(p)).findings;
const parcelFinding = (p: ProjectRecord): ReviewerFinding | undefined => gate(p).find((f) => f.id === "reviewer.jurisdiction.parcel");
const status = async (fn: () => Promise<unknown>): Promise<number> => {
  try { await fn(); return 200; } catch (e) { return Number((e as { status?: number; statusCode?: number }).status ?? (e as { statusCode?: number }).statusCode ?? 500); }
};
const audits = (projectId: string, action: string) =>
  db.query<{ actor: string; details: string }>("SELECT actor_name AS actor, details FROM audit_logs WHERE project_id = ? AND action = ?", [projectId, action]);

const inCounty = makeProject("77 Farmstead Road");
const inCity = makeProject("1200 North Example Street");
const unchecked = makeProject("9 Quiet Lane");
await PJ.runParcelJurisdictionCheck(db, { projectId: inCounty.id });
await PJ.runParcelJurisdictionCheck(db, { projectId: inCity.id });

console.log("\nonly a current disagreement can be accepted, with a reason and a named person");
await check("precondition: the county parcel blocks the city AHJ's permit tracks", () => {
  assert.equal(parcelFinding(inCounty)?.severity, "blocker");
});
await check("no name, or a reason too short to say why, is a 400 that writes nothing", async () => {
  assert.equal(await status(() => PJ.acceptParcelJurisdiction(db, fresh(inCounty), { reason: "County issues by agreement", by: "  " })), 400);
  assert.equal(await status(() => PJ.acceptParcelJurisdiction(db, fresh(inCounty), { reason: "ok", by: "Pat Synthetic" })), 400);
  assert.equal(PJ.parcelAcceptanceOf(db, inCounty.id), null);
  assert.equal(parcelFinding(inCounty)?.severity, "blocker");
});
await check("an address that agrees, or was never checked, has nothing to accept: 409, nothing written", async () => {
  assert.equal(await status(() => PJ.acceptParcelJurisdiction(db, fresh(inCity), { reason: "City files its own parcels", by: "Pat Synthetic" })), 409);
  assert.equal(await status(() => PJ.acceptParcelJurisdiction(db, fresh(unchecked), { reason: "City files its own parcels", by: "Pat Synthetic" })), 409);
  assert.equal(PJ.parcelAcceptanceOf(db, inCity.id), null);
  assert.equal(PJ.parcelAcceptanceOf(db, unchecked.id), null);
});

console.log("\nthe accepted blocker is a pass naming the person, bound to what it answered");
await check("MUST-PASS: a named person's acceptance turns the blocker into a pass that names them, the reason and the parcel's answer", async () => {
  const r = await PJ.acceptParcelJurisdiction(db, fresh(inCounty), { reason: "The city files these county parcels under its service agreement", by: "Pat Synthetic" });
  assert.equal(r.status, "agrees");
  assert.equal(r.acceptedBy?.by, "Pat Synthetic");
  const f = parcelFinding(inCounty);
  assert.equal(f?.severity, "pass");
  assert.equal(f?.title, "Jurisdiction accepted by Pat Synthetic: City of Sampleton files for this parcel");
  assert.match(f?.message ?? "", /places the job's address in Example County, not City of Sampleton\. Pat Synthetic accepted on \d{4}-\d{2}-\d{2}/);
  assert.match(f?.message ?? "", /service agreement/);
  assert.equal(gate(inCounty).filter((x) => x.severity === "blocker" && x.id === "reviewer.jurisdiction.parcel").length, 0);
  const a = audits(inCounty.id, "parcel_jurisdiction.accepted");
  assert.equal(a.length, 1);
  assert.equal(a[0].actor, "Pat Synthetic");
  assert.doesNotMatch(a[0].details, /farmstead|\b77\b/i, "the audit row names no address");
});
await check("a second acceptance of the same answer is a 409", async () => {
  assert.equal(await status(() => PJ.acceptParcelJurisdiction(db, fresh(inCounty), { reason: "Again, by agreement", by: "Pat Synthetic" })), 409);
});
await check("a changed AHJ brings the blocker back (the acceptance answered another question)", () => {
  db.run("UPDATE projects SET ahj = ? WHERE id = ?", ["City of Otherton", inCounty.id]);
  try {
    const f = parcelFinding(inCounty);
    assert.equal(f?.severity, "blocker");
    assert.equal(f?.title, "Parcel is in Example County, not City of Otherton");
  } finally { db.run("UPDATE projects SET ahj = ? WHERE id = ?", ["City of Sampleton", inCounty.id]); }
  assert.equal(parcelFinding(inCounty)?.severity, "pass", "back to the accepted AHJ: the pass returns");
});
await check("a changed address brings the blocker back (the acceptance is bound to the address it answered)", async () => {
  db.run("UPDATE projects SET project_address = ? WHERE id = ?", ["78 Farmstead Road", inCounty.id]);
  try {
    await PJ.runParcelJurisdictionCheck(db, { projectId: inCounty.id });
    assert.equal(parcelFinding(inCounty)?.severity, "blocker");
  } finally { db.run("UPDATE projects SET project_address = ? WHERE id = ?", ["77 Farmstead Road", inCounty.id]); }
});
await check("withdrawn by a named person: the blocker is back, and the withdrawal is audited", async () => {
  assert.equal(await status(() => PJ.withdrawParcelJurisdictionAcceptance(db, inCounty.id, "")), 400);
  assert.equal(await PJ.withdrawParcelJurisdictionAcceptance(db, inCounty.id, "Lee Synthetic"), true);
  assert.equal(parcelFinding(inCounty)?.severity, "blocker");
  assert.equal(audits(inCounty.id, "parcel_jurisdiction.acceptance_withdrawn")[0]?.actor, "Lee Synthetic");
  assert.equal(await PJ.withdrawParcelJurisdictionAcceptance(db, inCounty.id, "Lee Synthetic"), false, "nothing left to withdraw");
});

// ── The route, on a real server process (sign-in off): the name is a person's, never a placeholder ──
console.log("\nthe route names a person (real server, sign-in off; reads the cached answer only)");
function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* gone */ } }
}
const PORT = 6610 + Math.floor(Math.random() * 15);
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, PORT: String(PORT), AUTH_ENABLED: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKUP_DIR: path.join(tmpDir, "server-backups"),
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let log = "";
server.stdout?.on("data", (d) => { log += String(d); });
server.stderr?.on("data", (d) => { log += String(d); });
try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not up yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) throw new Error(`server never came up. log tail:\n${log.slice(-2000)}`);
  const post = (body: Record<string, unknown>) => fetch(`${BASE}/api/projects/${inCounty.id}/parcel-jurisdiction/accept`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  await check("no name, or \"operator\", is a 400 and nothing is written", async () => {
    for (const decidedBy of [undefined, "operator", "human"]) {
      const res = await post({ reason: "The city files these county parcels", ...(decidedBy ? { decidedBy } : {}) });
      assert.equal(res.status, 400, `${decidedBy}: ${await res.text()}`);
    }
    assert.equal(PJ.parcelAcceptanceOf(db, inCounty.id), null);
  });
  await check("a named person's POST records the acceptance; the report shows the pass; DELETE withdraws it", async () => {
    const res = await post({ reason: "The city files these county parcels", decidedBy: "Pat Synthetic" });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(JSON.parse(text).parcelJurisdiction.acceptedBy.by, "Pat Synthetic");
    const report = await (await fetch(`${BASE}/api/projects/${inCounty.id}/reviewer-report`)).json() as { findings: ReviewerFinding[] };
    assert.equal(report.findings.find((f) => f.id === "reviewer.jurisdiction.parcel")?.severity, "pass");
    const del = await fetch(`${BASE}/api/projects/${inCounty.id}/parcel-jurisdiction/accept`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ decidedBy: "Pat Synthetic" }),
    });
    assert.equal(del.status, 200, await del.text());
    assert.equal(PJ.parcelAcceptanceOf(db, inCounty.id), null);
  });
} finally {
  stop(server);
}

PJ.setParcelFetchForTests(null);
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
