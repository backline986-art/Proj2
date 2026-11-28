// AN AC MODULE'S ONE DATA SHEET IS THE INVERTER'S DATA SHEET TOO (audit 2026-11-28).
// A module with a factory-integrated microinverter has no standalone inverter sheet: its data sheet
// carries the microinverter's AC output table and UL 1741 certificate line. The splitter filed that
// page as the module spec only, so no inverter spec was cut and the document gate held the job for a
// sheet the plan set does not have.
// Pins, through the real write paths (createProject, saveProjectDocument, buildUtilityPackage,
// reconcileSplitParts, documentInventory, submissionDocumentsByType):
//   A. TEXT: the module sheet's text shows AC output + UL 1741 → cut as the inverter spec too, with
//      no model call; the gate row is present and names the sheet; BOTH upload slots get a file.
//   B. READ: an image-only module sheet → the stage pass is told to ask (its own field, never a gap);
//      the page-index read says "integrated inverter" → cut; reconcile keeps the part; never asked again.
//   C. MUST STILL BLOCK: the read says a plain module sheet → no inverter part, the gate row stays
//      missing, and the page is not asked about a second time.
//   D. A read that could not run is noted and not retried on every pass.
//   E. MUST-EXCLUDE: a string-inverter job, and a micro job that has its own inverter sheet, are
//      neither fanned out nor asked about.
//   F. A combined MODULE / INVERTER sheet (two cuts of one page) now fills both upload slots.
//   G. The plan-scan route's own note of the same bytes does not wipe the splitter's note.
// A fake page-index reader records every page it was shown: no spend. Synthetic data only.
// Run: tsx backend/test/docSplitterAcModule.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-ac-module-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage, reconcileSplitParts } = await import("../src/docSplitter");
const req = await import("../src/requiredDocuments");
const sub = await import("../src/submissionDocuments");
const reads = await import("../src/planSetImageReads");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const titleBlock = (sheet: string, name: string) => ["ZZFIXTURE SOLAR CO  100 TEST ST", `SHEET NAME: ${name}`, `SHEET NUMBER: ${sheet}`];
type Sheet = { lines: string[]; image?: boolean };
// `tag` makes each plan set its own bytes: the read's note is keyed by them, and two fixtures built in
// the same second would otherwise share one note.
const mkPdf = async (sheets: Sheet[], tag: number): Promise<Buffer> => {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`zzfixture plan set ${tag}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const s of sheets) {
    const page = pdf.addPage([1224, 792]);
    if (s.image) page.drawRectangle({ x: 40, y: 120, width: 760, height: 620, color: rgb(0.85, 0.85, 0.85) });
    s.lines.forEach((line, i) => page.drawText(line, { x: 820, y: 740 - i * 20, size: 8, font }));
  }
  return Buffer.from(await pdf.save());
};
const MICRO = { pvMicroModel: "ZZ-MICRO-300", pvMicroQty: "20", moduleModel: "ZZ-MOD-400/AC" };
const STRING = { invModel: "ZZ-STRING-7600", inverterModel: "ZZ-STRING-7600", moduleModel: "ZZ-MOD-400" };
let n = 0;
const projectWith = async (sheets: Sheet[], equipment: Record<string, string>) => {
  const p = repo.createProject(db, {
    owner: `Fixture Owner ${++n}`, street: "100 Test St", city: "Testville", state: "ZZ", zip: "00001",
    ahj: "City of Testville", utility: "Testville Power", dcKw: "8", acKw: "6", ...equipment,
  } as never).project;
  const buffer = await mkPdf(sheets, n);
  saveProjectDocument(db, p.id, { docType: "plan_set", filename: `zzfixture-plan-set-${n}.pdf`, contentType: "application/pdf", buffer, source: "upload" });
  return { id: p.id, bytes: buffer };
};
/** A fake page-index reader: `labels` maps a 1-based page to what it "sees" there. */
function fakeLlm(labels: Record<number, { kind: string; integratedInverter?: boolean }>, opts: { fail?: boolean } = {}) {
  const shown: number[][] = [];
  return {
    shown,
    async classifyPlanPages(input: { pageImages: Array<{ page: number; base64: string; mimeType: string }> }) {
      shown.push(input.pageImages.map((p) => p.page));
      if (opts.fail) throw new Error("the read is down");
      return { pages: input.pageImages.map((p) => ({ page: p.page, sheet: "", title: "DATA SHEET", ...(labels[p.page] ?? { kind: "other" }) })) };
    },
  };
}
const inverterRow = (id: string) => req.documentInventory(db, repo.getProjectDetail(db, id).project).presence.find((p) => p.docType === "inverter_spec");
const partNames = (id: string, docType: string) => db.query<{ original_filename: string }>(
  "SELECT original_filename FROM project_documents WHERE project_id = ? AND doc_type = ? AND source = 'split'", [id, docType]).map((r) => r.original_filename);
const pagesOf = (result: { parts: Array<{ docType: string; pages: number[] }> }, t: string) => JSON.stringify(result.parts.find((p) => p.docType === t)?.pages ?? []);

const SLD: Sheet = { lines: [...titleBlock("PV-3", "ELECTRICAL LINE DIAGRAM"), "BRANCH CIRCUIT TO COMBINER"] };
const SITE: Sheet = { lines: [...titleBlock("PV-2", "SITE PLAN"), "FIRE ACCESS PATHWAYS"] };
// The AC module's data sheet with a TEXT layer: module data, the micro's AC output table and its listing.
const AC_MODULE_TEXT: Sheet = { lines: [...titleBlock("DS-1", "PV MODULE SPECIFICATION SHEET"),
  "ZZ-MOD-400/AC  ELECTRICAL CHARACTERISTICS  PMAX 400 W", "AC OUTPUT ELECTRICAL CHARACTERISTICS  ZZ-MICRO-300",
  "MAX CONTINUOUS OUTPUT POWER 300 VA  240 V  1.25 A", "CERTIFICATES: UL 61730-1, UL 1741, IEEE 1547"] };
// The same sheet as an IMAGE: the text layer is the title block only.
const MODULE_IMAGE: Sheet = { lines: titleBlock("DS-1", "PV MODULE SPECIFICATION SHEET"), image: true };
// A plain module data sheet with a text layer: no inverter evidence on it.
const MODULE_TEXT: Sheet = { lines: [...titleBlock("DS-1", "PV MODULE SPECIFICATION SHEET"), "ZZ-MOD-400  PMAX 400 W  VOC 37.1 V  ISC 13.9 A", "CERTIFICATES: UL 61730-1"] };
const INVERTER_SHEET: Sheet = { lines: [...titleBlock("DS-2", "MICROINVERTER SPECIFICATION SHEET"), "ZZ-MICRO-300  UL 1741"], image: true };
const COMBINED: Sheet = { lines: titleBlock("DS-1", "PV MODULE / INV SPECIFICATION SHEET"), image: true };
const MODULE_PAGE = 3;

// ---------------------------------------------------------------------------
console.log("\nA. TEXT: the module sheet shows the micro's AC output and UL 1741");
{
  const { id } = await projectWith([SLD, SITE, AC_MODULE_TEXT], MICRO);
  const llm = fakeLlm({});
  const result = await buildUtilityPackage(db, id, "all", { llm });
  run("the module data sheet is the module spec", pagesOf(result, "module_spec") === `[${MODULE_PAGE}]`, JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  run("MUST-PASS: …and is cut as the inverter spec too", pagesOf(result, "inverter_spec") === `[${MODULE_PAGE}]`, JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  run("the text answered: no page-index call", llm.shown.length === 0, JSON.stringify(llm.shown));
  run("the split reports which page", JSON.stringify(result.acModuleSheetPages) === `[${MODULE_PAGE}]`, JSON.stringify(result.acModuleSheetPages));
  run("the inverter part's filename names the sheet", partNames(id, "inverter_spec").some((f) => f.includes(`(AC module data sheet p${MODULE_PAGE})`)), JSON.stringify(partNames(id, "inverter_spec")));
  const row = inverterRow(id);
  run("the gate's inverter row is present", row?.present === true, JSON.stringify(row));
  run("…and says which sheet covers it", /^attached file — the module data sheet \(plan set page 3\).*integrated microinverter.*UL 1741/.test(String(row?.via)), String(row?.via));
  const project = repo.getProjectDetail(db, id).project;
  const picked = sub.submissionDocumentsByType(db, project, null);
  run("the two cuts are the same bytes (the case the duplicate rule sees)",
    Boolean(picked.module_spec && picked.inverter_spec) && fs.readFileSync(picked.module_spec).equals(fs.readFileSync(picked.inverter_spec)), JSON.stringify(Object.keys(picked)));
  run("MUST-PASS: the inverter-spec upload slot gets a real file", Boolean(picked.inverter_spec && fs.existsSync(picked.inverter_spec)), JSON.stringify(Object.keys(picked)));
  run("…and so does the module-spec slot", Boolean(picked.module_spec && fs.existsSync(picked.module_spec)));
  const reconciled = await reconcileSplitParts(db, id);
  run("the next reconcile pass keeps the inverter part", !reconciled.withdrawn.includes("inverter_spec"), JSON.stringify(reconciled.withdrawn));
  run("…and has nothing to ask", reconciled.moduleSheetsToRead.length === 0, JSON.stringify(reconciled.moduleSheetsToRead));
}

// ---------------------------------------------------------------------------
console.log("\nB. READ: an image-only module sheet is put to the page-index read once");
{
  const { id, bytes } = await projectWith([SLD, SITE, MODULE_IMAGE], MICRO);
  const first = await buildUtilityPackage(db, id, "all");
  run("with no model, the module sheet is the module spec only", pagesOf(first, "module_spec") === `[${MODULE_PAGE}]` && pagesOf(first, "inverter_spec") === "[]", JSON.stringify(first.parts.map((p) => [p.docType, p.pages])));
  run("the gate holds the inverter row", inverterRow(id)?.present === false, JSON.stringify(inverterRow(id)));
  const pending = await reconcileSplitParts(db, id);
  run("MUST-PASS: reconcile names the module sheet to ask about", JSON.stringify(pending.moduleSheetsToRead) === `[${MODULE_PAGE}]`, JSON.stringify(pending.moduleSheetsToRead));
  run("…as its own field, never a gap (a gap re-splits at doors that hold no model)", !pending.gaps.includes("inverter_spec"), JSON.stringify(pending.gaps));
  const llm = fakeLlm({ [MODULE_PAGE]: { kind: "module_spec", integratedInverter: true } });
  const result = await buildUtilityPackage(db, id, "all", { llm });
  run("one page-index call, shown the module sheet only", JSON.stringify(llm.shown) === `[[${MODULE_PAGE}]]`, JSON.stringify(llm.shown));
  run("MUST-PASS: the sheet is cut as the inverter spec too", pagesOf(result, "inverter_spec") === `[${MODULE_PAGE}]`, JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  run("…and stays the module spec", pagesOf(result, "module_spec") === `[${MODULE_PAGE}]`);
  run("the module part is not marked as a page-index cut", partNames(id, "module_spec").every((f) => !f.includes("(page-index read)")), JSON.stringify(partNames(id, "module_spec")));
  const row = inverterRow(id);
  run("the gate's inverter row is present and names the sheet", row?.present === true && /module data sheet \(plan set page 3\)/.test(String(row?.via)), JSON.stringify(row));
  const after = await reconcileSplitParts(db, id);
  run("the next reconcile pass keeps the part the read cut", !after.withdrawn.includes("inverter_spec"), JSON.stringify(after.withdrawn));
  run("…and asks nothing more", after.moduleSheetsToRead.length === 0, JSON.stringify(after.moduleSheetsToRead));
  const again = fakeLlm({});
  const recut = await buildUtilityPackage(db, id, "all", { llm: again });
  run("a later split reuses the noted answer: no second call", again.shown.length === 0 && pagesOf(recut, "inverter_spec") === `[${MODULE_PAGE}]`, JSON.stringify(again.shown));
  // G. the plan-scan route's note of the same bytes keeps the splitter's.
  reads.recordPlanSetImageRead(db, "", bytes, null);
  const kept = await reconcileSplitParts(db, id);
  run("G. a plan-scan note of the same bytes does not wipe the splitter's note", !kept.withdrawn.includes("inverter_spec") && kept.moduleSheetsToRead.length === 0, JSON.stringify(kept));
  const stored = JSON.stringify(db.query("SELECT field, value, sheet FROM plan_set_image_reads"));
  run("the note holds a page number and a sheet kind, nothing of the job", !/Fixture Owner|100 Test St|ZZ-MICRO|ZZ-MOD/.test(stored), stored);
}

// ---------------------------------------------------------------------------
console.log("\nC. MUST STILL BLOCK: the read says a plain module sheet");
{
  const { id } = await projectWith([SLD, SITE, MODULE_IMAGE], MICRO);
  const llm = fakeLlm({ [MODULE_PAGE]: { kind: "module_spec" } });
  const result = await buildUtilityPackage(db, id, "all", { llm });
  run("the read was asked", JSON.stringify(llm.shown) === `[[${MODULE_PAGE}]]`, JSON.stringify(llm.shown));
  run("MUST-EXCLUDE: no inverter part is cut", pagesOf(result, "inverter_spec") === "[]", JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  run("the gate still holds the inverter row", inverterRow(id)?.present === false, JSON.stringify(inverterRow(id)));
  const after = await reconcileSplitParts(db, id);
  run("asked once: reconcile does not name the page again", after.moduleSheetsToRead.length === 0, JSON.stringify(after.moduleSheetsToRead));
  const again = fakeLlm({ [MODULE_PAGE]: { kind: "module_spec", integratedInverter: true } });
  await buildUtilityPackage(db, id, "all", { llm: again });
  run("…and a later split does not call the read for it", again.shown.length === 0, JSON.stringify(again.shown));
}
{
  const { id } = await projectWith([SLD, SITE, MODULE_TEXT], MICRO);
  const result = await buildUtilityPackage(db, id, "all", { llm: fakeLlm({ [MODULE_PAGE]: { kind: "module_spec" } }) });
  run("MUST-EXCLUDE: a text module sheet with no inverter evidence is not cut as the inverter spec", pagesOf(result, "inverter_spec") === "[]", JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  run("the gate holds the inverter row", inverterRow(id)?.present === false, JSON.stringify(inverterRow(id)));
}

// ---------------------------------------------------------------------------
console.log("\nD. A READ THAT COULD NOT RUN is noted, not retried on every pass");
{
  const { id } = await projectWith([SLD, SITE, MODULE_IMAGE], MICRO);
  const down = fakeLlm({}, { fail: true });
  const result = await buildUtilityPackage(db, id, "all", { llm: down });
  run("the split still runs", pagesOf(result, "module_spec") === `[${MODULE_PAGE}]` && pagesOf(result, "inverter_spec") === "[]", JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  const after = await reconcileSplitParts(db, id);
  run("the page is not named again", after.moduleSheetsToRead.length === 0, JSON.stringify(after.moduleSheetsToRead));
  run("the gate holds the inverter row", inverterRow(id)?.present === false);
}

// ---------------------------------------------------------------------------
console.log("\nE. MUST-EXCLUDE: jobs the rule is not about");
{
  const { id } = await projectWith([{ lines: [...titleBlock("PV-3", "ELECTRICAL LINE DIAGRAM"), "STRING INVERTER"] }, SITE, AC_MODULE_TEXT], STRING);
  const llm = fakeLlm({ [MODULE_PAGE]: { kind: "module_spec", integratedInverter: true } });
  const result = await buildUtilityPackage(db, id, "all", { llm });
  run("a string-inverter job: the module sheet is not the inverter spec", pagesOf(result, "inverter_spec") === "[]", JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  run("…and nothing is asked", llm.shown.length === 0 && (await reconcileSplitParts(db, id)).moduleSheetsToRead.length === 0, JSON.stringify(llm.shown));
}
{
  const { id } = await projectWith([SLD, SITE, MODULE_IMAGE, INVERTER_SHEET], MICRO);
  const llm = fakeLlm({ [MODULE_PAGE]: { kind: "module_spec", integratedInverter: true } });
  const result = await buildUtilityPackage(db, id, "all", { llm });
  run("a micro job with its own inverter sheet: that sheet alone is the inverter spec", pagesOf(result, "inverter_spec") === "[4]", JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  run("…and the module sheet is not asked about", llm.shown.length === 0, JSON.stringify(llm.shown));
  run("the gate row reads as an ordinary attached file", inverterRow(id)?.via === "attached file", String(inverterRow(id)?.via));
}

// ---------------------------------------------------------------------------
console.log("\nF. A COMBINED MODULE / INVERTER SHEET fills both upload slots");
{
  const { id } = await projectWith([SLD, SITE, COMBINED], STRING);
  const result = await buildUtilityPackage(db, id, "all");
  run("the sheet is cut into both parts", pagesOf(result, "module_spec") === "[3]" && pagesOf(result, "inverter_spec") === "[3]", JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));
  const picked = sub.submissionDocumentsByType(db, repo.getProjectDetail(db, id).project, null);
  run("MUST-PASS: both slots get a file", Boolean(picked.module_spec && picked.inverter_spec), JSON.stringify(Object.keys(picked)));
  run("the gate row is an attached file, not 'attached once'", inverterRow(id)?.via === "attached file", String(inverterRow(id)?.via));
}
{
  // A person's byte-identical uploads are still one document.
  const p = repo.createProject(db, { owner: "Fixture Owner Dup", street: "100 Test St", city: "Testville", state: "ZZ", zip: "00001", ahj: "City of Testville", utility: "Testville Power", dcKw: "8", acKw: "6" } as never).project;
  for (const docType of ["module_spec", "inverter_spec"]) {
    saveProjectDocument(db, p.id, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\none sheet\n"), source: "upload" });
  }
  const picked = sub.submissionDocumentsByType(db, repo.getProjectDetail(db, p.id).project, null);
  run("MUST-EXCLUDE: a person's byte-identical uploads still go up once", Boolean(picked.module_spec) && picked.inverter_spec === undefined, JSON.stringify(Object.keys(picked)));
}

// ---------------------------------------------------------------------------
console.log("\nH. The stage pass, the one door that holds a model, acts on the field");
{
  const stage = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "autoStageSteps.ts"), "utf8");
  run("it splits again when reconcile names module sheets to read", /splitNewer === 0 \|\| gaps\.length > 0 \|\| moduleSheetsToRead\.length > 0/.test(stage));
  run("…and takes them from reconcile", /moduleSheetsToRead = reconciled\.moduleSheetsToRead/.test(stage));
}

if (failures > 0) {
  console.error(`\n${failures} AC-module splitter check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll AC-module splitter checks passed.");
