// PLAN PAGES WHOSE TEXT IS DRAWN AS OUTLINES (#696 part 1): found, said, and never sent to a model.
//
// Some CAD exports draw every letter as a filled vector shape instead of a font glyph. The sheet
// prints normally, but its text layer is empty: the text parser sees a blank page, the splitter
// cannot name it, and because it paints no picture it also sits under the raster threshold that
// routes a scanned page to vision (scannedPlanSet.imageOnlyPages, MIN_RASTER_PIXELS). Neither path
// reads it, and nothing said so: the submit gate then reported sheets "missing" from a plan set that
// has them.
//
// Detection is deterministic, from the page's own drawing (pdf.js, the parser the renderer uses):
//   - its text layer holds fewer than OUTLINED_MAX_TEXT_CHARS letters/digits (no or near-no text —
//     the same per-page bar as scannedPlanSet's "no usable text layer"), AND
//   - it paints less than OUTLINED_MAX_RASTER_PIXELS of raster (a scan is vision's, as today), AND
//   - it draws at least OUTLINED_MIN_PATH_SEGMENTS vector path segments (a blank or frame-only page
//     is not an unread sheet; ten outlined letters already pass this bar).
// The operator list is read only for a page whose text is already short, so a normal text page
// costs nothing extra and is judged exactly as before.
//
// WHAT HAPPENS TO SUCH A PAGE (Helm's ruling on #696: "withhold and say so"). It is reported as
// "unread: text drawn as outlines; a person reads this page" and is withheld from EVERY model: the
// two vision renderers (pageImages.openPdfForVisionRender and renderPdfPageForVision — every door
// that turns a plan page into an image for a model goes through one of them) refuse it with
// VisionPageWithheldError before anything is drawn. Rule 2 is why: the page mask (#612/#680) finds
// account and meter digits in the TEXT layer, and here there is none, so a mask would have nothing
// to find. A route to vision for these pages (a local OCR pass that masks digit runs) is part 2 of
// the issue and safety-critical; nothing here sends one.
//
// Universal: a property of the PDF's drawing, never of a portal, utility, design firm, city or state.

/** Why such a page is not read (the words of the report and of a withheld render). */
export const OUTLINED_TEXT_WHY = "text drawn as outlines; a person reads this page";
/** The page's status in every report (parser review, QC, splitter, the submit gate). */
export const OUTLINED_TEXT_REASON = `unread: ${OUTLINED_TEXT_WHY}`;

/** Fewer letters/digits than this on a page = no usable text layer. Equal to scannedPlanSet's
 *  MIN_CHARS_PER_PAGE (pinned by outlinedTextPages.test). */
export const OUTLINED_MAX_TEXT_CHARS = 40;
/** A page painting at least this much raster is a picture (vision's, as today). Equal to
 *  scannedPlanSet's MIN_RASTER_PIXELS (pinned by outlinedTextPages.test). */
export const OUTLINED_MAX_RASTER_PIXELS = 500_000;
/** Vector path segments (move / line / curve) a page must draw to be an outlined sheet rather than a
 *  blank or frame-only page. A sheet border is 4-20; one outlined letter is roughly 10-40. */
export const OUTLINED_MIN_PATH_SEGMENTS = 200;

export interface PageDrawingStats {
  /** Letters/digits in the page's text layer. */
  textChars: number;
  /** Vector path segments the page draws (0 when not counted: the text was long enough). */
  pathSegments: number;
  /** Raster pixels the page paints (image XObjects and inline images, at their own resolution). */
  rasterPixels: number;
}

/** Letters/digits in a page's text items. */
export function textCharsOf(strs: Iterable<string>): number {
  let n = 0;
  for (const s of strs) n += String(s ?? "").replace(/[^A-Za-z0-9]/g, "").length;
  return n;
}

/** THE predicate: no or near-no text, under the raster threshold, and a vector-heavy drawing. */
export function isOutlinedTextPage(stats: PageDrawingStats): boolean {
  return stats.textChars < OUTLINED_MAX_TEXT_CHARS
    && stats.rasterPixels < OUTLINED_MAX_RASTER_PIXELS
    && stats.pathSegments >= OUTLINED_MIN_PATH_SEGMENTS;
}

/** The pdf.js operator-list fields read here (a structural subset of PDFOperatorList). */
export interface OperatorListLike { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }
/** The pdf.js OPS codes read here. */
export type OpsLike = Record<string, number>;

const isNumArray = (v: unknown): v is ArrayLike<number> =>
  Array.isArray(v) ? v.every((x) => typeof x === "number") : ArrayBuffer.isView(v) && !(v instanceof DataView);

/** Path segments in one constructPath op. pdf.js 5+ packs the path as [paintOp, [Float32Array of
 *  DrawOPS codes and their coordinates], minMax]: moveTo 0 (+2), lineTo 1 (+2), curveTo 2 (+6),
 *  quadraticCurveTo 3 (+4), closePath 4 (+0). Older pdf.js passed [ops[], coords[], minMax]. An
 *  unrecognised shape counts as one segment, so a version change can only under-count — and an
 *  under-count is caught by the pin in outlinedTextPages.test, not by withholding fewer pages quietly. */
function segmentsOfConstructPath(args: unknown): number {
  if (!Array.isArray(args)) return 1;
  const [a0, a1] = args as unknown[];
  // Older shape: an array of op codes, then the coordinates.
  if (Array.isArray(a0) && a0.every((x) => typeof x === "number")) return (a0 as number[]).length;
  if (Array.isArray(a1)) {
    let n = 0;
    for (const buf of a1) {
      if (!isNumArray(buf)) continue;
      for (let i = 0; i < buf.length; ) {
        const op = buf[i];
        if (op === 0 || op === 1) { n++; i += 3; } else if (op === 2) { n++; i += 7; } else if (op === 3) { n++; i += 5; } else if (op === 4) { i += 1; } else break;
      }
    }
    return Math.max(1, n);
  }
  return 1;
}

/** Vector segments and raster pixels a page's operator list draws. Form XObjects are already
 *  inlined in a pdf.js operator list, so a CAD sheet wrapped in one form is counted whole. */
export function drawingStatsFromOperatorList(list: OperatorListLike, OPS: OpsLike): { pathSegments: number; rasterPixels: number } {
  let pathSegments = 0;
  let rasterPixels = 0;
  const dim = (o: unknown) => {
    const r = (o && typeof o === "object" ? o : {}) as { width?: unknown; height?: unknown };
    const w = Number(r.width), h = Number(r.height);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w * h : 0;
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as unknown[] | null | undefined;
    if (fn === OPS.constructPath) pathSegments += segmentsOfConstructPath(args);
    else if (fn === OPS.rectangle) pathSegments += 4;
    else if (fn === OPS.moveTo || fn === OPS.lineTo || fn === OPS.curveTo || fn === OPS.curveTo2 || fn === OPS.curveTo3) pathSegments += 1;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      // [objId, width, height, …]
      const w = Number(args?.[1]), h = Number(args?.[2]);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) rasterPixels += w * h;
    } else if (fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat || fn === OPS.paintSolidColorImageMask) {
      rasterPixels += dim(args?.[0]);
    } else if (fn === OPS.paintInlineImageXObjectGroup || fn === OPS.paintImageMaskXObjectGroup) {
      const imgs = args?.[0];
      if (Array.isArray(imgs)) for (const im of imgs) rasterPixels += dim(im);
      else rasterPixels += dim(imgs);
    }
  }
  return { pathSegments, rasterPixels };
}

/** The pdf.js page fields read here. */
export interface PdfjsDrawingPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
  getOperatorList: () => Promise<OperatorListLike>;
}

let opsCache: OpsLike | null = null;
async function pdfjsOps(): Promise<OpsLike> {
  if (!opsCache) opsCache = (await import("pdfjs-dist/legacy/build/pdf.mjs")).OPS as unknown as OpsLike;
  return opsCache;
}

/** One pdf.js page's drawing stats. The operator list is read only when the text is short (the
 *  renderer reads the same, cached, list to draw the page). `textChars` may be passed when the
 *  caller already holds the page's text. */
export async function pdfjsPageDrawingStats(page: PdfjsDrawingPage, known: { textChars?: number } = {}): Promise<PageDrawingStats> {
  const textChars = known.textChars ?? textCharsOf((await page.getTextContent()).items.map((i) => String(i.str ?? "")));
  if (textChars >= OUTLINED_MAX_TEXT_CHARS) return { textChars, pathSegments: 0, rasterPixels: 0 };
  const stats = drawingStatsFromOperatorList(await page.getOperatorList(), await pdfjsOps());
  return { textChars, ...stats };
}

/** Is this pdf.js page an outlined-text page? A page whose drawing cannot be read is NOT known to
 *  be safe to send: the caller treats a throw as a refusal (the renderers do). */
export async function isOutlinedPdfjsPage(page: PdfjsDrawingPage): Promise<boolean> {
  return isOutlinedTextPage(await pdfjsPageDrawingStats(page));
}

/**
 * The 1-based outlined-text pages of a PDF. `pageTexts` (0-based, one entry per page, e.g. from
 * extractPdfPages or the parser's labels) lets a caller that already read the text skip re-reading
 * it; a page whose text clears the bar is never opened further. A page that cannot be read is left
 * out (it is reported by whatever failed to read it); a PDF that cannot be opened returns [].
 */
export async function outlinedTextPagesOfPdf(pdfBytes: Uint8Array, opts: { pageTexts?: readonly string[]; maxPages?: number } = {}): Promise<number[]> {
  // A page whose known text already clears the bar needs no PDF at all.
  if (opts.pageTexts && opts.pageTexts.length && opts.pageTexts.every((t) => textCharsOf([t]) >= OUTLINED_MAX_TEXT_CHARS)) return [];
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { pdfjsDocumentOptions } = await import("./pdfjsOptions");
  let doc: { numPages: number; getPage: (n: number) => Promise<unknown>; destroy?: () => Promise<void> };
  try {
    doc = await getDocument(pdfjsDocumentOptions({ data: new Uint8Array(pdfBytes), useSystemFonts: true, disableWorker: true } as Parameters<typeof pdfjsDocumentOptions>[0])).promise as unknown as typeof doc;
  } catch {
    return [];
  }
  const out: number[] = [];
  try {
    const last = Math.min(doc.numPages, Math.max(1, Math.floor(opts.maxPages ?? doc.numPages)));
    for (let n = 1; n <= last; n++) {
      const known = opts.pageTexts && n - 1 < opts.pageTexts.length ? textCharsOf([opts.pageTexts[n - 1]]) : undefined;
      if (known !== undefined && known >= OUTLINED_MAX_TEXT_CHARS) continue;
      try {
        const page = (await doc.getPage(n)) as PdfjsDrawingPage;
        if (isOutlinedTextPage(await pdfjsPageDrawingStats(page, { textChars: known }))) out.push(n);
      } catch { /* unreadable page: not claimed as outlined */ }
    }
  } finally {
    try { await doc.destroy?.(); } catch { /* best effort */ }
  }
  return out;
}

/** "page 3" / "pages 3, 7" for a report line. */
export function outlinedPagesPhrase(pages: readonly number[]): string {
  return `page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}`;
}

/** The report line for a set of outlined pages, e.g. "Plan-set pages 3, 7 unread: text drawn as
 *  outlines; a person reads this page. Nothing on them was sent to any model." */
export function outlinedPagesReport(pages: readonly number[], subject = "Plan-set"): string {
  if (!pages.length) return "";
  return `${subject} ${outlinedPagesPhrase(pages)} ${OUTLINED_TEXT_REASON}. Nothing on ${pages.length === 1 ? "it" : "them"} was sent to any model.`;
}

/** The plan-set SHEET types the splitter cuts (docSplitter CATEGORY_PATTERNS, pinned equal by
 *  outlinedTextPages.test): a "missing" one of these may be on an unread page. */
export const PLAN_SHEET_DOC_TYPES: ReadonlySet<string> = new Set(["sld", "site_plan", "structural", "module_spec", "inverter_spec", "battery_spec", "labels"]);

/** The clause the submit gate, Stage and QC add to a MISSING plan sheet when the plan set has unread
 *  pages: the sheet may be on one of them, and only a person can tell. "" when there is nothing to
 *  say (no unread page, or the row is not a plan sheet). */
export function outlinedPagesMissingSheetNote(docType: string, pages: readonly number[]): string {
  if (!pages.length || !PLAN_SHEET_DOC_TYPES.has(docType)) return "";
  return `plan-set ${outlinedPagesPhrase(pages)} ${pages.length === 1 ? "is" : "are"} unread (text drawn as outlines), so a person checks whether it is ${pages.length === 1 ? "that page" : "among them"} and splits it out by hand`;
}
