// A PERSON-VERIFIED RECORD TYPE REACHES THE LEARN AS AUTHORITY; A SEEDED ONE AS A HINT (#166).
//
// A watched City of Bend learn (2026-11-12) ticked "Renewable energy up to 25KVA" while the job's
// person-verified process row named "Prescriptive photovoltaic systems": lookedUpRecordType was
// read by the borrow alone, and the learner never saw the name. This pins the backend half:
//
//   - lookedUpRecordTypeFor reads `verified` off THE ROW THAT ANSWERED — on a track view the
//     project's own row answers for the issuer (the Marion case), where the issuer has no row;
//   - a seeded row is never `verified` (hard rule 3); verifyPermitProcessLookup makes it so;
//   - learnTargetRecordType is null on a utility learn;
//   - the planner's line says "person-verified" for one and "unverified … a hint" for the other;
//   - explainProgramChoice takes the verified target before any word tier;
//   - sameRecordType folds case, punctuation and a "permit" suffix (criterion d).
//
// KILL CHECKS (each disabled by hand and seen red): lookedUpRecordTypeFor reading
// permitProcessFor(project) instead of the answering row → T3 fails; `verified: true` for a seeded
// row → T1 fails; the target tier removed from explainProgramChoice → T5 fails.
//   npx tsx backend/test/recordTypeTarget.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitedFact, ProjectRecord } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "record-type-target-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
delete process.env.SMTP_HOST;

const db = await (await import("../src/db")).openDatabase();
const pp = await import("../src/permitProcess");
const al = await import("../src/autoLearn");
const prog = await import("../../portal-bot/src/adapters/applicationProgram");

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { console.log(`  ok   - ${label}`); },
    (err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); },
  );

const PAGE = "https://www.example-city.or.us/building/solar";
const cited = <T>(value: T, quote: string): CitedFact<T> => ({ value, sourceUrl: PAGE, quote, origin: "lookup" });
const blank = <T>(): CitedFact<T> => ({ value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "none" });
const WANT = "Prescriptive photovoltaic systems";

/** A seeded row for `ahj` whose electrical permit is issued by `issuer` under record type WANT. */
const seedRow = (ahj: string, issuer: string) => pp.savePermitProcessLookup(db, {
  state: "OR", ahj, lookedUpAt: "2026-11-01T15:00:00.000Z", model: "test-model",
  issuingAgency: cited(issuer, `${issuer} issues permits`),
  permitStructure: cited("combo" as const, "one combination permit"),
  permits: [{
    discipline: "electrical", label: "Electrical",
    issuingAgency: cited(issuer, `${issuer} issues permits`),
    portalUrl: blank<string>(),
    recordType: cited(WANT, `select the ${WANT} work item`),
    documents: blank<string[]>(),
    fee: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "none" },
  }],
});

const project = (ahj: string): ProjectRecord => ({ id: "p1", state: "OR", ahj } as unknown as ProjectRecord);

await check("T1 a SEEDED row's record type reaches the learn with verified:false — a hint, never the pick (rule 3)", () => {
  const r = seedRow("City of Example Bend", "City of Example Bend");
  assert.equal(r.saved, true, r.reason);
  const got = pp.lookedUpRecordTypeFor(project("City of Example Bend"), "electrical");
  assert.deepEqual(got, { value: WANT, verified: false, sourceUrl: PAGE });
  assert.deepEqual(al.learnTargetRecordType(project("City of Example Bend"), "ahj", "electrical", "electrical"), { value: WANT, verified: false });
});

await check("T2 a person's verify makes the same row verified:true; the utility scope still answers null", () => {
  const v = pp.verifyPermitProcessLookup(db, { state: "OR", ahj: "City of Example Bend" }, { verifiedBy: "Pat Synthetic" });
  assert.equal(v.saved, true, v.reason);
  const got = pp.lookedUpRecordTypeFor(project("City of Example Bend"), "electrical");
  assert.deepEqual(got, { value: WANT, verified: true, sourceUrl: PAGE });
  assert.deepEqual(al.learnTargetRecordType(project("City of Example Bend"), "ahj", "electrical", "electrical"), { value: WANT, verified: true });
  assert.equal(al.learnTargetRecordType(project("City of Example Bend"), "utility", "nem", "nem"), null);
  assert.equal(pp.lookedUpRecordTypeFor(project("City of Example Bend"), "nem"), null, "an interconnection track has no permit record type");
});

await check("T3 on a track view, `verified` is the standing of the PROJECT's row that answered for the issuer (the Marion case)", () => {
  // The city's row cites the county for its electrical permit; the county has no row of its own.
  const r = seedRow("City of Example Jefferson", "Example County");
  assert.equal(r.saved, true, r.reason);
  const v = pp.verifyPermitProcessLookup(db, { state: "OR", ahj: "City of Example Jefferson" }, { verifiedBy: "Pat Synthetic" });
  assert.equal(v.saved, true, v.reason);
  const view = {
    ...project("Example County"),
    trackView: { track: "electrical", projectAhj: "City of Example Jefferson", source: "lookup" },
  } as unknown as ProjectRecord;
  assert.equal(pp.permitProcessFor(view), null, "fixture: the issuer has no row of its own");
  const got = pp.lookedUpRecordTypeFor(view, "electrical");
  assert.deepEqual(got, { value: WANT, verified: true, sourceUrl: PAGE });
});

await check("T4 the planner's line names the standing: person-verified = tick it; seeded = a hint only", () => {
  const verified = al.recordTypePlannerLine({ value: WANT, verified: true });
  assert.match(verified, /person-verified/);
  assert.match(verified, /tick exactly this/i);
  assert.ok(verified.endsWith(WANT), verified);
  const seeded = al.recordTypePlannerLine({ value: WANT, verified: false });
  assert.match(seeded, /lookup read the record type as/);
  assert.match(seeded, /unverified/);
  assert.match(seeded, /hint/);
  assert.doesNotMatch(seeded, /person-verified/);
  assert.ok(seeded.endsWith(WANT), seeded);
  assert.equal(al.recordTypePlannerLine(null), "");
  assert.equal(al.recordTypePlannerLine({ value: "  ", verified: true }), "");
});

await check("T5 the program chooser takes the verified target before any word tier", () => {
  const groups = [{ area: 1000, options: [
    { key: "a", label: "Residential Net Metering Application", radio: true },
    { key: "b", label: "Prescriptive Photovoltaic Systems", radio: true },
    { key: "c", label: "Renewable energy up to 25KVA", radio: true },
  ] }];
  const without = prog.explainProgramChoice(groups, "electrical", { jobClass: "residential" });
  assert.equal(without.pick?.key, "a", "baseline: the tiers pick the interconnection-worded option");
  const withTarget = prog.explainProgramChoice(groups, "electrical", { jobClass: "residential", recordType: "prescriptive photovoltaic-systems permit" });
  assert.equal(withTarget.reason, "target");
  assert.equal(withTarget.pick?.key, "b");
  assert.deepEqual(withTarget.candidates, ["Prescriptive Photovoltaic Systems"]);
  // A target the page does not offer changes nothing: the tiers answer as before.
  const absent = prog.explainProgramChoice(groups, "electrical", { jobClass: "residential", recordType: "Solar PV combination permit" });
  assert.equal(absent.pick?.key, "a");
  assert.equal(absent.reason, "matched");
});

await check("T6 (d) the label match survives case, punctuation and a 'permit' suffix — and never a substring", () => {
  assert.equal(pp.sameRecordType("PRESCRIPTIVE Photovoltaic-Systems Permit", "Prescriptive photovoltaic systems"), true);
  assert.equal(pp.sameRecordType("Residential - Electrical", "residential electrical permit"), true);
  assert.equal(pp.sameRecordType("Residential Solar", "Residential Solar - Demolition"), false);
  assert.equal(pp.sameRecordType("Prescriptive photovoltaic systems", "Renewable energy up to 25KVA"), false);
  assert.equal(pp.sameRecordType("", ""), false);
});

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "recordTypeTarget.test: PASS" : `recordTypeTarget.test: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
