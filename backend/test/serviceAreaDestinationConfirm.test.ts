// CONFIRMING A SERVICE-AREA AUTHORITY BEFORE ITS FIRST JOB (the client-scoped twins of the doordest
// routes: PUT / POST / DELETE /api/clients/:id/service-area/filing-destinations[/reject]).
//
// Coordinator's conditions (2026-11-10, under the owner's delegation), each pinned here on invented
// authorities in state ZZ:
//   (a) THE SAME RECORDS: a twin Confirm writes exactly what a per-job Confirm writes for the same
//       authority (the verified KB row, the audit action, actor and details), and nothing else; the only
//       differences are the audit row's project (none: the area job is never stored) and the client and
//       area entry it names instead;
//   (b) NO RELAXED REFUSAL: the same decision functions refuse the same things — no named person, a stale
//       proposal, a click altered from what was shown, a proposal whose problems forbid Confirm; plus the
//       twin's own two: an entry not on the client (404), and an entry that now names a different
//       authority than the one shown (409);
//   (c) ONE AUTHORITY PER CLICK, no bulk: the request names one entry and one authority; after a Confirm
//       that authority leaves the queue (for every client) and a later job naming it reads verified;
//   (d) the area job is never persisted: no project row, the audit row has no project and names the client;
//   (e) Reject and Offer again through the twins write the same rejection row as the per-job routes;
//   (f) the routes: three, under /api/clients/:id (the client scope guard, routeScope), each names the
//       person BEFORE serviceAreaDecisionJob and calls the same decision function; no INSERT / UPDATE /
//       DELETE was added to filingDestinationProposals.ts; cross-org is pinned over HTTP in tenancy.test;
//   (g) the view: an area proposal's buttons carry its client, entry and authority, and the dashboard
//       sends them to the client's twin route with the same body as the track card plus those two keys.
//   npx tsx backend/test/serviceAreaDestinationConfirm.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-area-confirm-"));
const CITY = "City of Marrowgate";
const CITY2 = "Town of Wicklebury"; // its page is not official: Edit only
const PAGE = "https://www.marrowgate-zz.gov/building/solar";
const PORTAL = "https://permits.marrowgate-zz.gov/apply";
const PAGE2 = "https://wicklebury-builders.example.com/solar";
const PORTAL2 = "https://permits.wicklebury-zz.gov/online";
const UTIL = "Sablecreek Electric";
const UTIL_PAGE = "https://www.sablecreek-zz.gov/solar/apply";
const UTIL_PORTAL = "https://sablecreek.powerclerk.com/MvcAccount/Login";
const READ_AT = "2026-11-10T08:19:28Z";
const blank = (ahj: string) => ({
  state: "ZZ", ahj, submissionMethod: "", timeline: "",
  requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "ZZ synthetic",
});
const refPath = path.join(tmpDir, "reference-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify({ generatedFrom: "serviceAreaDestinationConfirm.test", count: 2, profiles: [
  { ...blank(CITY), submissionMethod: `Online portal ${PORTAL}`, citations: [{ field: "submissionMethod", value: PORTAL.replace(/^https:\/\//, ""), sourceUrl: PAGE, quote: "Apply online at permits.marrowgate-zz.gov", fetchedAt: READ_AT }] },
  { ...blank(CITY2), submissionMethod: `Online portal ${PORTAL2}`, citations: [{ field: "submissionMethod", value: PORTAL2.replace(/^https:\/\//, ""), sourceUrl: PAGE2, quote: "Apply online at permits.wicklebury-zz.gov", fetchedAt: READ_AT }] },
] }));
const handPath = path.join(tmpDir, "hand-check.json");
fs.writeFileSync(handPath, JSON.stringify({ pages: [] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = refPath;
process.env.HAND_CHECK_PAGES_PATH = handPath;
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const repo = await import("../src/repository");
const fdp = await import("../src/filingDestinationProposals");
const tracksMod = await import("../src/submittalTracks");
const ufMod = await import("../src/utilityFilingLookup");
const db = await openDatabase();

const su = ufMod.saveUtilityFilingLookup(db, {
  state: "ZZ", utility: UTIL, lookedUpAt: READ_AT,
  filing: { value: { name: "PowerClerk", url: UTIL_PORTAL }, sourceUrl: UTIL_PAGE, quote: "Submit your interconnection application online through PowerClerk", origin: "lookup" },
  program: { value: "net_metering", sourceUrl: UTIL_PAGE, quote: "Net metering program", origin: "lookup" },
} as never);
assert.ok(su.saved, `setup: ${su.reason}`);

const areaClient = createClient(db, { companyName: "Area Confirm Solar", serviceArea: [
  { kind: "city", state: "ZZ", name: "Marrowgate" }, { kind: "city", state: "ZZ", name: "Wicklebury" }, { kind: "utility", state: "ZZ", name: UTIL },
] });
const jobClient = createClient(db, { companyName: "Job Confirm Solar" });
const readTracks = (p: Parameters<typeof tracksMod.getSubmittalTracks>[1]) => tracksMod.getSubmittalTracks(db, p);
const queue = () => fdp.filingDestinationQueue(db, DEFAULT_ORG_ID, readTracks);
const PERSON = "Pat Synthetic";
const areaEntry = (name: string) => queue().clients.find((c) => c.clientId === areaClient.id)?.authorities.find((a) => a.authority.name === name);
const twinJob = (name: string) => {
  const a = areaEntry(name)!;
  const act = a.proposals[0].areaAct!;
  return { a, act, job: fdp.serviceAreaDecisionJob(db, { id: areaClient.id }, { entryKey: act.entryKey, authorityKey: act.authorityKey, track: act.track }) };
};
const confirmInput = (p: { id: string; kind: string; address: string; sourceUrl: string; quote: string }, track: string) =>
  ({ track, proposalId: p.id, kind: p.kind, address: p.address, sourceUrl: p.sourceUrl, quote: p.quote }) as never;

/** Every record a Confirm can write for an authority, with the times and ids taken out. */
function snapshot(): Record<string, unknown> {
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
  const strip = (rows: Array<Record<string, unknown>>) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/(_at|^id)$/.test(k)).map(([k, v]) => [k, typeof v === "string" ? v.replace(ISO, "<time>") : v])));
  const audits = db.query<Record<string, unknown>>("SELECT project_id, actor_type, actor_name, action, details FROM audit_logs WHERE action LIKE 'filing_destination.%' ORDER BY created_at, id")
    .map((r) => { const d = JSON.parse(String(r.details)); delete d.serviceArea; return { actor_type: r.actor_type, actor_name: r.actor_name, action: r.action, details: d }; });
  return {
    knowledge: strip(db.query("SELECT * FROM permit_utility_knowledge WHERE ahj = ? OR utility = ? ORDER BY profile_key", [CITY, UTIL])),
    permitLookups: strip(db.query("SELECT * FROM permit_process_lookups ORDER BY profile_key")),
    utilityLookups: strip(db.query("SELECT * FROM utility_filing_lookups ORDER BY profile_key")),
    rejections: strip(db.query("SELECT * FROM filing_destination_rejections ORDER BY proposal_id")),
    audits,
  };
}
/** Run fn, keep what it returns, and roll every write back (the db wrapper's own transaction; nested
 *  transactions inside it join it). */
const ROLLBACK = new Error("roll back");
const inSavepoint = <T>(fn: () => T): T => {
  let out: T | undefined;
  try { db.transaction(() => { out = fn(); throw ROLLBACK; }); } catch (err) { if (err !== ROLLBACK) throw err; }
  return out as T;
};

await check("(a) THE SAME RECORDS: a twin Confirm writes exactly what a per-job Confirm writes, for an AHJ and for a utility", () => {
  // The per-job side's job exists before either run (creating a job learns from it, which is not the
  // Confirm's write); it is archived after, so the rest of this file sees only the service area.
  const jobIds: Record<string, string> = {
    [CITY]: repo.createProject(db, { clientId: jobClient.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Marrowgate", state: "ZZ", zip: "99999", ahj: CITY, utility: "" } as never).project.id,
    [UTIL]: repo.createProject(db, { clientId: jobClient.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Testville", state: "ZZ", zip: "99999", ahj: "", utility: UTIL } as never).project.id,
  };
  for (const name of [CITY, UTIL]) {
    const before = snapshot();
    const viaJob = inSavepoint(() => {
      const id = jobIds[name];
      const job = repo.getProjectDetail(db, id).project;
      const g = fdp.filingDestinationsFor(db, job, readTracks(job)).find((x) => x.authority.name === name)!;
      fdp.decideFilingDestination(db, job, readTracks(job), confirmInput(g.proposals[0], g.tracks[0]), PERSON);
      const s = snapshot();
      const audit = db.get<{ project_id: string }>("SELECT project_id FROM audit_logs WHERE action = 'filing_destination.confirmed' ORDER BY created_at DESC LIMIT 1")!;
      assert.equal(audit.project_id, id);
      return s;
    });
    assert.deepEqual(snapshot(), before, "the savepoint did not roll back");
    const viaArea = inSavepoint(() => {
      const { a, act, job } = twinJob(name);
      fdp.decideFilingDestination(db, job, readTracks(job), confirmInput(a.proposals[0], act.track), PERSON);
      const audit = db.get<{ project_id: string | null; details: string }>("SELECT project_id, details FROM audit_logs WHERE action = 'filing_destination.confirmed' ORDER BY created_at DESC LIMIT 1")!;
      assert.equal(audit.project_id, null, "the twin audited against a project row");
      assert.deepEqual(JSON.parse(audit.details).serviceArea, { clientId: areaClient.id, entryKey: act.entryKey });
      return snapshot();
    });
    assert.notDeepEqual(viaJob, before, `${name}: the per-job Confirm wrote nothing`);
    assert.deepEqual(viaArea, viaJob, `${name}: the twin Confirm wrote different records than the per-job Confirm`);
  }
  for (const id of Object.values(jobIds)) db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), id]);
});

await check("(b) NO RELAXED REFUSAL: the same refusals, and the twin's own two", () => {
  const { a, act, job } = twinJob(CITY);
  const p = a.proposals[0];
  const c0 = db.get<{ n: number }>("SELECT total_changes() AS n")!.n;
  assert.throws(() => fdp.decideFilingDestination(db, job, readTracks(job), confirmInput(p, act.track), ""), /named person/);
  assert.throws(() => fdp.decideFilingDestination(db, job, readTracks(job), confirmInput({ ...p, id: "0".repeat(24) }, act.track), PERSON), /no longer current/);
  assert.throws(() => fdp.decideFilingDestination(db, job, readTracks(job), confirmInput({ ...p, address: "https://permits.marrowgate-zz.gov/elsewhere" }, act.track), PERSON), /not the proposal shown/);
  // A proposal whose page is not official: Confirm refused, as on a job.
  const w = twinJob(CITY2);
  assert.ok(w.a.proposals[0].problems.length > 0);
  assert.throws(() => fdp.decideFilingDestination(db, w.job, readTracks(w.job), confirmInput(w.a.proposals[0], w.act.track), PERSON), /cannot be confirmed/);
  // The twin's own: an entry not on this client, and an authority other than the one shown.
  assert.throws(() => fdp.serviceAreaDecisionJob(db, { id: jobClient.id }, { entryKey: act.entryKey, authorityKey: act.authorityKey, track: act.track }), (e: { status?: number }) => e.status === 404);
  assert.throws(() => fdp.serviceAreaDecisionJob(db, { id: areaClient.id }, { entryKey: act.entryKey, authorityKey: "ahj|zz|town of wicklebury", track: act.track }), (e: { status?: number }) => e.status === 409);
  assert.throws(() => fdp.serviceAreaDecisionJob(db, { id: areaClient.id }, { entryKey: act.entryKey, authorityKey: act.authorityKey, track: "nem" }), (e: { status?: number }) => e.status === 409);
  assert.equal(db.get<{ n: number }>("SELECT total_changes() AS n")!.n, c0, "a refused decision wrote something");
});

await check("(c)+(d) one authority per click: after a twin Confirm it leaves the queue, a later job reads verified, and no area job is stored", () => {
  const projects0 = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n;
  const { a, act, job } = twinJob(CITY);
  const r = fdp.decideFilingDestination(db, job, readTracks(job), confirmInput(a.proposals[0], act.track), PERSON);
  assert.equal(r.action, "confirmed");
  assert.equal(r.authority.name, CITY);
  assert.equal(areaEntry(CITY), undefined, "the confirmed authority is still in the queue");
  assert.ok(areaEntry(UTIL), "confirming one authority touched another");
  assert.ok(queue().counts.alreadyVerified >= 1);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n, projects0, "the area job was stored");
  const later = repo.getProjectDetail(db, repo.createProject(db, { clientId: areaClient.id, owner: "Synthetic Later", street: "2 Test Way", city: "Marrowgate", state: "ZZ", zip: "99999", ahj: CITY, utility: "" } as never).project.id).project;
  assert.equal(fdp.filingDestinationsFor(db, later, readTracks(later)).find((g) => g.authority.name === CITY)!.status, "verified");
  const audit = db.get<{ project_id: string | null; actor_name: string; created_at: string }>("SELECT project_id, actor_name, created_at FROM audit_logs WHERE action = 'filing_destination.confirmed' ORDER BY created_at DESC LIMIT 1")!;
  assert.deepEqual([audit.project_id, audit.actor_name, Boolean(audit.created_at)], [null, PERSON, true]);
});

await check("(e) Reject and Offer again through the twins write the same rejection row, audited on the client", () => {
  const { a, act, job } = twinJob(UTIL);
  const p = a.proposals[0];
  fdp.rejectFilingDestination(db, job, readTracks(job), { track: act.track, proposalId: p.id, reason: "synthetic" }, PERSON);
  const row = db.get<Record<string, unknown>>("SELECT * FROM filing_destination_rejections WHERE proposal_id = ?", [p.id])!;
  assert.deepEqual([row.authority_kind, row.authority, row.rejected_by, row.reason], ["utility", UTIL, PERSON, "synthetic"]);
  const listed = areaEntry(UTIL)!;
  assert.deepEqual(listed.rejected.map((r) => r.id), [p.id]);
  assert.equal(listed.rejected[0].areaAct!.entryKey, act.entryKey);
  const back = fdp.withdrawDestinationRejection(db, job, { track: act.track, proposalId: p.id }, PERSON);
  assert.equal(back.withdrawn, true);
  assert.ok(!db.get("SELECT 1 AS x FROM filing_destination_rejections WHERE proposal_id = ?", [p.id]));
  const audits = db.query<{ action: string; project_id: string | null; details: string }>("SELECT action, project_id, details FROM audit_logs WHERE action IN ('filing_destination.rejected', 'filing_destination.rejection_withdrawn') ORDER BY created_at");
  assert.deepEqual(audits.map((x) => [x.action, x.project_id, JSON.parse(x.details).serviceArea?.clientId]), [["filing_destination.rejected", null, areaClient.id], ["filing_destination.rejection_withdrawn", null, areaClient.id]]);
});

await check("(b) an entry removed from the client after the queue was read is refused (404)", () => {
  const { act } = twinJob(UTIL);
  updateClient(db, areaClient.id, { serviceArea: [{ kind: "city", state: "ZZ", name: "Wicklebury" }] });
  assert.throws(() => fdp.serviceAreaDecisionJob(db, { id: areaClient.id }, { entryKey: act.entryKey, authorityKey: act.authorityKey, track: act.track }), (e: { status?: number }) => e.status === 404);
  updateClient(db, areaClient.id, { serviceArea: [{ kind: "city", state: "ZZ", name: "Marrowgate" }, { kind: "city", state: "ZZ", name: "Wicklebury" }, { kind: "utility", state: "ZZ", name: UTIL }] });
});

await check("(f) the routes: three twins under /api/clients/:id, person named first, the same decision functions; no new write in the module", () => {
  const server = read("backend/src/server.ts");
  const regs = [...server.matchAll(/app\.(get|post|put|delete|patch)\(\s*"(\/api\/clients\/:id\/service-area[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(regs, ["put /api/clients/:id/service-area/filing-destinations", "post /api/clients/:id/service-area/filing-destinations/reject", "delete /api/clients/:id/service-area/filing-destinations/reject"]);
  const fnFor: Record<string, string> = { put: "decideFilingDestination", post: "rejectFilingDestination", delete: "withdrawDestinationRejection" };
  for (const reg of regs) {
    const [verb, p] = reg.split(" ");
    const start = server.indexOf(`app.${verb}("${p}"`);
    const body = server.slice(start, server.indexOf("\n}));", start));
    const named = body.indexOf("destinationPerson(req");
    assert.ok(named > 0 && named < body.indexOf("serviceAreaDecisionJob(db") && named < body.indexOf(`${fnFor[verb]}(db`), `${reg}: the person is not named before the decision`);
    assert.ok(body.includes(`${fnFor[verb]}(db, job`), `${reg} does not call ${fnFor[verb]}`);
    assert.ok(!/db\.run|INSERT|UPDATE|DELETE FROM/.test(body), `${reg} writes on its own`);
  }
  assert.match(server, /app\.use\("\/api\/clients\/:id",\s*(?:child)?[sS]copeGuard\(/, "the client scope guard is gone");
  const src = read("backend/src/filingDestinationProposals.ts");
  assert.deepEqual((src.match(/\b(?:INSERT INTO|UPDATE(?!\s+SET\b)|DELETE FROM)\s+\w+/g) ?? []).sort(), ["DELETE FROM filing_destination_rejections", "INSERT INTO filing_destination_rejections"]);
  assert.match(read("backend/test/tenancy.test.ts"), /service-area\/filing-destinations/);
});

await check("(g) the view and the dashboard: an area proposal's buttons name its client, entry and authority; the click goes to the twin with the track card's body plus those two keys", () => {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(read("frontend/filing-destination.js"), sandbox);
  const FD = sandbox.FilingDestination as { renderQueue: (q: unknown) => string; confirmBody: (t: string, p: unknown) => Record<string, unknown> };
  const q = queue();
  const html = FD.renderQueue(q);
  const a = areaEntry(UTIL)!;
  const act = a.proposals[0].areaAct!;
  const btn = html.match(new RegExp(`<button[^>]*data-fd-confirm[^>]*data-fd-id="${a.proposals[0].id}"[^>]*>`))?.[0] ?? "";
  assert.ok(btn.includes(`data-fd-client="${areaClient.id}"`) && btn.includes(`data-fd-area-entry="${act.entryKey}"`) && btn.includes(`data-fd-authority-key="${act.authorityKey}"`) && !btn.includes("data-fd-project"), btn);
  assert.equal((html.match(/data-fd-confirm/g) ?? []).length, q.clients.flatMap((c) => c.authorities).flatMap((x) => x.proposals).length, "a confirm button is not one per proposal");
  assert.ok(!/confirm all|bulk/i.test(html));
  const dash = read("frontend/dashboard.js");
  const ctx = dash.slice(dash.indexOf("function destinationQueueContext"), dash.indexOf("async function loadDestinationQueue"));
  assert.match(ctx, /\/api\/clients\/\$\{encodeURIComponent\(btn\.dataset\.fdClient\)\}\/service-area\/filing-destinations/);
  assert.match(ctx, /extra: \{ areaEntry: btn\.dataset\.fdAreaEntry \|\| "", authorityKey: btn\.dataset\.fdAuthorityKey \|\| "" \}/);
  const decide = dash.slice(dash.indexOf("async function decideFilingDestination"), dash.indexOf("function bindFilingDestinationButtons"));
  assert.ok(decide.indexOf("namedPersonConsent(") < decide.indexOf("if (ctx.extra) body = { ...body, ...ctx.extra };") && decide.indexOf("if (ctx.extra)") < decide.indexOf("await api(path"), "the extra keys are not added after the person is named and before the one call");
});

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
