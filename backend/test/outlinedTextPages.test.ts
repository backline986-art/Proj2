// PLAN PAGES WHOSE TEXT IS DRAWN AS OUTLINES (#696 part 1): found, said, withheld from every model.
//
// A CAD export that draws its letters as filled vector shapes has no text layer and paints no
// raster, so it sits under the threshold that routes a scan to vision: neither path read it, and
// nothing said so. The fixtures are INVENTED PDFs generated here (_outlinedTextFixture.ts: a
// dot-matrix face drawn as filled squares) — never a real plan set. Pinned:
//   A  detection: an outlined page (plain, inside a form XObject, with stray real text, with a small
//      logo) is found; a normal text page, a scanned (raster) page and a frame-only page are not;
//      a normal text page's drawing is never even read (its text clears the bar first);
//   B  MUST-EXCLUDE: both vision renderers refuse an outlined page before anything is drawn, with or
//      without project secrets; a normal text page and a raster page render as before (pinned);
//   C  the plan read: an all-outlined set asks no model anything; a scan with an outlined page never
//      shows it to the page index or the extraction read, and names it; a text set names it with no
//      model call; a normal text set is unchanged; the hybrid merge carries the pages through;
//   D  the splitter marks an outlined page unclassified (even one whose stray "PV 1.0" scored it as
//      a site plan before), names it, and stores it for QC and the gate;
//   E  QC lists the pages in its own row, and the gate's "missing" reason for a plan sheet names them;
//   F  the constants agree with scannedPlanSet's and the sheet types with the splitter's.
// No real model: a fake LLM records every call. Run: npx tsx backend/test/outlinedTextPages.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outlinedPlanSet } from "./_outlinedTextFixture";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlined-text-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const ot = await import("../src/outlinedTextPages");
const scan = await import("../src/scannedPlanSet");
const { openPdfForVisionRender, renderPdfPageForVision, renderPdfPageToPng } = await import("../src/pageImages");
const { VisionPageWithheldError } = await import("../src/visionPageMask");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const toFile = (bytes: Uint8Array, name: string) => { const p = path.join(tmpDir, name); fs.writeFileSync(p, bytes); return p; };

type Img = { page: number; base64: string; mimeType: string };
function fakeLlm(indexKind = "site_plan") {
  const extractCalls: Array<{ planPageImages?: Img[] }> = [];
  const indexCalls: Img[][] = [];
  const orientCalls: unknown[] = [];
  return {
    extractCalls, indexCalls, orientCalls,
    get total() { return extractCalls.length + indexCalls.length + orientCalls.length; },
    async extractProjectFields(input: { planPageImages?: Img[] }) {
      extractCalls.push(input);
      return { provider: "claude" as const, fields: { dcKw: { value: 6.4, confidence: 0.8 } }, lowConfidenceFields: [], notes: "read" };
    },
    async classifyPlanPages(input: { pageImages: Img[] }) {
      indexCalls.push(input.pageImages);
      return { pages: input.pageImages.map((p) => ({ page: p.page, kind: p.page === 1 ? "cover" : indexKind, rotate: 0 })), sheetIndex: [] };
    },
    async orientPlanPages(input: unknown) { orientCalls.push(input); return []; },
  };
}

console.log("\nA. DETECTION");
const MIXED = await outlinedPlanSet(["outlined", "outlined-form", "text", "blank", "raster", "outlined-stray", "outlined-logo"]);
await check("A1 outlined pages are found: plain, inside a form XObject, with stray real text, with a small logo", async () => {
  assert.deepEqual(await ot.outlinedTextPagesOfPdf(MIXED), [1, 2, 6, 7]);
});
await check("A2 MUST-EXCLUDE: a normal text page, a frame-only page and a scanned (raster) page are not outlined", async () => {
  const pages = await ot.outlinedTextPagesOfPdf(MIXED);
  for (const p of [3, 4, 5]) assert.ok(!pages.includes(p), `page ${p}`);
});
await check("A3 a normal text page's drawing is never read: its text clears the bar first (a page whose operator list throws)", async () => {
  const page = {
    getTextContent: async () => ({ items: [{ str: "SHEET PV-3 SYNTHETIC SOLAR PLAN SET SITE PLAN NOTES" }] }),
    getOperatorList: async () => { throw new Error("must not be read"); },
  };
  const stats = await ot.pdfjsPageDrawingStats(page);
  assert.ok(stats.textChars >= ot.OUTLINED_MAX_TEXT_CHARS);
  assert.equal(await ot.isOutlinedPdfjsPage(page), false);
});
await check("A4 known page texts skip the PDF entirely when every page clears the bar", async () => {
  assert.deepEqual(await ot.outlinedTextPagesOfPdf(new Uint8Array([1, 2, 3]), { pageTexts: ["SHEET PV-1 SYNTHETIC SOLAR PLAN SET SITE PLAN NOTES ".repeat(2)] }), []);
});
await check("A5 the predicate: each of its three conditions is needed", () => {
  const base = { textChars: 0, pathSegments: 5000, rasterPixels: 0 };
  assert.equal(ot.isOutlinedTextPage(base), true);
  assert.equal(ot.isOutlinedTextPage({ ...base, textChars: ot.OUTLINED_MAX_TEXT_CHARS }), false, "a text layer");
  assert.equal(ot.isOutlinedTextPage({ ...base, rasterPixels: ot.OUTLINED_MAX_RASTER_PIXELS }), false, "a picture");
  assert.equal(ot.isOutlinedTextPage({ ...base, pathSegments: ot.OUTLINED_MIN_PATH_SEGMENTS - 1 }), false, "a near-blank page");
});
await check("A6 the operator-list counter reads pdf.js 5+'s packed path shape and the older one", () => {
  const OPS = { constructPath: 91, paintImageXObject: 85 } as Record<string, number>;
  // moveTo, lineTo x3, closePath, then a curveTo: 5 segments
  const packed = { fnArray: [91], argsArray: [[22, [new Float32Array([0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 4, 2, 1, 1, 2, 2, 3, 3])], null]] };
  assert.equal(ot.drawingStatsFromOperatorList(packed, OPS).pathSegments, 5);
  const older = { fnArray: [91], argsArray: [[[13, 14, 14, 14], [0, 0, 1, 0, 1, 1, 0, 1], null]] };
  assert.equal(ot.drawingStatsFromOperatorList(older, OPS).pathSegments, 4);
  assert.equal(ot.drawingStatsFromOperatorList({ fnArray: [85], argsArray: [["img", 1000, 800]] }, OPS).rasterPixels, 800_000);
});

console.log("\nB. EVERY VISION DOOR REFUSES AN OUTLINED PAGE (rule 2: the mask has no text layer to read)");
const mixedPath = toFile(MIXED, "mixed.pdf");
await check("B1 MUST-EXCLUDE: openPdfForVisionRender refuses outlined pages with VisionPageWithheldError, secrets or not", async () => {
  for (const secrets of [[], ["40000777"]]) {
    const r = await openPdfForVisionRender(MIXED, { secrets });
    try {
      for (const p of [1, 2, 6, 7]) {
        await assert.rejects(r.render(p, { maxLongEdge: 800, maxPixels: 400_000 }), (e: unknown) => e instanceof VisionPageWithheldError && /text drawn as outlines; a person reads this page/.test((e as Error).message), `page ${p}`);
      }
    } finally { await r.close(); }
  }
});
await check("B2 MUST-EXCLUDE: renderPdfPageForVision (reviewer, module listing, AI review) refuses outlined pages, secrets or not", async () => {
  for (const secrets of [[], ["40000777"]]) {
    for (const p of [1, 2, 6, 7]) {
      const img = await renderPdfPageForVision(mixedPath, p, secrets);
      assert.equal(img.ok, false, `page ${p}`);
      assert.match((img as { reason: string }).reason, /text drawn as outlines; a person reads this page/);
    }
  }
});
await check("B3 MUST-PASS (pinned): a normal text page renders for vision exactly as before — byte-for-byte the plain PNG with no secrets", async () => {
  const img = await renderPdfPageForVision(mixedPath, 3, []);
  assert.equal(img.ok, true);
  assert.ok((img as { png: Buffer }).png.equals(await renderPdfPageToPng(mixedPath, 3)));
  const r = await openPdfForVisionRender(MIXED);
  try { const out = await r.render(3, { maxLongEdge: 800, maxPixels: 400_000 }); assert.ok(out.bytes.length > 1000); } finally { await r.close(); }
});
await check("B4 MUST-PASS: a raster (scanned) page still goes through today's masked vision door", async () => {
  const r = await openPdfForVisionRender(MIXED, { secrets: ["40000777"] });
  try { const out = await r.render(5, { maxLongEdge: 800, maxPixels: 400_000 }); assert.equal(out.mimeType, "image/jpeg"); assert.ok(out.bytes.length > 1000); } finally { await r.close(); }
  const png = await renderPdfPageForVision(mixedPath, 5, []);
  assert.equal(png.ok, true);
});

console.log("\nC. THE PLAN READ (scannedPlanSet.readPlanSetForExtraction)");
await check("C1 MUST-EXCLUDE: a set whose every page is outlined asks NO model anything, and names every page", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await outlinedPlanSet(["outlined", "outlined-form", "outlined"]));
  assert.equal(llm.total, 0, "no extraction, no page index, no orientation call");
  assert.equal(read.mode, "vision");
  assert.deepEqual(read.outlinedPages, [1, 2, 3]);
  assert.deepEqual(read.extraction?.outlinedTextPages, [1, 2, 3]);
  assert.deepEqual(read.extraction?.fields, {});
  assert.deepEqual(read.extraction?.visionPages, []);
  assert.match(read.extraction?.notes ?? "", /Plan-set pages 1, 2, 3 unread: text drawn as outlines; a person reads this page\. Nothing on them was sent to any model\./);
});
await check("C2 MUST-EXCLUDE: a scan with an outlined page never shows that page to the page index or the read; it is named", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await outlinedPlanSet(["raster", "outlined", "raster", "raster"]));
  assert.equal(read.mode, "vision");
  const shown = [...llm.indexCalls.flat(), ...llm.extractCalls.flatMap((c) => c.planPageImages ?? [])].map((i) => i.page);
  assert.ok(shown.length > 0, "the raster pages were read");
  assert.ok(!shown.includes(2), `page 2 was shown to a model: ${shown.join(",")}`);
  assert.deepEqual(read.outlinedPages, [2]);
  assert.deepEqual(read.extraction?.outlinedTextPages, [2]);
  assert.ok(read.extraction?.visionSkipped?.some((s) => s.page === 2 && /text drawn as outlines/.test(s.reason)));
  assert.match(read.extraction?.notes ?? "", /Plan-set page 2 unread: text drawn as outlines; a person reads this page/);
});
await check("C3 a text set with an outlined page: the text parser reads the rest, the page is named, no model call here", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await outlinedPlanSet(["text", "outlined", "text", "text"]));
  assert.equal(read.mode, "text");
  assert.deepEqual(read.outlinedPages, [2]);
  assert.equal(llm.total, 0);
});
await check("C4 MUST-PASS (pinned): a normal text set reads exactly as before — mode text, no outlined pages, no model call", async () => {
  const llm = fakeLlm();
  const read = await scan.readPlanSetForExtraction(llm as never, await outlinedPlanSet(["text", "text", "text"]));
  assert.equal(read.mode, "text");
  assert.equal(read.outlinedPages, undefined);
  assert.equal(llm.total, 0);
});
await check("C5 the hybrid merge carries the image read's outlined pages through (validated) and leaves a read without them untouched", () => {
  const textRead = { provider: "claude" as const, fields: { dcKw: { value: 6.4, confidence: 0.9 } }, lowConfidenceFields: [], notes: "text" };
  const merged = scan.mergeImagePageRead(textRead, { fields: {}, visionPages: [], outlinedTextPages: [4, "x", -1, 2, 2.5] });
  assert.deepEqual(merged.outlinedTextPages, [2, 4]);
  assert.equal(scan.mergeImagePageRead(textRead, { fields: {}, visionPages: [] }), textRead);
});

console.log("\nD. THE SPLITTER");
const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument, shippedPlanSetOutlinedPages } = await import("../src/projectDocuments");
const { buildUtilityPackage, reconcileSplitParts, CATEGORY_PATTERNS } = await import("../src/docSplitter");
const db = await openDatabase();
let n = 0;
const projectWith = async (bytes: Uint8Array) => {
  const p = createProject(db, {
    owner: `Outline Owner ${++n}`, street: `${n} Outline Way`, city: "Fixtureville", state: "NM", zip: "87031",
    ahj: "Village of Fixture", utility: "Synthetic Power", dcKw: "6.4",
  }).project;
  saveProjectDocument(db, p.id, { docType: "plan_set", filename: `outlined-${n}.pdf`, contentType: "application/pdf", buffer: Buffer.from(bytes), source: "upload" });
  return p.id;
};
// 1: a real SLD sheet, 2: an outlined site plan whose only real text is "PV 1.0", 3: a plain outlined sheet.
const SPLIT_SET = async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.load(await outlinedPlanSet(["text", "outlined-stray", "outlined"]));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(0).drawText("SHEET NAME: SINGLE LINE DIAGRAM  SHEET NUMBER E 1.1", { x: 40, y: 60, size: 10, font });
  return doc.save();
};
const pidSplit = await projectWith(await SPLIT_SET());
const pkg = await buildUtilityPackage(db, pidSplit, "all");
await check("D1 MUST-EXCLUDE: an outlined page is unclassified — the stray \"PV 1.0\" no longer files it as the site plan", () => {
  assert.ok(!pkg.parts.some((p) => p.docType === "site_plan"), JSON.stringify(pkg.parts.map((p) => [p.docType, p.pages])));
  for (const p of pkg.parts) assert.ok(!p.pages.includes(2) && !p.pages.includes(3), `${p.docType} holds an outlined page`);
  assert.ok(pkg.unclassifiedPages.includes(2) && pkg.unclassifiedPages.includes(3));
});
await check("D2 the split names the outlined pages", () => {
  assert.deepEqual(pkg.outlinedTextPages, [2, 3]);
});
await check("D3 MUST-PASS (pinned): the normal text sheet is still filed as before (the SLD)", () => {
  assert.deepEqual(pkg.parts.find((p) => p.docType === "sld")?.pages, [1]);
});
await check("D4 the split stores the shipped plan set's unread pages, and reconcile names them too", async () => {
  assert.deepEqual(shippedPlanSetOutlinedPages(db, pidSplit), [2, 3]);
  assert.deepEqual((await reconcileSplitParts(db, pidSplit)).outlinedTextPages, [2, 3]);
});
await check("D5 an upload is checked in the background with its text: the column lands without a split", async () => {
  const pid = await projectWith(await outlinedPlanSet(["text", "outlined"]));
  const deadline = Date.now() + 20_000;
  let pages: number[] = [];
  while (Date.now() < deadline) {
    pages = shippedPlanSetOutlinedPages(db, pid);
    if (pages.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(pages, [2]);
});
let pidPlain = "";
await check("D6 a normal text plan set stores none", async () => {
  pidPlain = await projectWith(await outlinedPlanSet(["text", "text"]));
  await buildUtilityPackage(db, pidPlain, "all");
  assert.deepEqual(shippedPlanSetOutlinedPages(db, pidPlain), []);
});

console.log("\nE. QC AND THE SUBMIT GATE NAME THE UNREAD PAGES");
const { runQcForProject } = await import("../src/qc");
const { owedDocumentAction } = await import("../src/requiredDocuments");
await check("E1 QC writes one row listing the unread pages", () => {
  runQcForProject(db, pidSplit);
  const rows = db.query<{ message: string; qc_status: string }>("SELECT message, qc_status FROM qc_results WHERE project_id = ? AND rule_id = 'docs.plan_set_unread_pages'", [pidSplit]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qc_status, "warning");
  assert.match(rows[0].message, /Plan-set pages 2, 3 unread: text drawn as outlines; a person reads this page\. Nothing on them was sent to any model\./);
});
await check("E2 QC's \"not attached\" row for a missing plan sheet names the unread pages", () => {
  const rows = db.query<{ rule_id: string; message: string }>("SELECT rule_id, message FROM qc_results WHERE project_id = ? AND rule_id LIKE 'docs.%' AND message LIKE '%is not attached%'", [pidSplit]);
  const sheetRows = rows.filter((r) => ot.PLAN_SHEET_DOC_TYPES.has(r.rule_id.replace(/^docs\./, "")));
  assert.ok(sheetRows.length > 0, `no missing plan-sheet row to check: ${rows.map((r) => r.rule_id).join(",")}`);
  for (const r of sheetRows) assert.match(r.message, /plan-set pages 2, 3 are unread \(text drawn as outlines\)/, r.rule_id);
  for (const r of rows.filter((x) => !ot.PLAN_SHEET_DOC_TYPES.has(x.rule_id.replace(/^docs\./, "")))) assert.doesNotMatch(r.message, /text drawn as outlines/, r.rule_id);
});
await check("E3 MUST-PASS (pinned): a set with no unread page gets no such row", () => {
  assert.ok(pidPlain);
  runQcForProject(db, pidPlain);
  assert.equal(db.query("SELECT 1 FROM qc_results WHERE project_id = ? AND rule_id = 'docs.plan_set_unread_pages'", [pidPlain]).length, 0);
  const anyNote = db.query<{ message: string }>("SELECT message FROM qc_results WHERE project_id = ?", [pidPlain]).some((r) => /text drawn as outlines/.test(r.message));
  assert.equal(anyNote, false);
});
await check("E4 the gate's words: a missing plan sheet names the unread pages; a form row and a set with none do not change", () => {
  assert.equal(owedDocumentAction({ docType: "site_plan", lane: "permit" } as never), "attach it or split it out of the plan set");
  assert.equal(owedDocumentAction({ docType: "site_plan", lane: "permit" } as never, [], [4]),
    "attach it or split it out of the plan set; plan-set page 4 is unread (text drawn as outlines), so a person checks whether it is that page and splits it out by hand");
  assert.equal(owedDocumentAction({ docType: "meter_photo", lane: "nem" } as never, [], [4]), "attach it or split it out of the plan set");
  assert.match(owedDocumentAction({ docType: "permit_application", lane: "permit" } as never, [], [4]), /^find the official form/);
});
await check("E5 the submit gate report's next action names the unread pages for a missing plan sheet", async () => {
  const { getSubmitGateReport } = await import("../src/repository");
  const report = getSubmitGateReport(db, pidSplit) as unknown as { checks?: Array<{ id: string; nextAction?: string }> };
  const docs = JSON.stringify(report);
  assert.match(docs, /plan-set pages 2, 3 are unread \(text drawn as outlines\)/);
});

console.log("\nG. THE PARSER REVIEW NAMES THE PAGES");
const { REPO } = await import("./_isolate");
await check("G1 the plan-scan route names the pages on a plain text set's 409, and the parser page flags them from every answer", () => {
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  const server = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
  assert.match(server, /throw new HttpError\(409, `This plan set has a text layer[^\n]*read\.outlinedPages\?\.length \? \{ outlinedTextPages: read\.outlinedPages \} : \{\}\)/);
  // both plan-scan answers (the scan's and the text set's) are read for the pages, before any status check
  assert.equal((html.match(/const v = await resp\.json\(\)\.catch\(\(\) => \(\{\}\)\);\n\s*noteOutlined\(v\);/g) ?? []).length, 2);
  assert.match(html, /v\.details && Array\.isArray\(v\.details\.outlinedTextPages\)/);
  assert.match(html, /unread: text drawn as outlines; a person reads this page\. Nothing on \$\{[^}]*\} was sent to any model/);
});

console.log("\nF. ONE DEFINITION");
await check("F1 the text and raster bars equal scannedPlanSet's", () => {
  assert.equal(scan.MIN_RASTER_PIXELS, ot.OUTLINED_MAX_RASTER_PIXELS);
  assert.equal(scan.planTextIsNearEmpty("x".repeat(ot.OUTLINED_MAX_TEXT_CHARS - 1), 1), true);
  assert.equal(scan.planTextIsNearEmpty("x".repeat(ot.OUTLINED_MAX_TEXT_CHARS), 1), false);
});
await check("F2 the plan-sheet types equal the splitter's categories", () => {
  assert.deepEqual([...ot.PLAN_SHEET_DOC_TYPES].sort(), [...new Set(CATEGORY_PATTERNS.map((c) => c.docType))].sort());
});

console.log(failures ? `\n${failures} outlinedTextPages check(s) FAILED (${passed} passed).` : `\nAll ${passed} outlinedTextPages checks passed.`);
process.exit(failures ? 1 : 0);
