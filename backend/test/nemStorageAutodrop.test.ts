// DROPPING A STORAGE JOB'S UTILITY TRACK ONLY ON A PERSON'S RECORD (draft 10, stacked on #673).
//
// Pins:
//   (a) a PERSON-verified record that names the job's battery mode drops the utility track at every
//       door (requiredTracks, the tracks screen, Stage), and the job says why (the person, the page,
//       the quote);
//   (b) the same record on the OFFICIAL tier keeps the track and shows it as information (rule 3: the
//       official tier never decides whether a filing is sent); a seeded record and a record with no
//       tier do the same;
//   (c) a record for a different mode, a job with new PV, and a job with an unclassified mode never
//       lose the track;
//   (d) a person can put the track back on one job, and let the record drop it again;
//   (e) withdrawing the record brings the track back on every job it dropped;
//   (f) work already on the track keeps it; a stale stamp never drops a track;
//   (g) the tracks screen shows why (escaped) with a restore control.
// Kill test: make requiredTracks ignore nemTrackDropFor → (a) fails; drop on any tier in
// settleNemTrackDrop → (b) fails.
// Run: npx tsx backend/test/nemStorageAutodrop.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nem-autodrop-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.RUN_TRIAGE = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const { runQcForProject } = await import("../src/qc");
const { recordUtilityStorageModes, clearUtilityStorageModes, nemTrackDropFor } = await import("../src/utilityStorageModes");
const { setNemTrackKept, projectsDroppedFor } = await import("../src/nemTrackDrop");
const { saveUtilityFilingLookup, utilityFilingKey } = await import("../src/utilityFilingLookup");
const { requiredTracks, getSubmittalTracks } = await import("../src/submittalTracks");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const STATE = "ZY";
const UTILITY = "Quillmoor Power Cooperative";
const BASE = {
  owner: "Rowan Achterberg", street: "7 Sedgefield Road", city: "Quillmoor", state: STATE, zip: "00077",
  ahj: "City of Quillmoor", utility: UTILITY, account: "55566677", meter: "M778899",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200",
  permitPath: "prescriptive", locateCalloutText: "N/A - wall mount, no excavation", mounting: "Roof Mount",
};
const BATTERY = { batteryMake: "Tidewell", batteryModel: "TW-10", batteryQty: "1", batteryCapacityKwh: "10", batteryOutputKw: "5", essInverterModel: "TW-PCS5", batteryMode: "Backup only", essBreaker: "30" };
const SHEETS_NO = { newModulesOnSchedule: "no", newModulesOnSld: "no" };
const PV = { dcKw: "6.0", acKw: "5.0", moduleMake: "Brightleaf", moduleModel: "BL-400", moduleWattage: "400", moduleQty: "15", invModel: "MX-300", invQty: "15", invOutputW: "1.2", pvBreaker: "30" };

let n = 0;
function project(payload: Record<string, unknown>): string {
  n += 1;
  return repo.createProject(db, { ...BASE, owner: `${BASE.owner} ${n}`, street: `${n} Sedgefield Road`, ...payload } as never, undefined, { learningExcluded: true }).project.id;
}
const detail = (id: string) => repo.getProjectDetail(db, id);
const tracksOf = (id: string) => requiredTracks(detail(id).project);
const modeRow = (id: string): string => db.get<{ message: string }>("SELECT message FROM qc_results WHERE project_id = ? AND rule_id = 'qc.nem_storage_mode'", [id])?.message ?? "";

const QUOTE = "Backup-only battery systems that never operate in parallel with our grid do not need an interconnection application.";
const SOURCE = "https://quillmoor-power.invalid/storage";
function writeRecord(record: Record<string, unknown> | null): void {
  db.run("UPDATE utility_filing_lookups SET storage_modes_json = ? WHERE profile_key = ?", [record ? JSON.stringify(record) : "", utilityFilingKey(STATE, UTILITY)]);
}
function rerun(...ids: string[]): void { for (const id of ids) runQcForProject(db, id); }

saveUtilityFilingLookup(db, {
  state: STATE, utility: UTILITY, lookedUpAt: new Date().toISOString(),
  filing: { value: { name: "Interconnection portal", url: null }, sourceUrl: "https://quillmoor-power.invalid/apply", quote: "Apply on our Interconnection portal.", origin: "lookup" } as never,
  program: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not stated" } as never,
});

const backup = project({ ...BATTERY, ...SHEETS_NO });
const backup2 = project({ ...BATTERY, ...SHEETS_NO });
const nonExport = project({ ...BATTERY, ...SHEETS_NO, batteryMode: "Non-export (PCS limited)" });
const withPv = project({ ...PV, ...BATTERY });
const vague = project({ ...BATTERY, ...SHEETS_NO, batteryMode: "self-consumption" });

await check("(0) with no record, every storage job keeps its utility track", () => {
  for (const id of [backup, backup2, nonExport, withPv, vague]) {
    assert.ok(tracksOf(id).includes("nem"), id);
    assert.equal(detail(id).nemTrackDrop ?? null, null);
  }
});

// (b) official / seeded / no tier: information only.
await check("(b) the same exemption on the OFFICIAL tier keeps the track and shows it for a person to verify", () => {
  writeRecord({ modesWithoutApplication: ["backup-only"], tier: "official", sourceUrl: SOURCE, quote: QUOTE, verifiedBy: "", verifiedAt: "2026-11-10T00:00:00Z" });
  rerun(backup);
  assert.ok(tracksOf(backup).includes("nem"));
  assert.equal(detail(backup).nemTrackDrop ?? null, null);
  const msg = modeRow(backup);
  assert.match(msg, /official-source read/);
  assert.match(msg, /stays on this job/);
  assert.ok(msg.includes(SOURCE), msg);
});
await check("(b) an official-tier record that even names a verifier never drops the track", () => {
  writeRecord({ modesWithoutApplication: ["backup-only"], tier: "official", sourceUrl: SOURCE, quote: QUOTE, verifiedBy: "Records Bot", verifiedAt: "2026-11-10T00:00:00Z" });
  rerun(backup);
  assert.ok(tracksOf(backup).includes("nem"));
});
await check("(b) a seeded record keeps the track and says so", () => {
  writeRecord({ modesWithoutApplication: ["backup-only"], tier: "seeded", sourceUrl: SOURCE, quote: QUOTE, verifiedBy: "", verifiedAt: "" });
  rerun(backup);
  assert.ok(tracksOf(backup).includes("nem"));
  assert.match(modeRow(backup), /seeded/);
});
await check("(b) a record with no tier (fail closed) keeps the track", () => {
  writeRecord({ modesWithoutApplication: ["backup-only"], sourceUrl: SOURCE, quote: QUOTE, verifiedBy: "Pat Reviewer", verifiedAt: "2026-11-10T00:00:00Z" });
  rerun(backup);
  assert.ok(tracksOf(backup).includes("nem"));
  assert.match(modeRow(backup), /stays on this job/);
});

// (c) a person's record for ANOTHER mode.
await check("(c) a person's record for a mode the job does not run keeps the track", () => {
  writeRecord(null);
  const r = recordUtilityStorageModes(db, { state: STATE, utility: UTILITY }, { modesWithoutApplication: ["non-export"], sourceUrl: SOURCE, quote: "Non-export battery systems do not need an interconnection application.", verifiedBy: "Pat Reviewer" });
  assert.equal(r.saved, true, r.reason);
  rerun(backup, nonExport);
  assert.ok(tracksOf(backup).includes("nem"), "backup-only job lost the track on a non-export record");
  assert.equal(modeRow(backup), "");
  assert.ok(!tracksOf(nonExport).includes("nem"), "the non-export job is the one the record covers");
});

// (a) a person's record drops the track at every door, with why.
await check("(a) a PERSON-verified record drops the utility track, and the job says why", async () => {
  const r = recordUtilityStorageModes(db, { state: STATE, utility: UTILITY }, { modesWithoutApplication: ["backup-only"], sourceUrl: SOURCE, quote: QUOTE, verifiedBy: "Pat Reviewer" });
  assert.equal(r.saved, true, r.reason);
  rerun(backup, backup2);
  const d = detail(backup);
  assert.ok(!requiredTracks(d.project).includes("nem"), "requiredTracks still asks for the utility track");
  assert.ok(requiredTracks(d.project).length > 0, "the permit track stays");
  assert.equal(d.nemTrackDrop?.verifiedBy, "Pat Reviewer");
  assert.equal(d.nemTrackDrop?.sourceUrl, SOURCE);
  assert.equal(d.nemTrackDrop?.quote, QUOTE);
  assert.equal(d.nemTrackDrop?.mode, "backup-only");
  assert.match(modeRow(backup), /^Utility track dropped: .*Pat Reviewer/);
  assert.ok(!getSubmittalTracks(db, d.project).some((t) => t.type === "nem"), "the tracks screen still shows a utility card");
  await assert.rejects(repo.prepareSubmission(db, backup, "nem"), (err: { status?: number; message?: string }) => err.status === 409 && /dropped/.test(String(err.message)));
});
await check("(c) the same person's record never drops the track on a job with new PV or an unclassified mode", () => {
  rerun(withPv, vague);
  assert.ok(tracksOf(withPv).includes("nem"));
  assert.ok(tracksOf(vague).includes("nem"));
});

// (d) restore on one job.
await check("(d) a person puts the track back on one job; the other job stays dropped", () => {
  setNemTrackKept(db, backup, true, "Lee Operator");
  rerun(backup);
  assert.ok(tracksOf(backup).includes("nem"));
  assert.equal(detail(backup).nemTrackKept?.by, "Lee Operator");
  assert.match(modeRow(backup), /Lee Operator put the utility track back/);
  assert.ok(!tracksOf(backup2).includes("nem"));
});
await check("(d) letting the record decide again drops it again", () => {
  setNemTrackKept(db, backup, false, "Lee Operator");
  rerun(backup);
  assert.ok(!tracksOf(backup).includes("nem"));
  assert.equal(detail(backup).nemTrackKept ?? null, null);
});

// (f) stale stamps and work in flight.
await check("(f) a stale stamp never drops a track: new modules, another mode or another utility", () => {
  const p = detail(backup).project;
  assert.ok(nemTrackDropFor(p));
  assert.equal(nemTrackDropFor({ ...p, parserSnapshot: { ...p.parserSnapshot, moduleModel: "BL-400", moduleQty: "15" } }), null);
  assert.equal(nemTrackDropFor({ ...p, parserSnapshot: { ...p.parserSnapshot, batteryMode: "export" } }), null);
  assert.equal(nemTrackDropFor({ ...p, utility: "Another Electric" }), null);
  assert.equal(nemTrackDropFor({ ...p, nemTrackExemption: { ...p.nemTrackExemption, keptBy: "Lee Operator" } }), null);
});
await check("(f) a job with utility filing work already on record keeps its track", () => {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO permit_check_targets (id, project_id, target_type, created_at, updated_at) VALUES (?, ?, 'nem', ?, ?)",
    [`pct-${backup2}`, backup2, now, now],
  );
  rerun(backup2);
  assert.ok(tracksOf(backup2).includes("nem"));
  assert.match(modeRow(backup2), /already has utility filing work/);
  db.run("DELETE FROM permit_check_targets WHERE id = ?", [`pct-${backup2}`]);
  rerun(backup2);
  assert.ok(!tracksOf(backup2).includes("nem"));
});

// (e) withdrawal.
await check("(e) withdrawing the record brings the track back on every job it dropped", () => {
  const dropped = projectsDroppedFor(db, STATE, UTILITY).sort();
  assert.deepEqual(dropped, [backup, backup2, nonExport].sort());
  clearUtilityStorageModes(db, { state: STATE, utility: UTILITY });
  rerun(...dropped);
  for (const id of dropped) {
    assert.ok(tracksOf(id).includes("nem"), id);
    assert.equal(detail(id).nemTrackDrop ?? null, null);
  }
  assert.deepEqual(projectsDroppedFor(db, STATE, UTILITY), []);
});

// (g) the tracks screen says why, escaped, with the restore control.
await check("(g) the tracks screen shows the dropped track's person, page and quote, escaped, with a restore button", () => {
  const src = fs.readFileSync(new URL("../../frontend/dashboard.js", import.meta.url), "utf8");
  const start = src.indexOf("function nemTrackDropHtml(");
  const end = src.indexOf("\nasync function saveNemTrackKeep(", start);
  assert.ok(start > 0 && end > start, "nemTrackDropHtml not found");
  const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fn = new Function("esc", `${src.slice(start, end)}\nreturn nemTrackDropHtml;`)(esc) as (d: unknown) => string;
  const html = fn({ nemTrackDrop: { utility: UTILITY, mode: "backup-only", sourceUrl: SOURCE, quote: "<b>Backup</b> batteries need no application.", verifiedBy: "Pat Reviewer", verifiedAt: "2026-11-10T00:00:00Z" } });
  assert.match(html, /not required/);
  assert.ok(html.includes("Pat Reviewer") && html.includes(SOURCE) && html.includes("2026-11-10"), html);
  assert.ok(html.includes("&lt;b&gt;Backup") && !html.includes("<b>Backup"), "quote not escaped");
  assert.match(html, /data-nem-track-keep="1"/);
  assert.match(fn({ nemTrackKept: { by: "Lee Operator", at: "2026-11-10" } }), /Lee Operator kept[\s\S]*data-nem-track-keep="0"/);
  assert.equal(fn({}), "");
  assert.equal(fn(null), "");
});

if (failures) { console.error(`\n${failures} nemStorageAutodrop check(s) FAILED.`); process.exit(1); }
console.log("\nAll nemStorageAutodrop checks passed.");
process.exit(0);
