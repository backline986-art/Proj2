// WHAT A PARSE DID NOT READ IS READ, KEPT AND SHOWN (intake audit 2026-11-28).
//
//   (1) THE UNATTENDED DOOR READS IMAGE-ONLY PAGES. Through placeIntakeJob with the real model
//       extractor under a fake provider: a text plan set whose datasheet pages are pictures gets
//       those pages read by vision and merged under the text read — a field only the picture states
//       lands on the project. More picture pages than the cap: the pages not read are saved.
//   (2) A LOW-CONFIDENCE VALUE IS NEVER A FACT AND NEVER LOST. Withheld from the project, kept with
//       its reading / kind / reason in the parse-review record, raised as ONE advisory review item;
//       an `unconfirmed` (stated-once) value is saved; an account reading is never copied.
//   (3) THE PARSER PAGE'S REVIEW OUTPUT IS SAVED. The record the page builds (parser-review.js)
//       goes through the real create path: the summary no longer reads "without explicit review
//       flags", the record is validated, an edit keeps it, and it is never a fill value.
//
// Synthetic data only (generated PDFs, "100 Test St, Testville, ZZ 00001"). No network.
//   npx tsx backend/test/parseReviewIntake.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { REPO } from "./_isolate";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "parse-review-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.EMAIL_INTAKE_ADDRESS;

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { placeIntakeJob, modelIntakeExtractor, payloadFromExtraction, intakeClientInOrg } = await import("../src/emailIntake");
const { createProject, updateProject, getProjectDetail, isCriticalReviewItem } = await import("../src/repository");
const { sanitizeParseReview, PARSE_REVIEW_ISSUE_TYPE, PARSE_REVIEW_FIELD } = await import("../src/parseReview");
const { resolveRecipeFieldValues } = await import("../src/portalRecipes");
const { MAX_VISION_PAGES } = await import("../src/scannedPlanSet");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { createCanvas } = await import("@napi-rs/canvas" as string);
const ParserReview = createRequire(import.meta.url)(path.join(REPO, "frontend", "parser-review.js"));

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).stack || (e as Error).message}`); }
};

const db = await openDatabase();
const made = createClient(db, { companyName: "Zzfixture Solar Co", businessEmail: "office@zzfixture.example.test" });
const client = intakeClientInOrg(db, made.id, DEFAULT_ORG_ID)!;
assert.ok(client, "fixture client");

/** A text plan set whose pages in `imagePages` are PICTURES carrying only a title block as text. */
async function hybridSet(pages: number, imagePages: number[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cv = createCanvas(1200, 800);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1200, 800); ctx.fillStyle = "#000"; ctx.font = "28px sans-serif";
  for (let y = 60; y < 800; y += 44) ctx.fillText(`SYNTH MODULE DATASHEET  LISTED TO UL 61730  Voc 41.${y % 10} V`, 30, y);
  const raster = await doc.embedPng(cv.toBuffer("image/png"));
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([1224, 792]);
    p.drawText(`CONTRACTOR: ZZFIXTURE SOLAR CO  SHEET NUMBER PV-${i}  SHEET SIZE ANSI B 11 X 17`, { x: 30, y: 20, size: 8, font });
    if (imagePages.includes(i)) p.drawImage(raster, { x: 30, y: 60, width: 1100, height: 700 });
    else for (let r = 0; r < 18; r++) p.drawText(`SHEET ${i} NOTE ${r}: Address: 100 Test St, Testville, ZZ 00001  CONDUCTOR ${i * 100 + r} AWG PER PLAN ${i}-${r}`, { x: 40, y: 740 - r * 36, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

type FakeInput = { planPageImages?: Array<{ page: number }>; planText?: string; planImageMode?: string };
/** The provider under the REAL extractor: a text read that states the address, and an image read
 *  that states what only the picture pages carry. `text` adds to the text read's answer. */
function fakeLlm(text: Record<string, unknown> = {}) {
  const calls: FakeInput[] = [];
  const field = (value: unknown, sheet: string, excerpt: string) => ({ value, confidence: 0.9, evidence: { source: "plan_set", sheet, excerpt } });
  return {
    calls,
    async extractProjectFields(input: FakeInput) {
      calls.push(input);
      if (input.planPageImages) {
        return { provider: "claude", fields: { moduleListingAgency: field("UL 61730", "datasheet", "LISTED TO UL 61730"), dcKw: field(9.9, "datasheet", "9.9") }, lowConfidenceFields: [], notes: "image read" };
      }
      return {
        provider: "claude",
        fields: { street: field("100 Test St", "PV-1", "Address: 100 Test St"), city: field("Testville", "PV-1", "Testville"), state: field("ZZ", "PV-1", "ZZ"), zip: field("00001", "PV-1", "00001"), dcKw: field(6.4, "PV-1", "6.40 KW DC") },
        lowConfidenceFields: [], notes: "text read", ...text,
      };
    },
  };
}
const snap = (projectId: string) => getProjectDetail(db, projectId).project.parserSnapshot as Record<string, any>;

// --- (1) image-only pages at the unattended door ------------------------------------------------

await check("(1a) MUST-PASS: the unattended door reads a text plan set's image-only pages and merges them under the text read", async () => {
  const llm = fakeLlm();
  const placed = await placeIntakeJob(db, { client, files: [{ filename: "planset.pdf", content: await hybridSet(6, [5, 6]) }], extract: modelIntakeExtractor(db, llm as never), uploadedBy: "tester", source: "bulk_drop" });
  assert.equal(placed.outcome, "created");
  if (placed.outcome !== "created") return;
  const image = llm.calls.filter((c) => c.planPageImages);
  assert.equal(image.length, 1, "one vision call for the picture pages");
  assert.deepEqual(image[0].planPageImages!.map((p) => p.page), [5, 6]);
  assert.equal(image[0].planImageMode, "hybrid");
  const s = snap(placed.projectId);
  assert.equal(s.moduleListingAgency, "UL 61730", "the field only the picture states is on the project");
  assert.equal(Number(s.dcKw), 6.4, "the text read stays authoritative where both answer");
  assert.deepEqual(s.parseReview.visionPages, [5, 6]);
  assert.ok(s.parseReview.conflicts.some((c: { field: string }) => c.field === "dcKw"), "the text / image disagreement is kept as a conflict");
});

await check("(1b) MUST-PASS: more picture pages than the cap — the pages NOT read are saved with the project and raised for a person", async () => {
  const imagePages = Array.from({ length: MAX_VISION_PAGES + 2 }, (_, i) => i + 2);
  const placed = await placeIntakeJob(db, { client, files: [{ filename: "planset.pdf", content: await hybridSet(imagePages.length + 2, imagePages) }], extract: modelIntakeExtractor(db, fakeLlm({ fields: { street: { value: "101 Test St", confidence: 0.9 }, city: { value: "Testville", confidence: 0.9 }, state: { value: "ZZ", confidence: 0.9 }, zip: { value: "00001", confidence: 0.9 } } }) as never), uploadedBy: "tester", source: "email_intake" });
  assert.equal(placed.outcome, "created");
  if (placed.outcome !== "created") return;
  const review = snap(placed.projectId).parseReview;
  assert.equal(review.door, "email_intake");
  assert.equal(review.visionPages.length, MAX_VISION_PAGES, "the cost guard holds: never more than the cap");
  assert.deepEqual(review.pagesNotRead.map((p: { page: number }) => p.page), imagePages.slice(MAX_VISION_PAGES));
  assert.match(placed.project.parserConfidenceSummary, /2 plan-set page\(s\) not read/);
  const item = db.get<{ issue_type: string; notes: string; status: string }>("SELECT issue_type, notes, status FROM human_review_items WHERE project_id = ? AND field_name = ?", [placed.projectId, PARSE_REVIEW_FIELD]);
  assert.equal(item?.status, "pending");
  assert.match(item!.notes, /pages nobody read/i);
});

await check("(1c) MUST-NOT: a failed image read never fails the intake — the text read stands and the failure is kept", async () => {
  const base = fakeLlm({ fields: { street: { value: "102 Test St", confidence: 0.9 }, city: { value: "Testville", confidence: 0.9 }, state: { value: "ZZ", confidence: 0.9 }, zip: { value: "00001", confidence: 0.9 } } });
  const llm = { extractProjectFields: async (input: FakeInput) => { if (input.planPageImages) throw new Error("synthetic: vision unavailable"); return base.extractProjectFields(input); } };
  const placed = await placeIntakeJob(db, { client, files: [{ filename: "planset.pdf", content: await hybridSet(5, [4]) }], extract: modelIntakeExtractor(db, llm as never), uploadedBy: "tester", source: "bulk_drop" });
  assert.equal(placed.outcome, "created");
  if (placed.outcome !== "created") return;
  const review = snap(placed.projectId).parseReview;
  assert.ok(review.flags.some((f: string) => /IMAGE-ONLY PAGES NOT READ/.test(f)), "the failure is a saved review line");
  assert.equal(snap(placed.projectId).moduleListingAgency, undefined);
});

// --- (2) low-confidence values ------------------------------------------------------------------

const LOW = {
  fields: {
    street: { value: "103 Test St", confidence: 0.9 }, city: { value: "Testville", confidence: 0.9 }, state: { value: "ZZ", confidence: 0.9 }, zip: { value: "00001", confidence: 0.9 },
    busRating: { value: "200", confidence: 0.4, evidence: { source: "plan_set", sheet: "E-1", excerpt: "MAX 705.12 = 200A" } },
    windSpeed: { value: "110", confidence: 0.5, evidence: { source: "plan_set", sheet: "S-1", excerpt: "WIND SPEED 110 MPH" } },
    roofMaterial: { value: "Comp shingle", confidence: 0.3 },
    account: { value: "5550001234", confidence: 0.4 },
  },
  lowConfidenceFields: ["busRating", "windSpeed", "roofMaterial", "account"],
  uncertainties: [
    { field: "busRating", kind: "inferred", reason: "read off a 705.12 maximum, not the panel label" },
    { field: "windSpeed", kind: "unconfirmed", reason: "printed once on S-1" },
    { field: "account", kind: "unreadable", reason: "a smudged digit: 555-000-1234 or 555-000-1284" },
  ],
};

await check("(2a) MUST-PASS: payloadFromExtraction withholds a guess with its reading, and keeps a stated-once value", () => {
  const { payload, unsure, uncertain } = payloadFromExtraction(LOW as never);
  assert.equal(payload.busRating, undefined, "an inferred value is not a fact");
  assert.equal(payload.roofMaterial, undefined, "low confidence with no uncertainty row stays withheld");
  assert.equal(payload.account, undefined);
  assert.equal(payload.windSpeed, "110", "unconfirmed = stated beside its label: saved");
  assert.deepEqual([...unsure].sort(), ["account", "busRating", "roofMaterial"]);
  const bus = uncertain.find((u) => u.field === "busRating")!;
  assert.deepEqual([bus.value, bus.kind, bus.saved, bus.sheet], ["200", "inferred", false, "E-1"]);
  assert.equal(uncertain.find((u) => u.field === "windSpeed")!.saved, true);
});

await check("(2b) MUST-PASS: through placeIntakeJob — withheld readings are saved with the project and raised as ONE advisory item", async () => {
  const placed = await placeIntakeJob(db, { client, files: [{ filename: "planset.pdf", content: await hybridSet(3, []) }], extract: async () => ({ provider: "claude", notes: "", ...LOW }) as never, uploadedBy: "tester", source: "bulk_drop" });
  assert.equal(placed.outcome, "created");
  if (placed.outcome !== "created") return;
  const s = snap(placed.projectId);
  assert.equal(s.busRating, undefined, "the guess is not on the project");
  assert.equal(String(s.windSpeed), "110");
  const withheld = s.parseReview.uncertain.filter((u: { saved: boolean }) => !u.saved);
  assert.deepEqual(withheld.map((u: { field: string }) => u.field).sort(), ["account", "busRating", "roofMaterial"]);
  assert.equal(withheld.find((u: { field: string }) => u.field === "busRating").value, "200", "the reading is kept for a person");
  assert.match(placed.project.parserConfidenceSummary, /3 value\(s\) read but withheld/);
  assert.doesNotMatch(placed.project.parserConfidenceSummary, /without explicit review flags/);
  const items = db.query<{ issue_type: string; field_name: string; notes: string; status: string }>("SELECT issue_type, field_name, notes, status FROM human_review_items WHERE project_id = ? AND field_name = ?", [placed.projectId, PARSE_REVIEW_FIELD]);
  assert.equal(items.length, 1, "one item, not one per field");
  assert.equal(items[0].issue_type, PARSE_REVIEW_ISSUE_TYPE);
  assert.match(items[0].notes, /busRating = 200 \[inferred, E-1/);
  assert.equal(isCriticalReviewItem({ status: "pending", fieldName: items[0].field_name, issueType: items[0].issue_type }), false, "advisory: it never holds a gate");
});

await check("(2c) MUST-NOT (rule 2): an account reading is never copied into the record or the review item", async () => {
  const row = db.get<{ id: string }>("SELECT id FROM projects WHERE project_address LIKE '103 Test St%'")!;
  const stored = JSON.stringify(snap(row.id).parseReview);
  const notes = String(db.get<{ notes: string }>("SELECT notes FROM human_review_items WHERE project_id = ? AND field_name = ?", [row.id, PARSE_REVIEW_FIELD])!.notes);
  for (const text of [stored, notes]) {
    assert.doesNotMatch(text.replace(/[\s\-.]/g, ""), /5550001234|5550001284/, "no account digits, whatever the separators");
  }
  assert.match(notes, /account \(value not shown here\)/);
});

// --- (3) the Parser page's review output is saved -----------------------------------------------

const pageRecord = ParserReview.buildParseReviewRecord({
  door: "parser_page",
  flags: ["Image-only pages in the plan set: read by VISION from pages 7, 8.", "NO UTILITY BILL UPLOADED"],
  reviewItems: {
    resolved: [],
    unsure: [{ field: "roofRafterSize", value: "2x6", evidence: { source: "plan_set", sheet: "S-1", excerpt: "2X6 RAFTERS" }, why: "two sizes are stated" }],
    missing: [{ field: "homeownerEmail", suppliedBy: "the client", why: "not stated in any attached document" }],
    conflicts: [{ field: "snow", readings: [{ value: 25, source: "structural_letter", sheet: "letter" }, { value: 30, source: "plan_set", sheet: "S-1" }], note: "letter vs plan set" }],
  },
  reads: ParserReview.noteParseRead(ParserReview.noteParseRead(null, { visionPages: [7, 8], visionFields: ["moduleVoc"], visionSkipped: [{ page: 9, reason: "over the 8-page cap" }] }), { planTextPagesNotRead: [4], outlinedTextPages: [2] }),
});

await check("(3a) MUST-PASS: the page's record goes through the real create path — the summary counts it and the record is kept", () => {
  const { project } = createProject(db, { owner: "Pat Example", street: "104 Test St", city: "Testville", state: "ZZ", zip: "00001", parseReview: pageRecord });
  assert.doesNotMatch(project.parserConfidenceSummary, /without explicit review flags/);
  for (const part of [/2 parser review flag\(s\)/, /1 saved value\(s\) the read could not confirm/, /1 conflict\(s\) between readings/, /3 plan-set page\(s\) not read/, /1 field\(s\) no document states/]) assert.match(project.parserConfidenceSummary, part);
  const review = (project.parserSnapshot as Record<string, any>).parseReview;
  assert.deepEqual(review.pagesNotRead.map((p: { page: number }) => p.page), [2, 4, 9]);
  assert.equal(review.pagesNotRead.find((p: { page: number }) => p.page === 9).reason, "over the 8-page cap");
  assert.equal(review.conflicts[0].readings.length, 2);
});

await check("(3b) MUST-PASS: an unrelated edit keeps the record; a re-parse that settles everything clears it", () => {
  const { project } = createProject(db, { owner: "Pat Example", street: "105 Test St", city: "Testville", state: "ZZ", zip: "00001", parseReview: pageRecord });
  const edited = updateProject(db, project.id, { busRating: "200" }).project;
  assert.ok((edited.parserSnapshot as Record<string, any>).parseReview, "an edit of another field keeps what the parse did not settle");
  assert.match(edited.parserConfidenceSummary, /plan-set page\(s\) not read/);
  const cleared = updateProject(db, project.id, { parseReview: null }).project;
  assert.equal("parseReview" in (cleared.parserSnapshot as object), false);
  assert.match(cleared.parserConfidenceSummary, /without explicit review flags/);
});

await check("(3c) MUST-NOT: the record is never a fill value, and a posted record is validated, bounded and scrubbed", () => {
  const { project } = createProject(db, { owner: "Pat Example", street: "106 Test St", city: "Testville", state: "ZZ", zip: "00001", account: "777-000-4321", parseReview: {
    door: "Parser Page<script>", flags: ["meter on bill reads 7770004321 here", 42, "x".repeat(5000)],
    uncertain: [{ field: "not a field id!", value: "x" }, { field: "meter", value: "998877665", reason: "could be 998877665" }, { field: "busRating", value: { nested: true }, kind: "GUESSED", saved: "yes" }],
    pagesNotRead: [{ page: -1, reason: "bad" }, { page: 3, reason: "over the cap" }, { page: 3, reason: "duplicate" }, "junk"],
    visionPages: [2, "2", 0, 1.5], extra: { anything: true },
  } });
  const review = (project.parserSnapshot as Record<string, any>).parseReview;
  assert.equal(review.door, "parserpagescript");
  assert.equal(review.extra, undefined);
  assert.ok(review.flags.every((f: string) => f.length <= 600) && !JSON.stringify(review).replace(/[\s\-.]/g, "").includes("7770004321"), "the job's own account digits are scrubbed");
  assert.deepEqual(review.uncertain.map((u: { field: string }) => u.field), ["meter", "busRating"]);
  assert.equal(review.uncertain[0].value, "", "a meter reading is never copied");
  assert.doesNotMatch(JSON.stringify(review), /998877665/);
  assert.equal(review.uncertain[1].saved, false, "saved is true only when it is exactly true");
  assert.deepEqual(review.pagesNotRead, [{ page: 3, reason: "over the cap" }]);
  assert.deepEqual(review.visionPages, [2]);
  const values = resolveRecipeFieldValues(db, getProjectDetail(db, project.id).project, "generic", "building");
  assert.equal("parseReview" in values, false, "an object value is never a recipe / planner field");
  assert.ok(!Object.values(values).some((v) => /over the cap|parserpagescript/.test(String(v))));
  assert.equal(sanitizeParseReview({ flags: [], uncertain: [] }), null, "an empty record is no record");
});

await check("(3d) PIN: the Parser page's save sends the record, and the dashboard shows it escaped", () => {
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  const save = html.slice(html.indexOf("function buildSystemPayload() {"));
  assert.match(save.slice(0, save.indexOf("\n}\n")), /payload\.parseReview = ParserReview\.buildParseReviewRecord\(/);
  const js = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8");
  const start = js.indexOf("function parseReviewPanelHtml(review) {");
  const source = js.slice(start, js.indexOf("\n}\n", start) + 2);
  const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const plural = (n: number, w: string) => `${n} ${n === 1 ? w : `${w}s`}`;
  const panel = new Function("esc", "plural", `${source}; return parseReviewPanelHtml;`)(esc, plural) as (r: unknown) => string;
  assert.equal(panel(undefined), "");
  const out = panel({ door: "bulk_drop", flags: [], missing: [], conflicts: [], uncertain: [{ field: "busRating", value: "<img src=x>", kind: "inferred", reason: "r", sheet: "E-1", saved: false }], pagesNotRead: [{ page: 9, reason: "over the 8-page cap" }, { page: 10, reason: "over the 8-page cap" }] });
  assert.match(out, /Read but NOT saved/);
  assert.match(out, /Pages 9, 10 <span class="muted">over the 8-page cap/);
  assert.match(out, /&lt;img src=x&gt;/);
  assert.doesNotMatch(out, /<img/);
  assert.match(js, /parseReviewPanelHtml\(\(project\.parserSnapshot \|\| \{\}\)\.parseReview\)/, "renderReview shows the panel");
});

// --- (5) a photo is filed as what it shows ------------------------------------------------------

await check("(5a) MUST-PASS: crossed photo boxes are swapped; a lone photo in the wrong box is moved; anything ambiguous is only flagged", () => {
  const fix = ParserReview.photoSlotFix;
  const both = ["utility_bill", "meter_photo"];
  const crossed = fix(both, [{ index: 1, shows: "meter_photo" }, { index: 2, shows: "utility_bill" }], { utility_bill: true, meter_photo: true });
  assert.equal(crossed.action, "swap");
  assert.match(crossed.flags[0], /each other's boxes/);
  assert.equal(fix(["utility_bill"], [{ index: 1, shows: "meter_photo" }], { utility_bill: true, meter_photo: false }).action, "bill_to_meter");
  assert.equal(fix(["meter_photo"], [{ index: 1, shows: "utility_bill" }], { utility_bill: false, meter_photo: true }).action, "meter_to_bill");
  // MUST-NOT: never move a photo over a document already in the other box (a PDF bill is not among the images sent).
  const overPdf = fix(["meter_photo"], [{ index: 1, shows: "utility_bill" }], { utility_bill: true, meter_photo: true });
  assert.equal(overPdf.action, "none");
  assert.match(overPdf.flags[0], /CHECK THE PHOTO in the meter-photo box: it shows a utility bill/);
  const twoMeters = fix(both, [{ index: 1, shows: "meter_photo" }, { index: 2, shows: "meter_photo" }], { utility_bill: true, meter_photo: true });
  assert.deepEqual([twoMeters.action, twoMeters.flags.length], ["none", 1]);
  const neither = fix(both, [{ index: 1, shows: "utility_bill" }, { index: 2, shows: "neither" }], { utility_bill: true, meter_photo: true });
  assert.equal(neither.action, "none");
  assert.match(neither.flags[0], /meter-photo box: it shows neither a bill nor a meter/);
  for (const quiet of [fix(both, undefined), fix(both, []), fix(both, [{ index: 1, shows: "utility_bill" }, { index: 2, shows: "meter_photo" }]), fix(both, [{ index: 7, shows: "meter_photo" }])]) {
    assert.deepEqual(quiet, { action: "none", flags: [] }, "a read that did not say, or that agrees with the boxes, changes nothing");
  }
});

await check("(5b) MUST-PASS: the read's own answer is validated, and the page applies it before anything is uploaded", async () => {
  const { imageKindsFromResponse } = await import("../src/llm");
  const raw = 'noise {"fields":{}, "imageKinds": [{"index": 2, "shows": "utility_bill"}, {"index": 1, "shows": "meter_photo"}, {"index": 1, "shows": "neither"}, {"index": 9, "shows": "meter_photo"}, {"index": 2.5, "shows": "x"}, {bad json}], "notes": ""}';
  assert.deepEqual(imageKindsFromResponse(raw, 2), [{ index: 1, shows: "meter_photo" }, { index: 2, shows: "utility_bill" }]);
  assert.deepEqual(imageKindsFromResponse('{"fields":{}}', 2), []);
  assert.deepEqual(imageKindsFromResponse('{"imageKinds":[{"index":1,"shows":"a bill"}]}', 1), [], "an unknown kind is not a kind");
  const llmSrc = fs.readFileSync(path.join(REPO, "backend", "src", "llm.ts"), "utf8");
  assert.match(llmSrc, /THE LABELS COME FROM UPLOAD BOXES AND CAN BE WRONG[^\n]*"imageKinds"/, "the image read is asked what each image shows");
  assert.match(llmSrc, /const imageKinds = imageKindsFromResponse\(raw, input\.images\.length\);\s*return imageKinds\.length \? \{ \.\.\.extraction, imageKinds \} : extraction;/, "and its answer rides the response");
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  const fixAt = html.indexOf("ParserReview.photoSlotFix(visionImages.map(i => i.kind), v.imageKinds, { utility_bill: !!state.ubFile, meter_photo: !!state.meterFile })");
  assert.ok(fixAt > 0, "the Parser page asks for the fix with the boxes' real occupancy");
  const block = html.slice(fixAt, fixAt + 1200);
  assert.match(block, /slotFix\.action === 'swap'\)\{ \[state\.ubFile, state\.meterFile\] = \[state\.meterFile, state\.ubFile\];/);
  assert.match(block, /slotFix\.action === 'bill_to_meter'\)\{ state\.meterFile = state\.ubFile;/);
  assert.match(block, /slotFix\.flags\.forEach\(f => state\.reviewFlags\.push\(f\)\)/);
  assert.ok(fixAt < html.indexOf("[state.ubFile, 'utility_bill'],"), "the files are typed for upload from the corrected slots");
});

// --- (6) what the read is asked for is saved ----------------------------------------------------

await check("(6a) MUST-PASS: building geometry and the inverter's rated power are saved by the unattended door and reach the recipe values", async () => {
  const f = (value: unknown) => ({ value, confidence: 0.9 });
  const read = { provider: "claude", notes: "", lowConfidenceFields: [], fields: {
    street: f("107 Test St"), city: f("Testville"), state: f("ZZ"), zip: f("00001"),
    existingBuildingArea: f(1675), buildingHeightFeet: f(15), buildingHeightInches: f(6), numberOfStories: f(2), numberOfBuildings: f(1),
    invOutputW: f(32), invRatedPowerW: f(7600), pvMicroRatedPowerW: f(290),
  } };
  const placed = await placeIntakeJob(db, { client, files: [{ filename: "planset.pdf", content: await hybridSet(3, []) }], extract: async () => read as never, uploadedBy: "tester", source: "bulk_drop" });
  assert.equal(placed.outcome, "created");
  if (placed.outcome !== "created") return;
  const values = resolveRecipeFieldValues(db, getProjectDetail(db, placed.projectId).project, "generic", "building");
  assert.deepEqual([values.existingBuildingArea, values.buildingHeightFeet, values.buildingHeightInches, values.numberOfStories, values.numberOfBuildings], ["1675", "15", "6", "2", "1"], "the plan set's values, not the 0 default");
  assert.deepEqual([values.invRatedPowerW, values.pvMicroRatedPowerW, values.invOutputW], ["7600", "290", "32"], "rated power has its own keys; the amps key is untouched");
});

await check("(6b) PIN: every field the extraction prompt asks for is saved by the doors, or is exempt for a stated reason", async () => {
  const { PARSER_PROJECT_FIELDS, intakeFieldLabel } = await import("../src/emailIntake");
  const { RECIPE_FIELD_DESCRIPTIONS } = await import("../src/portalRecipes");
  const llmSrc = fs.readFileSync(path.join(REPO, "backend", "src", "llm.ts"), "utf8");
  const from = llmSrc.indexOf("\n- owner: full homeowner name");
  const to = llmSrc.indexOf("\n", llmSrc.indexOf("\n- locateCalloutText:") + 1);
  assert.ok(from > 0 && to > from, "the extraction prompt's field list was found");
  const asked = new Set<string>();
  const idList = /^- ((?:[a-z][A-Za-z0-9]*(?: \([^)]*\))?)(?:, [a-z][A-Za-z0-9]*(?: \([^)]*\))?)*)(?::| — )/;
  for (const line of llmSrc.slice(from, to).split("\n")) {
    const m = idList.exec(line);
    if (m) for (const part of m[1].replace(/\([^)]*\)/g, "").split(",")) asked.add(part.trim().split(" ")[0]);
  }
  assert.ok(asked.size > 90, `read only ${asked.size} field ids from the prompt`);
  // NOT SAVED, ON PURPOSE — each with its reason. A new prompt field must be saved or listed here.
  const EXEMPT: Record<string, string> = {
    structureDescription: "a person's answer; the Parser page derives its basis at save (ParserReview.structureBasis)",
    structureType: "read by codeReviewRules.structureType but saved by neither door — it changes where application documents go; an owner decision, not this change",
    contractorCompany: "resolved to the client by clientMatch, never saved as a field", contractorCcb: "as contractorCompany", contractorElectricalLicense: "as contractorCompany",
    contractorMetroCityLicense: "as contractorCompany", contractorAddress: "as contractorCompany", contractorPhone: "as contractorCompany", contractorEmail: "as contractorCompany",
    contractorSupervisor: "as contractorCompany", contractorElectricianLicense: "as contractorCompany",
  };
  const dropped = [...asked].filter((id) => !PARSER_PROJECT_FIELDS.has(id) && !EXEMPT[id]);
  assert.deepEqual(dropped, [], "asked of the model and then dropped by the save allowlist");
  for (const id of ["existingBuildingArea", "buildingHeightFeet", "buildingHeightInches", "numberOfStories", "numberOfBuildings", "invRatedPowerW", "pvMicroRatedPowerW"]) assert.ok(asked.has(id) && PARSER_PROJECT_FIELDS.has(id), id);
  assert.match(RECIPE_FIELD_DESCRIPTIONS.invOutputW, /AMPS/, "the amps-under-a-watts-name key says what it holds");
  assert.match(RECIPE_FIELD_DESCRIPTIONS.pvMicroOutputW, /AMPS/);
  assert.match(RECIPE_FIELD_DESCRIPTIONS.invRatedPowerW, /WATTS/);
  assert.equal(intakeFieldLabel("invOutputW"), "Inverter output current (A)", "the client-facing label no longer calls amps watts");
});

console.log(`\nparseReviewIntake: ${passed} passed, ${failures} failed`);
if (failures) { console.error(`FAIL - parseReviewIntake (${failures})`); process.exit(1); }
console.log("ok - parseReviewIntake");
process.exit(0);
