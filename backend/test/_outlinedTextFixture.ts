// SYNTHETIC "OUTLINED TEXT" PLAN PAGES for #696 — invented, generated here, never a real plan set.
//
// A CAD export that draws its letters as filled vector shapes has no text layer and paints no
// raster. This builds such a page with pdf-lib: every character of the given lines is drawn as a
// 5 x 7 grid of small filled squares (a dot-matrix face, so a person can still read it on the
// rendered sheet), with no font and no image. Helper only (no `.test.ts`): the runner does not
// discover it.
import { PDFDocument, PDFPage, rgb } from "pdf-lib";

// 5 x 7 bitmaps, one string of 7 rows per character ("1" = ink).
const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

/** Draw `text` as outlines (filled squares, no font) with its top-left at (x, y), `cell` points per dot. */
export function drawOutlinedText(page: PDFPage, text: string, x: number, y: number, cell = 2): void {
  let d = "";
  let cx = 0;
  for (const ch of text.toUpperCase()) {
    const rows = GLYPHS[ch] ?? GLYPHS[" "];
    rows.forEach((row, r) => {
      for (let c = 0; c < 5; c++) {
        if (row[c] !== "1") continue;
        const px = cx + c * cell, py = r * cell;
        d += `M ${px} ${py} L ${px + cell} ${py} L ${px + cell} ${py + cell} L ${px} ${py + cell} Z `;
      }
    });
    cx += 6 * cell;
  }
  // drawSvgPath's y runs DOWN from (x, y), like SVG.
  if (d) page.drawSvgPath(d, { x, y, color: rgb(0, 0, 0) });
}

/** One outlined sheet: a frame, a title block and drawing notes, all as vector outlines. */
export function drawOutlinedSheet(page: PDFPage, lines: string[]): void {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 18, y: 18, width: width - 36, height: height - 36, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  lines.forEach((line, i) => drawOutlinedText(page, line, 40, height - 60 - i * 24, 2.4));
}

/** The default invented sheet lines: a site plan whose meter number is drawn as outlines. */
export const OUTLINED_SITE_PLAN_LINES = [
  "SITE PLAN  SHEET PV-2",
  "METER #40 000 777",
  "SYSTEM 6.40 KW DC",
  "16 MODULES 400 W",
  "MAIN PANEL 200 A",
];

export type FixturePage = "outlined" | "outlined-form" | "outlined-stray" | "outlined-logo" | "text" | "raster" | "blank";

/** A busy synthetic raster (w x h px) — a scanned sheet stand-in. */
async function rasterPng(w: number, h: number): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas" as string);
  const cv = createCanvas(w, h);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.fillStyle = "#000"; ctx.font = `${Math.max(10, Math.round(h / 24))}px sans-serif`;
  for (let y = 30; y < h; y += Math.round(h / 18)) ctx.fillText(`SYNTH SCANNED SHEET LINE ${y}  CONDUCTOR 10 AWG`, 20, y);
  return cv.toBuffer("image/png");
}

/** A whole PDF: `kinds[i]` says what page i+1 is.
 *  - "outlined": every letter drawn as vector outlines, no text layer, no raster;
 *  - "outlined-form": the same sheet, wrapped in a form XObject (a CAD export's usual shape);
 *  - "outlined-stray": an outlined sheet that also carries a few real text items ("PV 1.0", a sheet
 *    number the splitter scores as a site plan) — under the near-no-text bar;
 *  - "outlined-logo": an outlined sheet with a small raster logo (under the raster threshold);
 *  - "text": a normal sheet with a real text layer (Helvetica);
 *  - "raster": a scanned sheet (a 1200 x 800 picture, no text layer) — vision's, as today;
 *  - "blank": a frame and nothing else. */
export async function outlinedPlanSet(kinds: FixturePage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const { StandardFonts } = await import("pdf-lib");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, kind] of kinds.entries()) {
    if (kind === "raster" || kind === "outlined-logo") {
      const page = doc.addPage([1224, 792]);
      if (kind === "raster") {
        page.drawImage(await doc.embedPng(await rasterPng(1200, 800)), { x: 12, y: 0, width: 1200, height: 792 });
      } else {
        drawOutlinedSheet(page, OUTLINED_SITE_PLAN_LINES);
        page.drawImage(await doc.embedPng(await rasterPng(300, 200)), { x: 1000, y: 40, width: 150, height: 100 });
      }
      continue;
    }
    if (kind === "outlined-form") {
      const src = await PDFDocument.create();
      const sp = src.addPage([1224, 792]);
      drawOutlinedSheet(sp, OUTLINED_SITE_PLAN_LINES);
      const [embedded] = await doc.embedPdf(await src.save(), [0]);
      const page = doc.addPage([1224, 792]);
      page.drawPage(embedded, { x: 0, y: 0 });
      continue;
    }
    const page = doc.addPage([1224, 792]);
    if (kind === "outlined") drawOutlinedSheet(page, OUTLINED_SITE_PLAN_LINES);
    else if (kind === "outlined-stray") { drawOutlinedSheet(page, OUTLINED_SITE_PLAN_LINES); page.drawText("PV 1.0", { x: 1100, y: 30, size: 8, font }); }
    else if (kind === "blank") page.drawRectangle({ x: 18, y: 18, width: 1188, height: 756, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    else {
      page.drawText(`SHEET PV-${i + 1}  SYNTHETIC SOLAR PLAN SET  SITE PLAN`, { x: 40, y: 740, size: 18, font });
      for (let r = 0; r < 12; r++) page.drawText(`NOTE ${r}: CONDUCTOR ${100 + r} AWG PER PLAN ${i + 1}-${r}`, { x: 40, y: 700 - r * 28, size: 12, font });
      // A real sheet also draws: a frame and some linework.
      page.drawRectangle({ x: 18, y: 18, width: 1188, height: 756, borderWidth: 1, borderColor: rgb(0, 0, 0) });
      for (let k = 0; k < 40; k++) page.drawLine({ start: { x: 600 + k * 10, y: 100 }, end: { x: 600 + k * 10, y: 400 }, thickness: 0.5 });
    }
  }
  return doc.save();
}
