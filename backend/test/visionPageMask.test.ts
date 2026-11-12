// RULE 2 FOR THE PAGE IMAGE (#293). The vision pass scrubbed its prompt text with the project's
// secrets, but the plan-set sheet went with it as an image, so a meter number printed on the sheet
// ("…tied to exterior utility meter #80 000 1234…") reached the model as pixels. Before a sheet is
// sent, its own text items are run through the prompt's detector (redactSecretValues with the
// project's secrets) and every carrying run is painted over; a carrier with no box fails closed
// (the page is not sent and the finding says why).
// Pins:
//   - RULE 2 / REVERT-CHECK: on a synthetic sheet, every pixel the meter number's glyphs touch is
//     painted in the image the vision model receives — a number in one run, split over two runs,
//     rotated 90°, set with tight tracking, and in a filled form field; the pass with a recording
//     LLM shows the same. Glyph ink that runs past the run's advance box (a substituted face: CI's
//     Noto fallback did this on #610) is followed and painted, pinned without fonts on a synthetic
//     image;
//   - FAIL CLOSED: a hit with no locatable box sends no image at all (unit and end to end), the
//     finding records why, and nothing is cached;
//   - MUST-PASS: a secret-free page (or a project with no secrets) is sent byte-for-byte as
//     renderPdfPageToPng renders it, the prompt text is unchanged, and the masked image never
//     replaces the operator's cached crop.
// Synthetic data only. Run: tsx backend/test/visionPageMask.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PDFDocument, StandardFonts, degrees, setCharacterSpacing, setCharacterSqueeze, type PDFFont, type PDFPage } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-page-mask-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { renderPdfPageToPng, renderPdfPageForVision, findPlanSetPdf } = await import("../src/pageImages");
const { planSecretMask, secretItemIndexes, itemQuad, paintMaskRegions } = await import("../src/visionPageMask");
const { applyVisionToReviewerReport, visionQuestionFor } = await import("../src/reviewerVision");
const { createCanvas, loadImage } = await import("@napi-rs/canvas");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const json = (v: unknown) => JSON.stringify(v);

const METER = "80 000 1234"; // synthetic
const ACCOUNT = "4400-1111-22"; // synthetic
const SECRETS = [METER, ACCOUNT];

// --- fixtures ---------------------------------------------------------------------------------
type Draw = (page: PDFPage, font: PDFFont, pdf: PDFDocument) => void;
/** A one-page sheet: the always-drawn lines, plus `secretDraws` only when withSecret. The twin
 *  without the secret marks exactly which pixels the secret's glyphs touch. */
async function sheet(secretDraws: Draw[], withSecret: boolean): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([792, 612]);
  page.drawText("PV-2 SITE PLAN", { x: 40, y: 560, size: 18, font });
  page.drawText("ARRAY LAYOUT AND ROOF SETBACKS, ONE-LINE DIAGRAM ON PV-5", { x: 40, y: 530, size: 10, font });
  page.drawText("36 IN FIRE ACCESS PATHWAY AT RIDGE", { x: 40, y: 80, size: 10, font });
  if (withSecret) for (const draw of secretDraws) draw(page, font, pdf);
  return Buffer.from(await pdf.save());
}

let n = 0;
function write(bytes: Buffer, label: string): string {
  const file = path.join(tmpDir, `${label}-${++n}.pdf`);
  fs.writeFileSync(file, bytes);
  return file;
}

type Pixels = { width: number; height: number; data: Uint8ClampedArray };
async function pixels(png: Buffer): Promise<Pixels> {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: data as unknown as Uint8ClampedArray };
}
const same = (a: Pixels, b: Pixels, i: number) => a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2];
const black = (a: Pixels, i: number) => a.data[i] < 8 && a.data[i + 1] < 8 && a.data[i + 2] < 8;

/** Against the twin without the secret: how many pixels the secret's glyphs touch, and how many of
 *  those are NOT painted black in `sent`. Plus how many pixels of the page's other text changed. */
async function coverage(sent: Buffer, withSecret: Buffer, without: Buffer) {
  const [s, w, o] = await Promise.all([pixels(sent), pixels(withSecret), pixels(without)]);
  let secretPixels = 0, visible = 0, otherTextChanged = 0;
  for (let i = 0; i < w.data.length; i += 4) {
    if (!same(w, o, i)) {
      secretPixels++;
      if (!black(s, i)) visible++;
    } else if (o.data[i] < 250 && !same(s, w, i)) {
      // An inked pixel of the sheet's own (non-secret) text that the mask changed.
      otherTextChanged++;
    }
  }
  return { secretPixels, visible, otherTextChanged, sizeMatches: s.width === w.width && s.height === w.height };
}

const CASES: Array<{ name: string; draws: Draw[] }> = [
  {
    name: "the number inside a sentence (one text run)",
    draws: [(page, font) => page.drawText(`SERVICE TIED TO EXTERIOR UTILITY METER #${METER} ON EAST WALL`, { x: 40, y: 300, size: 10, font })],
  },
  {
    name: "the number split over two runs",
    draws: [
      (page, font) => page.drawText("UTILITY METER #80 000", { x: 40, y: 260, size: 12, font }),
      (page, font) => page.drawText("1234", { x: 40 + font.widthOfTextAtSize("UTILITY METER #80 000 ", 12), y: 260, size: 12, font }),
    ],
  },
  {
    name: "the number rotated 90° in the title block",
    draws: [(page, font) => page.drawText(`METER ${METER}`, { x: 740, y: 200, size: 11, font, rotate: degrees(90) })],
  },
  {
    // Tight tracking (Tc < 0): the run's advance ends a third of an em before its last glyph's
    // ink does. A substituted, wider face does the same to a run's last glyph (CI's fonts did, #610).
    name: "the number set with tight tracking (ink past the run's advance)",
    draws: [(page, font) => {
      page.pushOperators(setCharacterSpacing(-3.5));
      page.drawText(METER, { x: 40, y: 220, size: 10, font }); // the number alone: every pixel is a digit
      page.pushOperators(setCharacterSpacing(0));
    }],
  },
  {
    name: "the account number in a filled form field",
    draws: [(page, _font, pdf) => {
      const field = pdf.getForm().createTextField("utility.account");
      field.setText(ACCOUNT);
      field.addToPage(page, { x: 300, y: 400, width: 200, height: 24, borderWidth: 0 });
    }],
  },
];

// --- RULE 2: every glyph pixel of the secret is painted in the image that is sent -------------
for (const c of CASES) {
  const withBytes = await sheet(c.draws, true);
  const withoutBytes = await sheet(c.draws, false);
  const withPath = write(withBytes, "with"), withoutPath = write(withoutBytes, "without");
  const image = await renderPdfPageForVision(withPath, 1, SECRETS);
  if (!image.ok) { run(`${c.name}: the page is masked, not withheld`, false, image.reason); continue; }
  const unmasked = await renderPdfPageToPng(withPath, 1);
  const cov = await coverage(image.png, unmasked, await renderPdfPageToPng(withoutPath, 1));
  run(`${c.name}: setup: the secret draws pixels`, cov.secretPixels > 50 && cov.sizeMatches, json(cov));
  run(`${c.name}: every pixel the secret touches is painted over`, cov.visible === 0 && image.masked > 0, json({ ...cov, masked: image.masked }));
  run(`${c.name}: the sheet's other text is untouched`, cov.otherTextChanged === 0, json(cov));
}

// --- MUST-PASS: no secret on the page, or none on the project → the page as it always went ------
{
  const bytes = await sheet([], false);
  const file = write(bytes, "clean");
  const plain = await renderPdfPageToPng(file, 1);
  const forVision = await renderPdfPageForVision(file, 1, SECRETS);
  run("a secret-free page is sent byte-for-byte as rendered", forVision.ok && forVision.masked === 0 && forVision.png.equals(plain));
  const withSecretFile = write(await sheet(CASES[0].draws, true), "nosecrets");
  const noSecrets = await renderPdfPageForVision(withSecretFile, 1, []);
  run("a project with no secrets sends the page as rendered",
    noSecrets.ok && noSecrets.png.equals(await renderPdfPageToPng(withSecretFile, 1)));
}

// --- the detector is redactSecretValues itself ---------------------------------------------------
{
  const items = [{ str: "UTILITY METER #80" }, { str: "000" }, { str: "1234 ON WALL" }, { str: "ROOF 80 000 12345" }];
  run("secretItemIndexes: a number split over three runs marks all three, and only them",
    json([...(secretItemIndexes(items, SECRETS) ?? [])].sort()) === json([0, 1, 2]));
  run("secretItemIndexes: a literal secret split mid-word is found by the joined probe",
    json([...(secretItemIndexes([{ str: "ESI AB12" }, { str: "34Z" }], ["AB1234Z"]) ?? [])].sort()) === json([0, 1]));
  run("secretItemIndexes: nothing to find → empty", secretItemIndexes([{ str: "METER 80 000 1235" }], SECRETS)?.size === 0);
  const q = itemQuad({ str: "X", transform: [10, 0, 0, 10, 100, 200], width: 50, height: 10 });
  run("itemQuad: the box covers the run from below the baseline to above the cap height",
    !!q && q[0][0] < 100 && q[0][1] < 200 && q[2][0] > 150 && q[2][1] > 210, json(q));
}

// --- glyph ink past the box is followed, font-independently (#610 CI: a fallback face's digits ran
// past their advance box). A synthetic 40x20 white image: a stroke from inside the paint box out
// past its edge, a separate blob inside the reach but not touching, and a stroke beyond the reach.
{
  const W = 40, H = 20;
  const img = new Uint8ClampedArray(W * H * 4).fill(255);
  // Grey ink: a pixel the mask paints reads 0, ink it leaves alone reads 60.
  const ink = (x: number, y: number, v = 60) => { const i = (y * W + x) * 4; img[i] = v; img[i + 1] = v; img[i + 2] = v; };
  for (let x = 8; x <= 16; x++) ink(x, 10);          // glyph stroke: starts inside the box (x < 12), runs out to 16
  ink(17, 10, 250);                                   // its faint anti-aliased tip
  ink(20, 5);                                         // a separate mark inside the reach, touching nothing
  for (let x = 16; x <= 30; x++) ink(x, 14);          // a rule that leaves the reach at x = 24
  for (let y = 10; y <= 14; y++) ink(16, y);          // ...joined to the stroke
  const box = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  paintMaskRegions(img, W, H, [{ paint: box(4, 6, 12, 12), reach: box(2, 2, 24, 18) }]);
  const isBlack = (x: number, y: number) => img[(y * W + x) * 4] === 0;
  run("paintMaskRegions: a stroke leaving the painted box is painted to its faint tip", [8, 12, 16, 17].every((x) => isBlack(x, 10)));
  run("paintMaskRegions: a separate mark in the reach is left alone", !isBlack(20, 5));
  run("paintMaskRegions: a connected rule is painted only inside the reach", isBlack(22, 14) && !isBlack(26, 14));
  run("paintMaskRegions: white outside the box stays white", img[(17 * W + 3) * 4] === 255 && img[(3 * W + 30) * 4] === 255);
}

// --- FAIL CLOSED: a hit with no box sends nothing -------------------------------------------------
{
  const noBox = planSecretMask([{ str: `METER ${METER}` }], [], SECRETS);
  run("a carrying run with no position → not sent", !noBox.ok, json(noBox));
  const zeroWidth = planSecretMask([{ str: `METER ${METER}`, transform: [10, 0, 0, 10, 0, 0], width: 0 }], [], SECRETS);
  run("a carrying run with no advance → not sent", !zeroWidth.ok, json(zeroWidth));
  const fieldNoRect = planSecretMask([], [{ fieldValue: ACCOUNT }], SECRETS);
  run("a carrying form field with no rect → not sent", !fieldNoRect.ok, json(fieldNoRect));
  const clean = planSecretMask([{ str: "PV-2 SITE PLAN" }], [{ fieldValue: "ROOF" }], SECRETS);
  run("nothing carries a secret → nothing to paint (positions not even needed)", clean.ok && clean.regions.length === 0, json(clean));
}

// --- END TO END: the reviewer vision pass ---------------------------------------------------------
const FINDING = {
  id: "city.plan.sld-weak", severity: "warning" as const, category: "plan_set" as const,
  title: "One-line diagram detail weak", message: "The SLD could not be confirmed from the text.",
  cityFeedback: "Provide a one-line diagram.", designTeamAction: "Add the one-line.",
  evidenceNeeded: ["One-line diagram with the main breaker and PV breaker"], codeReferences: [], installerCallout: false,
};
async function projectWith(bytes: Buffer, meterNumber = METER) {
  const p = createProject(db, {
    owner: `Mask Owner ${++n}`, street: `${n} Mask Way`, city: "Anytown", state: "OR", zip: "97000",
    ahj: "Mask City", utility: "Mask Power", dcKw: "6.0", meterNumber,
  }).project;
  saveProjectDocument(db, p.id, { docType: "plan_set", filename: `plan-set-${n}.pdf`, contentType: "application/pdf", buffer: bytes, source: "upload" });
  return p;
}
const report = (projectId: string) => ({
  projectId, generatedAt: new Date().toISOString(), matchedProcessProfile: null, findings: [FINDING], installerCallouts: [],
  finalSubmitGate: { mustShowAhjPreviewWindow: true, finalSubmitButtonAloneIsEnough: false, requirements: [] },
});
function recorder() {
  const calls: Array<{ prompt: string; image: Buffer }> = [];
  return {
    calls,
    llm: { async visionExtract(input: { imageBase64: string; prompt: string }) {
      calls.push({ prompt: input.prompt, image: Buffer.from(input.imageBase64, "base64") });
      return { present: false, confidence: "low", observed: "", missing: "" };
    } },
  };
}
{
  // The site-plan line the issue names, on a one-page plan set.
  const draws = CASES[0].draws;
  const p = await projectWith(await sheet(draws, true));
  const stored = findPlanSetPdf(db, p.id)!;
  const cropBefore = await renderPdfPageToPng(stored, 1);
  const rec = recorder();
  await applyVisionToReviewerReport(db, rec.llm as never, report(p.id) as never);
  run("setup: the vision pass sent the sheet", rec.calls.length > 0, json(rec.calls.length));
  const twin = write(await sheet(draws, false), "twin");
  let worst = { secretPixels: 0, visible: 0 };
  for (const call of rec.calls) {
    const cov = await coverage(call.image, cropBefore, await renderPdfPageToPng(twin, 1));
    if (cov.visible >= worst.visible) worst = cov;
  }
  run("RULE 2: no image the vision model received shows a pixel of the meter number",
    worst.secretPixels > 50 && worst.visible === 0, json(worst));
  run("the prompt text is the one main sends (same question hash)",
    rec.calls.every((c) => crypto.createHash("sha1").update(c.prompt).digest("hex").slice(0, 16) === visionQuestionFor(FINDING as never)));
  const cropAfter = await renderPdfPageToPng(stored, 1);
  run("the operator's cached crop is still the unmasked sheet", cropAfter.equals(cropBefore));
}
{
  // MUST-PASS end to end: a secret-free sheet goes exactly as rendered.
  const p = await projectWith(await sheet([], false));
  const rec = recorder();
  await applyVisionToReviewerReport(db, rec.llm as never, report(p.id) as never);
  const plain = await renderPdfPageToPng(findPlanSetPdf(db, p.id)!, 1);
  run("a secret-free sheet reaches vision byte-for-byte as rendered", rec.calls.length > 0 && rec.calls.every((c) => c.image.equals(plain)), json(rec.calls.length));
}
{
  // FAIL CLOSED end to end: the meter number is in a run squeezed to no width (Tz 0), so it has
  // no box to paint. The sheet is not sent, the finding says why, and nothing is cached.
  const draws: Draw[] = [(page, font) => {
    page.pushOperators(setCharacterSqueeze(0));
    page.drawText(`METER ${METER}`, { x: 40, y: 300, size: 10, font });
    page.pushOperators(setCharacterSqueeze(100));
  }];
  const p = await projectWith(await sheet(draws, true));
  const stored = findPlanSetPdf(db, p.id)!;
  const image = await renderPdfPageForVision(stored, 1, SECRETS);
  run("setup: a zero-width carrying run is withheld", !image.ok, json(image.ok ? { masked: image.masked } : image));
  const rec = recorder();
  const out = await applyVisionToReviewerReport(db, rec.llm as never, report(p.id) as never);
  run("FAIL CLOSED: no image is sent", rec.calls.length === 0, json(rec.calls.length));
  const v = out.findings[0].visionVerification;
  run("the finding records why the sheet was not sent", !!v && !v.checked && /Not sent to vision/.test(v.note) && /account or meter number/.test(v.note), json(v));
  run("the finding is not relaxed", out.findings[0].severity === "warning");
  const cached = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviewer_vision_cache WHERE project_id = ?", [p.id]);
  run("nothing is cached, so a later pass looks again", cached?.n === 0, json(cached));
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nvisionPageMask: all checks passed");
process.exit(0);
