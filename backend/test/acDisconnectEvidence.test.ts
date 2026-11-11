// THE JOB'S AC DISCONNECT PART COUNTS AS "SHOWN" ONLY WHEN ITS OWN PLAN SET NAMES IT — FOR THE
// REVIEWER GATE AND FOR QC, FROM ONE READER (soft run on main f280d056, finding 2; Helm's condition).
//
// A utility whose cited list asks for an AC disconnect (whenMissing "blocker", its page quoted) could
// block a job that held the part its plan set names: the gate's evidence read looked only for a few
// wordings in the plan text, and QC looked only at the split-page list and the upload notes. The
// intake (acDisconnectIntake) reads the part off the plan set's own AC-disconnect label and fills
// acDiscMakeModel. But a job's fields keep no record of where a value came from, so the key alone is
// never evidence: acDisconnectIntake.capturedDisconnectPart counts the part only when the job's own
// plan-set text names that part at its AC-disconnect label. Pinned on a synthetic utility (state ZZ):
//   (a) NOTHING CAPTURED: the reviewer blocker and the QC result are exactly as before;
//   (b) THE JOB'S PART, NAMED BY ITS PLAN SET: the blocker clears (shown, not proven: a warning stays
//       for a person, and the finding's evidence names the part); QC stops listing it as missing;
//   (c) NOT EVIDENCE: the key with no plan set behind it (a typed value), a part the plan set does
//       not name, another equipment's part, acDiscReq alone, a rating line with no part, a
//       placeholder, and the client's standard part clear nothing;
//   (d) ONE FACT, ONE READER: over a matrix of jobs the reviewer and QC agree on shown / missing, and
//       both read capturedDisconnectPart (qc.ts hands QC the same answer on the same text);
//   (e) the plan text still proves it as before (high confidence: no finding at all), and a part alone
//       never raises it above "shown";
//   (f) END TO END on a stored job: QC (runQcForProject) and the gate (reviewerGateReportFor) agree.
// Synthetic data only; scratch DB; no network.
//   npx tsx backend/test/acDisconnectEvidence.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";
import type { ProjectRecord, UtilityApplicationRequirement, UtilityRequirementList } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-disconnect-evidence-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");

const { buildReviewerReport } = await import("../src/reviewerEngine");
const { evaluateBaselineRules } = await import("../src/baselineRules");
const { capturedDisconnectPart } = await import("../src/acDisconnectIntake");
const { evidenceForTopic } = await import("../src/projectEvidence");
const UR = await import("../src/utilityRequirements");

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message.slice(0, 1500)}`); }
};

const UTILITY = "Synthetic Valley Electric";
const PAGE = "https://www.synthetic-valley-electric.example/customer-generation/faq";
const QUOTE = "An AC disconnect switch is required on the customer's side of the meter. Breakers do not meet this requirement.";
const ITEM: UtilityApplicationRequirement = {
  key: "ac_disconnect", whenMissing: "blocker", tier: "seeded",
  sourceName: `${UTILITY} customer generation FAQ`, sourceUrl: PAGE, quote: QUOTE, fetchedAt: "2026-11-10T08:25:08Z",
  qc: { ruleId: "synthetic-ac-disconnect", ruleName: "{utility} AC disconnect", message: "{utility}'s application is missing: {missing}.", fieldName: "acDiscMakeModel", severity: "blocker" },
} as UtilityApplicationRequirement;
const LIST: UtilityRequirementList = { displayName: UTILITY, requirements: [ITEM] };
const FINDING = "reviewer.utility.ac-disconnect";

// PLAN-SET TEXT. The label wordings here are ones the gate's own text read does not match (it reads
// "AC disconnect", "utility disconnect", "lockable disconnect"…), so what clears the blocker below is
// the part read and nothing else.
const SCHEDULE = "E-2 EQUIPMENT SCHEDULE\nCOMBINER PANEL 1 EATON BR816L125RP\nAC SAFETY DISCONNECT 1 EATON DG222URB 60A 240V NON-FUSIBLE\nMODULES 20 QCELLS";
const SCHEDULE_OTHER_PART = "E-2 EQUIPMENT SCHEDULE\nAC SAFETY DISCONNECT 1 SQUARE D DU222RB 60A 240V NON-FUSIBLE";
const SCHEDULE_NO_PART = "E-2 EQUIPMENT SCHEDULE\nCOMBINER PANEL 1 EATON BR816L125RP\nA.C. SAFETY DISCONNECT 1 60A 240V NON-FUSIBLE";
const DC_SWITCH = "E-2 EQUIPMENT SCHEDULE\nDC DISCONNECT 1 EATON DG222URB 60A";

// A package that says nothing about a disconnect in its split-page list or notes.
const BASE: Record<string, string> = {
  state: "ZZ", utility: UTILITY, ahj: "City of Testville", dcKw: "8", account: "1234567890", meter: "987654",
  moduleQty: "20", moduleWattage: "400",
  splitPagesText: "01 Site/Roof Plan\n02 SLD 3-Line\n03 Module spec\n04 Inverter spec",
};
let n = 0;
const job = (snap: Record<string, string>): ProjectRecord => ({
  id: `ac-disc-${++n}`, clientId: "client-x", homeownerName: "Synthetic Owner", projectAddress: `${100 + n} Synthetic Way`,
  city: "Testville", state: "ZZ", zip: "99999", ahj: "City of Testville", utility: UTILITY,
  accountNumber: "1234567890", meterNumber: "987654", systemSizeDcKw: 8, systemSizeAcKw: 7.6,
  interconnectionMethod: "Load-side breaker", status: "pending", parserSnapshot: { ...BASE, ...snap },
} as unknown as ProjectRecord);
const gate = (snap: Record<string, string>) => buildReviewerReport(job(snap), { utilityRequirements: LIST } as never).findings.find((f) => f.id === FINDING);
/** QC as qc.ts runs it: the one reader's answer, on the job's plan-set text, handed to the baseline. */
const qc = (snap: Record<string, string>) => evaluateBaselineRules({ ...BASE, ...snap } as never, undefined, undefined,
  { requirements: LIST, disconnectPartOnPlanSet: capturedDisconnectPart({ ...BASE, ...snap }, snap.planSetExtractedText) }).find((r) => r.ruleId === "synthetic-ac-disconnect");

await check("setup: the synthetic item may block (a seeded row quoting its named page in words that name it)", () => {
  assert.equal(UR.requirementMayBlock(ITEM), true);
});

await check("(a) NOTHING CAPTURED: the reviewer blocker and the QC blocker are exactly as before", () => {
  for (const snap of [{}, { planSetExtractedText: SCHEDULE_NO_PART }]) {
    const f = gate(snap);
    assert.equal(f?.severity, "blocker");
    assert.equal(f?.title, `${UTILITY} AC disconnect missing`);
    assert.equal(f?.message, `${UTILITY}'s application asks for the AC disconnect; it was not found in the package.`);
    const r = qc(snap);
    assert.equal(r?.qcStatus, "fail");
    assert.equal(r?.severity, "blocker");
    assert.equal(r?.message, `${UTILITY}'s application is missing: AC disconnect.`);
  }
  // A bare caller that hands QC no plan-set answer reads the package text alone, as before.
  assert.equal(evaluateBaselineRules({ ...BASE, acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: SCHEDULE } as never, undefined, undefined, { requirements: LIST }).find((r) => r.ruleId === "synthetic-ac-disconnect")?.severity, "blocker");
});

await check("(b) THE JOB'S PART, NAMED BY ITS PLAN SET: the blocker clears to a warning that names the part; QC no longer lists it", () => {
  const snap = { acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: SCHEDULE };
  assert.equal(capturedDisconnectPart(snap, SCHEDULE), "Eaton DG222URB");
  const f = gate(snap);
  assert.ok(f, "shown, not proven: a person still checks it");
  assert.equal(f!.severity, "warning");
  assert.equal(f!.title, `Verify ${UTILITY} AC disconnect`);
  assert.match(JSON.stringify(f), /AC disconnect part named on the plan set: Eaton DG222URB/);
  assert.equal(qc(snap), undefined, "QC still reports the disconnect as missing");
  // The key as the schedule prints it (with its rating), in another case, and the legacy split keys.
  assert.equal(gate({ acDiscMakeModel: "EATON DG222URB 60A", planSetExtractedText: SCHEDULE })?.severity, "warning");
  assert.equal(gate({ acDiscMake: "Eaton", acDiscModel: "dg222urb", planSetExtractedText: SCHEDULE })?.severity, "warning");
  assert.equal(gate({ acDiscMakeModel: "Square D DU222RB", planSetExtractedText: SCHEDULE_OTHER_PART })?.severity, "warning");
});

await check("(c) NOT EVIDENCE: a key with no plan set behind it, a part the plan set does not name, and everything that is not the job's plan-set part", () => {
  const not: Array<[string, Record<string, string>]> = [
    // The key alone is a value anyone can type (the parser form, an API body): never evidence.
    ["the key with no plan-set text", { acDiscMakeModel: "Eaton DG222URB" }],
    ["the key, and a plan set that names a different part", { acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: SCHEDULE_OTHER_PART }],
    ["the key, and a plan set whose AC disconnect names no part", { acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: SCHEDULE_NO_PART }],
    ["the combiner's part typed as the disconnect's", { acDiscMakeModel: "Eaton BR816L125RP", planSetExtractedText: SCHEDULE_NO_PART }],
    ["the part written against a DC disconnect", { acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: DC_SWITCH }],
    ["the same model under another maker", { acDiscMakeModel: "Siemens DG222URB", planSetExtractedText: SCHEDULE }],
    ["acDiscReq alone", { acDiscReq: "yes" }],
    ["acDiscReq alone, the plan set naming a part the job did not capture", { acDiscReq: "yes", planSetExtractedText: SCHEDULE }],
    ["acDiscReq with rating fields", { acDiscReq: "required", acDiscAmps: "60A", acDiscFused: "non-fusible", acDiscQty: "1", planSetExtractedText: SCHEDULE_NO_PART }],
    ["a rating line naming no part", { acDiscMakeModel: "60A NON-FUSIBLE, 240V", planSetExtractedText: SCHEDULE }],
    ["a placeholder", { acDiscMakeModel: "N/A", planSetExtractedText: SCHEDULE }],
    // The client's standard part is company data (the overlay's disconnectMake / disconnectModel),
    // never one of the job's plan-set keys: on the job's snapshot it is not read.
    ["the client's standard part", { disconnectMake: "Eaton", disconnectModel: "DG222URB", disconnectMakeModel: "Eaton DG222URB", standardDisconnectMake: "Eaton", standardDisconnectModel: "DG222URB", planSetExtractedText: SCHEDULE }],
  ];
  for (const [label, snap] of not) {
    assert.equal(capturedDisconnectPart(snap, snap.planSetExtractedText), "", label);
    assert.equal(gate(snap)?.severity, "blocker", `reviewer: ${label}`);
    assert.equal(qc(snap)?.severity, "blocker", `QC: ${label}`);
  }
});

await check("(d) ONE FACT, ONE READER: the reviewer and QC agree on shown / missing for every job, and both read capturedDisconnectPart", () => {
  const matrix: Array<Record<string, string>> = [
    {}, { acDiscReq: "yes" }, { acDiscMakeModel: "Eaton DG222URB" }, { acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: SCHEDULE },
    { acDiscMakeModel: "none", planSetExtractedText: SCHEDULE }, { acDiscMakeModel: "Siemens GNF322R", planSetExtractedText: SCHEDULE },
    { acDiscMake: "Square D", acDiscModel: "DU222RB", planSetExtractedText: SCHEDULE_OTHER_PART }, { acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: DC_SWITCH },
    { acDiscAmps: "60A", planSetExtractedText: SCHEDULE_NO_PART },
  ];
  let shown = 0;
  for (const snap of matrix) {
    const reviewerShown = evidenceForTopic(job(snap), "acDisconnect").present;
    const qcShown = !qc(snap);
    assert.equal(reviewerShown, qcShown, JSON.stringify(snap));
    assert.equal(reviewerShown, Boolean(capturedDisconnectPart(snap, snap.planSetExtractedText)), JSON.stringify(snap));
    if (reviewerShown) shown++;
  }
  assert.equal(shown, 2, "the matrix exercises both answers");
  const code = (file: string) => fs.readFileSync(path.join(REPO, file), "utf8").replace(/\/\/[^\n]*/g, "");
  // The gate and QC each call the one reader; neither reads the part keys itself.
  assert.match(code("backend/src/projectEvidence.ts"), /capturedDisconnectPart\(/);
  assert.match(code("backend/src/qc.ts"), /disconnectPartOnPlanSet = capturedDisconnectPart\(/);
  assert.ok(!/acDisc(?:MakeModel|Make|Model)\b/.test(code("backend/src/projectEvidence.ts")), "projectEvidence reads the disconnect part keys itself");
  assert.match(code("backend/src/baselineRules.ts"), /ac_disconnect: \(\{ split, notes, disconnectPart \}\) => Boolean\(disconnectPart\) \|\|/);
});

await check("(e) THE PLAN TEXT STILL PROVES IT, and a part alone never raises it above shown", () => {
  const drawn = { planSetExtractedText: "E-1 ONE-LINE DIAGRAM: 60A NON-FUSIBLE AC DISCONNECT, LOCKABLE, VISIBLE BREAK, ADJACENT TO METER" };
  assert.equal(evidenceForTopic(job(drawn), "acDisconnect").confidence, "high");
  assert.equal(gate(drawn), undefined);
  assert.equal(gate({ ...drawn, acDiscMakeModel: "Eaton DG222URB" }), undefined, "a captured key lowered what the text proves");
  // The part with location words nearby is still only "shown": at most medium from the part.
  const withWords = { acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: `${SCHEDULE}\nSEE SHEET E-1 FOR LOCATION. PAGE 3.` };
  assert.equal(evidenceForTopic(job(withWords), "acDisconnect").confidence, "medium");
  assert.equal(gate(withWords)?.severity, "warning");
});

// ── (f) end to end on a stored job ─────────────────────────────────────────────────────────────
const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const repo = await import("../src/repository");
const { runQcForProject } = await import("../src/qc");
const ufl = await import("../src/utilityFilingLookup");
const db = await openDatabase();

await check("(f) END TO END: on a stored job QC and the gate agree — blocked with the key alone, cleared when the job's plan set names the part", () => {
  // A person records the utility's item on its filing row (data only; the tier may block).
  const saved = ufl.saveUtilityFilingLookup(db, {
    state: "ZZ", utility: UTILITY, lookedUpAt: new Date().toISOString(),
    filing: { value: { name: "Customer Generation Application", url: null }, sourceUrl: PAGE, quote: "Apply online", origin: "lookup" },
    program: { value: "net_metering", sourceUrl: PAGE, quote: "net metering", origin: "lookup" },
  } as never);
  assert.ok(saved.saved, saved.reason);
  const rec = UR.recordUtilityApplicationRequirements(db, { state: "ZZ", utility: UTILITY }, {
    verifiedBy: "A. Person", requirements: [{ key: "ac_disconnect", whenMissing: "blocker", sourceUrl: PAGE, quote: QUOTE }],
  } as never);
  assert.ok((rec as { saved?: boolean }).saved !== false, JSON.stringify(rec));
  const client = createClient(db, { companyName: "AC Disconnect Evidence Solar", ccbLicenseNumber: "790792" });
  const mk = (extra: Record<string, string>) => repo.createProject(db, {
    clientId: client.id, owner: "Synthetic Owner", street: `${200 + ++n} Test Way`, city: "Testville", zip: "99999", ...BASE, ...extra,
  } as never).project.id as string;
  const read = (id: string) => {
    runQcForProject(db, id);
    const qcMissing = db.query<{ message: string }>("SELECT message FROM qc_results WHERE project_id = ? AND qc_status != 'pass'", [id]).some((r) => /AC disconnect/i.test(r.message) && /missing/i.test(r.message));
    const f = repo.reviewerGateReportFor(db, repo.getProjectDetail(db, id).project).findings.find((x) => x.id === FINDING);
    return { qcMissing, gate: f?.severity ?? "none" };
  };
  assert.deepEqual(read(mk({})), { qcMissing: true, gate: "blocker" }, "nothing captured");
  assert.deepEqual(read(mk({ acDiscMakeModel: "Eaton DG222URB" })), { qcMissing: true, gate: "blocker" }, "the key alone (a typed value)");
  assert.deepEqual(read(mk({ acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: SCHEDULE_OTHER_PART })), { qcMissing: true, gate: "blocker" }, "the plan set names another part");
  assert.deepEqual(read(mk({ acDiscMakeModel: "Eaton DG222URB", planSetExtractedText: SCHEDULE })), { qcMissing: false, gate: "warning" }, "the job's plan set names the part");
});

console.log(`\n${passed} passed, ${failures} failed`);
// Explicit: QC on a stored job leaves background work that would hold the process open.
process.exit(failures ? 1 : 0);
