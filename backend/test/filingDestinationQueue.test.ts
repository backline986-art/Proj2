// DESTINATIONS TO CONFIRM (owner, 2026-11-10): ONE screen listing every authority an open job of the
// org files with whose door no person has verified, grouped by client, with the doordest proposals and
// the SAME Confirm / Edit / Reject on the SAME routes (filingDestinationProposals.filingDestinationQueue,
// GET /api/filing-destinations, frontend/filing-destination.js renderQueue).
//
// Pinned here, on synthetic authorities (invented names, state ZZ):
//   (a) grouping: by client; one entry per authority per client, listing every job that waits on it;
//       each proposal is byte-identical to what that job's own filingDestinationsFor shows on its track
//       card, and names that job and track (`act`); an archived job and a submitted track are not listed;
//   (b) READING THE QUEUE WRITES NOTHING: total_changes() and every job's track views are identical
//       before and after;
//   (c) ORG-SCOPED (rule 6): the default org never sees another org's job or authority; that org sees only
//       its own; null (superadmin) sees both; the route passes reqOrgFilter, is GET-only, and adds no
//       write path (the module's only writes are still the rejection INSERT / DELETE);
//   (d) a Confirm sent to the job and track the queue names (the EXISTING decideFilingDestination) records
//       the person-verified door; the authority leaves the queue for every client and is counted as
//       verified; a Reject sent the same way leaves the authority listed with the rejection and its act;
//   (e) "check by hand": per-authority DATA (reference-hand-check-pages.json or HAND_CHECK_PAGES_PATH)
//       matched by the authority's name core; a non-http(s) page is dropped; the shipped file parses, and
//       every record names an AHJ the shipped reference data knows;
//   (f) the view (node:vm): everything escaped; each button carries its job (data-fd-project) and track;
//       there is no bulk action; Confirm's body from the queue equals Confirm's body from the track card;
//       an authority with nothing to propose links its job; "check by hand" shows the page link;
//   (g) the dashboard wiring: the queue's buttons go through the SAME decideFilingDestination (one
//       function, a context per screen) and the named-person confirm precedes the one route call.
//   npx tsx backend/test/filingDestinationQueue.test.ts
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

// ── synthetic reference data: invented AHJs in state ZZ, each citing its own official page ──────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filing-destination-queue-"));
const AHJ_A = "City of Fernhollow";
const AHJ_B = "Town of Alderbank";
const AHJ_C = "Village of Quillmere"; // the OTHER org's job files here
const UTIL_A = "Brightwater Valley Electric";
const A_PAGE = "https://www.fernhollow-zz.gov/building/solar";
const A_PORTAL = "https://permits.fernhollow-zz.gov/apply";
const B_PAGE = "https://www.alderbank-zz.gov/building";
const B_PORTAL = "https://permits.alderbank-zz.gov/online";
const C_PAGE = "https://www.quillmere-zz.gov/permits";
const C_PORTAL = "https://permits.quillmere-zz.gov/apply";
const UTIL_A_PAGE = "https://www.brightwater-zz.gov/solar/apply";
const UTIL_A_PORTAL = "https://brightwater.powerclerk.com/MvcAccount/Login";
const READ_AT = "2026-11-10T08:19:28Z";
const blankProfile = (ahj: string) => ({
  state: "ZZ", ahj, submissionMethod: "", timeline: "",
  requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "ZZ synthetic",
});
const cited = (ahj: string, value: string, page: string, quote: string) => ({
  ...blankProfile(ahj), submissionMethod: `Online portal ${value}`,
  citations: [{ field: "submissionMethod", value, sourceUrl: page, quote, fetchedAt: READ_AT }],
});
const reference = {
  generatedFrom: "filingDestinationQueue.test", count: 3,
  profiles: [
    cited(AHJ_A, A_PORTAL.replace(/^https:\/\//, ""), A_PAGE, "Apply for a Permit"),
    cited(AHJ_B, B_PORTAL.replace(/^https:\/\//, ""), B_PAGE, "Apply online at permits.alderbank-zz.gov"),
    cited(AHJ_C, C_PORTAL.replace(/^https:\/\//, ""), C_PAGE, "Apply online"),
  ],
};
const refPath = path.join(tmpDir, "reference-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify(reference));
const handPath = path.join(tmpDir, "hand-check.json");
fs.writeFileSync(handPath, JSON.stringify({
  pages: [
    // Matches "Town of Alderbank" by its name core.
    { authorityKind: "ahj", state: "ZZ", authority: "Alderbank", pageUrl: "https://www.alderbank-zz.gov/permits/171", happened: "connection reset", check: "Whether solar takes one permit or two.", recordedAt: "2026-11-10", source: "synthetic" },
    // Not http(s): dropped at load.
    { authorityKind: "ahj", state: "ZZ", authority: "Alderbank", pageUrl: "javascript:alert(1)", happened: "x", check: "x", recordedAt: "", source: "" },
    // Another state: never matches.
    { authorityKind: "ahj", state: "YY", authority: "Alderbank", pageUrl: "https://elsewhere-yy.gov/", happened: "x", check: "x", recordedAt: "", source: "" },
  ],
}));
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
const { createClient } = await import("../src/clients");
const repo = await import("../src/repository");
const fdp = await import("../src/filingDestinationProposals");
const tracksMod = await import("../src/submittalTracks");
const ufMod = await import("../src/utilityFilingLookup");
const hcp = await import("../src/handCheckPages");
const db = await openDatabase();

const OTHER_ORG = "org-queue-other";
const clientOne = createClient(db, { companyName: "Queue One Solar", ccbLicenseNumber: "792792" });
const clientTwo = createClient(db, { companyName: "Queue Two Solar", ccbLicenseNumber: "793793" });
const clientOther = createClient(db, { companyName: "Other Org Solar", ccbLicenseNumber: "794794" });
const mk = (clientId: string, ahj: string, utility: string, owner: string) =>
  repo.createProject(db, { clientId, owner, street: "1 Test Way", city: "Fernhollow", state: "ZZ", zip: "99999", ahj, utility } as never).project.id as string;
const jobA1 = mk(clientOne.id, AHJ_A, UTIL_A, "Synthetic Owner One");
const jobA2 = mk(clientOne.id, AHJ_A, UTIL_A, "Synthetic Owner Two");
const jobB = mk(clientTwo.id, AHJ_B, "", "Synthetic Owner Three");
const jobA3 = mk(clientTwo.id, AHJ_A, "", "Synthetic Owner Four");
const jobArchived = mk(clientTwo.id, "Hamlet of Archivedale", "", "Synthetic Owner Five");
const jobOther = mk(clientOther.id, AHJ_C, "", "Synthetic Owner Six");
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, ?, ?)", [OTHER_ORG, "Other synthetic org", "full", new Date().toISOString()]);
db.run("UPDATE projects SET org_id = ? WHERE id = ?", [OTHER_ORG, jobOther]);
db.run("UPDATE clients SET org_id = ? WHERE id = ?", [OTHER_ORG, clientOther.id]);
db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), jobArchived]);

const s1 = ufMod.saveUtilityFilingLookup(db, {
  state: "ZZ", utility: UTIL_A, lookedUpAt: READ_AT,
  filing: { value: { name: "PowerClerk", url: UTIL_A_PORTAL }, sourceUrl: UTIL_A_PAGE, quote: "Submit your interconnection application online through PowerClerk", origin: "lookup" },
  program: { value: "net_metering", sourceUrl: UTIL_A_PAGE, quote: "Net metering program", origin: "lookup" },
} as never);
assert.ok(s1.saved, `setup: ${s1.reason}`);

const project = (id: string) => repo.getProjectDetail(db, id).project;
const readTracks = (p: Parameters<typeof tracksMod.getSubmittalTracks>[1]) => tracksMod.getSubmittalTracks(db, p);
const queue = (orgId: string | null = DEFAULT_ORG_ID) => fdp.filingDestinationQueue(db, orgId, readTracks);
const changes = () => (db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0);
const PERSON = "Pat Synthetic";
const ahjEntry = (q: ReturnType<typeof queue>, clientId: string, name: string) =>
  q.clients.find((c) => c.clientId === clientId)?.authorities.find((a) => a.authority.kind === "ahj" && a.authority.name === name);

await check("(a) grouped by client; one entry per authority per client listing every waiting job; archived jobs are left out", () => {
  const q = queue();
  assert.deepEqual(q.clients.map((c) => c.clientName), ["Queue One Solar", "Queue Two Solar"]);
  const one = q.clients[0];
  assert.deepEqual(one.authorities.map((a) => `${a.authority.kind}:${a.authority.name}`), [`ahj:${AHJ_A}`, `utility:${UTIL_A}`]);
  const a = ahjEntry(q, clientOne.id, AHJ_A)!;
  assert.deepEqual(a.jobs.map((j) => j.projectId).sort(), [jobA1, jobA2].sort());
  assert.match(a.jobs[0].label, /Synthetic Owner/);
  const two = q.clients[1];
  assert.deepEqual(two.authorities.map((x) => x.authority.name).sort(), [AHJ_A, AHJ_B].sort());
  assert.ok(!JSON.stringify(q).includes("Archivedale"), "an archived job's authority is listed");
  // A shared authority (AHJ_A, under both clients) is counted once.
  assert.equal(q.counts.authorities, 3);
  assert.equal(q.counts.jobs, 4);
  // Nothing account- or meter-shaped rides along: the queue carries job ids and labels only.
  assert.ok(!/accountNumber|meterNumber/.test(JSON.stringify(q)));
});

await check("(a) each proposal is exactly the one the job's own track card shows, and names that job and track", () => {
  const q = queue();
  for (const c of q.clients) for (const a of c.authorities) for (const p of a.proposals) {
    const { act, ...shown } = p;
    const card = fdp.filingDestinationsFor(db, project(act.projectId), readTracks(project(act.projectId)))
      .find((g) => g.authority.kind === a.authority.kind && g.authority.profileKey === a.authority.profileKey)!;
    assert.ok(card.tracks.includes(act.track), `${act.track} is not one of the card's tracks ${card.tracks}`);
    assert.deepEqual(card.proposals.find((x) => x.id === p.id), shown, "the queue's proposal differs from the track card's");
  }
  const a = ahjEntry(q, clientOne.id, AHJ_A)!;
  assert.equal(a.status, "proposed");
  assert.deepEqual(a.proposals.map((p) => [p.kind, p.address, p.problems.length]), [["portal", A_PORTAL, 0]]);
});

await check("(a) a track already submitted is not waiting on a door", () => {
  const q = fdp.filingDestinationQueue(db, DEFAULT_ORG_ID, (p) => readTracks(p).map((t) => (p.id === jobB ? { ...t, outstanding: false } : t)));
  assert.equal(ahjEntry(q, clientTwo.id, AHJ_B), undefined);
});

await check("(b) READING THE QUEUE WRITES NOTHING: no row, and every job's tracks are identical", () => {
  const ids = [jobA1, jobA2, jobB, jobA3, jobOther];
  const before = ids.map((id) => JSON.stringify(readTracks(project(id)))).join("\n");
  const c0 = changes();
  for (let i = 0; i < 3; i++) { queue(); queue(null); queue(OTHER_ORG); }
  assert.equal(changes(), c0, "reading the queue wrote to the database");
  assert.equal(ids.map((id) => JSON.stringify(readTracks(project(id)))).join("\n"), before, "reading the queue changed a track");
});

await check("(c) ORG-SCOPED: the default org never sees the other org's job; that org sees only its own; superadmin sees both", () => {
  const mine = JSON.stringify(queue());
  assert.ok(!mine.includes(AHJ_C) && !mine.includes(jobOther) && !mine.includes("Other Org Solar"), "another org's job reached the queue");
  const theirs = queue(OTHER_ORG);
  assert.deepEqual(theirs.clients.map((c) => c.clientName), ["Other Org Solar"]);
  assert.deepEqual(theirs.clients[0].authorities.map((a) => a.authority.name), [AHJ_C]);
  assert.ok(!JSON.stringify(theirs).includes(jobA1));
  const all = queue(null);
  assert.deepEqual(all.clients.map((c) => c.clientName), ["Other Org Solar", "Queue One Solar", "Queue Two Solar"]);
});

await check("(c) the route is one GET, filtered by reqOrgFilter, and the module adds no write path", () => {
  const server = read("backend/src/server.ts");
  const regs = [...server.matchAll(/app\.(get|post|put|delete|patch)\(\s*"\/api\/filing-destinations[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(regs, ['app.get("/api/filing-destinations"']);
  const start = server.indexOf('app.get("/api/filing-destinations"');
  const body = server.slice(start, server.indexOf("\napp.", start + 10));
  assert.match(body, /filingDestinationQueue\(db,\s*reqOrgFilter\(db,\s*req\)/);
  const src = read("backend/src/filingDestinationProposals.ts");
  assert.deepEqual((src.match(/\b(?:INSERT INTO|UPDATE(?!\s+SET\b)|DELETE FROM)\s+\w+/g) ?? []).sort(), ["DELETE FROM filing_destination_rejections", "INSERT INTO filing_destination_rejections"]);
  assert.deepEqual((read("backend/src/handCheckPages.ts").match(/\b(?:INSERT|UPDATE|DELETE|writeFile\w*|db\.run)\b/g) ?? []), []);
  assert.match(read("backend/test/routeScope.test.ts"), /"\/api\/filing-destinations": "reqOrgFilter"/);
});

await check("(e) check by hand: per-authority data, matched by name core; a non-http(s) page and another state's page are not shown", () => {
  const b = ahjEntry(queue(), clientTwo.id, AHJ_B)!;
  assert.deepEqual(b.handCheck.map((h) => h.pageUrl), ["https://www.alderbank-zz.gov/permits/171"]);
  assert.equal(ahjEntry(queue(), clientOne.id, AHJ_A)!.handCheck.length, 0);
  assert.equal(queue().counts.handCheck, 1);
  assert.equal(hcp.parseHandCheckPage({ authorityKind: "ahj", state: "ZZ", authority: "X", pageUrl: "ftp://x.gov/" }), null);
  assert.equal(hcp.parseHandCheckPage({ authorityKind: "city", state: "ZZ", authority: "X", pageUrl: "https://x.gov/" }), null);
});

await check("(e) the shipped hand-check file parses, every page is http(s), and every record names an AHJ the shipped reference data knows", () => {
  const raw = JSON.parse(read("backend/data/reference-hand-check-pages.json")) as { pages: unknown[] };
  assert.ok(raw.pages.length >= 1);
  const parsed = raw.pages.map(hcp.parseHandCheckPage);
  assert.equal(parsed.filter(Boolean).length, raw.pages.length, "a shipped record does not parse");
  const ref = JSON.parse(read("backend/data/reference-ahj-processes.json")) as { profiles: Array<{ state: string; ahj: string }> };
  const known = new Set(ref.profiles.map((p) => hcp.handCheckKey("ahj", p.state, p.ahj)));
  for (const p of parsed) {
    if (p!.authorityKind !== "ahj") continue;
    assert.ok(known.has(hcp.handCheckKey("ahj", p!.state, p!.authority)), `${p!.state} ${p!.authority} is not a reference AHJ`);
  }
});

// ── the view, loaded as the dashboard loads it ────────────────────────────────────────────────────
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(read("frontend/filing-destination.js"), sandbox, { filename: "filing-destination.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FD = sandbox.window.FilingDestination as any;

await check("(f) the view: escaped; each button names its job and track; no bulk action; Confirm's body equals the track card's", () => {
  const q = queue();
  const html: string = FD.renderQueue(q);
  assert.match(html, /Destinations|authorities wait on a person/);
  const a = ahjEntry(q, clientOne.id, AHJ_A)!;
  const p = a.proposals[0];
  assert.ok(html.includes(`data-fd-confirm data-fd-track="${p.act.track}" data-fd-project="${p.act.projectId}" data-fd-id="${p.id}"`), "Confirm does not name its job and track");
  assert.ok(!/confirm-all|data-fd-bulk|Confirm all/i.test(html), "a bulk action is offered");
  // One Confirm button per proposal, never more.
  const proposals = q.clients.reduce((n, c) => n + c.authorities.reduce((m, x) => m + x.proposals.length, 0), 0);
  assert.equal((html.match(/data-fd-confirm /g) ?? []).length, proposals);
  // The queue's Confirm sends exactly what the job's card would.
  const card = { destinations: fdp.filingDestinationsFor(db, project(p.act.projectId), readTracks(project(p.act.projectId))) };
  const fromCard = FD.findProposal(card, p.id);
  const fromQueue = FD.findProposal(FD.queuePayload(q), p.id);
  assert.deepEqual(FD.confirmBody(p.act.track, fromQueue.proposal), FD.confirmBody(fromCard.destination.tracks[0], fromCard.proposal));
  // The hand-check link and the job links.
  assert.match(html, /<a href="https:\/\/www\.alderbank-zz\.gov\/permits\/171" target="_blank" rel="noopener">www\.alderbank-zz\.gov\/permits\/171<\/a>/);
  assert.ok(html.includes(`href="#/project/${encodeURIComponent(jobA1)}"`));
  const hostile = `<img src=x onerror="alert(1)">`;
  const evil = FD.renderQueue({ clients: [{ clientId: hostile, clientName: hostile, authorities: [{ ...a, authority: { ...a.authority, name: hostile }, jobs: [{ projectId: hostile, label: hostile, tracks: [] }], proposals: [], status: "none", handCheck: [{ pageUrl: "javascript:alert(1)", happened: hostile, check: hostile }] }] }], counts: {} });
  assert.ok(!evil.includes("<img"), "an interpolated value was not escaped");
  assert.ok(!evil.includes("javascript:"), "a non-http page became a link");
  assert.match(evil, /Nothing on file to propose/);
  assert.match(FD.renderQueue({ clients: [], counts: { alreadyVerified: 2 } }), /has a person-verified destination \(2 verified\)/);
});

await check("(g) the dashboard: the queue's buttons go through the same decideFilingDestination, the person named before the one call", () => {
  const dash = read("frontend/dashboard.js");
  assert.match(dash, /async function decideFilingDestination\(btn, action, where\)[\s\S]{0,80}const ctx = \(where \|\| trackCardDestinationContext\)\(btn\)/);
  assert.match(dash, /bindFilingDestinationButtons\(body, destinationQueueContext\)/);
  assert.match(dash, /function destinationQueueContext\(btn\)[\s\S]{0,200}projectId: btn\.dataset\.fdProject/);
  assert.match(dash, /api\("\/api\/filing-destinations"\)/);
  // Inside the one function: the named-person consent comes before the one api call.
  const fn = dash.slice(dash.indexOf("async function decideFilingDestination("), dash.indexOf("function bindFilingDestinationButtons("));
  assert.ok(fn.indexOf("namedPersonConsent(") > 0 && fn.indexOf("namedPersonConsent(") < fn.indexOf("await api(path"), "the route is called before the person is named");
  // The one route call, and the job re-read the track card has always done after it.
  assert.equal((fn.match(/await api\(/g) ?? []).length, 2, "the decision calls something besides its one route and the job re-read");
  assert.equal((fn.match(/await api\(path/g) ?? []).length, 1, "the decision makes more than one write call");
  assert.match(fn, /let path = `\/api\/projects\/\$\{projectId\}\/filing-destinations`/);
  const html = read("frontend/dashboard.html");
  assert.match(html, /id="openDestQueueBtn"/);
  assert.match(html, /id="destQueueModal"/);
});

await check("(d) a Confirm sent to the job and track the queue names records the door; the authority leaves the queue for every client", () => {
  const q = queue();
  const p = ahjEntry(q, clientOne.id, AHJ_A)!.proposals[0];
  const r = fdp.decideFilingDestination(db, project(p.act.projectId), readTracks(project(p.act.projectId)),
    { track: p.act.track, proposalId: p.id, kind: p.kind, address: p.address, sourceUrl: p.sourceUrl, quote: p.quote }, PERSON);
  assert.equal(r.action, "confirmed");
  const after = queue();
  assert.equal(ahjEntry(after, clientOne.id, AHJ_A), undefined, "the confirmed authority is still listed for client one");
  assert.equal(ahjEntry(after, clientTwo.id, AHJ_A), undefined, "the confirmed authority is still listed for client two");
  assert.equal(after.counts.alreadyVerified, 1);
  for (const id of [jobA1, jobA2, jobA3]) {
    const permit = readTracks(project(id)).find((t) => t.category === "permit")!;
    assert.equal(permit.channelBasis, "verified", `${id}: ${permit.channel}`);
  }
  const audit = db.get<{ actor_name: string }>("SELECT actor_name FROM audit_logs WHERE project_id = ? AND action = 'filing_destination.confirmed'", [p.act.projectId]);
  assert.equal(audit?.actor_name, PERSON);
});

await check("(d) a Reject sent the same way leaves the authority listed with the rejection and the job to undo it on", () => {
  const b = ahjEntry(queue(), clientTwo.id, AHJ_B)!;
  const p = b.proposals[0];
  fdp.rejectFilingDestination(db, project(p.act.projectId), readTracks(project(p.act.projectId)), { track: p.act.track, proposalId: p.id, reason: "synthetic" }, PERSON);
  const after = ahjEntry(queue(), clientTwo.id, AHJ_B)!;
  assert.equal(after.status, "none");
  assert.deepEqual(after.rejected.map((x) => [x.id, x.rejectedBy, x.act.projectId]), [[p.id, PERSON, jobB]]);
  assert.match(FD.renderQueue(queue()), new RegExp(`data-fd-unreject data-fd-track="${p.act.track}" data-fd-project="${jobB}" data-fd-id="${p.id}"`));
});

db.close();
if (failures) {
  console.error(`\nfilingDestinationQueue: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nfilingDestinationQueue: all checks passed");
process.exit(0);
