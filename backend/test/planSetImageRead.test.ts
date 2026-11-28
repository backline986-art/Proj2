// AN IMAGE-ONLY PLAN SET'S AC DISCONNECT COUNTS AS "SHOWN" FROM THE SERVER'S OWN NOTE OF THE INTAKE'S
// IMAGE READ — NEVER FROM A JOB FIELD (#135).
//
// A scanned plan set has no text layer, so the gate's and QC's evidence for a utility's AC-disconnect
// item (the plan-set TEXT) is empty and the job was held even when the intake's image read found the
// switch. The read's fields go back to the parser page and return on save as plain keys, and a key
// alone is never evidence (#133). planSetImageReads keeps the server's own note of that read, written
// only by the plan-scan route, keyed by the PDF's bytes and the caller's org. Pinned on a synthetic
// utility (state ZZ):
//   (a) WHAT IS KEPT: only the AC disconnect's own fields, only when the image read answered them from
//       the plan set with a callout that names the AC disconnect, in the field's shape; never another
//       field of the read, never the quoted callout;
//   (b) WHAT IS NOT: a field the image read did not answer, another source, a DC / rapid-shutdown /
//       storage disconnect, a value without the field's shape, a bare "required";
//   (c) THE ONE READER: the job's own newest stored plan set, by its bytes, in its own org. No plan
//       set, other bytes, a replaced plan set, another document type and another org read nothing;
//       reading writes nothing;
//   (d) END TO END on a stored job: held (gate blocker, QC missing) with no note, and with a snapshot
//       that only CLAIMS a vision read; with the note the gate's blocker is a warning that names the
//       image read and QC stops listing it. A later read of the same bytes that names no disconnect
//       holds the job again;
//   (e) ONE WRITER, ONE READER, wired where they should be (static pins), and the table comes from its
//       migration.
// Synthetic data only; scratch DB; no model call; no network.
//   npx tsx backend/test/planSetImageRead.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";
import type { ParserLlmExtraction } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-set-image-read-"));
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
const { runQcForProject } = await import("../src/qc");
const ufl = await import("../src/utilityFilingLookup");
const UR = await import("../src/utilityRequirements");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { recordPlanSetImageRead, planSetImageDisconnectRead, planSetPdfSha256 } = await import("../src/planSetImageReads");
const { namesAcDisconnectLabel } = await import("../src/acDisconnectIntake");
const { PDFDocument } = await import("pdf-lib");
const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message.slice(0, 1500)}`); }
};

/** A PDF with no text layer at all (a scan's shape); `tag` only makes the bytes differ. */
const scanPdf = async (tag: string): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  doc.setTitle(`synthetic scan ${tag}`);
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 72, y: 72, width: 200, height: 100 });
  return Buffer.from(await doc.save());
};

type Fields = ParserLlmExtraction["fields"];
const field = (value: string, excerpt: string, source = "plan_set", sheet = "E-2"): Fields[string] =>
  ({ value, confidence: 0.8, evidence: { source, sheet, excerpt } }) as Fields[string];
const readOf = (fields: Fields, visionFields = Object.keys(fields), planReadMode: "vision" | "hybrid" = "vision"): ParserLlmExtraction =>
  ({ provider: "claude", fields, lowConfidenceFields: [], notes: "", visionFields, planReadMode }) as unknown as ParserLlmExtraction;
const rowsFor = (bytes: Buffer, org = DEFAULT_ORG_ID) =>
  db.query<{ field: string; value: string; sheet: string }>("SELECT field, value, sheet FROM plan_set_image_reads WHERE org_id = ? AND pdf_sha256 = ? ORDER BY field", [org, planSetPdfSha256(bytes)]);

const CALLOUT = "AC DISCONNECT 1 EATON DG222URB 60A 240V NON-FUSIBLE";

// ── (a) what is kept ───────────────────────────────────────────────────────────────────────────
await check("(a) KEPT: only the AC disconnect's own fields the image read answered from the plan set, value and sheet — never another field, never the callout", async () => {
  const pdf = await scanPdf("a");
  const kept = recordPlanSetImageRead(db, DEFAULT_ORG_ID, pdf, readOf({
    acDiscMakeModel: field("Eaton DG222URB", CALLOUT),
    acDiscAmps: field("60 A", CALLOUT),
    acDiscFused: field("Non-Fusible", "A.C. SAFETY DISCONNECT, NON-FUSIBLE"),
    acDiscReq: field("shown", "(N) UTILITY DISCONNECT, VISIBLE, LOCKABLE", "plan_set", "E-1"),
    // The rest of a read is never stored here, whatever it holds.
    accountNumber: field("5550001111", "ACCOUNT 5550001111", "plan_set"),
    meterNumber: field("7770002222", "METER 7770002222"),
    homeownerName: field("Synthetic Owner", "OWNER: SYNTHETIC OWNER"),
    acDiscVoltage: field("240V", CALLOUT),
  }));
  assert.deepEqual([...kept].sort(), ["acDiscAmps", "acDiscFused", "acDiscMakeModel", "acDiscReq"]);
  assert.deepEqual(rowsFor(pdf), [
    { field: "acDiscAmps", value: "60A", sheet: "E-2" },
    { field: "acDiscFused", value: "non-fusible", sheet: "E-2" },
    { field: "acDiscMakeModel", value: "Eaton DG222URB", sheet: "E-2" },
    { field: "acDiscReq", value: "shown", sheet: "E-1" },
  ]);
  const everything = JSON.stringify(db.query("SELECT * FROM plan_set_image_reads"));
  for (const never of ["5550001111", "7770002222", "Synthetic Owner", "240V", "VISIBLE, LOCKABLE", "SAFETY DISCONNECT"]) {
    assert.ok(!everything.includes(never), `"${never}" must not be stored`);
  }
  // The label reader the callout is checked with: the intake's forms and the gate's wordings.
  for (const yes of ["A.C. DISCONNECT", "AC SAFETY DISCONNECT 60A", "VISIBLE, LOCKABLE, LABELED DISCONNECT", "utility disconnect", "(N) 60A AC DISCONNECT"]) assert.equal(namesAcDisconnectLabel(yes), true, yes);
  for (const no of ["DC DISCONNECT 60A", "RAPID SHUTDOWN SWITCH", "ESS DISCONNECT", "BATTERY DISCONNECT 60A", "60A 240V NON-FUSIBLE", "", null]) assert.equal(namesAcDisconnectLabel(no), false, String(no));
});

// ── (b) what is not ────────────────────────────────────────────────────────────────────────────
await check("(b) NOT KEPT: not answered by the image read, another source, a DC / rapid-shutdown / storage disconnect, a value without the field's shape, a bare \"required\"", async () => {
  const cases: Array<[string, ParserLlmExtraction | null]> = [
    ["no read at all", null],
    ["answered by the text read, not the image read", readOf({ acDiscAmps: field("60A", CALLOUT) }, [])],
    ["read off another document", readOf({ acDiscAmps: field("60A", CALLOUT, "utility_bill") })],
    ["no callout quoted", readOf({ acDiscAmps: field("60A", "") })],
    ["a DC disconnect's rating", readOf({ acDiscAmps: field("60A", "DC DISCONNECT 60A 600V") })],
    ["a rapid shutdown switch", readOf({ acDiscReq: field("shown", "RAPID SHUTDOWN SWITCH AT SERVICE") })],
    ["a storage disconnect's part", readOf({ acDiscMakeModel: field("Eaton DG222URB", "ESS DISCONNECT EATON DG222URB") })],
    ["a rating line with no AC-disconnect label", readOf({ acDiscAmps: field("60A", "60A 240V NON-FUSIBLE") })],
    ["amps without the shape", readOf({ acDiscAmps: field("sixty", CALLOUT) })],
    ["a maker with no part number", readOf({ acDiscMakeModel: field("Eaton", CALLOUT) })],
    ["fusing without the shape", readOf({ acDiscFused: field("see schedule", CALLOUT) })],
    ["a bare rule, not a switch on the sheet", readOf({ acDiscReq: field("required", "AC DISCONNECT REQUIRED PER UTILITY") })],
    ["a very long value", readOf({ acDiscAmps: field(`60A ${"x".repeat(120)}`, CALLOUT) })],
  ];
  for (const [why, read] of cases) {
    const pdf = await scanPdf(`b-${why}`);
    assert.deepEqual(recordPlanSetImageRead(db, DEFAULT_ORG_ID, pdf, read), [], why);
    assert.deepEqual(rowsFor(pdf), [], why);
  }
});

// ── stored jobs ────────────────────────────────────────────────────────────────────────────────
const UTILITY = "Synthetic Valley Electric";
const PAGE = "https://www.synthetic-valley-electric.example/customer-generation/faq";
const QUOTE = "An AC disconnect switch is required on the customer's side of the meter. Breakers do not meet this requirement.";
const FINDING = "reviewer.utility.ac-disconnect";
const BASE: Record<string, string> = {
  state: "ZZ", utility: UTILITY, ahj: "City of Testville", dcKw: "8", account: "1234567890", meter: "987654",
  moduleQty: "20", moduleWattage: "400",
  splitPagesText: "01 Site/Roof Plan\n02 SLD 3-Line\n03 Module spec\n04 Inverter spec",
};
const saved = ufl.saveUtilityFilingLookup(db, {
  state: "ZZ", utility: UTILITY, lookedUpAt: new Date().toISOString(),
  filing: { value: { name: "Customer Generation Application", url: null }, sourceUrl: PAGE, quote: "Apply online", origin: "lookup" },
  program: { value: "net_metering", sourceUrl: PAGE, quote: "net metering", origin: "lookup" },
} as never);
assert.ok(saved.saved, saved.reason);
UR.recordUtilityApplicationRequirements(db, { state: "ZZ", utility: UTILITY }, {
  verifiedBy: "A. Person", requirements: [{ key: "ac_disconnect", whenMissing: "blocker", sourceUrl: PAGE, quote: QUOTE }],
} as never);
const client = createClient(db, { companyName: "Image Read Evidence Solar", ccbLicenseNumber: "790792" });
let n = 0;
const mk = (extra: Record<string, string> = {}) => repo.createProject(db, {
  clientId: client.id, owner: "Synthetic Owner", street: `${300 + ++n} Test Way`, city: "Testville", zip: "99999", ...BASE, ...extra,
} as never).project.id as string;
const attach = (projectId: string, buffer: Buffer, docType = "plan_set") => saveProjectDocument(db, projectId, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer });
const AMPS_READ = readOf({ acDiscAmps: field("60A", CALLOUT) });

// ── (c) the one reader ─────────────────────────────────────────────────────────────────────────
await check("(c) THE READER: the job's own newest stored plan set, by its bytes, in its own org — and it writes nothing", async () => {
  const pdf = await scanPdf("c");
  recordPlanSetImageRead(db, DEFAULT_ORG_ID, pdf, readOf({ acDiscAmps: field("60A", CALLOUT), acDiscMakeModel: field("Eaton DG222URB", CALLOUT) }));

  const noPlanSet = mk();
  assert.equal(planSetImageDisconnectRead(db, noPlanSet), null, "no plan set on file");

  const same = mk();
  attach(same, pdf);
  const before = db.query<{ n: number }>("SELECT total_changes() AS n")[0].n;
  const read = planSetImageDisconnectRead(db, same);
  assert.equal(db.query<{ n: number }>("SELECT total_changes() AS n")[0].n, before, "reading writes nothing");
  assert.equal(read?.field, "acDiscMakeModel", "the most specific field first");
  assert.equal(read?.value, "Eaton DG222URB");
  assert.equal(read?.sheet, "E-2");

  const otherBytes = mk();
  attach(otherBytes, await scanPdf("c-other"));
  assert.equal(planSetImageDisconnectRead(db, otherBytes), null, "a plan set of other bytes");

  const otherType = mk();
  attach(otherType, pdf, "sld");
  assert.equal(planSetImageDisconnectRead(db, otherType), null, "the same bytes filed as another document type");

  const replaced = mk();
  attach(replaced, pdf);
  assert.ok(planSetImageDisconnectRead(db, replaced), "before the replacement");
  await new Promise((r) => setTimeout(r, 15));
  attach(replaced, await scanPdf("c-replacement"));
  assert.equal(planSetImageDisconnectRead(db, replaced), null, "the newest plan set is other bytes");

  // Rule 6: another org's job holding the same bytes reads nothing, and its own scan is its own note.
  const otherOrg = mk();
  attach(otherOrg, pdf);
  db.run("UPDATE projects SET org_id = ? WHERE id = ?", ["org-other", otherOrg]);
  assert.equal(planSetImageDisconnectRead(db, otherOrg), null, "another org's job");
  recordPlanSetImageRead(db, "org-other", pdf, AMPS_READ);
  assert.equal(planSetImageDisconnectRead(db, otherOrg)?.value, "60A", "its own org's scan");
  assert.equal(planSetImageDisconnectRead(db, same)?.value, "Eaton DG222URB", "the first org's note is untouched");
});

// ── (d) end to end ─────────────────────────────────────────────────────────────────────────────
const gateAndQc = (id: string) => {
  runQcForProject(db, id);
  const qcMissing = db.query<{ message: string }>("SELECT message FROM qc_results WHERE project_id = ? AND qc_status != 'pass'", [id]).some((r) => /AC disconnect/i.test(r.message) && /missing/i.test(r.message));
  const f = repo.reviewerGateReportFor(db, repo.getProjectDetail(db, id).project).findings.find((x) => x.id === FINDING);
  return { qcMissing, gate: f?.severity ?? "none", finding: f };
};
const verdict = (id: string) => { const r = gateAndQc(id); return { qcMissing: r.qcMissing, gate: r.gate }; };

await check("(d) END TO END: an image-only plan set is held with no note and with a snapshot that only claims a read; the server's note makes it shown (a warning naming the read) for the gate and QC", async () => {
  const pdf = await scanPdf("d");

  const held = mk();
  attach(held, pdf);
  assert.deepEqual(verdict(held), { qcMissing: true, gate: "blocker" }, "no note: held as before");

  // What a client can post: the fields, the vision markers, even evidence — none of it is the note.
  const spoof = mk({
    acDiscAmps: "60A", acDiscMakeModel: "Eaton DG222URB", acDiscFused: "non-fusible", acDiscReq: "shown",
    visionFields: "acDiscAmps,acDiscMakeModel", planReadMode: "vision", planSetImageDisconnectRead: "Eaton DG222URB",
  });
  attach(spoof, await scanPdf("d-spoof"));
  assert.deepEqual(verdict(spoof), { qcMissing: true, gate: "blocker" }, "a snapshot that claims a vision read");

  recordPlanSetImageRead(db, DEFAULT_ORG_ID, pdf, AMPS_READ);
  const shown = gateAndQc(held);
  assert.deepEqual({ qcMissing: shown.qcMissing, gate: shown.gate }, { qcMissing: false, gate: "warning" }, "the server's note: shown, never proven");
  const text = JSON.stringify(shown.finding);
  assert.match(text, /read off the plan set's page image at intake \(E-2\): 60A AC disconnect/);
  assert.equal(shown.finding?.evidenceStatus, "weak");
  assert.equal(shown.finding?.evidenceFound?.[0]?.verifier, "vision");
  assert.deepEqual(verdict(spoof), { qcMissing: true, gate: "blocker" }, "another job's note clears nothing here");

  // A later read of the same bytes that names no AC disconnect replaces the note: held again.
  recordPlanSetImageRead(db, DEFAULT_ORG_ID, pdf, readOf({ acDiscAmps: field("60A", "DC DISCONNECT 60A") }));
  assert.deepEqual(verdict(held), { qcMissing: true, gate: "blocker" }, "the note was cleared");
});

// ── (e) wiring ─────────────────────────────────────────────────────────────────────────────────
await check("(e) ONE WRITER, ONE READER: only the plan-scan route writes the note (with the caller's org); the gate and QC ask the one reader; the table comes from its migration", () => {
  const src = (f: string) => fs.readFileSync(path.join(REPO, "backend/src", f), "utf8");
  const server = src("server.ts");
  const route = server.slice(server.indexOf('"/api/parser/plan-scan-extract"'), server.indexOf('app.post("/api/parser/vision-extract"'));
  // THE ONE WRITER is the server's own image read (parserExtraction.readPlanSetImagePages), which the
  // plan-scan route AND the unattended doors (email intake, bulk drop) call — so a set read at either
  // door leaves the same note. It was the route itself until the unattended doors read image pages.
  assert.match(route, /readPlanSetImagePages\(db, createLLMProvider\(\), bytes, \{ orgId: requestScope\(db, req\)\.orgId, defaultState \}\)/, "the route reads through the one image read, under the caller's org");
  const shared = src("parserExtraction.ts");
  const reader = shared.slice(shared.indexOf("export async function readPlanSetImagePages"), shared.indexOf("export async function extractParserFieldsFromDocuments"));
  assert.match(reader, /if \(read\.mode !== "text" && read\.extraction\) \{[\s\S]*recordPlanSetImageRead\(db, opts\.orgId, pdfBytes, read\.extraction\)/, "the note is of the bytes it read, only after a read that is not the text path");
  const files = fs.readdirSync(path.join(REPO, "backend/src")).filter((f) => f.endsWith(".ts"));
  const writers = files.filter((f) => /INSERT INTO plan_set_image_reads|recordPlanSetImageRead\(/.test(src(f)) && f !== "planSetImageReads.ts");
  assert.deepEqual(writers, ["parserExtraction.ts"], "no other caller writes the note");
  assert.equal((shared.match(/recordPlanSetImageRead\(/g) ?? []).length, 1);
  assert.match(src("repository.ts"), /planSetImageDisconnectRead = planSetImageDisconnectReadOf\(db, project\.id\)/, "the gate asks the one reader");
  assert.match(src("qc.ts"), /planTextNamesAcDisconnect\(planSetText\) \|\| Boolean\(planSetImageDisconnectRead\(db, projectId\)\)/, "QC asks the one reader");
  const engine = src("reviewerEngine.ts");
  assert.match(engine, /topic === "acDisconnect" && !textCheck\.present \? imageDisconnectRead : null/, "only where the text names none, only for the AC disconnect");
  assert.ok(!/parserSnapshot[^\n]*planSetImageDisconnectRead/.test(engine), "never from the job's snapshot");
  const cols = db.query<{ name: string }>("PRAGMA table_info(plan_set_image_reads)").map((c) => c.name).sort();
  assert.deepEqual(cols, ["field", "org_id", "pdf_sha256", "read_at", "read_mode", "sheet", "value"]);
  assert.match(src("db.ts"), /version: 83,\s*name: "plan_set_image_reads"/);
});

console.log(`\n${passed} passed, ${failures} failed`);
// Explicit: QC on a stored job leaves background work that would hold the process open.
process.exit(failures ? 1 : 0);
