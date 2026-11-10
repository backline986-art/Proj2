// A JOB HELD BY ITS CLASS TEACHES THE SHARED RESIDENTIAL KNOWLEDGE NOTHING (#688, part B).
//
// The commercial soft run showed learnFromProject merging every invented commercial job into the
// shared AHJ and utility rows: project_count bumped, commercial required documents merged in, and a
// seeded utility row moved to `learned`. The guard rides the one learning predicate every
// project-sourced writer already asks (knowledgeBase.isLearningExcluded): a commercial job, or one
// whose own evidence says "probably commercial" and nobody confirmed, writes no knowledge event, no
// fingerprint, no failure example, no timeline sample, and leaves permit_utility_knowledge
// BYTE-IDENTICAL — while a residential job learns exactly as it did. Nothing stored is deleted or
// rewritten. One audit line says the learn was skipped (once, not once per save).
//
// KILL (verified by hand): drop the class arm of isLearningExcluded → (2)-(5) fail.
//
//   npx tsx backend/test/learnSkipsCommercial.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-skips-commercial-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const kb = await import("../src/knowledgeBase");
const db = await openDatabase();

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`  FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok   - ${name}`);
};

const UTILITY = "Example Electric";
const AHJ = "Testburg";
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** Drive the real learn paths: the birth learn, a permit target, a correction, two status reads. */
async function exercise(label: string, extra: Record<string, unknown>, options: { projectClass?: string } = {}): Promise<string> {
  const { project } = R.createProject(db, {
    owner: `${label} Owner`, street: `${label.length} Test St`, city: AHJ, state: "NV", zip: "89000", ahj: AHJ, utility: UTILITY, dcKw: "8", acKw: "7", ...extra,
  } as never, undefined, options);
  const pid = project.id;
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, created_at)
     VALUES (?, ?, 'permit', 'combo', 'submitted', ?, ?)`,
    [`sub-${pid.slice(0, 8)}`, pid, iso(9 * 86400000), iso(9 * 86400000)],
  );
  const target = R.createPermitCheckTarget(db, pid, { jurisdiction: AHJ, portalName: "Testburg Portal", applicationNumber: `APP-${label}`, permitType: "combo" })
    .permitCheckTargets.find((t) => t.targetType === "permit")!;
  R.addManualCorrection(db, pid, "Please provide the rafter span calculations stamped by an engineer.");
  await R.recordPermitStatusCheck(db, pid, { targetId: target.id, source: "manual", rawStatusText: "Plan review in progress." });
  await R.recordPermitStatusCheck(db, pid, { targetId: target.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
  R.updateProject(db, pid, { owner: `${label} Owner`, ahj: AHJ, utility: UTILITY, state: "NV", ...extra } as never);
  return pid;
}
const count = (sql: string, id: string) => Number(db.get<{ n: number }>(sql, [id])?.n ?? 0);
const learned = (pid: string) => ({
  events: count("SELECT COUNT(*) n FROM knowledge_events WHERE project_id = ?", pid),
  fingerprints: count("SELECT COUNT(*) n FROM historical_project_fingerprints WHERE project_id = ?", pid),
  failures: count("SELECT COUNT(*) n FROM historical_failure_examples WHERE project_id = ?", pid),
  samples: count("SELECT COUNT(*) n FROM permit_timeline_samples WHERE project_id = ?", pid),
});
const kbTable = () => JSON.stringify(db.query("SELECT * FROM permit_utility_knowledge ORDER BY profile_key"));
const skips = (pid: string) => count("SELECT COUNT(*) n FROM audit_logs WHERE project_id = ? AND action = 'knowledge.learn_skipped_class_hold'", pid);

// (1) CONTROL: a residential job teaches the shared rows (so the profile exists for every later guard).
const control = await exercise("Control", {});
const c = learned(control);
check("(1) MUST-PASS: an 8 kW residential job learns (events, fingerprint, failure row, sample)",
  c.events > 0 && c.fingerprints === 1 && c.failures === 1 && c.samples === 1, JSON.stringify(c));
check("(1b) …and writes no class-skip audit line", skips(control) === 0);

// (2) A 750 kW three-phase warehouse: held by its evidence, never confirmed.
const before = kbTable();
const warehouse = await exercise("Warehouse", { dcKw: "750", acKw: "600", servicePhase: "three-phase", serviceVoltage: "480", occupancy: "Commercial - S-1 warehouse" });
const w = learned(warehouse);
check("(2) a held commercial-evidence job writes no event, fingerprint, failure example or timeline sample",
  w.events === 0 && w.fingerprints === 0 && w.failures === 0 && w.samples === 0, JSON.stringify(w));
check("(2b) permit_utility_knowledge is byte-identical after it", kbTable() === before);
check("(2c) one audit line says the learn was skipped — once, however many saves", skips(warehouse) === 1, `lines=${skips(warehouse)}`);

// (3) A job set commercial at intake (8 kW, nothing else commercial about it).
const before3 = kbTable();
const intake = await exercise("Intake", {}, { projectClass: "commercial" });
const i = learned(intake);
check("(3) a job set commercial at intake teaches nothing", i.events === 0 && i.fingerprints === 0 && i.failures === 0 && i.samples === 0, JSON.stringify(i));
check("(3b) permit_utility_knowledge is byte-identical after it", kbTable() === before3);

// (4) The later learn doors: a relearn of its correction and the boot backfill.
const corr = R.getProjectDetail(db, warehouse).corrections[0];
if (corr && !corr.closedAt) R.resolveCorrection(db, corr.id, { resubmitted: false });
else if (corr) kb.relearnCorrection(db, corr.id);
check("(4) resolving its correction learns no failure row", learned(warehouse).failures === 0, JSON.stringify(learned(warehouse)));
await openDatabase(); // a second open runs the boot backfill
check("(4b) the boot backfill teaches nothing from a held job", learned(warehouse).events === 0 && learned(intake).events === 0);

// (5) Released: a named person confirms the 8 kW intake job residential — it now learns like any other.
R.setProjectClass(db, intake, { projectClass: "residential", by: "Dana Reviewer" });
check("(5) once a person confirms it residential, the job learns", learned(intake).events > 0, JSON.stringify(learned(intake)));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nlearnSkipsCommercial: all checks passed");
