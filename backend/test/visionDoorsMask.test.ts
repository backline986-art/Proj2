// RULE 2 AT EVERY VISION DOOR THAT SENDS A PLAN PAGE (#612). #293 masked a project's account/meter
// number in the page image at the reviewer's vision door only. The other doors rendered the same
// sheets and sent them as they were: the module datasheet's listing read (moduleListing), the AI
// second opinion's sheet images (reviewSubject), the title-block-only sheets' listing read
// (imageSheetListings), the undecided spec pages' page-index read (scannedPlanSet via docSplitter)
// and the image-only pages' field read (scannedPlanSet.readPlanSetForExtraction). Each now paints
// over a text run carrying a project secret, and withholds the page when no box can be found.
// Pins, per door:
//   - RULE 2 / REVERT-CHECK: a synthetic plan set whose title block prints a meter number (on every
//     sheet, as real title blocks do): no image the door sends shows a pixel of it;
//   - MUST-PASS: the same sheet without the number goes byte-for-byte as it went before;
//   - FAIL CLOSED: a number with no box to paint (a run squeezed to no width) sends nothing for that
//     page, and the door names it as withheld;
//   - the JPEG renderer itself: masked as the PNG door is, byte-identical with no secrets.
// Synthetic data only. Run: tsx backend/test/visionDoorsMask.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, setCharacterSqueeze } from "pdf-lib";
import type { LLMProvider, ReviewSubject } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-doors-mask-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.SKIP_CODE_RESEARCH = "1";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { openPdfForVisionRender } = await import("../src/pageImages");
const { VisionPageWithheldError } = await import("../src/visionPageMask");
const { ensureModuleListingAgency } = await import("../src/moduleListing");
const { readImageSheetListings } = await import("../src/imageSheetListings");
const { readUndecidedSpecPages, readPlanSetForExtraction } = await import("../src/scannedPlanSet");
const { runStandaloneReview } = await import("../src/reviewSubject");
const { extractPdfPages } = await import("../src/batchImport");
const { createCanvas, loadImage } = await import("@napi-rs/canvas");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const json = (v: unknown) => JSON.stringify(v);

const METER = "80 000 1234"; // synthetic
const SECRETS = [METER];

// --- fixtures ---------------------------------------------------------------------------------
type Meter = "printed" | "absent" | "unboxable";
/** Three 11x17 sheets sharing one title block: two of plan prose, one a picture pasted in (its text
 *  is the title block only). The title block ends with the utility meter number — printed, absent
 *  (the twin: identical but for the digits), or squeezed to no width (Tz 0: no box to paint). The
 *  label reads "UTILITY METER:", which the bill/meter page screen (looksLikeBillOrMeterPage) does
 *  not withhold, so the page reaches the renderer. */
async function planSet(meter: Meter): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cv = createCanvas(1200, 800);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1200, 800); ctx.fillStyle = "#000"; ctx.font = "26px sans-serif";
  for (let y = 60; y < 800; y += 44) ctx.fillText(`SYNTHETIC MODULE DATASHEET ROW ${y} RATING ${y % 9} MODEL SYN-${y}`, 30, y);
  const raster = await doc.embedPng(cv.toBuffer("image/png"));
  const label = "CONTRACTOR: SYNTHETIC SOLAR CO  ADDRESS: 1 EXAMPLE WAY ANYTOWN  UTILITY METER:";
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([1224, 792]);
    p.drawText(`${label}`, { x: 30, y: 24, size: 10, font });
    const x = 30 + font.widthOfTextAtSize(`${label} `, 10);
    if (meter === "printed") p.drawText(METER, { x, y: 24, size: 10, font });
    if (meter === "unboxable") {
      p.pushOperators(setCharacterSqueeze(0));
      p.drawText(METER, { x, y: 24, size: 10, font });
      p.pushOperators(setCharacterSqueeze(100));
    }
    p.drawText(`SHEET ${i}`, { x: 1100, y: 24, size: 10, font });
    if (i === 3) {
      p.drawImage(raster, { x: 30, y: 60, width: 1100, height: 700 });
    } else {
      for (let r = 0; r < 40; r++) {
        p.drawText(`SHEET ${i} NOTE ${r}: ROOF MOUNT ARRAY ON RAFTERS AT ${16 + (r % 3) * 8} IN OC PER DETAIL ${i}-${r} CONDUCTOR ${i * 100 + r}`, { x: 40, y: 740 - r * 16, size: 9, font });
      }
    }
  }
  return Buffer.from(await doc.save());
}
const PRINTED = await planSet("printed");
const ABSENT = await planSet("absent");
const UNBOXABLE = await planSet("unboxable");
let n = 0;
function write(bytes: Buffer, label: string): string {
  const file = path.join(tmpDir, `${label}-${++n}.pdf`);
  fs.writeFileSync(file, bytes);
  return file;
}
const pageTexts = await extractPdfPages(write(PRINTED, "texts"), 60);

type Pixels = { width: number; height: number; data: Uint8ClampedArray };
async function pixels(img: Buffer): Promise<Pixels> {
  const im = await loadImage(img);
  const canvas = createCanvas(im.width, im.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(im, 0, 0);
  return { width: im.width, height: im.height, data: ctx.getImageData(0, 0, im.width, im.height).data as unknown as Uint8ClampedArray };
}
const lum = (p: Pixels, i: number) => 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2];

/** The meter number's pixels are where the unmasked image of the PRINTED sheet differs from the
 *  ABSENT twin's by more than JPEG noise; `visible` counts those the sent image does not paint dark.
 *  A digit that leaked keeps its anti-aliased grey edge (and the white around it), so it shows up
 *  here; a painted one is solid black. */
async function leak(sent: Buffer, unmasked: Buffer, twin: Buffer) {
  const [s, u, o] = await Promise.all([pixels(sent), pixels(unmasked), pixels(twin)]);
  if (s.width !== u.width || u.width !== o.width || s.height !== u.height || u.height !== o.height) return { secret: -1, visible: -1 };
  let secret = 0, visible = 0;
  for (let i = 0; i < u.data.length; i += 4) {
    if (Math.abs(lum(u, i) - lum(o, i)) <= 48) continue;
    secret++;
    if (lum(s, i) > 48) visible++;
  }
  return { secret, visible };
}
/** One door's three images: masked (PRINTED, the project's secrets), unmasked (PRINTED, none) and
 *  twin (ABSENT, none) — plus the twin sent WITH the secrets, which must be the twin's own bytes. */
async function checkDoor(door: string, send: (pdf: Buffer, secrets: string[]) => Promise<Buffer[]>) {
  const [masked, unmasked, twin, twinWithSecrets] = await Promise.all([
    send(PRINTED, SECRETS), send(PRINTED, []), send(ABSENT, []), send(ABSENT, SECRETS),
  ]);
  run(`${door}: setup: each run sent the same number of images`, masked.length > 0 && masked.length === unmasked.length && unmasked.length === twin.length,
    json([masked.length, unmasked.length, twin.length]));
  let worst = { secret: 0, visible: 0 };
  for (let k = 0; k < Math.min(masked.length, unmasked.length, twin.length); k++) {
    const l = await leak(masked[k], unmasked[k], twin[k]);
    if (l.secret < 0 || l.visible > worst.visible || worst.secret === 0) worst = l;
  }
  run(`${door}: setup: the meter number draws pixels in the image the door sends`, worst.secret > 30, json(worst));
  run(`${door}: RULE 2: no image the door sends shows a pixel of the meter number`, worst.visible === 0, json(worst));
  run(`${door}: MUST-PASS: a sheet without the number is sent byte-for-byte as before`,
    twinWithSecrets.length === twin.length && twinWithSecrets.every((b, k) => b.equals(twin[k])));
}

// --- the JPEG renderer every scanned/listing door uses ------------------------------------------
{
  const opts = { maxLongEdge: 2000, maxPixels: 2_000_000, quality: 92 } as const;
  const render = async (pdf: Buffer, secrets: string[]) => {
    const r = await openPdfForVisionRender(new Uint8Array(pdf), { secrets });
    try { return [(await r.render(3, opts)).bytes]; } finally { await r.close(); }
  };
  await checkDoor("openPdfForVisionRender", render);
  const r = await openPdfForVisionRender(new Uint8Array(UNBOXABLE), { secrets: SECRETS });
  let thrown: unknown = null;
  try { await r.render(3, opts); } catch (err) { thrown = err; } finally { await r.close(); }
  run("openPdfForVisionRender: FAIL CLOSED: a number with no box throws VisionPageWithheldError",
    thrown instanceof VisionPageWithheldError && /^withheld: /.test((thrown as Error).message), String(thrown));
}

// --- imageSheetListings (the title-block-only sheets' listing read) ---------------------------------
{
  const send = async (pdf: Buffer, secrets: string[]) => {
    const images: Buffer[] = [];
    const llm = { async visionExtract(input: { imageBase64: string }) { images.push(Buffer.from(input.imageBase64, "base64")); return { listings: [] }; } };
    const read = await readImageSheetListings(llm as never, new Uint8Array(pdf), pageTexts, { want: { module: true, racking: false }, secrets, countRaster: async () => [0, 0, 1] });
    if (!read.read.includes(3)) console.error(`    (imageSheetListings did not read page 3: ${json(read)})`);
    return images;
  };
  await checkDoor("imageSheetListings", send);
  const images: Buffer[] = [];
  const llm = { async visionExtract(input: { imageBase64: string }) { images.push(Buffer.from(input.imageBase64, "base64")); return { listings: [] }; } };
  const read = await readImageSheetListings(llm as never, new Uint8Array(UNBOXABLE), pageTexts, { want: { module: true, racking: false }, secrets: SECRETS, countRaster: async () => [0, 0, 1] });
  run("imageSheetListings: FAIL CLOSED: nothing sent, the page named as withheld",
    images.length === 0 && read.skipped.some((s) => s.page === 3 && /^withheld: .*account or meter number/.test(s.reason)), json(read.skipped));
}

// --- scannedPlanSet.readUndecidedSpecPages (docSplitter's page-index read) -------------------------
{
  const send = async (pdf: Buffer, secrets: string[] | null) => {
    const images: Buffer[] = [];
    const llm = { async classifyPlanPages(input: { pageImages: Array<{ base64: string }> }) {
      for (const p of input.pageImages) images.push(Buffer.from(p.base64, "base64"));
      return { pages: [] };
    } };
    await readUndecidedSpecPages(llm as never, new Uint8Array(pdf), [3], pageTexts, { secrets });
    return images;
  };
  await checkDoor("readUndecidedSpecPages", send);
  run("readUndecidedSpecPages: FAIL CLOSED: a number with no box sends no thumbnail", (await send(UNBOXABLE, SECRETS)).length === 0);
  run("readUndecidedSpecPages: FAIL CLOSED: secrets unreadable (null) → nothing rendered or sent", (await send(PRINTED, null)).length === 0);
}

// --- scannedPlanSet.readPlanSetForExtraction (a text set's image-only pages, hybrid read) ----------
{
  const send = async (pdf: Buffer, secrets: string[]) => {
    const images: Buffer[] = [];
    const llm = {
      async extractProjectFields(input: { planPageImages: Array<{ base64: string }> }) {
        for (const p of input.planPageImages) images.push(Buffer.from(p.base64, "base64"));
        return { provider: "claude", fields: {}, lowConfidenceFields: [], notes: "" };
      },
      async classifyPlanPages() { return { pages: [] }; },
      async orientPlanPages() { return []; },
    };
    const read = await readPlanSetForExtraction(llm as never, new Uint8Array(pdf), { secrets });
    if (read.mode !== "hybrid") console.error(`    (readPlanSetForExtraction read mode ${read.mode})`);
    return images;
  };
  await checkDoor("readPlanSetForExtraction (hybrid)", send);
  const images: Buffer[] = [];
  const llm = {
    async extractProjectFields(input: { planPageImages: Array<{ base64: string }> }) { images.push(...input.planPageImages.map((p) => Buffer.from(p.base64, "base64"))); return { provider: "claude", fields: {}, lowConfidenceFields: [], notes: "" }; },
    async classifyPlanPages() { return { pages: [] }; },
    async orientPlanPages() { return []; },
  };
  const read = await readPlanSetForExtraction(llm as never, new Uint8Array(UNBOXABLE), { secrets: SECRETS });
  run("readPlanSetForExtraction: FAIL CLOSED: nothing sent, the page named as withheld",
    images.length === 0 && (read.extraction?.visionSkipped ?? []).some((s) => s.page === 3 && /^withheld: /.test(s.reason)), json(read.extraction?.visionSkipped));
}

// --- moduleListing (the module datasheet's listing read) -------------------------------------------
{
  const send = async (pdf: Buffer, secrets: string[]) => {
    const p = createProject(db, {
      owner: `Doors Owner ${++n}`, street: `${n} Doors Way`, city: "Anytown", state: "OR", zip: "97000",
      ahj: "Doors City", utility: "Doors Power", dcKw: "6.0", meterNumber: secrets[0] ?? "",
    }).project;
    saveProjectDocument(db, p.id, { docType: "module_spec", filename: `module-${n}.pdf`, contentType: "application/pdf", buffer: pdf, source: "upload" });
    db.run("UPDATE project_documents SET extracted_text = '' WHERE project_id = ?", [p.id]);
    const images: Buffer[] = [];
    const llm = { async visionExtract(input: { imageBase64: string }) { images.push(Buffer.from(input.imageBase64, "base64")); return { listingAgency: "", standards: [], quote: "" }; } };
    await ensureModuleListingAgency(db, getProjectDetail(db, p.id).project, llm as never);
    return images;
  };
  await checkDoor("moduleListing", send);
  const p = createProject(db, {
    owner: `Doors Owner ${++n}`, street: `${n} Doors Way`, city: "Anytown", state: "OR", zip: "97000",
    ahj: "Doors City", utility: "Doors Power", dcKw: "6.0", meterNumber: METER,
  }).project;
  saveProjectDocument(db, p.id, { docType: "module_spec", filename: `module-${n}.pdf`, contentType: "application/pdf", buffer: UNBOXABLE, source: "upload" });
  db.run("UPDATE project_documents SET extracted_text = '' WHERE project_id = ?", [p.id]);
  let calls = 0;
  const reading = await ensureModuleListingAgency(db, getProjectDetail(db, p.id).project, { async visionExtract() { calls++; return {}; } } as never);
  const after = getProjectDetail(db, p.id).project.parserSnapshot as Record<string, unknown>;
  run("moduleListing: FAIL CLOSED: nothing sent, the pages named as withheld, not recorded as looked at",
    calls === 0 && (reading.withheld?.length ?? 0) > 0 && !after.moduleListingAgencyLookedAt, json({ calls, reading }));
}

// --- reviewSubject (the standalone review's AI second-opinion sheet images) ----------------------
{
  const subject = (fields: Record<string, string>): ReviewSubject => ({
    workType: "solar_pv_residential", state: "OR", ahj: "City of Testport", utility: "Test Power",
    applicant: { name: "Test Owner", address: "1 Example Way", city: "Anytown", zip: "97000" },
    system: { sizeDcKw: 6.4, sizeAcKw: 5, interconnectionMethod: "Load-side breaker" },
    fields: { mounting: "Roof mount", ...fields },
  } as unknown as ReviewSubject);
  const send = async (pdf: Buffer, secrets: string[]) => {
    const images: Buffer[] = [];
    const llm = {
      async visionExtract() { return { listings: [] }; },
      async reviewPlanSetGeneral(input: { pageImagesBase64: string[] }) {
        images.push(...input.pageImagesBase64.map((b) => Buffer.from(b, "base64")));
        return { provider: "claude" as const, findings: [], summary: "", confidence: "low" as const, notes: "" };
      },
    };
    await runStandaloneReview(db, "default", subject(secrets.length ? { meterNumber: secrets[0] } : {}), { buffer: pdf, filename: "set.pdf" }, { llm: llm as unknown as LLMProvider });
    return images;
  };
  await checkDoor("reviewSubject (AI second opinion)", send);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nvisionDoorsMask: all checks passed");
process.exit(0);
