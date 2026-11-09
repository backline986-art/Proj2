// THE FIELD-COVERAGE REPORT COUNTS WHICH PORTAL BOXES OUR READ LEAVES BLANK, AND WRITES NOTHING (#647).
//
// scripts/field-coverage-report.ts runs the stage gate's own walk (stageKeysForTrack, the assembly
// stageGapsForTrack reads) for every project and track with a complete recipe and tallies blank
// fields by key x portal host (and AHJ for the permit tracks), plus where the filled values came from.
//
//   (S)  recipeStageKeys is recipeStageGaps plus the filled keys: dropping the filled entries gives
//        the gate's list exactly, so the report's numerator is the gate's own.
//   (C)  a synthetic DB, two portals (a NEM portal and an AHJ portal), four projects in scope plus
//        one in another org, one learning-excluded and one archived: the counts per key, per portal
//        and per AHJ are pinned; --all brings the other org in; --since filters by creation date.
//   (P)  provenance: a value the creation parse wrote reads "extracted", a review-queue edit reads
//        "person_corrected", a value a later save changed reads "changed_after_extraction", a client
//        record key reads "client_record".
//   (N)  the report (JSON and text) carries no value: no homeowner name, street, account or meter
//        number, email; a secret field appears by its fixed key and label only (rule 2).
//   (W)  reads write nothing: the database file is byte-identical after a run, and the read-only
//        handle refuses a write.
//
// KILL TESTS: count filled keys as blank → C fails; drop the learning_excluded / archived skip → C
// fails; open the DB through openDatabase() → W fails (it migrates and re-seeds); print the replay's
// value instead of the key → N fails.
//
// Run: npx tsx backend/test/fieldCoverageReport.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("field-coverage-report");
const { db, repo, recipes, client } = fx;
const { recipeStageGaps, recipeStageKeys } = await import("../src/recipeStageGaps");
const report = await import("../../scripts/field-coverage-report");

const fill = (label: string, field: string, extra: Partial<RecipeStep> = {}): RecipeStep =>
  ({ action: "fill", selector: { label }, field, note: label, ...extra } as RecipeStep);
const upload = (docType: string, label: string): RecipeStep =>
  ({ action: "upload", selector: { label }, docType, note: `upload ${docType}: ${label}` } as RecipeStep);
const REVIEW = { action: "stopForReview", selector: {} } as RecipeStep;

await check("(S) recipeStageKeys minus the filled keys is exactly recipeStageGaps", () => {
  const steps = [
    fill("Customer Name", "homeownerName"), fill("Owner Email", "homeownerEmail"), fill("Account", "accountNumber", { sensitive: true }),
    fill("Optional", "homeownerPhone", { optional: true }), upload("meter_photo", "Meter Photo"), upload("plan_set", "Plans"), REVIEW,
  ];
  const values = { homeownerName: "A Person", homeownerEmail: "", accountNumber: "", homeownerPhone: "" };
  const docs = { plan_set: "/tmp/plans.pdf" };
  const keys = recipeStageKeys(steps, values, docs);
  assert.deepEqual(keys.map((k) => [k.key, k.filled]), [
    ["homeownerName", true], ["homeownerEmail", false], ["accountNumber", false], ["meter_photo", false], ["plan_set", true],
  ]);
  assert.deepEqual(keys.filter((k) => !k.filled).map(({ filled: _f, ...g }) => g), recipeStageGaps(steps, values, docs));
});

// ── The synthetic database ─────────────────────────────────────────────────────────────────────
// Two portals, both synthetic hosts, never opened. NEM: name, email, account (secret), a meter
// photo. Permit (the fixture's AHJ, Portland): name, email, inverter model, the contractor licence
// from the client record.
const nem = recipes.startPortalRecording(db, {
  scopeType: "utility", state: "OR", utility: "PGE", portalUrl: "https://nem.portal-a.example/apply", portalPlatform: "powerclerk", createdBy: "test",
});
recipes.savePortalRecipeSteps(db, nem.id, [
  fill("Customer Name", "homeownerName"), fill("Owner Email", "homeownerEmail"),
  fill("Account Number", "accountNumber", { sensitive: true }), upload("meter_photo", "Meter Photo"), REVIEW,
], { status: "complete", notes: "Auto-learned and verified (high confidence)." });
fx.completeRecipe([
  fill("Owner", "homeownerName"), fill("Owner Email", "homeownerEmail"), fill("Inverter Model", "inverterModel"),
  fill("CCB License", "ccbLicenseNumber"), REVIEW,
]);

const p1 = fx.newProject(); // no email
const p2 = fx.newProject({ homeownerEmail: "two@example.test" } as never);
const p3 = fx.newProject({ homeownerEmail: "three@example.test" } as never);
repo.updateProject(db, p3, { invModel: "IQ8A" }); // a later save changes the extracted inverter
const p4 = fx.newProject();
// A person corrects p4's homeowner name in the review queue.
const reviewId = "review-fcr-1";
db.run(
  `INSERT INTO human_review_items (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
   VALUES (?, ?, 'low_confidence', 'homeownerName', '', '', '', 'open', '', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  [reviewId, p4],
);
repo.humanVerify(db, p4, { reviewItemId: reviewId, action: "edit", fieldValue: "Corrected Owner Four" });
const other = fx.newProject({ homeownerEmail: "other@example.test" } as never);
db.run("UPDATE projects SET org_id = 'org-other' WHERE id = ?", [other]);
const excluded = fx.newProject();
db.run("UPDATE projects SET learning_excluded = 1 WHERE id = ?", [excluded]);
const archived = fx.newProject();
db.run("UPDATE projects SET archived_at = '2026-11-02T00:00:00.000Z' WHERE id = ?", [archived]);
// p1..p4 were created "today"; date p1 back so --since can drop it.
db.run("UPDATE projects SET created_at = '2026-01-15T00:00:00.000Z' WHERE id = ?", [p1]);

// A stored plan set with no text on file: reading the project (getProjectDetail's plan-set overlay)
// starts a background extraction that WRITES its result. On the read-only handle it must be refused.
db.run("UPDATE project_documents SET extracted_text = '' WHERE project_id = ?", [p2]);

// Every value that must never reach the report.
const secrets = db.query<{ homeowner_name: string; project_address: string; account_number: string; meter_number: string }>(
  "SELECT homeowner_name, project_address, account_number, meter_number FROM projects",
).flatMap((r) => [r.homeowner_name, r.project_address, r.account_number, r.meter_number])
  .concat(["two@example.test", "three@example.test", "other@example.test", "Corrected Owner Four", "IQ8A", "240136"])
  .filter((v) => String(v ?? "").trim().length >= 4);

// Close the writer, so the file on disk is the whole database (the WAL is folded back in).
const file = db.sourcePath;
db.close();
const hash = (): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// A WAL with frames in it would be a write waiting to be checkpointed. (A read-only connection on a
// WAL-mode file may create an EMPTY -wal / -shm pair: that is SQLite's read lock, not data.)
const walBytes = (): number => (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);
const before = hash();
const refused = report.refuseBackgroundWrites();
const ro = report.openReadOnly(file);
const r = report.buildFieldCoverageReport(ro, { orgId: "org-default" });
const text = report.renderFieldCoverageReport(r);
const json = JSON.stringify(r);

type Row = { key: string; blank: number; bound: number; pctBlank: number };
const pick = (rows: Row[]) => Object.fromEntries(rows.map((f) => [f.key, [f.blank, f.bound, f.pctBlank]]));

await check("(C) projects in scope: the other org, the learning-excluded and the archived project are not read", () => {
  assert.deepEqual(r.projects, { scanned: 4, skippedLearningExcluded: 1, skippedArchived: 1 });
  assert.equal(r.tracks.unreadable, 0, JSON.stringify(r.unreadable));
  assert.equal(r.tracks.withRecipe, 8, JSON.stringify(r.tracks)); // 4 projects x (NEM + one permit track)
  assert.equal(r.tracks.withoutRecipe, 0, JSON.stringify(r.noRecipe));
});

await check("(C) the counts per key across every portal", () => {
  assert.deepEqual(pick(r.overall), {
    homeownerName: [0, 8, 0], homeownerEmail: [4, 8, 50], accountNumber: [0, 4, 0], meter_photo: [4, 4, 100],
    inverterModel: [0, 4, 0], ccbLicenseNumber: [0, 4, 0],
  });
  const email = r.overall.find((f) => f.key === "homeownerEmail")!;
  assert.equal(email.where, "project");
  // Most blanks first; a tie goes to the higher rate.
  assert.deepEqual(r.overall.slice(0, 2).map((f) => f.key), ["meter_photo", "homeownerEmail"]);
});

await check("(C) the counts per portal host, and per AHJ on the permit track", () => {
  assert.deepEqual(r.byPortal.map((g) => [g.track, g.portalHost, g.tracks]).sort(), [
    ["nem", "nem.portal-a.example", 4], ["permit", "permits.portland.example", 4],
  ]);
  const nemGroup = r.byPortal.find((g) => g.track === "nem")!;
  assert.deepEqual(pick(nemGroup.fields), { homeownerEmail: [2, 4, 50], meter_photo: [4, 4, 100], homeownerName: [0, 4, 0], accountNumber: [0, 4, 0] });
  const permitGroup = r.byPortal.find((g) => g.track === "permit")!;
  assert.deepEqual(pick(permitGroup.fields), { homeownerEmail: [2, 4, 50], homeownerName: [0, 4, 0], inverterModel: [0, 4, 0], ccbLicenseNumber: [0, 4, 0] });
  assert.equal(r.byAhj.length, 1, JSON.stringify(r.byAhj.map((g) => g.ahj)));
  assert.equal(r.byAhj[0].ahj, "Portland, OR");
  assert.deepEqual(pick(r.byAhj[0].fields), pick(permitGroup.fields));
});

await check("(C) --all reads the other org; --since drops the older project", () => {
  const everyOrg = report.buildFieldCoverageReport(ro, { orgId: null });
  assert.equal(everyOrg.projects.scanned, 5);
  assert.deepEqual(pick(everyOrg.overall).homeownerEmail, [4, 10, 40]);
  const recent = report.buildFieldCoverageReport(ro, { orgId: "org-default", since: "2026-02-01" });
  assert.equal(recent.projects.scanned, 3);
  assert.deepEqual(pick(recent.overall).homeownerEmail, [2, 6, 33.3]);
});

await check("(P) where the filled values came from", () => {
  const src = (key: string) => r.overall.find((f) => f.key === key)!.source;
  // homeownerName: 3 projects keep the parse's name (x2 tracks), p4's was corrected in the queue (x2).
  assert.equal(src("homeownerName").extracted, 6, JSON.stringify(src("homeownerName")));
  assert.equal(src("homeownerName").person_corrected, 2, JSON.stringify(src("homeownerName")));
  // inverterModel (permit only): p3's was changed by a later save; the other three are the parse's.
  assert.equal(src("inverterModel").extracted, 3, JSON.stringify(src("inverterModel")));
  assert.equal(src("inverterModel").changed_after_extraction, 1, JSON.stringify(src("inverterModel")));
  assert.equal(src("accountNumber").extracted, 4, JSON.stringify(src("accountNumber")));
  assert.equal(src("ccbLicenseNumber").client_record, 4, JSON.stringify(src("ccbLicenseNumber")));
  // A blank never counts as a source; documents carry none.
  const email = r.overall.find((f) => f.key === "homeownerEmail")!;
  assert.equal(Object.values(email.source).reduce((a, b) => a + b, 0), email.bound - email.blank);
  assert.equal(Object.values(r.overall.find((f) => f.key === "meter_photo")!.source).reduce((a, b) => a + b, 0), 0);
});

await check("(N) no value, name, address, account or meter number in the report (rule 2)", () => {
  for (const v of secrets) {
    assert.equal(json.includes(v), false, `the JSON report carries a value: ${v.slice(0, 2)}…`);
    assert.equal(text.includes(v), false, `the text report carries a value: ${v.slice(0, 2)}…`);
  }
  const account = r.overall.find((f) => f.key === "accountNumber")!;
  assert.equal(account.secret, true);
  assert.equal(account.fieldName, "Utility account number");
  assert.match(text, /accountNumber\s+Utility account number \[secret\]/);
  assert.equal(client.id.length > 0, true);
});

await check("(W) the run wrote nothing: the database file is byte-identical, the handle refuses a write, and a read's background backfill is refused", async () => {
  assert.throws(() => ro.run("UPDATE projects SET status = status"), /readonly/i);
  // Let the background extraction the read started run to its write.
  for (let i = 0; i < 50 && !refused(); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(refused() >= 1, "the background text backfill never tried its write (fixture drift: the test no longer covers it)");
  ro.close();
  assert.equal(hash(), before, "the database changed during a report run");
  assert.equal(walBytes(), 0, "the run left frames in the write-ahead log");
});

finish("field coverage report");
