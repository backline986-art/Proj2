// SAFETY RULE 2 AT THE VISION DOOR — THE PAGE IMAGE (#293).
//
// The reviewer's vision pass scrubs every word of its PROMPT with the project's own secrets
// (reviewerVision.visionPrompt), but the plan-set sheet goes with the prompt as an image. A site
// plan that prints "…tied to exterior utility meter #80 000 100…" puts the meter number in the
// pixels, where no text scrub reaches. So before a sheet is sent, its own text items (pdf.js, the
// same items extractPdfPages reads) are run through the SAME detector the prompt uses —
// redactSecretValues with projectSecretValues — and every item that carries a hit is painted over
// on the rendered page. An item whose box cannot be placed fails closed: that page is not sent.
//
// This module is the pure half (which items, and where they sit on the page); the render and the
// paint live in pageImages.renderPdfPageForVision. No pattern is copied here: the hit positions
// come from redactSecretValues itself, by asking it to replace each hit with a same-length run of
// a marker character and reading back where the markers landed.

import { redactSecretValues } from "../../shared/src/portalSafety";

/** The parts of a pdf.js text item this module reads. */
export interface MaskTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/** A widget/annotation as pdf.js lists it: its appearance is drawn onto the page by render(), but
 *  its text is not in getTextContent(), so a filled form field is checked here on its own. */
export interface MaskAnnotation {
  rect?: number[];
  fieldValue?: unknown;
  contents?: unknown;
  alternativeText?: unknown;
}

/** A quadrilateral in PDF user space (four [x, y] corners, in drawing order). */
export type PdfQuad = Array<[number, number]>;

// Never in extracted text that matters: any stray one in an item is turned into a space first, so a
// marker in the scrubbed text can only be one the replacer wrote.
const MARK = "\u0000";

/** True when the detector would change `text` — the text carries one of `secrets`. */
export function carriesSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.length > 0 && redactSecretValues(text, secrets) !== text;
}

/**
 * Indexes of the items whose text carries part of a project secret.
 *
 * pdf.js splits a printed number wherever its producer did ("#80 000" | "100", or a run per glyph),
 * so the items are joined the way extractPdfPages joins them (a space between items) AND with
 * nothing between them (a number split mid-run, or a short literal secret split inside a word), and
 * a hit in either join marks every item it touches.
 *
 * null when a hit was found but could not be mapped back to items (it cannot happen while the
 * replacer keeps lengths, and fails closed if it ever does).
 */
export function secretItemIndexes(items: readonly MaskTextItem[], secrets: readonly string[]): Set<number> | null {
  const hits = new Set<number>();
  if (!secrets.length) return hits;
  for (const sep of [" ", ""]) {
    let text = "";
    const owner: number[] = [];
    items.forEach((item, i) => {
      if (i > 0 && sep) {
        text += sep;
        owner.push(-1);
      }
      const s = (item.str ?? "").split(MARK).join(" ");
      text += s;
      for (let k = 0; k < s.length; k++) owner.push(i);
    });
    const marked = redactSecretValues(text, secrets, (hit) => MARK.repeat(hit.length));
    if (marked === text) continue;
    if (marked.length !== text.length) return null;
    for (let k = 0; k < marked.length; k++) {
      if (marked[k] === MARK && owner[k] >= 0) hits.add(owner[k]);
    }
    if (!hits.size) return null;
  }
  return hits;
}

/** How far past an item's advance box (in ems of its type) a quad reaches. */
export interface QuadPad { side: number; below: number; above: number }

/** The box painted outright: descenders, accents and ordinary side bearings stay inside it. */
export const PAINT_PAD: QuadPad = { side: 0.25, below: 0.35, above: 1.15 };
/** How far ink CONNECTED to the painted box is followed and painted too. The advance box is where
 *  the font's metrics put the run, not where its ink is: tight tracking (a negative Tc) or a
 *  substituted, wider face (a non-embedded font drawn with whatever the machine has) puts the last
 *  glyph's ink past the advance. Seen on CI for #610, where the local machine's face fit. */
export const REACH_PAD: QuadPad = { side: 1.25, below: 0.8, above: 1.8 };

/**
 * The box an item's glyphs occupy, in PDF user space, padded by `pad` ems of its type (by default
 * from 0.35 em below the baseline to 1.15 em above it, and 0.25 em past each end). Follows the
 * item's own direction (transform), so rotated title-block text is covered too. null when the item
 * has no usable position or advance (fail closed).
 */
export function itemQuad(item: MaskTextItem, pad: QuadPad = PAINT_PAD): PdfQuad | null {
  const t = item.transform;
  const width = Number(item.width);
  if (!t || t.length < 6 || !t.slice(0, 6).every(Number.isFinite) || !(width > 0) || !Number.isFinite(width)) return null;
  const [a, b, c, d, e, f] = t;
  const along = Math.hypot(a, b);
  const up = Math.hypot(c, d);
  if (!(along > 0) || !(up > 0)) return null;
  const height = Number(item.height) > 0 && Number.isFinite(Number(item.height)) ? Number(item.height) : up;
  const ux = a / along, uy = b / along; // reading direction
  const vx = c / up, vy = d / up; // glyph "up"
  const left = -pad.side * height, right = width + pad.side * height;
  const bottom = -pad.below * height, top = pad.above * height;
  const at = (x: number, y: number): [number, number] => [e + ux * x + vx * y, f + uy * x + vy * y];
  return [at(left, bottom), at(right, bottom), at(right, top), at(left, top)];
}

/** An annotation's rect as a quad, or null when it has none usable. */
export function annotationQuad(annotation: MaskAnnotation): PdfQuad | null {
  const r = annotation.rect;
  if (!r || r.length < 4 || !r.slice(0, 4).every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = r;
  if (x1 === x2 || y1 === y2) return null;
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}

/** The text an annotation draws on the page (a form field's value, a note's contents). */
export function annotationText(annotation: MaskAnnotation): string {
  const parts: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" || typeof v === "number") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(add);
  };
  add(annotation.fieldValue);
  add(annotation.contents);
  add(annotation.alternativeText);
  return parts.join(" ");
}

/** One carrier to mask: `paint` is painted outright; ink connected to it is followed out to `reach`. */
export interface MaskRegion<Q = PdfQuad> { paint: Q; reach: Q }

export type SecretMaskPlan =
  | { ok: true; regions: MaskRegion[] }
  | { ok: false; reason: string };

/**
 * What must be painted over before this page may go to a vision model: the boxes of every text item
 * and annotation that carries a project secret. ok:false (do not send the page) when a carrier has
 * no box. An empty quads list means the page carries no secret and goes as rendered.
 */
export function planSecretMask(items: readonly MaskTextItem[], annotations: readonly MaskAnnotation[], secrets: readonly string[]): SecretMaskPlan {
  const regions: MaskRegion[] = [];
  if (!secrets.length) return { ok: true, regions };
  const hits = secretItemIndexes(items, secrets);
  if (hits === null) return { ok: false, reason: "the page's text carries an account or meter number that could not be located on the sheet" };
  for (const i of [...hits].sort((x, y) => x - y)) {
    const paint = itemQuad(items[i]);
    const reach = itemQuad(items[i], REACH_PAD);
    if (!paint || !reach) return { ok: false, reason: "the page's text carries an account or meter number in a text run with no position to mask" };
    regions.push({ paint, reach });
  }
  for (const annotation of annotations) {
    if (!carriesSecret(annotationText(annotation), secrets)) continue;
    const quad = annotationQuad(annotation);
    if (!quad) return { ok: false, reason: "a form field on the page carries an account or meter number and has no box to mask" };
    // A widget's appearance is clipped to its rect, so its ink never leaves it.
    regions.push({ paint: quad, reach: quad });
  }
  return { ok: true, regions };
}

type Pt = readonly [number, number] | readonly number[];
function inside(x: number, y: number, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** Any corner or the centre of pixel (px, py) inside the polygon: a pixel the edge only grazes counts. */
function touches(px: number, py: number, poly: readonly Pt[]): boolean {
  return inside(px + 0.5, py + 0.5, poly) || inside(px, py, poly) || inside(px + 1, py, poly) || inside(px, py + 1, poly) || inside(px + 1, py + 1, poly);
}

/**
 * Paint the regions black, in place, on an RGBA image (device pixels; region corners already in
 * device space). Every pixel `paint` touches goes black with no anti-aliased edge; then any ink
 * (a pixel that is not pure white) 8-connected to a painted pixel is painted too, as far as `reach`
 * — so a glyph whose ink runs past its advance box goes whole. Bounded by `reach`, so a table rule
 * through the number is painted only near it. Returns how many pixels were painted.
 */
export function paintMaskRegions(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, regions: ReadonlyArray<MaskRegion<readonly Pt[]>>): number {
  let painted = 0;
  const blacken = (i: number) => { rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 255; painted++; };
  for (const { paint, reach } of regions) {
    const xs = [...paint, ...reach].map((p) => p[0]), ys = [...paint, ...reach].map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)) + 1);
    if (x1 < x0 || y1 < y0) continue;
    const bw = x1 - x0 + 1;
    const seen = new Uint8Array(bw * (y1 - y0 + 1));
    const queue: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!touches(x, y, paint)) continue;
        seen[(y - y0) * bw + (x - x0)] = 1;
        blacken((y * width + x) * 4);
        queue.push(x, y);
      }
    }
    while (queue.length) {
      const y = queue.pop()!, x = queue.pop()!;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
          const k = (ny - y0) * bw + (nx - x0);
          if (seen[k]) continue;
          seen[k] = 1;
          const i = (ny * width + nx) * 4;
          const ink = rgba[i] < 255 || rgba[i + 1] < 255 || rgba[i + 2] < 255;
          if (!ink || !touches(nx, ny, reach)) continue;
          blacken(i);
          queue.push(nx, ny);
        }
      }
    }
  }
  return painted;
}
