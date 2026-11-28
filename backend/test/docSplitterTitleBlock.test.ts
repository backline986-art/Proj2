// WHAT A TITLE BLOCK PRINTS BESIDE THE SHEET NUMBER (audit 2026-11-28). Two findings, one title block:
//
// 1. THE PAPER SIZE IS NOT A SHEET NUMBER. A title block that prints its sheet size on every page
//    ("Sheet Size  Sheet Number  ANSI B 11" X 17"  DS 01  Sheet Name") gave the index reader two
//    more "sheet numbers" (B 11 and X 17) on every page, the cover included. With three listed
//    numbers on a page and a mixed-case label the reader did not know, no page had a sheet number,
//    so a data sheet the cover's index names was never reported undecided and never put to the
//    page-index read.
// 2. A PLACARD SHEET WITH AN ELECTRICAL SHEET NUMBER. On an E x.x sheet a category's `words` do not
//    count (they are words the sheet uses), and PLACARD is one. So a sheet whose own NAME is PLACARD,
//    numbered E 1.4, scored nothing and was left out of the labels part. The cover's index names the
//    sheet, and that name counts.
// Pins both ways (MUST-PASS and MUST-EXCLUDE), on the pure readers and through buildUtilityPackage,
// and that frontend/parser-review.js (the parser page's copy) gives the same answers.
// Synthetic data only. Run: tsx backend/test/docSplitterTitleBlock.test.ts
import { REPO } from "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-title-block-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage, indexSpecSheets, isUndecidedSpecPage, scorePage } = await import("../src/docSplitter");

const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8"), sandbox, { filename: "parser-review.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PR = sandbox.window.ParserReview as any;

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const json = (v: unknown) => JSON.stringify(v);

// The title block as the text layer joins it: the label row, then the value row.
const block = (sheet: string, size = 'ANSI B 11" X 17"') => `ZZFIXTURE SOLAR CO 100 TEST ST Sheet Size Sheet Number ${size} ${sheet} Sheet Name ZZFIXTURE SOLAR CO`;
const INDEX_ROWS = "SHEET INDEX CS 01: COVER SHEET PV 1.0: SITE PLAN E 1.1: ELECTRICAL LINE DIAGRAM E 1.2: ELECTRICAL NOTES E 1.4: PLACARD DS 01: EQUIPMENT DATA SHEET DS 02: RACKING DATA SHEET";
const cover = (size?: string) => `${INDEX_ROWS} ${block("CS 01", size)}`;
const SIZES = ['ANSI B 11" X 17"', "ANSI B 11 X 17", 'ARCH D 24" x 36"', "ARCH D 24 X 36", '11" X 17"', "11″ × 17″", '22" X 34"'];

// ---------------------------------------------------------------------------
console.log("\n1. THE PAPER SIZE IS NOT A SHEET NUMBER");
for (const size of SIZES) {
  const index = indexSpecSheets([cover(size)]);
  const listed = [...index.listed].sort();
  run(`MUST-EXCLUDE: ${size} lists no sheet number`, json(listed) === json(["CS01", "DS01", "DS02", "E1.1", "E1.2", "E1.4", "PV1.0"]), json(listed));
  run("…and the index still names its two data sheets", json([...index.spec].sort()) === json(["DS01", "DS02"]), json([...index.spec]));
  const page = block("DS 01", size);
  run("MUST-PASS: the data sheet the index names is reported undecided", isUndecidedSpecPage(page, scorePage(page), index) === true);
  const other = block("PV 1.0", size);
  run("MUST-EXCLUDE: a page the index does not name a data sheet is not", isUndecidedSpecPage(other, scorePage(other), index) === false);
  const fe = PR.indexSpecSheets([cover(size)]);
  run("the parser page's copy lists the same numbers", json([...fe.listed].sort()) === json(listed) && json([...fe.spec].sort()) === json([...index.spec].sort()), json([...fe.listed].sort()));
  run("…and reports the same page undecided", PR.isUndecidedSpecPage(page, PR.scoreSplitPage(page), fe) === true && PR.isUndecidedSpecPage(other, PR.scoreSplitPage(other), fe) === false);
}
{
  const index = indexSpecSheets([cover()]);
  // The labelled number is the page's own, whatever else the page cites.
  const cites = `${block("PV 1.0")} SEE DS 01 FOR MODULE DATA`;
  run("MUST-EXCLUDE: a page that only cites a data sheet's number is not that sheet", isUndecidedSpecPage(cites, scorePage(cites), index) === false);
  const citing = `${block("DS 02")} SEE PV 1.0`;
  run("MUST-PASS: a labelled data sheet that cites another sheet is still itself", isUndecidedSpecPage(citing, scorePage(citing), index) === true);
  run("the parser page's copy agrees on both", PR.isUndecidedSpecPage(cites, PR.scoreSplitPage(cites), PR.indexSpecSheets([cover()])) === false
    && PR.isUndecidedSpecPage(citing, PR.scoreSplitPage(citing), PR.indexSpecSheets([cover()])) === true);
  // Real sheet numbers that merely look near a size are kept.
  const plain = indexSpecSheets(["SHEET INDEX A 1 COVER B 2 SITE PLAN X 3 SPEC SHEET D 4 DATA SHEET"]);
  run("MUST-PASS: single-letter sheet numbers are still sheet numbers", json([...plain.listed].sort()) === json(["A1", "B2", "D4", "X3"]) && json([...plain.spec].sort()) === json(["D4", "X3"]), json([[...plain.listed], [...plain.spec]]));
  const quoted = indexSpecSheets(['SHEET INDEX "S-1" SPEC SHEET "S-2" CUT SHEET PV-1 SITE PLAN']);
  run("MUST-PASS: a sheet number in quotes is not a size in inches", json([...quoted.listed].sort()) === json(["PV1", "S1", "S2"]) && json([...quoted.spec].sort()) === json(["S1", "S2"]), json([...quoted.listed]));
  const upper = "SHEET NUMBER: DS 01 SEE DS 02";
  run("the upper-case label reads as before", isUndecidedSpecPage(upper, scorePage(upper), index) === true);
}

// ---------------------------------------------------------------------------
console.log("\n2. A PLACARD SHEET WITH AN ELECTRICAL SHEET NUMBER");
{
  const index = indexSpecSheets([cover()]);
  const name = (text: string) => index.names.get(PR.pageSheetNumber(text, index.listed) ?? "") ?? "";
  const placard = `${block("E 1.4")} PV ARRAY MAIN SERVICE PANEL UTILITY METER AC DISCONNECT`;
  run("the index names the sheet", index.names.get("E1.4") === ": PLACARD", json([...index.names]));
  run("without its name the sheet scores nothing (the #33 rule)", json(scorePage(placard).docTypes) === "[]", json(scorePage(placard)));
  run("MUST-PASS: named PLACARD by the index, it is a labels sheet", json(scorePage(placard, name(placard)).docTypes) === json(["labels"]), json(scorePage(placard, name(placard))));
  const notes = `${block("E 1.2")} ELECTRICAL NOTES PROVIDE PLACARD AT SERVICE STRUCTURAL NOTES RAFTER SPACING`;
  run("MUST-EXCLUDE: an electrical notes sheet that says PROVIDE PLACARD is not", json(scorePage(notes, name(notes)).docTypes) === "[]", json(scorePage(notes, name(notes))));
  const sld = `${block("E 1.1")} ELECTRICAL LINE DIAGRAM PLACARD AT METER`;
  run("MUST-EXCLUDE: an SLD that mentions a placard stays the SLD", json(scorePage(sld, name(sld)).docTypes) === json(["sld"]), json(scorePage(sld, name(sld))));
  run("a name that is a NOTES name does not count", json(scorePage(placard, "PLACARD NOTES AND GENERAL NOTES").docTypes) === "[]");
  const fe = PR.indexSpecSheets([cover()]);
  for (const t of [placard, notes, sld]) {
    const feName = fe.names.get(PR.pageSheetNumber(t, fe.listed) || "") || "";
    run("the parser page's copy scores the same", json(PR.scoreSplitPage(t, feName)) === json(scorePage(t, name(t))), `${json(PR.scoreSplitPage(t, feName))} vs ${json(scorePage(t, name(t)))}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n3. THROUGH THE SPLIT");
{
  type Sheet = { lines: string[]; image?: boolean };
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheets: Sheet[] = [
    { lines: ["SHEET INDEX", "CS 01: COVER SHEET", "PV 1.0: SITE PLAN", "E 1.1: ELECTRICAL LINE DIAGRAM", "E 1.4: PLACARD", "DS 01: EQUIPMENT DATA SHEET", "DS 02: RACKING DATA SHEET",
      "Sheet Size Sheet Number", 'ANSI B 11" X 17" CS 01', "Sheet Name"] },
    { lines: ["Sheet Size Sheet Number", 'ANSI B 11" X 17" PV 1.0', "Sheet Name", "SITE PLAN", "FIRE ACCESS PATHWAYS"] },
    { lines: ["Sheet Size Sheet Number", 'ANSI B 11" X 17" E 1.1', "Sheet Name", "ELECTRICAL LINE DIAGRAM"] },
    { lines: ["Sheet Size Sheet Number", 'ANSI B 11" X 17" E 1.4', "Sheet Name", "PV ARRAY", "MAIN SERVICE PANEL", "AC DISCONNECT"] },
    { lines: ["Sheet Size Sheet Number", 'ANSI B 11" X 17" DS 01', "Sheet Name"], image: true },
    { lines: ["Sheet Size Sheet Number", 'ANSI B 11" X 17" DS 02', "Sheet Name"], image: true },
  ];
  for (const s of sheets) {
    const page = pdf.addPage([1224, 792]);
    if (s.image) page.drawRectangle({ x: 40, y: 120, width: 760, height: 620, color: rgb(0.85, 0.85, 0.85) });
    s.lines.forEach((line, i) => page.drawText(line, { x: 820, y: 740 - i * 20, size: 8, font }));
  }
  const p = createProject(db, { owner: "Fixture Owner", street: "100 Test St", city: "Testville", state: "ZZ", zip: "00001", ahj: "City of Testville", utility: "Testville Power", dcKw: "8" } as never).project;
  saveProjectDocument(db, p.id, { docType: "plan_set", filename: "zzfixture-plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from(await pdf.save()), source: "upload" });
  const shown: number[][] = [];
  const llm = {
    async classifyPlanPages(input: { pageImages: Array<{ page: number; base64: string; mimeType: string }> }) {
      shown.push(input.pageImages.map((x) => x.page));
      return { pages: input.pageImages.map((x) => ({ page: x.page, sheet: "", title: "DATA SHEET", kind: x.page === 5 ? "module_spec" : "racking_spec" })) };
    },
  };
  const result = await buildUtilityPackage(db, p.id, "all", { llm });
  const parts = json(result.parts.map((x) => [x.docType, x.pages]));
  run("MUST-PASS: the two index-named data sheets are put to the page-index read", json(shown) === "[[5,6]]", json(shown));
  run("…and the module data sheet is filed", json(result.parts.find((x) => x.docType === "module_spec")?.pages) === "[5]", parts);
  run("MUST-PASS: the E-numbered placard sheet is in the labels part", json(result.parts.find((x) => x.docType === "labels")?.pages) === "[4]", parts);
  run("MUST-EXCLUDE: the SLD and site plan are filed as themselves", json(result.parts.find((x) => x.docType === "sld")?.pages) === "[3]" && json(result.parts.find((x) => x.docType === "site_plan")?.pages) === "[2]", parts);
}

if (failures > 0) {
  console.error(`\n${failures} title-block splitter check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll title-block splitter checks passed.");
