// A PAGE'S TEXT IN READING ORDER, AT ANY ROTATION, AT BOTH DOORS (intake audit 2026-11-28).
//
// A generated corpus: the same four-row schedule drawn COLUMN BY COLUMN (every label, then every
// value — the order a drawing tool may well write a table in) on a page stored at /Rotate 0, 90,
// 180 and 270, each displayed upright. Read with the real pdf.js.
//   MUST PASS — every row reads as one line at every rotation, through the server's reader
//               (extractPdfLayoutText) and through placeIntakeJob (what the model is handed);
//             — the browser copy (frontend/parser-review.js) and shared/src/pageTextLayout.ts
//               give the same text on the whole corpus (the mirror pin);
//             — an unrotated page of upright text reads exactly as it did before the change;
//             — a sideways label is laid out in its own frame, not scattered through the rows;
//             — pages past the door's page cap are NAMED as not read.
//   MUST FAIL WITHOUT THE FIX — the old grouping (no viewport transform) pairs no label with its
//               value on a /Rotate 90 or 270 sheet; the stream-order text never does.
// Synthetic data only. No network, no model.
//   npx tsx backend/test/pageTextLayout.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { REPO } from "./_isolate";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "page-layout-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.EMAIL_INTAKE_ADDRESS;

const { extractPdfLayoutText, extractPdfText, pdfPageLayoutInputs } = await import("../src/batchImport");
const { layoutTextFromItems, normalizePageText } = await import("../../shared/src/pageTextLayout");
const { PDFDocument, StandardFonts, degrees } = await import("pdf-lib");
const ParserReview = createRequire(import.meta.url)(path.join(REPO, "frontend", "parser-review.js"));

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).stack || (e as Error).message}`); }
};

const ROWS: Array<[string, string, string]> = [
  ["CIRCUIT-A", "TEN-AWG", "20A-OCPD"],
  ["CIRCUIT-B", "EIGHT-AWG", "40A-OCPD"],
  ["CIRCUIT-C", "SIX-AWG", "60A-OCPD"],
  ["CIRCUIT-D", "FOUR-AWG", "80A-OCPD"],
];
const ROW_LINES = ROWS.map((r) => r.join(" "));
const W = 612, H = 792;
type Rot = 0 | 90 | 180 | 270;
/** Where a point of the DISPLAYED page (x right, y down) sits in the unrotated user space. */
function userPoint(rot: Rot, X: number, Y: number): [number, number] {
  if (rot === 0) return [X, H - Y];
  if (rot === 90) return [Y, X];
  if (rot === 180) return [W - X, Y];
  return [W - Y, H - X];
}
/** A plan-set-like page stored at /Rotate `rot`, displayed upright, its table written column by column. */
async function schedulePdf(rot: Rot, extraPages = 0, firstLine = "Address: 100 Test St, Testville, ZZ 00001"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([W, H]);
  page.setRotation(degrees(rot));
  const put = (text: string, X: number, Y: number) => { const [x, y] = userPoint(rot, X, Y); page.drawText(text, { x, y, size: 11, font, rotate: degrees(rot) }); };
  put(firstLine, 60, 60);
  for (let col = 0; col < 3; col++) ROWS.forEach((row, r) => put(row[col], 60 + col * 170, 120 + r * 30));
  for (let i = 0; i < extraPages; i++) doc.addPage([W, H]).drawText(`SHEET ${i + 2} DETAIL NOTES FOR THE SYNTHETIC SET PAGE ${i + 2}`, { x: 40, y: 700, size: 11, font });
  return Buffer.from(await doc.save());
}
const fileOf = (name: string, bytes: Buffer) => { const f = path.join(scratch, name); fs.writeFileSync(f, bytes); return f; };
const lines = (text: string) => text.split("\n").map((l) => l.trim());

const corpus: Array<{ rot: Rot; file: string }> = [];
for (const rot of [0, 90, 180, 270] as Rot[]) corpus.push({ rot, file: fileOf(`schedule-${rot}.pdf`, await schedulePdf(rot)) });

for (const { rot, file } of corpus) {
  await check(`MUST-PASS: /Rotate ${rot} — every schedule row reads as one line (server reader, real pdf.js)`, async () => {
    const { text, pageCount, pagesRead } = await extractPdfLayoutText(file);
    assert.deepEqual([pageCount, pagesRead], [1, 1]);
    assert.match(text, /^--- PAGE 1 ---\n/);
    const got = lines(text);
    for (const row of ROW_LINES) assert.ok(got.includes(row), `row "${row}" is one line; got:\n${text}`);
    assert.ok(got.indexOf(ROW_LINES[0]) < got.indexOf(ROW_LINES[3]), "rows run top to bottom");
    assert.ok(got.indexOf("Address: 100 Test St, Testville, ZZ 00001") < got.indexOf(ROW_LINES[0]), "the line above the table comes first");
  });
}

/** THE READER AS IT WAS (frontend/parser-review.js before this change), kept here as the "before":
 *  lines grouped by the raw matrix position, rotation and text direction ignored. */
function oldLayout(items: Array<{ str?: string; transform?: number[] }>): string {
  const mapped = (items || []).map((item) => { const tx = item.transform || [1, 0, 0, 1, 0, 0]; return { str: String(item.str || "").trim(), x: Number(tx[4] || 0), y: Number(tx[5] || 0) }; }).filter((item) => item.str);
  if (!mapped.length) return "";
  mapped.sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));
  const out: Array<{ y: number; items: typeof mapped }> = [];
  for (const item of mapped) { const last = out[out.length - 1]; if (!last || Math.abs(last.y - item.y) > 3) out.push({ y: item.y, items: [item] }); else last.items.push(item); }
  return out.map((line) => line.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ")).join("\n");
}

await check("MUST-FAIL WITHOUT THE FIX: the reader as it was pairs no label with its value on a rotated sheet", async () => {
  for (const { rot, file } of corpus) {
    const { pages } = await pdfPageLayoutInputs(file);
    const old = lines(oldLayout(pages[0].items));
    const paired = ROW_LINES.filter((row) => old.includes(row)).length;
    if (rot === 0) assert.equal(paired, 4, "an unrotated page already read correctly");
    else assert.equal(paired, 0, `/Rotate ${rot}: the old reader pairs none (got ${paired})`);
  }
});

await check("MUST-FAIL WITHOUT THE FIX: the stream-order text (extractPdfText) never has a row together", async () => {
  for (const { file } of corpus) {
    const stream = await extractPdfText(file, 60);
    for (const row of ROW_LINES) assert.ok(!stream.includes(row), "labels and values are apart in stream order");
    assert.match(stream, /CIRCUIT-A\s+CIRCUIT-B\s+CIRCUIT-C\s+CIRCUIT-D/, "the tool wrote the label column first");
  }
});

await check("MUST-PASS: an unrotated page of upright text reads exactly as before (with or without the transform)", async () => {
  const { pages } = await pdfPageLayoutInputs(corpus[0].file);
  assert.equal(layoutTextFromItems(pages[0].items, pages[0].viewportTransform), oldLayout(pages[0].items), "byte for byte what the old reader gave");
  assert.equal(layoutTextFromItems(pages[0].items), oldLayout(pages[0].items), "and with no transform at all");
});

await check("MUST-PASS: a sideways label is laid out in its own frame and appended, not scattered through the rows", () => {
  const items = [
    { str: "LABEL", transform: [1, 0, 0, 1, 50, 700] }, { str: "VALUE", transform: [1, 0, 0, 1, 200, 700] },
    { str: "NORTH", transform: [0, 1, -1, 0, 120, 690] }, { str: "ARROW", transform: [0, 1, -1, 0, 120, 730] },
    { str: "SECOND", transform: [1, 0, 0, 1, 50, 660] }, { str: "ROW", transform: [1, 0, 0, 1, 200, 660] },
  ];
  assert.equal(layoutTextFromItems(items, [1, 0, 0, -1, 0, 792]), "LABEL VALUE\nSECOND ROW\nNORTH ARROW");
});

await check("PIN: the browser copy (parser-review.js) and shared/src/pageTextLayout.ts give the same text on the whole corpus", async () => {
  for (const { rot, file } of corpus) {
    const { pages } = await pdfPageLayoutInputs(file);
    for (const vt of [pages[0].viewportTransform, undefined, null, [1, 2, 3], [0, 1, 1, 0, 0, 0], [0, -1, -1, 0, H, W], [-1, 0, 0, 1, W, 0]]) {
      assert.equal(ParserReview.layoutTextFromItems(pages[0].items, vt), layoutTextFromItems(pages[0].items, vt as never), `rotation ${rot}, transform ${JSON.stringify(vt)}`);
    }
    assert.ok(lines(ParserReview.pdfPageText(pages[0].items, pages[0].viewportTransform)).includes(ROW_LINES[2]), "the page's own reader takes the transform");
  }
  for (const raw of ["A – B — C − D", "x y | “q” ‘r’", "a  \t b\n\n\n\nc", ""]) assert.equal(ParserReview.normalizeText(raw), normalizePageText(raw));
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  assert.match(html, /ParserReview\.pdfPageText\(content\.items, page\.getViewport\(\{ scale: 1 \}\)\.transform\)/, "the Parser page hands its reader the page's viewport transform");
});

// --- through the unattended door ----------------------------------------------------------------

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { placeIntakeJob, intakeClientInOrg } = await import("../src/emailIntake");
const { getProjectDetail } = await import("../src/repository");
const db = await openDatabase();
const client = intakeClientInOrg(db, createClient(db, { companyName: "Zzfixture Solar Co", businessEmail: "office@zzfixture.example.test" }).id, DEFAULT_ORG_ID)!;
const addressRead = (street: string) => ({ provider: "claude", lowConfidenceFields: [], notes: "", fields: { street: { value: street, confidence: 0.9 }, city: { value: "Testville", confidence: 0.9 }, state: { value: "ZZ", confidence: 0.9 }, zip: { value: "00001", confidence: 0.9 } } });

await check("MUST-PASS: placeIntakeJob hands the model a /Rotate 90 plan set page-marked, each schedule row on one line", async () => {
  let seen = "";
  const placed = await placeIntakeJob(db, { client, files: [{ filename: "planset.pdf", content: await schedulePdf(90) }], extract: async (t) => { seen = t.planText; return addressRead("100 Test St") as never; }, uploadedBy: "tester", source: "bulk_drop" });
  assert.equal(placed.outcome, "created");
  assert.match(seen, /^--- PAGE 1 ---\n/);
  for (const row of ROW_LINES) assert.ok(lines(seen).includes(row), `the model is handed "${row}" as one line; got:\n${seen}`);
});

await check("MUST-PASS: pages past the door's page cap are named as not read, on the project", async () => {
  const placed = await placeIntakeJob(db, { client, files: [{ filename: "planset.pdf", content: await schedulePdf(0, 62, "Address: 200 Test St, Testville, ZZ 00001") }], extract: async () => addressRead("200 Test St") as never, uploadedBy: "tester", source: "email_intake" });
  assert.equal(placed.outcome, "created");
  if (placed.outcome !== "created") return;
  const review = (getProjectDetail(db, placed.projectId).project.parserSnapshot as Record<string, any>).parseReview;
  assert.deepEqual(review.pagesNotRead.map((p: { page: number }) => p.page), [61, 62, 63]);
  assert.match(review.pagesNotRead[0].reason, /past the first 60 pages/);
  assert.match(placed.project.parserConfidenceSummary, /3 plan-set page\(s\) not read/);
  assert.deepEqual(ParserReview.pagesPastTextCap(45, 48, { visionPages: [47] }).map((p: { page: number }) => p.page), [46, 48], "the Parser page names its own cap the same way");
});

console.log(`\npageTextLayout: ${passed} passed, ${failures} failed`);
if (failures) { console.error(`FAIL - pageTextLayout (${failures})`); process.exit(1); }
console.log("ok - pageTextLayout");
process.exit(0);
