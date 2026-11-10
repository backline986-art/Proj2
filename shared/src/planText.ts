// PLAN-SET TEXT FOR THE EXTRACTION PROMPT: EACH PAGE ONCE, CUT BY WHOLE PAGES (#697).
//
// The parser page used to post each PDF page's text twice: a layout-ordered copy (items grouped by
// line, left to right) and then the raw item order of the SAME words. The backend then bounded the
// plan text at 80,000 characters (first 60,000, "[Middle text omitted]", last 20,000). With every
// page doubled the window held about 40,000 characters of unique sheet text, and the middle cut fell
// mid-page on whatever sat in the middle of the set: the three-line diagram, the structural notes.
//
// Two pure rules, used by both doors:
//   - textOncePerPage: a page whose text is two halves made of the SAME words (the doubled copy)
//     keeps its first half, the layout copy the extraction prompt was tuned on. The parser page runs
//     the browser copy of this (frontend/parser-review.js, pinned to this one by
//     backend/test/planTextOnce.test.ts) before it posts; the backend runs it again so a tab opened
//     before the change cannot double the prompt.
//   - planTextWindow: over the limit, whole pages are dropped from the MIDDLE and the marker names
//     them ("pages 9-12 not read"), so the parser review can say which sheets the model never saw.
//
// Generic on purpose: no design platform, utility, AHJ or state is named; the rules read only the
// "--- PAGE n ---" markers the extractors write and the words on each page.

/** The extraction prompt's plan-text bound (characters). Unchanged by #697: only what fits changed. */
export const PLAN_TEXT_CHAR_LIMIT = 80_000;
/** Of the bound, how much the front of the set gets before pages are dropped from the middle. */
export const PLAN_TEXT_HEAD_CHARS = 60_000;

const PAGE_MARKER = /---\s*(?:OCR\s+)?PAGE\s+(\d+)\s*---/gi;
const words = (s: string) => s.split(/\s+/).filter(Boolean);

function sameWords(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((w, i) => w === y[i]);
}

/**
 * One page's text, with a doubled copy collapsed to its first half. A page is doubled when a blank
 * line splits it into two parts made of exactly the same words (in any order or line breaking);
 * anything else is returned as it came. The whitespace after the page (the separator before the
 * next marker) is kept.
 */
export function collapseDoubledPage(body: string): string {
  const all = words(body);
  if (all.length < 2 || all.length % 2) return body;
  const half = all.length / 2;
  const blank = /\n[ \t]*\n/g;
  for (let m = blank.exec(body); m; m = blank.exec(body)) {
    const first = body.slice(0, m.index);
    const firstWords = words(first);
    if (firstWords.length > half) break;
    if (firstWords.length < half) continue;
    const rest = body.slice(m.index + m[0].length);
    if (sameWords(firstWords, words(rest))) return first + (/\s*$/.exec(rest)?.[0] ?? "");
  }
  return body;
}

/** The plan text with every doubled page collapsed to one copy. Text without page markers is read
 *  as one page. */
export function textOncePerPage(text: string): string {
  const src = String(text ?? "");
  const hits = [...src.matchAll(PAGE_MARKER)];
  if (!hits.length) return collapseDoubledPage(src);
  let out = src.slice(0, hits[0].index);
  hits.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index! : src.length;
    out += m[0] + collapseDoubledPage(src.slice(start, end));
  });
  return out;
}

export interface PlanTextWindow {
  /** The text the model is given. */
  text: string;
  /** Page numbers left out of `text` (empty when everything fit). */
  omittedPages: number[];
}

/** "page 4" / "pages 9-12" / "pages 3, 5-7". */
export function pageListLabel(pages: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    runs.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return `${pages.length === 1 ? "page" : "pages"} ${runs.join(", ")}`;
}

/**
 * Bound the plan text at `limit` characters. Within the limit it is returned whole. Over it, the
 * front of the set is kept up to `head` characters and the back fills what is left, BOTH BY WHOLE
 * PAGES; the pages between are replaced by one marker that names them. Only when there are no
 * page markers, or the first page alone is over `head`, does the cut fall inside a page (the old
 * character cut, which says so).
 */
export function planTextWindow(text: string, limit = PLAN_TEXT_CHAR_LIMIT, head = PLAN_TEXT_HEAD_CHARS): PlanTextWindow {
  const src = String(text ?? "");
  if (src.length <= limit) return { text: src, omittedPages: [] };
  const charCut = (): PlanTextWindow => ({
    text: src.slice(0, head) + "\n[Middle text omitted: the plan text is over the character limit; this cut falls inside a page]\n" + src.slice(-(limit - head)),
    omittedPages: [],
  });
  const hits = [...src.matchAll(PAGE_MARKER)];
  if (hits.length < 2) return charCut();
  // Each chunk runs from its marker to the next one; any text before the first marker rides
  // with the first page.
  const chunks = hits.map((m, i) => ({
    page: Number(m[1]),
    text: src.slice(i === 0 ? 0 : m.index!, i + 1 < hits.length ? hits[i + 1].index! : src.length),
  }));
  const markerFor = (pages: number[]) =>
    `[Plan text omitted: ${pageListLabel(pages)} not read (the plan text is over the ${limit.toLocaleString("en-US")}-character limit)]\n\n`;
  // Reserve room for the marker at its longest (every page named).
  const reserve = markerFor(chunks.map((c) => c.page)).length;
  const budget = limit - reserve;
  let front = 0;
  let used = 0;
  while (front < chunks.length && used + chunks[front].text.length <= Math.min(head, budget)) used += chunks[front++].text.length;
  if (front === 0) return charCut();
  let back = chunks.length;
  while (back - 1 >= front && used + chunks[back - 1].text.length <= budget) used += chunks[--back].text.length;
  // Room the back did not need goes to the front, still in order.
  while (front < back && used + chunks[front].text.length <= budget) used += chunks[front++].text.length;
  const omitted = chunks.slice(front, back).map((c) => c.page);
  if (!omitted.length) return { text: src, omittedPages: [] };
  const keepFront = chunks.slice(0, front).map((c) => c.text).join("");
  const keepBack = chunks.slice(back).map((c) => c.text).join("");
  return { text: keepFront + markerFor(omitted) + keepBack, omittedPages: omitted };
}
