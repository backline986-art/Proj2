// WHO ISSUES EACH PERMIT, READ FROM THE REFERENCE ROW'S CITATIONS (worker-trackissuer, 2026-11-10).
//
// A shipped AHJ process row can cite, on its own page, who issues its electrical permit
// (citations[field=electricalPermitIssuer], first word "state" or the AHJ itself) and a separate
// counter for it (citations[field=electricalSubmissionMethod]). Pins, on a SYNTHETIC reference file
// (invented places, so nothing here depends on a real row):
//   1. "state" → the electrical track's issuer is the state authority's own row (stateAuthorityFor),
//      source "reference", cited with the AHJ's page; the building track stays the AHJ's; two tracks.
//      No authority row on file → a placeholder name, never the AHJ.
//   2. The state issuer's door starts unknown: never the AHJ's door, not even after a person verifies
//      the AHJ's portal (the gate's personVerifiedFilingDoor stays null for it); its proposed
//      destinations are its own group, with nothing copied from the AHJ.
//   3. A separate counter of the same AHJ: the electrical track's channel is that counter (in person),
//      never the AHJ's portal (verified or not); the gate's door read is null; the destinations
//      group of the AHJ does not claim it; staging it is refused (409, separateCounter).
//   4. Cited rows read as cited: the track label says "from the AHJ's own page", never "the
//      operator's seeded note"; the ESS step lists citations[field=ess] as cited, not as notes.
//   5. Fields over words (draft 18 A): a note's "email" never flips a portal method to email; a
//      structure field outranks a note's "separate … electric"; a row with no field keeps the word
//      fallback.
//   6. The approval sheet says up front when the track's destination is not person-verified.
// Run: tsx backend/test/trackIssuerFromCitations.test.ts
import { ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";

const ST = "MT";
const NO_AUTH_ST = "WY";
const PAGE = (host: string, p = "page") => `https://www.${host}.example.gov/${p}`;
const AT = "2026-11-10T08:00:00Z";
const cite = (field: string, value: string, host: string, quote: string) => ({ field, value, sourceUrl: PAGE(host), quote, fetchedAt: AT });
const flags = {
  timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: true, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", sourceSheet: "synthetic test rows",
};
const SPLIT_DOOR = "https://permits.splitton.example.gov/apply";
const COUNTER_DOOR = "https://permits.countertown.example.gov/apply";
const profiles = [
  { ...flags, state: ST, ahj: "City of Splitton", submissionMethod: SPLIT_DOOR, reviewerNotes: "Corrections come by email.",
    citations: [cite("electricalPermitIssuer", "state", "splitton", "Electrical permits and inspections are handled by the State electrical office, not the city.")] },
  { ...flags, state: ST, ahj: "Stateland Electrical Licensing Office", submissionMethod: "", requiresBuildingPermitApplication: false,
    requiresElectricalPermitApplication: true, reviewerNotes: "The state's electrical permit authority.", stateAuthorityFor: ["electrical"],
    citations: [cite("ahj", "Stateland Electrical Licensing Office", "splitton", "Electrical permits and inspections are handled by the State electrical office, not the city.")] },
  { ...flags, state: ST, ahj: "City of Countertown", submissionMethod: COUNTER_DOOR, reviewerNotes: "All plans go to the portal.",
    citations: [
      cite("electricalPermitIssuer", "city (bought at City Hall)", "countertown", "Electrical permits are in addition to the building permit and are purchased separately at City Hall."),
      cite("electricalSubmissionMethod", "In person at City Hall", "countertown", "Electrical permits are in addition to the building permit and are purchased separately at City Hall."),
    ] },
  { ...flags, state: ST, ahj: "City of Notesville", submissionMethod: "https://portal.notesville.example.gov/", reviewerNotes: "The city returns a signed copy by email." },
  { ...flags, state: ST, ahj: "City of Fieldsville", submissionMethod: "https://portal.fieldsville.example.gov/",
    reviewerNotes: "A separate electrical disconnect is shown on the plans.",
    citations: [cite("permitStructure", "combo", "fieldsville", "One combination permit covers the building and electrical work for solar.")] },
  { ...flags, state: ST, ahj: "City of Quietfield", submissionMethod: "https://portal.quietfield.example.gov/",
    reviewerNotes: "Apply for the electrical permit separately after the building permit.",
    citations: [cite("electricalPermitIssuer", "city", "quietfield", "Please use the city's online portal for electrical permits.")] },
  { ...flags, state: ST, ahj: "City of Wordsville", submissionMethod: "", reviewerNotes: "Apply for the solar and electrical permits separately. Submit by email." },
  { ...flags, state: ST, ahj: "City of Batteryton", submissionMethod: "https://portal.batteryton.example.gov/", reviewerNotes: "Battery jobs need the fire department's battery permit.",
    citations: [cite("ess", "Fire Department battery systems permit for a stationary battery system", "batteryton", "The battery systems permit applies to the installation of a stationary battery system.")] },
  { ...flags, state: NO_AUTH_ST, ahj: "City of Lonelyton", submissionMethod: "https://portal.lonelyton.example.gov/", reviewerNotes: "",
    citations: [cite("electricalPermitIssuer", "state", "lonelyton", "Electrical permits are issued by the State, not the city.")] },
];
const refPath = path.join(ISOLATED_CWD, "synthetic-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify({ generatedFrom: "test", redaction: "", count: profiles.length, profiles }));
process.env.AHJ_PROCESS_REFERENCE_PATH = refPath;
process.env.AUTOPILOT_DB_PATH = path.join(ISOLATED_CWD, "trackissuer.sqlite");
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const repo = await import("../src/repository");
const kb = await import("../src/knowledgeBase");
const { trackIssuer, projectForTrack, unknownStateAuthorityName } = await import("../src/permitProcess");
const { getSubmittalTracks, requiredTracks, personVerifiedFilingDoor } = await import("../src/submittalTracks");
const { findApplicationProfile, permitStructureAnswer } = await import("../src/applicationDocs");
const { essPermitStep } = await import("../src/essRequirements");
const { filingDestinationsFor } = await import("../src/filingDestinationProposals");
const { buildApprovalSheet } = await import("../src/approvalSheet");
const { separateCounterFor } = await import("../src/ahjRowCitations");

const db = await openDatabase();
let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); } catch (err) {
    failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
};

const client = createClient(db, { companyName: "Issuer Test Co", legalBusinessName: "Issuer Test Co", ccbLicenseNumber: "T-1", businessEmail: "t@example.invalid", businessPhone: "(406) 555-0100" } as never);
let seq = 0;
const newProject = (ahj: string, state = ST, extra: Record<string, string> = {}): ProjectRecord => {
  seq += 1;
  const created = repo.createProject(db, { clientId: client.id, owner: `Owner ${seq}`, street: `${seq} Test St`, city: ahj.replace(/^City of /, ""), state, zip: "59000", ahj, ...extra } as never) as { project: ProjectRecord };
  return repo.getProjectDetail(db, created.project.id).project;
};
const tracksOf = (p: ProjectRecord) => getSubmittalTracks(db, p);
const card = (p: ProjectRecord, type: string) => tracksOf(p).find((t) => t.type === type)!;

const splitton = newProject("City of Splitton");
const countertown = newProject("City of Countertown");

await run("1. 'state' on the AHJ's page: electrical is the state authority's, building stays the AHJ's", () => {
  assert.deepEqual(requiredTracks(splitton).filter((t) => t !== "nem"), ["building", "electrical"]);
  const ele = trackIssuer(splitton, "electrical");
  assert.equal(ele.name, "Stateland Electrical Licensing Office");
  assert.equal(ele.source, "reference");
  assert.equal(ele.sourceUrl, PAGE("splitton"), "cited with the AHJ's own page");
  assert.equal(trackIssuer(splitton, "mpu").name, ele.name, "MPU follows electrical");
  assert.equal(trackIssuer(splitton, "building").source, "project");
  assert.equal(projectForTrack(splitton, "electrical").ahj, "Stateland Electrical Licensing Office");
  assert.equal(projectForTrack(splitton, "building"), splitton, "the building view is the project itself");
});

await run("1b. no state authority row on file: a placeholder name, never the AHJ", () => {
  const lonely = newProject("City of Lonelyton", NO_AUTH_ST);
  const ele = trackIssuer(lonely, "electrical");
  assert.equal(ele.name, unknownStateAuthorityName(NO_AUTH_ST));
  assert.equal(ele.source, "reference");
  const c = card(lonely, "electrical");
  assert.equal(c.channelKind, "unknown");
  assert.ok(!c.channel.includes("lonelyton.example.gov/") || /verify on/i.test(c.channel), c.channel);
  assert.ok(!(c.recipePortalUrl ?? "").includes("portal.lonelyton"), "the AHJ's door is not on the state track");
});

await run("2. the state issuer's door starts unknown and is never the AHJ's, even after the AHJ is verified", () => {
  kb.saveVerifiedAhjProfile(db, { state: ST, ahj: "City of Splitton", portalUrl: SPLIT_DOOR, verifiedBy: "Dana Verifier" });
  const p = repo.getProjectDetail(db, splitton.id).project;
  const bld = card(p, "building");
  const ele = card(p, "electrical");
  assert.equal(bld.channelBasis, "verified");
  assert.ok(bld.channel.includes(SPLIT_DOOR));
  assert.notEqual(ele.channelBasis, "verified");
  assert.equal(ele.channelKind, "unknown", ele.channel);
  assert.ok(!ele.channel.includes("splitton"), `no AHJ door on the state track: ${ele.channel}`);
  assert.ok(!(ele.recipePortalUrl ?? "").includes("splitton"), "no AHJ portal fallback either");
  assert.equal(personVerifiedFilingDoor(db, "electrical", projectForTrack(p, "electrical")), null, "the gate finds no verified door");
  assert.deepEqual(personVerifiedFilingDoor(db, "building", projectForTrack(p, "building")), { url: SPLIT_DOOR });
  const groups = filingDestinationsFor(db, p, tracksOf(p));
  const state = groups.find((g) => g.authority.name === "Stateland Electrical Licensing Office");
  assert.ok(state, "the state authority is its own destination group");
  assert.deepEqual(state!.tracks, ["electrical"]);
  assert.equal(state!.status, "none");
  assert.ok(state!.proposals.every((x) => !x.address.includes("splitton")), "nothing copied from the AHJ");
  const city = groups.find((g) => g.authority.name === "City of Splitton");
  assert.ok(city && !city.tracks.includes("electrical"));
});

await run("3. a separate counter of the same AHJ: its own (in-person) door, never the AHJ's portal", async () => {
  assert.deepEqual(requiredTracks(countertown).filter((t) => t !== "nem"), ["building", "electrical"]);
  assert.equal(trackIssuer(countertown, "electrical").source, "project", "the AHJ still issues it");
  kb.saveVerifiedAhjProfile(db, { state: ST, ahj: "City of Countertown", portalUrl: COUNTER_DOOR, verifiedBy: "Dana Verifier" });
  const p = repo.getProjectDetail(db, countertown.id).project;
  const ele = card(p, "electrical");
  assert.equal(ele.channelKind, "in_person", ele.channel);
  assert.match(ele.channel, /^In person at City Hall/);
  assert.ok(!ele.channel.includes("countertown.example.gov/apply"));
  assert.equal(ele.channelCitation?.sourceUrl, PAGE("countertown"), "the counter's own page beside it");
  assert.ok(!(ele.recipePortalUrl ?? "").includes("countertown"), "no AHJ portal fallback");
  assert.equal(personVerifiedFilingDoor(db, "electrical", projectForTrack(p, "electrical")), null);
  assert.deepEqual(personVerifiedFilingDoor(db, "building", projectForTrack(p, "building")), { url: COUNTER_DOOR });
  assert.ok(separateCounterFor(p, "mpu"), "MPU follows the electrical counter");
  assert.equal(separateCounterFor(p, "building"), null);
  const city = filingDestinationsFor(db, p, tracksOf(p)).find((g) => g.authority.name === "City of Countertown");
  assert.ok(city && !city.tracks.includes("electrical"), "confirming the AHJ's portal does not claim the counter's track");
  await assert.rejects(() => repo.prepareSubmission(db, p.id, "electrical"), (err: { status?: number; message?: string; details?: Record<string, unknown> }) => {
    assert.equal(err.status, 409);
    assert.match(String(err.message), /separate counter/);
    return true;
  });
});

await run("4a. cited rows read as cited: the track label names the AHJ's page, not the operator's note", () => {
  for (const p of [splitton, countertown]) {
    const a = permitStructureAnswer(p);
    assert.equal(a.structure, "separate");
    assert.equal(a.level, "reference_cited");
    for (const t of ["building", "electrical"]) {
      const label = card(p, t).label;
      assert.match(label, /from the AHJ's own page \(www\.\w+\.example\.gov\), quoted/);
      assert.ok(!/seeded note/.test(label), label);
    }
  }
});

await run("4b. the ESS step reads citations[field=ess] as cited, not as process notes", () => {
  const p = newProject("City of Batteryton", ST, { hasBattery: "Yes", batteryModel: "Test Battery 10", batteryQuantity: "1" } as never);
  const step = essPermitStep({ ...p, parserSnapshot: { ...p.parserSnapshot, hasBattery: "Yes", batteryModel: "Test Battery 10" } } as ProjectRecord);
  assert.ok(step, "a battery job has an ESS step");
  assert.equal(step!.status, "cited");
  assert.ok(step!.entries.length >= 1);
  assert.ok(step!.entries.every((e) => e.basis === "reference_cited"), JSON.stringify(step!.entries));
  assert.equal(step!.entries[0].sourceUrl, PAGE("batteryton"));
  assert.match(step!.summary, /AHJ's own page/);
});

await run("5. fields over words: a note never flips the channel or the structure a field states", () => {
  const notes = newProject("City of Notesville");
  assert.ok(!/email/i.test(findApplicationProfile(notes).submissionMethod), "a portal method stays a portal despite 'by email' in a note");
  assert.notEqual(card(notes, "combo").channelKind, "email");
  const fields = newProject("City of Fieldsville");
  const a = permitStructureAnswer(fields);
  assert.equal(a.structure, "combo", "the cited field says one permit, whatever the note's 'separate … electrical' says");
  assert.equal(a.level, "reference_cited");
  assert.ok(requiredTracks(fields).includes("combo"));
  // A structure field that does not settle it: the note's "separately … electrical" is NOT read.
  const quiet = newProject("City of Quietfield");
  assert.equal(permitStructureAnswer(quiet).structure, "unknown", "a field outranks prose even when it leaves the structure open");
  // No field at all: the word reading stays the fallback.
  const words = newProject("City of Wordsville");
  assert.equal(permitStructureAnswer(words).structure, "separate");
  assert.equal(permitStructureAnswer(words).level, "reference");
  assert.match(findApplicationProfile(words).submissionMethod, /email/i);
});

await run("6. the approval sheet says up front the destination is not person-verified (display only)", () => {
  const p = repo.getProjectDetail(db, splitton.id).project;
  const ele = buildApprovalSheet(db, p, "electrical");
  const note = ele.issues.find((i) => /not person-verified/.test(i.text));
  assert.ok(note, JSON.stringify(ele.issues));
  assert.match(note!.text, /Approve & auto-submit will stop at review/);
  assert.ok(note!.confirmAuthority, "it links to the authority's Confirm");
  const bld = buildApprovalSheet(db, p, "building");
  assert.ok(!bld.issues.some((i) => /not person-verified/.test(i.text)), "a verified door carries no such line");
  const counter = buildApprovalSheet(db, repo.getProjectDetail(db, countertown.id).project, "electrical");
  const cn = counter.issues.find((i) => /not person-verified/.test(i.text));
  assert.ok(cn && /separate counter/.test(cn.text) && !cn.confirmAuthority, "the counter's track names the counter and offers no AHJ Confirm");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall track-issuer checks passed");
process.exit(0);
