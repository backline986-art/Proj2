// THE PLAN SET IS READ ONCE PER PAGE, AND THE MIDDLE SHEETS SURVIVE THE 80k BOUND (#697).
//
// The parser page posted every PDF page twice (a layout-ordered copy, then the raw item order of
// the same words) and the backend cut the plan text at 80,000 characters (first 60k, last 20k), so
// about 40k characters of unique sheet text reached the model and the middle sheets (three-line
// diagram, structural notes) were dropped. Pins:
//   - MIRROR: the page's textOncePerPage (frontend/parser-review.js) answers exactly what
//     shared/src/planText.ts answers, on every case below;
//   - the page's reader is unchanged: parser-review.js pdfPageText gives byte-for-byte the text
//     the old inline parser.html code gave, on three synthetic plan sets read by real pdf.js;
//   - POSTED ONCE: on a two-page set every page's words appear once in what is posted, and the
//     posted text holds no word the page's own text does not (rule 2: nothing new reaches a model);
//   - the backend collapses a doubled page (a tab opened before this change): the prompt it builds
//     from the doubled text is the prompt it builds from the single copy;
//   - over the bound, WHOLE pages are dropped from the middle, the marker names them, the
//     response names them (planTextPagesNotRead), and the three-line sheet in the middle of a
//     14-sheet doubled set is read (it was cut before);
//   - TOKEN PIN: the extraction prompt's user half for the two design-platform fixtures is at or
//     below 55% of what it was before this change (measured on staging c5410bbd);
//   - FIXTURE RESULTS: the deterministic readers (structural intake, packet application, AC
//     disconnect) return the same fields from the single copy as from the doubled text.
// No real model (askLong is stubbed and captures the prompt). Synthetic data only.
// Run: tsx backend/test/planTextOnce.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { REPO } from "./_isolate";
import { platformAPlanSet, platformBPlanSet, wrapLayoutPlanSet } from "./_planSetPlatforms";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-text-once-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { textOncePerPage, planTextWindow, collapseDoubledPage, PLAN_TEXT_CHAR_LIMIT } = await import("../../shared/src/planText");
const { planTextForExtraction } = await import("../src/structuralIntake");
const { pdfjsDocumentOptions } = await import("../src/pdfjsOptions");
const { ClaudeLLMProvider } = await import("../src/llm");
const { extractParserFields } = await import("../src/parserExtraction");
const { openDatabase } = await import("../src/db");
const db = await openDatabase();

const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8"), sandbox, { filename: "parser-review.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PR = sandbox.window.ParserReview as any;

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` ${detail}` : ""}`); }
};
const words = (s: string) => s.split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------------------------
// The parser page's reader BEFORE this change, copied verbatim from parser.html (staging c5410bbd)
// so the move into parser-review.js is pinned byte-for-byte.
// ---------------------------------------------------------------------------------------------
function oldNormalizeText(raw = "") {
  return String(raw || "")
    .replace(/–|—|−/g, "-")
    .replace(/ /g, " ")
    .replace(/[|]/g, "1")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function oldPdfItemsToLayoutText(items: any[]) {
  const mapped = (items || [])
    .map((item) => {
      const tx = item.transform || [1, 0, 0, 1, 0, 0];
      return { str: String(item.str || "").trim(), x: Number(tx[4] || 0), y: Number(tx[5] || 0) };
    })
    .filter((item) => item.str);
  if (!mapped.length) return "";
  mapped.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 3) return b.y - a.y;
    return a.x - b.x;
  });
  const lines: Array<{ y: number; items: typeof mapped }> = [];
  for (const item of mapped) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - item.y) > 3) lines.push({ y: item.y, items: [item] });
    else last.items.push(item);
  }
  return lines.map((line) => line.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ")).join("\n");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oldPageText = (items: any[]) => {
  const linear = items.map((item) => item.str || "").join(" ");
  return oldNormalizeText(`${oldPdfItemsToLayoutText(items)}\n\n${linear}`);
};

// parser.html keeps its own normalizeText (other suites eval it out of the page); the copy in
// parser-review.js that pdfPageText uses must answer the same.
{
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  const src = /function normalizeText\(raw=''\)\{[\s\S]*?\n\}/.exec(html)?.[0] ?? "";
  const pageNormalize = vm.runInNewContext(`(${src.replace("function normalizeText", "function")})`) as (s: string) => string;
  const samples = ["a\u2013b\u2014c\u2212d", "x\u00a0y | z", "\u201cq\u201d \u2018s\u2019", "a \t  b\n\n\n\nc", ""];
  run("parser.html's normalizeText and parser-review.js's copy agree", Boolean(src) && samples.every((t) => pageNormalize(t) === PR.normalizeText(t) && pageNormalize(t) === oldNormalizeText(t)));
}

// Real pdf.js on a synthetic PDF, as the page's extractPdfText walks it.
const pdfjsReq = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
pdfjs.GlobalWorkerOptions.workerSrc = `file://${pdfjsReq.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pageItems(bytes: Uint8Array): Promise<any[][]> {
  const doc = await pdfjs.getDocument(pdfjsDocumentOptions({ data: new Uint8Array(bytes), useSystemFonts: true, disableWorker: true })).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) out.push((await (await doc.getPage(p)).getTextContent()).items);
  return out;
}
// The page's planDoc.text: "--- PAGE n ---" + the page text, pages joined by a blank line.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const planDocText = (pages: any[][], pageText: (items: any[]) => string) =>
  pages.map((items, i) => `--- PAGE ${i + 1} ---\n${pageText(items)}`).join("\n\n");

// The extraction prompt, captured from the real extractProjectFields with askLong stubbed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const provider = new ClaudeLLMProvider("sk-ant-test-key-not-used") as any;
let capturedUser = "";
provider.askLong = async (_label: string, _system: string, user: string) => {
  capturedUser = user;
  return JSON.stringify({ fields: {}, lowConfidenceFields: [], notes: "" });
};
async function promptFor(planText: string): Promise<string> {
  capturedUser = "";
  await provider.extractProjectFields({ planText });
  return capturedUser;
}
const fieldValues = (r: { fields: Record<string, { value: unknown }> }) =>
  JSON.stringify(Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v.value]).sort()));

// ---------------------------------------------------------------------------------------------
// 1. MIRROR — the browser copy answers what the shared rule answers.
// ---------------------------------------------------------------------------------------------
{
  const cases = [
    "",
    "no markers at all",
    "SHEET A\nSIZE 10\n\nSHEET A SIZE 10",
    "--- PAGE 1 ---\nPV-1 COVER\nSIZE 8.4 KW\n\nPV-1 COVER SIZE 8.4 KW\n\n--- PAGE 2 ---\nPV-2 SITE\n\nPV-2 SITE",
    "--- PAGE 1 ---\nNOTE ONE\n\nNOTE TWO\n\n--- PAGE 2 ---\nX Y\n\nY X",
    "--- PAGE 1 ---\nA B C\n\nA B\n\n--- OCR PAGE 2 ---\nscan words\n",
    "preamble\n--- PAGE 3 ---\nROOF 2X6\n \nROOF 2X6\n",
    "--- PAGE 1 ---\nMODULES 21\n\nMODULES 22",
    "--- PAGE 1 ---\n\n\n",
  ];
  for (const c of cases) run(`mirror: textOncePerPage agrees (${JSON.stringify(c).slice(0, 48)})`, PR.textOncePerPage(c) === textOncePerPage(c), `browser ${JSON.stringify(PR.textOncePerPage(c))} vs shared ${JSON.stringify(textOncePerPage(c))}`);
  run("a doubled page keeps its first (layout) copy", collapseDoubledPage("\nPV-1 COVER\nSIZE 8.4 KW\n\nPV-1 COVER SIZE 8.4 KW\n\n") === "\nPV-1 COVER\nSIZE 8.4 KW\n\n");
  run("two different paragraphs are not a doubled page", textOncePerPage(cases[4]).includes("NOTE ONE") && textOncePerPage(cases[4]).includes("NOTE TWO"));
  run("halves that differ by one word are kept whole", textOncePerPage(cases[7]) === cases[7]);
}

// ---------------------------------------------------------------------------------------------
// 2. The page's reader did not move; what it POSTS is one copy per page (three plan sets).
// ---------------------------------------------------------------------------------------------
const FIXTURES: Array<[string, () => Promise<Buffer>]> = [["platform A", platformAPlanSet], ["platform B", platformBPlanSet], ["wrap layouts", wrapLayoutPlanSet]];
const fixtureTexts: Record<string, { doubled: string; once: string }> = {};
for (const [name, make] of FIXTURES) {
  const pages = await pageItems(await make());
  const doubled = planDocText(pages, PR.pdfPageText);
  run(`${name}: the page's text is byte-for-byte what parser.html read before`, doubled === planDocText(pages, oldPageText));
  const once = PR.textOncePerPage(doubled);
  fixtureTexts[name] = { doubled, once };
  const layoutOnly = planDocText(pages, (items) => oldNormalizeText(oldPdfItemsToLayoutText(items)));
  run(`${name}: the posted text is each page's layout copy, once`, once.replace(/\s+$/, "") === layoutOnly.replace(/\s+$/, ""), `posted ${once.length} chars, layout ${layoutOnly.length}`);
  run(`${name}: the posted text is about half (${once.length} of ${doubled.length} chars)`, once.length <= doubled.length * 0.55);
  // Rule 2: the single copy is a sub-multiset of the page's words — nothing new goes to the model.
  const pool = new Map<string, number>();
  for (const w of words(doubled)) pool.set(w, (pool.get(w) ?? 0) + 1);
  run(`${name}: nothing posted that the page's own text did not hold`, words(once).every((w) => { const n = pool.get(w) ?? 0; pool.set(w, n - 1); return n > 0; }));
}

// A two-page set: each page's words appear ONCE in what is posted.
{
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([792, 612]);
  p1.drawText("PV-1 COVER SHEET", { x: 36, y: 570, size: 14, font });
  p1.drawText("SYSTEM SIZE 6.40 KW DC", { x: 36, y: 540, size: 9, font });
  p1.drawText("CONTRACTOR", { x: 500, y: 56, size: 7, font });
  p1.drawText("EXAMPLE SOLAR (FICTITIOUS)", { x: 500, y: 44, size: 7, font });
  const p2 = pdf.addPage([792, 612]);
  p2.drawText("PV-2 THREE-LINE DIAGRAM", { x: 36, y: 570, size: 14, font });
  p2.drawText("ZEBRAFENCE 40A PV BREAKER", { x: 36, y: 540, size: 9, font });
  const pages = await pageItems(await pdf.save());
  const doubled = planDocText(pages, PR.pdfPageText);
  const posted = PR.textOncePerPage(doubled);
  const count = (s: string, w: string) => s.split(w).length - 1;
  run("two-page set: the page's own text carries each word twice (layout + item order)", count(doubled, "ZEBRAFENCE") === 2 && count(doubled, "SIZE") === 2);
  run("two-page set: posted once (each page's words once, both page markers kept)", count(posted, "ZEBRAFENCE") === 1 && count(posted, "SIZE") === 1 && count(posted, "--- PAGE ") === 2, JSON.stringify(posted));
}

// ---------------------------------------------------------------------------------------------
// 3. The backend collapses a doubled page itself (a tab opened before this change).
// ---------------------------------------------------------------------------------------------
for (const [name] of FIXTURES) {
  const { doubled, once } = fixtureTexts[name];
  const fromDoubled = await promptFor(doubled);
  const fromOnce = await promptFor(once);
  run(`${name}: the prompt built from the doubled text is the prompt built from the single copy`, fromDoubled === fromOnce && fromOnce.length > 0);
}

// ---------------------------------------------------------------------------------------------
// 4. Over the bound: whole pages from the middle, named, and the middle sheet is read.
// ---------------------------------------------------------------------------------------------
{
  // 14 sheets of ~6.5k characters of single-copy text each (~91k: the size the roadmap's probe
  // measured for a real 7-sheet set posted doubled), posted DOUBLED the way the old page did.
  const sheetTitles = ["COVER SHEET", "SITE PLAN", "ROOF PLAN", "ATTACHMENT DETAIL", "STRUCTURAL CALCS", "STRUCTURAL NOTES", "THREE-LINE DIAGRAM",
    "ELECTRICAL CALCS", "WIRE SCHEDULE", "WARNING LABELS", "PLACARD", "MODULE SPEC SHEET", "MICROINVERTER SPEC SHEET", "RACKING SPEC SHEET"];
  const sheetBody = (n: number) => {
    const lines = [`PV-${n} ${sheetTitles[n - 1]}`, n === 7 ? "SHEET7MARK 705.12 200A BUS 175A MAIN 40A PV BREAKER" : `SHEET${n}MARK`];
    while (lines.join("\n").length < 6400) lines.push(`NOTE ${lines.length}: SYNTHETIC SHEET ${n} GENERAL NOTE TEXT FOR THE BOUND TEST, NOT A REAL PROJECT.`);
    return lines.join("\n");
  };
  const doubledSet = Array.from({ length: 14 }, (_, i) => {
    const layout = sheetBody(i + 1);
    return `--- PAGE ${i + 1} ---\n${layout}\n\n${layout.replace(/\n/g, " ")}`;
  }).join("\n\n");
  const single = textOncePerPage(doubledSet);
  run(`bound: the doubled set is over the bound (${doubledSet.length}), and so is one copy (${single.length})`, doubledSet.length > 2 * PLAN_TEXT_CHAR_LIMIT && single.length > PLAN_TEXT_CHAR_LIMIT);

  // What main read: the doubled text through the old character cut.
  const oldCut = doubledSet.slice(0, 60000) + "\n[Middle text omitted]\n" + doubledSet.slice(-20000);
  run("bound (before): the old cut lost the three-line sheet in the middle", !oldCut.includes("SHEET7MARK"));

  const prompt = planTextForExtraction(doubledSet);
  const win = planTextWindow(single);
  run(`bound: the prompt's plan text stays within ${PLAN_TEXT_CHAR_LIMIT} characters (${prompt.length})`, prompt.length <= PLAN_TEXT_CHAR_LIMIT);
  run("bound: the three-line sheet in the middle is read now", prompt.includes("SHEET7MARK 705.12 200A BUS"));
  run(`bound: whole pages are dropped from the middle (${win.omittedPages.join(", ")})`, win.omittedPages.length > 0 && win.omittedPages[0] > 1 && win.omittedPages[win.omittedPages.length - 1] < 14
    && win.omittedPages.every((p, i, a) => i === 0 || p === a[i - 1] + 1));
  const kept = Array.from({ length: 14 }, (_, i) => i + 1).filter((p) => !win.omittedPages.includes(p));
  run("bound: every kept page is there whole, never cut mid-page", kept.every((p) => prompt.includes(`--- PAGE ${p} ---\n${sheetBody(p)}`)));
  run("bound: no omitted page leaks a fragment", win.omittedPages.every((p) => !prompt.includes(`SHEET${p}MARK`)));
  const label = win.omittedPages.length === 1 ? `page ${win.omittedPages[0]}` : `pages ${win.omittedPages[0]}-${win.omittedPages[win.omittedPages.length - 1]}`;
  run(`bound: the marker names the omitted pages ("${label} not read")`, prompt.includes(`[Plan text omitted: ${label} not read`));

  const r = await extractParserFields(db, provider, { planText: doubledSet }, null);
  run("bound: the parser response names the pages not read", JSON.stringify(r.planTextPagesNotRead) === JSON.stringify(win.omittedPages), JSON.stringify(r.planTextPagesNotRead));
  run("bound: the prompt the model was given is that same window", capturedUser.includes(prompt));
  const small = await extractParserFields(db, provider, { planText: fixtureTexts["platform A"].doubled }, null);
  run("under the bound: no pages-not-read on the response", small.planTextPagesNotRead === undefined);
  run("no page markers: the old character cut still bounds the text", planTextForExtraction("x ".repeat(60000)).length <= PLAN_TEXT_CHAR_LIMIT + 120);
}

// ---------------------------------------------------------------------------------------------
// 5. TOKEN PIN and FIXTURE RESULTS.
// ---------------------------------------------------------------------------------------------
{
  // The extraction prompt's user half for these fixtures, as the parser page posted them before this
  // change (measured on Helm staging c5410bbd with this file's fixtures: the doubled page text
  // through the real extractProjectFields). The user half is the plan text plus fixed framing, so
  // tokens move with characters; the pin holds the saving, not just asserts it.
  const BEFORE_USER_CHARS: Record<string, number> = { "platform A": 5824, "platform B": 5760 };
  for (const name of Object.keys(BEFORE_USER_CHARS)) {
    const now = await promptFor(PR.textOncePerPage(fixtureTexts[name].doubled));
    const before = BEFORE_USER_CHARS[name];
    run(`TOKEN PIN ${name}: the extraction prompt's user half is at or below 55% of before (${now.length} of ${before} chars, ~${Math.ceil(now.length / 4)} of ~${Math.ceil(before / 4)} tokens)`, now.length <= before * 0.55);
  }
  for (const [name] of FIXTURES) {
    const { doubled, once } = fixtureTexts[name];
    const a = await extractParserFields(db, provider, { planText: doubled }, null);
    const b = await extractParserFields(db, provider, { planText: once }, null);
    run(`${name}: the deterministic readers return the same fields from one copy (${fieldValues(b)})`, fieldValues(a) === fieldValues(b) && Object.keys(b.fields).length > 0);
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nplanTextOnce: all checks passed");
process.exit(0);
