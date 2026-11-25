// PROPOSED FILING DESTINATIONS, CONFIRMED BY A NAMED PERSON (owner, 2026-11-10;
// backend/src/filingDestinationProposals.ts). Where a filing goes stays a person's fact (CLAUDE.md
// rule 3's last sentence, rule 1, rule 5): Keelix only PRE-FILLS a destination it read on the
// authority's own official page, and one click by a named person writes the existing verified record.
//
// Pinned here, on synthetic authorities (invented names, state ZZ):
//   (a) proposals come only from rows on an OFFICIAL host with words and a read time; anything else is
//       listed as skipped with why, never proposed; a NEM destination never comes from the AHJ's row;
//   (b) A PROPOSAL CHANGES NOTHING: reading proposals writes no row, and the job's tracks, channel
//       basis, launchable URL and filing-email channel are byte-identical before and after — so no
//       proposal can make a filing ready, launch a portal or send an email;
//   (c) only server.ts's routes import the module (nothing that decides a channel, stages or sends can);
//   (d) Confirm refuses a blank person, a stale proposal, an altered click and a proposal with problems;
//   (e) Confirm writes the EXISTING person-verified record with who/when, audits it, and only THEN does
//       the track read "verified by a person" with that URL; the proposal is then gone;
//   (f) an email proposal is not confirmable until the authority's lookup row exists, then writes the
//       filing-email record (setFilingEmail) — the same record rule 1's email gate reads;
//   (g) a with-permit proposal writes the person's with-permit statement (#664's record);
//   (h) Reject is one click: the proposal stops being offered, is listed with who/why, and "Offer
//       again" brings it back; each is audited;
//   (i) Edit (a person's own statement) needs its page and words and passes rule 5 like every door;
//   (j) the routes sit under /api/projects/:id (tenancy guard), read the project first and name the
//       person before anything is written.
//   npx tsx backend/test/filingDestinationProposals.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

// ── synthetic reference data: two invented AHJs in state ZZ, each citing its own official page ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filing-destinations-"));
const AHJ_A = "City of Fernhollow";
const AHJ_B = "Town of Alderbank";
const UTIL_A = "Brightwater Valley Electric";
const UTIL_B = "Alderbank Municipal Light";
const A_PAGE = "https://www.fernhollow-zz.gov/building/solar";
const A_PORTAL_VALUE = "permits.fernhollow-zz.gov/apply";
const A_PORTAL = `https://${A_PORTAL_VALUE}`;
const VENDOR_PAGE = "https://www.permit-directory.example/fernhollow";
const B_PAGE = "https://www.alderbank-zz.gov/building";
const B_EMAIL = "permits@alderbank-zz.gov";
const B_QUOTE = `Email your completed solar permit application to ${B_EMAIL} with the plan set attached.`;
const UTIL_A_PAGE = "https://www.brightwater-zz.gov/solar/apply";
const UTIL_A_PORTAL = "https://brightwater.powerclerk.com/MvcAccount/Login";
const UTIL_B_PAGE = "https://www.alderbank-zz.gov/light/net-metering";
const READ_AT = "2026-11-10T08:19:28Z";
const AHJ_E = "Hamlet of Wrenfield";
const E_PAGE = "https://www.wrenfield-zz.gov/permits";
const E_QUOTE = "Submit building permit applications in person at the Hamlet Hall counter.";

const blankProfile = (ahj: string) => ({
  state: "ZZ", ahj, submissionMethod: "", timeline: "",
  requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "ZZ synthetic",
});
const reference = {
  generatedFrom: "filingDestinationProposals.test", count: 3,
  profiles: [
    {
      ...blankProfile(AHJ_A), submissionMethod: `Online portal ${A_PORTAL_VALUE}`,
      citations: [
        { field: "submissionMethod", value: A_PORTAL_VALUE, sourceUrl: A_PAGE, quote: "Apply for a Permit", fetchedAt: READ_AT },
        // Same door, cited from a directory site: not the authority's own page, so never proposed.
        { field: "submissionMethod", value: "fernhollow.permit-directory.example/apply", sourceUrl: VENDOR_PAGE, quote: "Fernhollow permits are filed online", fetchedAt: READ_AT },
        // No read time: not proposed.
        { field: "submissionMethod", value: "old.fernhollow-zz.gov/permits", sourceUrl: A_PAGE, quote: "Old permit system", fetchedAt: "" },
        // An email in the words of a NON-door field is not a door.
        { field: "requiresUtilityApproval", sourceUrl: A_PAGE, quote: "Contact the utility at solar@brightwater-zz.gov for approval", fetchedAt: READ_AT },
      ],
    },
    {
      ...blankProfile(AHJ_B), submissionMethod: "Email",
      citations: [{ field: "submissionMethod", sourceUrl: B_PAGE, quote: B_QUOTE, fetchedAt: READ_AT }],
    },
    {
      ...blankProfile(AHJ_E), submissionMethod: "In person at the counter",
      citations: [{ field: "submissionMethod", sourceUrl: E_PAGE, quote: E_QUOTE, fetchedAt: READ_AT }],
    },
  ],
};
const refPath = path.join(tmpDir, "reference-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify(reference));
process.env.AHJ_PROCESS_REFERENCE_PATH = refPath;
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
const fe = await import("../src/filingEmail");
const ppMod = await import("../src/permitProcess");
const ufMod = await import("../src/utilityFilingLookup");
const db = await openDatabase();

const client = createClient(db, { companyName: "Destination Proposal Solar", ccbLicenseNumber: "790790" });
const mk = (ahj: string, utility: string) =>
  repo.createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Fernhollow", state: "ZZ", zip: "99999", ahj, utility } as never).project.id as string;
const projA = mk(AHJ_A, UTIL_A);
const projB = mk(AHJ_B, UTIL_B);
const project = (id: string) => repo.getProjectDetail(db, id).project;
const views = (id: string) => tracksMod.getSubmittalTracks(db, project(id));
const dests = (id: string) => fdp.filingDestinationsFor(db, project(id), views(id));
const group = (id: string, kind: "ahj" | "utility") => dests(id).find((d) => d.authority.kind === kind)!;
const permitTrack = (id: string) => views(id).find((t) => t.category === "permit")!.type;
const PERSON = "Pat Synthetic";

// The utility's own seeded filing lookup (as the lookup writes it): a cited portal on its .gov page.
const s1 = ufMod.saveUtilityFilingLookup(db, {
  state: "ZZ", utility: UTIL_A, lookedUpAt: READ_AT,
  filing: { value: { name: "PowerClerk", url: UTIL_A_PORTAL }, sourceUrl: UTIL_A_PAGE, quote: "Submit your interconnection application online through PowerClerk", origin: "lookup" },
  program: { value: "net_metering", sourceUrl: UTIL_A_PAGE, quote: "Net metering program", origin: "lookup" },
} as never);
assert.ok(s1.saved, `setup: ${s1.reason}`);
// A municipal utility whose page says its application rides inside the city's permit.
const s2 = ufMod.saveUtilityFilingLookup(db, {
  state: "ZZ", utility: UTIL_B, lookedUpAt: READ_AT,
  filing: { value: { name: "City building permit application", url: null, method: "with_ahj_permit" }, sourceUrl: UTIL_B_PAGE, quote: "The net metering agreement is submitted with the building permit application.", origin: "lookup" },
  program: { value: "net_metering", sourceUrl: UTIL_B_PAGE, quote: "Net metering", origin: "lookup" },
} as never);
assert.ok(s2.saved, `setup: ${s2.reason}`);

const changes = () => (db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0);

await check("(a) the permit portal is proposed from the city's official page; the directory site is Edit-only; the undated row and a non-door email are not proposed", () => {
  const g = group(projA, "ahj");
  assert.equal(g.status, "proposed");
  assert.equal(g.proposals.length, 2, JSON.stringify(g.proposals, null, 1));
  const p = g.proposals[0];
  assert.equal(p.official, true);
  // The directory site's citation is shown for Edit only: Confirm is refused with why.
  const vendor = g.proposals[1];
  assert.equal(vendor.official, false);
  assert.equal(vendor.sourceUrl, VENDOR_PAGE);
  assert.match(vendor.problems.join(" "), /not a government host or a domain a person verified as City of Fernhollow's own.*use Edit/);
  assert.equal(p.kind, "portal");
  assert.equal(p.address, A_PORTAL);
  assert.equal(p.sourceUrl, A_PAGE);
  assert.equal(p.sourceHost, "www.fernhollow-zz.gov");
  assert.equal(p.quote, "Apply for a Permit");
  assert.equal(p.fetchedAt, READ_AT);
  assert.equal(p.from, "reference");
  assert.equal(p.quoteNamesAddress, false, "the words do not contain the address: the card must say so");
  assert.deepEqual(p.problems, []);
  assert.equal(g.skipped.length, 1, g.skipped.join("\n"));
  assert.match(g.skipped.join("\n"), /no fetched-at time/);
  assert.ok(!JSON.stringify(g).includes("solar@brightwater-zz.gov"), "an email in a non-door field became a door");
});

await check("(a) the utility's portal is proposed from its own lookup row; NEM never takes a door from the AHJ's row", () => {
  const g = group(projA, "utility");
  assert.equal(g.status, "proposed");
  assert.deepEqual(g.proposals.map((p) => [p.kind, p.address, p.from]), [["portal", UTIL_A_PORTAL, "utility_lookup"]]);
  assert.deepEqual(g.proposals[0].problems, []);
  // Pure: the NEM side reads only the utility's lookup.
  assert.deepEqual(fdp.utilityCandidates(null), []);
});

await check("(b) A PROPOSAL CHANGES NOTHING: no row is written, and the tracks, basis, URL and email channel are identical", () => {
  const before = JSON.stringify(views(projA)) + JSON.stringify(views(projB));
  const kbBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE verified_at IS NOT NULL AND verified_at != ''")?.n;
  const c0 = changes();
  for (let i = 0; i < 3; i++) { dests(projA); dests(projB); }
  assert.equal(changes(), c0, "reading proposals wrote to the database");
  assert.equal(JSON.stringify(views(projA)) + JSON.stringify(views(projB)), before, "reading proposals changed a track");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE verified_at IS NOT NULL AND verified_at != ''")?.n, kbBefore);
  const permit = views(projA).find((t) => t.category === "permit")!;
  assert.notEqual(permit.channelBasis, "verified");
  assert.ok(!String(permit.channel).includes(A_PORTAL), `the permit card names the proposed URL: ${permit.channel}`);
  assert.ok(!String((permit as { recipePortalUrl?: string }).recipePortalUrl ?? "").includes(A_PORTAL_VALUE));
  assert.equal(fe.filingEmailChannelFor(db, project(projB), permitTrack(projB)), null, "a proposed email became the filing channel");
  const nem = views(projB).find((t) => t.type === "nem")!;
  assert.ok(!/inside the AHJ permit application/.test(String(nem.channel)) || /not yet identified/.test(String(nem.channel)), `a proposed with-permit switched the NEM track: ${nem.channel}`);
});

await check("(c) only server.ts imports the proposals module: nothing that decides a channel, stages or sends can read a proposal", () => {
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(ts|js|mts)$/.test(e.name) || /\.test\.|\.smoke\./.test(e.name)) continue;
      if (/(?:from\s+|import\(\s*)["'][^"']*filingDestinationProposals["']/.test(fs.readFileSync(p, "utf8")) && !p.endsWith("filingDestinationProposals.ts")) importers.push(path.relative(REPO, p));
    }
  };
  for (const d of ["backend/src", "portal-bot/src", "shared/src"]) walk(path.join(REPO, d));
  assert.deepEqual(importers, ["backend/src/server.ts"]);
  // And the module stores no proposal: its only INSERT is the rejection, its only DELETE the undo.
  const src = fs.readFileSync(path.join(REPO, "backend/src/filingDestinationProposals.ts"), "utf8");
  assert.deepEqual((src.match(/\b(?:INSERT INTO|UPDATE(?!\s+SET\b)|DELETE FROM)\s+\w+/g) ?? []).sort(), ["DELETE FROM filing_destination_rejections", "INSERT INTO filing_destination_rejections"]);
});

await check("(d) Confirm refuses a blank person, a stale proposal, an altered click and a proposal with problems", () => {
  const p = group(projA, "ahj").proposals[0];
  const t = permitTrack(projA);
  const body = { track: t, proposalId: p.id, kind: p.kind, address: p.address, sourceUrl: p.sourceUrl, quote: p.quote };
  const refused = (fn: () => unknown, status: number, re: RegExp) => {
    try { fn(); } catch (err) {
      assert.ok(err instanceof fdp.DestinationRefused, String(err));
      assert.equal((err as InstanceType<typeof fdp.DestinationRefused>).status, status, (err as Error).message);
      assert.match((err as Error).message, re);
      return;
    }
    assert.fail("not refused");
  };
  refused(() => fdp.decideFilingDestination(db, project(projA), views(projA), body, ""), 400, /named person/);
  refused(() => fdp.decideFilingDestination(db, project(projA), views(projA), { ...body, proposalId: "0".repeat(24) }, PERSON), 409, /no longer current/);
  refused(() => fdp.decideFilingDestination(db, project(projA), views(projA), { ...body, address: "https://evil.example/apply" }, PERSON), 409, /not the proposal shown/);
  refused(() => fdp.decideFilingDestination(db, project(projA), views(projA), { ...body, quote: "Apply for a permit (edited)" }, PERSON), 409, /not the proposal shown/);
  // The email proposal for the other AHJ has a problem until its lookup row exists.
  const e = group(projB, "ahj").proposals.find((x) => x.kind === "email")!;
  assert.match(e.problems.join(" "), /run its lookup first/);
  refused(() => fdp.decideFilingDestination(db, project(projB), views(projB), { track: permitTrack(projB), proposalId: e.id, kind: "email", address: e.address, sourceUrl: e.sourceUrl, quote: e.quote }, PERSON), 409, /cannot be confirmed/);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'filing_destination.%'")?.n ?? 0, 0, "a refused click was audited as a decision");
});

await check("(e) Confirm writes the person-verified portal with who/when, audits it, and only then the track reads verified", () => {
  const p = group(projA, "ahj").proposals[0];
  const t = permitTrack(projA);
  const r = fdp.decideFilingDestination(db, project(projA), views(projA), { track: t, proposalId: p.id, kind: "portal", address: p.address, sourceUrl: p.sourceUrl, quote: p.quote }, PERSON);
  assert.equal(r.action, "confirmed");
  const kb = db.get<{ portal_url: string; verified_at: string; verified_by: string; notes: string }>(
    "SELECT portal_url, verified_at, verified_by, notes FROM permit_utility_knowledge WHERE ahj = ? AND verified_at IS NOT NULL", [AHJ_A]);
  assert.ok(kb, "no verified KB row");
  assert.equal(kb!.portal_url, A_PORTAL);
  assert.equal(kb!.verified_by, PERSON);
  assert.match(kb!.verified_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(kb!.notes, /Filing destination confirmed by Pat Synthetic from https:\/\/www\.fernhollow-zz\.gov/);
  const permit = views(projA).find((x) => x.category === "permit")!;
  assert.equal(permit.channelBasis, "verified");
  assert.match(String(permit.channel), new RegExp(`${A_PORTAL.replace(/[.\/]/g, "\\$&")} \\(verified by a person\\)`));
  const audit = db.get<{ actor: string; details_json: string }>("SELECT actor_name AS actor, details AS details_json FROM audit_logs WHERE project_id = ? AND action = 'filing_destination.confirmed'", [projA]);
  assert.ok(audit, "not audited");
  assert.equal(audit!.actor, PERSON);
  assert.match(audit!.details_json, new RegExp(p.id));
  const g = group(projA, "ahj");
  assert.equal(g.status, "verified");
  assert.deepEqual(g.proposals, []);
});

await check("(h) Reject is one click: the proposal stops being offered, is listed with who and why; Offer again brings it back", () => {
  const p = group(projA, "utility").proposals[0];
  fdp.rejectFilingDestination(db, project(projA), views(projA), { track: "nem", proposalId: p.id, reason: "That is the old tenant" }, PERSON);
  let g = group(projA, "utility");
  assert.deepEqual(g.proposals, []);
  assert.equal(g.status, "none");
  assert.equal(g.rejected.length, 1);
  assert.equal(g.rejected[0].rejectedBy, PERSON);
  assert.equal(g.rejected[0].reason, "That is the old tenant");
  assert.ok(db.get("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'filing_destination.rejected' AND actor_name = ?", [projA, PERSON]));
  assert.deepEqual(fdp.withdrawDestinationRejection(db, project(projA), { track: "nem", proposalId: p.id }, PERSON), { withdrawn: true });
  g = group(projA, "utility");
  assert.deepEqual(g.proposals.map((x) => x.id), [p.id]);
  assert.ok(db.get("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'filing_destination.rejection_withdrawn'", [projA]));
});

await check("(e) a utility portal confirm writes the utility's verified record and the NEM track reads verified", () => {
  const p = group(projA, "utility").proposals[0];
  fdp.decideFilingDestination(db, project(projA), views(projA), { track: "nem", proposalId: p.id, kind: "portal", address: p.address, sourceUrl: p.sourceUrl, quote: p.quote }, PERSON);
  const pres = ufMod.utilityTrackPresentation(db, project(projA));
  assert.equal(pres.basis, "verified");
  assert.equal(pres.portalUrl, UTIL_A_PORTAL);
  assert.equal(group(projA, "utility").status, "verified");
});

await check("(f) the email proposal becomes confirmable once the AHJ's lookup row exists, and writes the filing-email record", () => {
  const saved = ppMod.savePermitProcessLookup(db, {
    state: "ZZ", ahj: AHJ_B, lookedUpAt: READ_AT, model: "test",
    issuingAgency: { value: AHJ_B, sourceUrl: B_PAGE, quote: `${AHJ_B} Building`, origin: "lookup" },
    permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not stated" },
    permits: [],
  } as never);
  assert.ok(saved.saved, saved.reason);
  const e = group(projB, "ahj").proposals.find((x) => x.kind === "email")!;
  assert.deepEqual(e.problems, []);
  assert.equal(e.quoteNamesAddress, true);
  fdp.decideFilingDestination(db, project(projB), views(projB), { track: permitTrack(projB), proposalId: e.id, kind: "email", address: e.address, sourceUrl: e.sourceUrl, quote: e.quote }, PERSON);
  const ch = fe.filingEmailChannelFor(db, project(projB), permitTrack(projB));
  assert.ok(ch, "no filing-email channel after confirm");
  assert.equal(ch!.record.address, B_EMAIL);
  assert.equal(ch!.record.verifiedBy, PERSON);
  assert.deepEqual(fe.filingEmailRecordProblems(ch!.record), []);
  assert.equal(group(projB, "ahj").status, "verified");
});

await check("(g) a with-permit proposal writes the person's with-permit statement (#664)", () => {
  const p = group(projB, "utility").proposals[0];
  assert.equal(p.kind, "with_permit");
  fdp.decideFilingDestination(db, project(projB), views(projB), { track: "nem", proposalId: p.id, kind: "with_permit", address: "", name: p.name, sourceUrl: p.sourceUrl, quote: p.quote }, PERSON);
  const lookup = ufMod.getUtilityFilingLookup(db, "ZZ", UTIL_B)!;
  assert.equal(lookup.confidence, "verified");
  assert.equal(lookup.verifiedBy, PERSON);
  assert.ok(ufMod.utilityTrackPresentation(db, project(projB)).filedWithPermit, "the NEM track does not read filed-with-permit");
});

await check("(i) Edit needs its page and words, and passes rule 5 like every door", () => {
  const projC = mk("Village of Quillmere", "Quillmere Power Cooperative");
  const t = permitTrack(projC);
  const edit = (over: Partial<Parameters<typeof fdp.decideFilingDestination>[3]>) =>
    fdp.decideFilingDestination(db, project(projC), views(projC), { track: t, kind: "portal", address: "https://permits.quillmere-zz.gov/", sourceUrl: "https://www.quillmere-zz.gov/permits", quote: "Apply online at permits.quillmere-zz.gov", ...over }, PERSON);
  assert.throws(() => edit({ sourceUrl: "" }), /which http\(s\) page/);
  assert.throws(() => edit({ quote: "here" }), /page's own words/);
  assert.throws(() => edit({ address: "https://quillmere.powerclerk.com/" }), (e: Error) => e instanceof fdp.DestinationRefused && e.status === 409);
  const r = edit({});
  assert.equal(r.action, "stated");
  assert.ok(db.get("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'filing_destination.stated' AND actor_name = ?", [projC, PERSON]));
  assert.equal(views(projC).find((x) => x.category === "permit")!.channelBasis, "verified");
});

await check("(d) a shared platform's bare host is not confirmable; a tenant path or a host naming the authority is", () => {
  const page = "https://www.fernhollow-zz.gov/building";
  assert.match(fdp.bareSharedHostProblem("https://region.sharedpermits.example", AHJ_A, page), /does not show City of Fernhollow's own tenant/);
  assert.match(fdp.bareSharedHostProblem("https://region.sharedpermits.example/", "Fernhollow City Light & Power", page), /own tenant/);
  assert.equal(fdp.bareSharedHostProblem("https://region.sharedpermits.example/application/63bf35f1", AHJ_A, page), "");
  assert.equal(fdp.bareSharedHostProblem("https://fernhollow.zz.sharedpermits.example", AHJ_A, page), "");
  assert.equal(fdp.bareSharedHostProblem("https://permits.fernhollow-zz.gov", AHJ_A, page), "", "the authority's own site is its own");
  assert.equal(fdp.bareSharedHostProblem("https://aca-prod.vendor.example/ABCREF", AHJ_A, page), "");
});

await check("(k) a utility's shipped cited door is proposed (Edit-only off an official host), and the track shows its page and words", async () => {
  const shipped = (await import("../src/utilityRequirements")).shippedUtilityRequirementRecords().find((r) => r.filingDoor);
  assert.ok(shipped, "no shipped door in the reference data");
  const door = shipped!.filingDoor!;
  const cands = fdp.shippedDoorCandidates(shipped!.states[0], shipped!.utility);
  assert.deepEqual(cands.map((c) => [c.kind, c.address, c.sourceUrl, c.from]), [["portal", door.url, door.sourceUrl, "reference"]]);
  const projD = repo.createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Testville", state: shipped!.states[0], zip: "99999", ahj: "Testville City", utility: shipped!.utility } as never).project.id as string;
  const g = group(projD, "utility");
  const p = g.proposals.find((x) => x.address === door.url);
  assert.ok(p, JSON.stringify(g, null, 1));
  assert.equal(p!.quote, door.quote);
  if (!p!.official) assert.match(p!.problems.join(" "), /use Edit/);
  const nem = views(projD).find((x) => x.type === "nem")!;
  assert.notEqual(nem.channelBasis, "verified");
  assert.deepEqual(nem.channelCitation, { sourceUrl: door.sourceUrl, quote: door.quote, fetchedAt: door.fetchedAt });
  // The permit card shows its reference citation too, when its channel is the seeded profile...
  const projE = mk(AHJ_E, "Wrenfield Electric");
  const permitE = views(projE).find((x) => x.category === "permit")!;
  assert.equal(permitE.channelBasis, "profile", permitE.channel);
  assert.deepEqual(permitE.channelCitation, { sourceUrl: E_PAGE, quote: E_QUOTE, fetchedAt: READ_AT });
  // ...and none once a person verified it.
  const permitA = views(projA).find((x) => x.category === "permit")!;
  assert.equal(permitA.channelBasis, "verified");
  assert.equal(permitA.channelCitation, undefined);
});

await check("(j) the routes sit under /api/projects/:id, read the project first and name the person before writing", () => {
  const src = fs.readFileSync(path.join(REPO, "backend/src/server.ts"), "utf8");
  for (const [verb, route] of [["get", "/api/projects/:id/filing-destinations"], ["put", "/api/projects/:id/filing-destinations"], ["post", "/api/projects/:id/filing-destinations/reject"], ["delete", "/api/projects/:id/filing-destinations/reject"]]) {
    const start = src.indexOf(`app.${verb}("${route}"`);
    assert.ok(start > 0, `${verb} ${route} not registered`);
    const body = src.slice(start, src.indexOf("\napp.", start + 10));
    assert.match(body, /getProjectDetail\(db, /, `${route} does not read the project first`);
    if (verb !== "get") {
      const named = body.indexOf("destinationPerson(req");
      const decided = body.search(/decideFilingDestination\(db|rejectFilingDestination\(db|withdrawDestinationRejection\(db/);
      assert.ok(named > 0 && decided > named, `${verb} ${route} writes before naming the person`);
    }
  }
});

db.close();
if (failures) {
  console.error(`\nfilingDestinationProposals: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nfilingDestinationProposals: all checks passed");
process.exit(0);
