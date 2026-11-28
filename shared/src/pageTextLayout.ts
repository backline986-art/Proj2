// A PDF PAGE'S TEXT IN READING ORDER, FROM ITEM GEOMETRY, AT ANY PAGE ROTATION.
//
// pdf.js hands back a page's text items in content-stream order with each item's matrix in the
// page's UNROTATED user space. Two readers went wrong on that:
//   - the Parser page grouped items into lines by the raw matrix position. On a sheet stored with
//     /Rotate 90 or 270 (landscape CAD sheets are commonly stored that way) "the same y" is a visual
//     COLUMN, so a table reached the model column by column: every label, then every value;
//   - the unattended doors (email intake, bulk drop) joined the items in stream order, which is
//     whatever order the drawing tool wrote them in — a table written column by column came apart
//     the same way whatever the rotation.
//
// layoutTextFromItems places every item through the page's VIEWPORT transform (which carries
// /Rotate and the page box), so a line is a line as the page is displayed. Text is grouped by the
// direction it reads in AFTER that transform: upright text forms the page's rows; text turned a
// quarter or half turn on the displayed page (a sideways label, a rotated title block) is laid out
// in its own reading frame and appended, instead of being scattered through the rows.
//
// With no viewport transform (or an unrotated page of upright text) the result is exactly what the
// Parser page's reader produced before: same 3-unit line tolerance, same order, same joins.
//
// THE BROWSER COPY is frontend/parser-review.js (layoutTextFromItems / normalizeText): the Parser
// page is a classic script and cannot import this file. backend/test/pageTextLayout.test.ts pins
// the two equal on a generated corpus, the way planTextOnce.test.ts pins textOncePerPage.

export interface LayoutTextItem { str?: string; transform?: number[] }

const LINE_TOLERANCE = 3;

/** Viewport transform of an unrotated page with the y axis flipped: reproduces the legacy order. */
const LEGACY_VIEW = [1, 0, 0, -1, 0, 0];

export function layoutTextFromItems(items: readonly LayoutTextItem[] | null | undefined, viewportTransform?: readonly number[] | null): string {
  const V = Array.isArray(viewportTransform) && viewportTransform.length === 6 && viewportTransform.every((n) => Number.isFinite(Number(n)))
    ? viewportTransform.map(Number)
    : LEGACY_VIEW;
  // One list per reading direction on the displayed page: 0 upright, 1 reads downward (turned a
  // quarter clockwise), 2 upside down, 3 reads upward.
  const frames: Array<Array<{ str: string; u: number; v: number }>> = [[], [], [], []];
  for (const item of items || []) {
    const str = String((item && item.str) || "").trim();
    if (!str) continue;
    const tx = (item && item.transform) || [1, 0, 0, 1, 0, 0];
    const a = Number(tx[0] || 0), b = Number(tx[1] || 0), e = Number(tx[4] || 0), f = Number(tx[5] || 0);
    const px = V[0] * e + V[2] * f + V[4];
    const py = V[1] * e + V[3] * f + V[5];
    // The item's reading direction on the displayed page (y grows downward there).
    const dx = V[0] * a + V[2] * b;
    const dy = V[1] * a + V[3] * b;
    const frame = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
    // (u, v): along the reading direction, and down across the lines, in that frame.
    const uv = frame === 0 ? [px, py] : frame === 2 ? [-px, -py] : frame === 1 ? [py, -px] : [-py, px];
    frames[frame].push({ str, u: uv[0], v: uv[1] });
  }
  const blocks: string[] = [];
  for (const mapped of frames) {
    if (!mapped.length) continue;
    // PDF text item order is not always visual order. Group by line position, then left to right.
    mapped.sort((p, q) => (Math.abs(p.v - q.v) > LINE_TOLERANCE ? p.v - q.v : p.u - q.u));
    const lines: Array<{ v: number; items: typeof mapped }> = [];
    for (const item of mapped) {
      const last = lines[lines.length - 1];
      if (!last || Math.abs(last.v - item.v) > LINE_TOLERANCE) lines.push({ v: item.v, items: [item] });
      else last.items.push(item);
    }
    blocks.push(lines.map((line) => line.items.sort((p, q) => p.u - q.u).map((i) => i.str).join(" ")).join("\n"));
  }
  return blocks.join("\n");
}

/** The Parser page's text normalisation (dash / quote / space forms; a stray bar read as a one),
 *  so both doors hand the model the same characters. */
export function normalizePageText(raw: unknown): string {
  return String(raw || "")
    .replace(/–|—|−/g, "-")
    .replace(/ /g, " ")
    .replace(/[|]/g, "1")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/** A whole document's text as the model is given it at every door: each page under its
 *  "--- PAGE n ---" marker (shared/src/planText.ts cuts and names whole pages by these), in
 *  reading order. `pages[i]` is page i + 1. */
export function pageMarkedLayoutText(pages: ReadonlyArray<{ items: readonly LayoutTextItem[]; viewportTransform?: readonly number[] | null }>): string {
  return pages.map((p, i) => `--- PAGE ${i + 1} ---\n${normalizePageText(layoutTextFromItems(p.items, p.viewportTransform))}`).join("\n\n");
}
