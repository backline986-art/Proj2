// A UTILITY'S SEEDED KNOWLEDGE-BASE DOOR IS OFFERED IN "DESTINATIONS TO CONFIRM" — FOR EDIT ONLY
// (soft run on main f280d056, finding 3; backend/src/filingDestinationProposals.ts).
//
// A utility whose only door is its seeded knowledge-base row with no page words showed status "none"
// with no proposal, although the NEM track card showed the address ("seeded knowledge base — verify"):
// the queue hid a door a person could verify. It is now offered as a proposal marked `seeded`.
// Filing doors stay person-verified (owner, 2026-11-10; CLAUDE.md rules 1, 3 and 5), so this pins, on
// synthetic utilities (invented names, state ZZ):
//   (a) the seeded door the track shows is proposed: marked seeded, from "seeded_kb", not official,
//       no words, the page the row names pre-filled, and a problem that says Edit only;
//   (b) READING WRITES NOTHING, and the track is byte-identical: still seeded, never verified;
//   (c) NEVER A ONE-CLICK CONFIRM: a Confirm naming it is refused (by its mark), nothing is written;
//   (d) EDIT AND SAVE, BY A NAMED PERSON, WITH THE PAGE AND ITS WORDS: refused without a person, a
//       page or words, and refused for an address rule 5 turns away; then it writes the EXISTING
//       person-verified utility record, and only then does the track read verified;
//   (e) THE SAME REFUSALS AS EVERY DOOR: a seeded information page and a seeded permit portal are
//       never offered (rule 5's hostFitsTrackAndEntity, the information-page refusal); a seeded
//       address the door checks would turn away is listed as skipped with why;
//   (f) a cited door for the same address is the one shown (no seeded twin beside it), and a seeded
//       lookup address still beats the seeded KB row;
//   (g) Reject and Offer again work on it like any proposal;
//   (h) the queue lists it as "needs Edit", never one-click;
//   (i) the card draws no Confirm button for it, and escapes every value.
//   npx tsx backend/test/seededUtilityDoorProposal.test.ts
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seeded-utility-door-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const repo = await import("../src/repository");
const fdp = await import("../src/filingDestinationProposals");
const tracksMod = await import("../src/submittalTracks");
const ufMod = await import("../src/utilityFilingLookup");
const { knowledgeProfileKey } = await import("../src/knowledgeBase");
const db = await openDatabase();

const STATE = "ZZ";
const PERSON = "Pat Synthetic";
const client = createClient(db, { companyName: "Seeded Door Solar", ccbLicenseNumber: "790791" });
const mk = (utility: string) =>
  repo.createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Fernhollow", state: STATE, zip: "99999", ahj: "City of Fernhollow", utility } as never).project.id as string;
const project = (id: string) => repo.getProjectDetail(db, id).project;
const views = (id: string) => tracksMod.getSubmittalTracks(db, project(id));
const utilityGroup = (id: string) => fdp.filingDestinationsFor(db, project(id), views(id)).find((d) => d.authority.kind === "utility")!;
const nem = (id: string) => views(id).find((t) => t.type === "nem")!;
const changes = () => (db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0);

let kbN = 0;
/** A SEEDED utility-wide knowledge-base row (no AHJ, no person's verify), as a reference import leaves it. */
const kbRow = (utility: string, portalUrl: string, opts: { platform?: string; name?: string; source?: string } = {}) =>
  db.run(`INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, portal_platform, confidence, notes, sources_json, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
          VALUES (?, ?, ?, '', ?, ?, ?, ?, 'seeded', '', ?, datetime('now'), datetime('now'), datetime('now'), NULL, '')`,
  [`kb-seeded-door-${++kbN}`, knowledgeProfileKey({ state: STATE, utility }), STATE, utility, opts.name ?? "", portalUrl, opts.platform ?? "", JSON.stringify(opts.source ? [opts.source] : [])]);
const refused = (fn: () => unknown, status: number, re: RegExp) => {
  try { fn(); } catch (err) {
    assert.ok(err instanceof fdp.DestinationRefused, String(err));
    assert.equal((err as InstanceType<typeof fdp.DestinationRefused>).status, status, (err as Error).message);
    assert.match((err as Error).message, re);
    return;
  }
  assert.fail("not refused");
};
const verifiedKbRows = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE verified_at IS NOT NULL AND verified_at != ''")?.n ?? 0;

// The case from the run: a utility whose only door is its seeded KB row (a tenant login, no words).
const LARK = "Larkspur Valley Electric";
const LARK_DOOR = "https://larkspurvalley.powerclerk.com/MvcAccount/Login";
const LARK_PAGE = "https://www.larkspur-valley-electric.example/customer-generation";
kbRow(LARK, LARK_DOOR, { platform: "PowerClerk", name: "Larkspur Valley Customer Generation Portal", source: LARK_PAGE });
const projLark = mk(LARK);

await check("(a) the seeded door the NEM track shows is proposed: marked seeded, Edit only, with the row's page pre-filled", () => {
  const card = nem(projLark);
  assert.match(String(card.channel), /seeded knowledge base — verify/, String(card.channel));
  assert.ok(String(card.channel).includes(LARK_DOOR));
  const g = utilityGroup(projLark);
  assert.equal(g.status, "proposed", JSON.stringify(g));
  assert.equal(g.proposals.length, 1);
  const p = g.proposals[0];
  assert.equal(p.seeded, true);
  assert.equal(p.from, "seeded_kb");
  assert.equal(p.kind, "portal");
  assert.equal(p.address, LARK_DOOR);
  assert.equal(p.official, false);
  assert.equal(p.quote, "");
  assert.equal(p.fetchedAt, "");
  assert.equal(p.quoteNamesAddress, false);
  assert.equal(p.sourceUrl, LARK_PAGE);
  assert.equal(p.problems.length, 1);
  assert.match(p.problems[0], /seeded knowledge-base entry with no page words on file.*never offered.*use Edit/);
  // The same citation test as every candidate: its shortfalls are named.
  assert.match(p.problems[0], /no verbatim quote; no fetched-at time/);
});

await check("(b) READING WRITES NOTHING, and the track is identical: still seeded, never verified, never ready", () => {
  const before = JSON.stringify(views(projLark));
  const kbBefore = verifiedKbRows();
  const c0 = changes();
  for (let i = 0; i < 3; i++) utilityGroup(projLark);
  assert.equal(changes(), c0, "reading the proposals wrote to the database");
  assert.equal(JSON.stringify(views(projLark)), before, "reading the proposals changed a track");
  assert.equal(verifiedKbRows(), kbBefore);
  assert.equal(nem(projLark).channelBasis, "profile");
  assert.equal(ufMod.utilityTrackPresentation(db, project(projLark)).basis, "profile");
});

await check("(c) NEVER A ONE-CLICK CONFIRM: a Confirm naming the seeded proposal is refused and writes nothing", () => {
  const p = utilityGroup(projLark).proposals[0];
  const kbBefore = verifiedKbRows();
  const body = { track: "nem" as const, proposalId: p.id, kind: p.kind, address: p.address, sourceUrl: p.sourceUrl, quote: p.quote };
  refused(() => fdp.decideFilingDestination(db, project(projLark), views(projLark), body, PERSON), 409, /seeded address.*cannot be confirmed by one click.*use Edit/);
  // Even with words typed into the click: a Confirm names the proposal, and the proposal is seeded.
  refused(() => fdp.decideFilingDestination(db, project(projLark), views(projLark), { ...body, quote: "Apply online through our portal" }, PERSON), 409, /seeded address/);
  assert.equal(verifiedKbRows(), kbBefore);
  assert.equal(nem(projLark).channelBasis, "profile");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'filing_destination.%'")?.n ?? 0, 0, "a refused click was audited as a decision");
});

await check("(d) EDIT AND SAVE needs a named person, the page and its words, and passes rule 5; only then is the door verified", () => {
  const p = utilityGroup(projLark).proposals[0];
  const kbBefore = verifiedKbRows();
  const edit = (over: Record<string, unknown> = {}, who = PERSON) =>
    fdp.decideFilingDestination(db, project(projLark), views(projLark), { track: "nem", kind: "portal", address: p.address, sourceUrl: LARK_PAGE, quote: "Submit your customer generation application through our online portal.", ...over } as never, who);
  refused(() => edit({}, ""), 400, /named person/);
  refused(() => edit({ sourceUrl: "" }), 400, /which http\(s\) page/);
  refused(() => edit({ quote: "" }), 400, /page's own words/);
  // The seeded proposal's own fields (no words) are not a statement.
  refused(() => edit({ sourceUrl: p.sourceUrl, quote: p.quote }), 400, /page's own words/);
  // A permit portal on the NEM track (rule 5), and an information page.
  assert.throws(() => edit({ address: "https://aca-prod.accela.com/LARKSPUR/Default.aspx" }), (e: Error) => e instanceof fdp.DestinationRefused && e.status === 409);
  assert.equal(verifiedKbRows(), kbBefore, "a refused save verified a row");
  assert.equal(nem(projLark).channelBasis, "profile");
  const r = edit();
  assert.equal(r.action, "stated");
  const kb = db.get<{ portal_url: string; verified_by: string; verified_at: string }>("SELECT portal_url, verified_by, verified_at FROM permit_utility_knowledge WHERE utility = ? AND verified_at IS NOT NULL AND verified_at != ''", [LARK]);
  assert.equal(kb?.portal_url, LARK_DOOR);
  assert.equal(kb?.verified_by, PERSON);
  assert.ok(db.get("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'filing_destination.stated' AND actor_name = ?", [projLark, PERSON]));
  assert.equal(ufMod.utilityTrackPresentation(db, project(projLark)).basis, "verified");
  const g = utilityGroup(projLark);
  assert.equal(g.status, "verified");
  assert.deepEqual(g.proposals, []);
});

await check("(e) THE SAME REFUSALS AS EVERY DOOR: a seeded information page and a seeded permit portal are never offered", () => {
  kbRow("Cholla Creek Electric", "https://www.cholla-creek-electric.example/customer-solar-program", { platform: "PowerClerk" });
  kbRow("Yucca Flat Electric", "https://aca-prod.accela.com/YUCCAFLAT/Default.aspx");
  for (const utility of ["Cholla Creek Electric", "Yucca Flat Electric"]) {
    const g = utilityGroup(mk(utility));
    assert.deepEqual(g.proposals, [], `${utility}: ${JSON.stringify(g.proposals)}`);
    assert.equal(g.status, "none", utility);
    assert.ok(!JSON.stringify(g).includes("accela"), "a permit portal reached the utility's destinations");
  }
});

await check("(e) a seeded address the door checks would turn away is listed as skipped with why, not offered", () => {
  const proj = mk("Thistle Ridge Light");
  kbRow("Thistle Ridge Light", "https://regionalgrid.powerclerk.com/", { platform: "PowerClerk" });
  // The track card shows this seeded address (rule 5 lets a utility's row name its platform host)...
  assert.equal(ufMod.utilityTrackPresentation(db, project(proj)).seededDoor?.url, "https://regionalgrid.powerclerk.com/");
  // ...but it is a shared platform's bare host that does not name this utility: not offered.
  const g = utilityGroup(proj);
  assert.deepEqual(g.proposals, [], JSON.stringify(g.proposals));
  assert.equal(g.skipped.length, 1, g.skipped.join("\n"));
  assert.match(g.skipped[0], /seeded knowledge base, no page words on file\): .*does not show Thistle Ridge Light's own tenant/);
  assert.equal(g.status, "none");
});

await check("(f) a seeded LOOKUP address beats the seeded KB row (the cited one is proposed, no seeded twin)", () => {
  const utility = "Juniper Hollow Cooperative";
  const lookupDoor = "https://juniperhollow.powerclerk.com/MvcAccount/Login";
  const page = "https://www.juniperhollow-zz.gov/solar/apply";
  const s = ufMod.saveUtilityFilingLookup(db, {
    state: STATE, utility, lookedUpAt: "2026-11-10T08:19:28Z",
    filing: { value: { name: "PowerClerk", url: lookupDoor }, sourceUrl: page, quote: "Submit your interconnection application online through PowerClerk", origin: "lookup" },
    program: { value: "net_metering", sourceUrl: page, quote: "Net metering program", origin: "lookup" },
  } as never);
  assert.ok(s.saved, s.reason);
  kbRow(utility, lookupDoor, { platform: "PowerClerk" });
  const g = utilityGroup(mk(utility));
  assert.deepEqual(g.proposals.map((p) => [p.address, p.from, p.seeded ?? false]), [[lookupDoor, "utility_lookup", false]]);
});

await check("(f) a shipped, cited door seeded into the KB row is shown once, as the cited proposal", () => {
  // Real shipped reference data (reference-utility-application-requirements.json `filingDoor`), read
  // only: the one utility on file whose cited door is also its seeded KB row.
  const proj = repo.createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "2 Test Way", city: "Boise", state: "ID", zip: "83702", ahj: "City of Boise", utility: "Idaho Power" } as never).project.id as string;
  const g = utilityGroup(proj);
  assert.equal(g.proposals.length, 1, JSON.stringify(g.proposals, null, 1));
  assert.equal(g.proposals[0].from, "reference");
  assert.ok(!g.proposals[0].seeded);
  assert.ok(g.proposals[0].quote.length > 8);
});

const WREN = "Wrenfield Rural Electric";
const WREN_DOOR = "https://wrenfieldrural.powerclerk.com/MvcAccount/Login";
kbRow(WREN, WREN_DOOR, { platform: "PowerClerk" });
const projWren = mk(WREN);

await check("(g) Reject and Offer again work on a seeded proposal like any other", () => {
  const p = utilityGroup(projWren).proposals[0];
  assert.equal(p.seeded, true);
  assert.equal(p.sourceUrl, "", "a row that names no page pre-fills none");
  fdp.rejectFilingDestination(db, project(projWren), views(projWren), { track: "nem", proposalId: p.id, reason: "Old tenant" }, PERSON);
  let g = utilityGroup(projWren);
  assert.deepEqual(g.proposals, []);
  assert.equal(g.status, "none");
  assert.equal(g.rejected[0]?.rejectedBy, PERSON);
  assert.deepEqual(fdp.withdrawDestinationRejection(db, project(projWren), { track: "nem", proposalId: p.id }, PERSON), { withdrawn: true });
  g = utilityGroup(projWren);
  assert.deepEqual(g.proposals.map((x) => x.id), [p.id]);
});

await check("(h) the queue lists it as needing Edit, never one-click, and reading the queue writes nothing", () => {
  const c0 = changes();
  const q = fdp.filingDestinationQueue(db, null, (p) => tracksMod.getSubmittalTracks(db, p));
  assert.equal(changes(), c0, "reading the queue wrote to the database");
  const a = q.clients.flatMap((c) => c.authorities).find((x) => x.authority.kind === "utility" && x.authority.name === WREN);
  assert.ok(a, "the seeded-door utility is not in the queue");
  assert.equal(a!.status, "proposed");
  assert.deepEqual(a!.proposals.map((p) => [p.address, p.seeded, p.problems.length > 0, p.act?.projectId, p.act?.track]), [[WREN_DOOR, true, true, projWren, "nem"]]);
  // No seeded proposal anywhere in the queue is one-click.
  for (const p of q.clients.flatMap((c) => c.authorities).flatMap((x) => x.proposals)) if (p.seeded) assert.ok(p.problems.length > 0, p.address);
});

await check("(i) the card: 'Seeded', Edit and save and Reject, no Confirm button, every value escaped", () => {
  const sandbox: { window: Record<string, unknown>; URL: typeof URL } = { window: {}, URL };
  vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend/filing-destination.js"), "utf8"), sandbox, { filename: "filing-destination.js" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const FD = sandbox.window.FilingDestination as any;
  const g = utilityGroup(projWren);
  const html: string = FD.renderGroup({ destinations: [g] }, "utility");
  assert.match(html, /Seeded — not yet confirmed/);
  assert.match(html, /data-fd-seeded/);
  assert.ok(html.includes(WREN_DOOR));
  assert.doesNotMatch(html, /data-fd-confirm/, "a Confirm button is drawn for a seeded address");
  assert.match(html, /<button[^>]*data-fd-edit[^>]*>Edit and save<\/button>/);
  assert.match(html, /data-fd-reject/);
  assert.match(html, /data-fd-save/);
  assert.match(html, /<textarea data-fd-field="quote" rows="3"><\/textarea>/, "the words are the person's to copy: never pre-filled");
  const HOSTILE = `<img src=x onerror="alert(1)">`;
  const hostile: string = FD.renderGroup({ destinations: [{ ...g, authority: { ...g.authority, name: HOSTILE }, proposals: [{ ...g.proposals[0], address: HOSTILE, name: HOSTILE, sourceUrl: `javascript:${HOSTILE}`, sourceHost: HOSTILE }] }] }, "utility");
  assert.ok(!hostile.includes("<img"), "a value reached the page unescaped");
  assert.doesNotMatch(hostile, /href="javascript:/);
  // In the queue view too.
  const q = fdp.filingDestinationQueue(db, null, (p) => tracksMod.getSubmittalTracks(db, p));
  const queueHtml: string = FD.renderQueue(q);
  assert.match(queueHtml, /Seeded — not yet confirmed/);
  const seededBlock = queueHtml.split('data-fd-proposal="').find((b) => b.includes("data-fd-seeded")) ?? "";
  assert.doesNotMatch(seededBlock, /data-fd-confirm/);
});

if (failures) { console.error(`\nseededUtilityDoorProposal: ${failures} check(s) FAILED.`); process.exit(1); }
console.log("\nseededUtilityDoorProposal: all checks passed.");
