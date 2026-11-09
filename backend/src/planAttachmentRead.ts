// WHAT THE ATTACHMENT DETAIL AND THE DESIGN-LOAD LABELS SAY, READ OFF THE SHEETS (#336).
//
// The prescriptive screen passed a real plan set on presence: "Attachment/racking details included:
// Yes". A structural review of the same set found the only attachment detail fastened the roof hook
// INTO THE DECKING ("DECK MOUNT ... PENETRATE INTO DECKING") while a general note and the roof-plan
// legend said the attachments go to the framing members; every roof-plane schedule said TRUSS where the
// parse said rafter; and one sheet labelled the 20 psf ROOF snow load what another called the GROUND
// snow load, which is the number the prescriptive screen keys on.
//
// These readers are deterministic, read only the sheets' own words, and only ever add a question: a
// detail they cannot read stays unread (the caller says "verify / check with an engineer"), never a
// pass. Nothing here is keyed to a state, utility or city: the prescriptive gate that consumes them is
// the jurisdiction's own (codeReviewRules' prescriptiveScreening, from its code profile).
//
// Synthetic strings only in tests: no plan excerpt from a real job goes into this repo.
import type { ProjectRecord } from "../../shared/src/types";
import { extractStatedDesignCriteria, type DesignTextSource } from "./designCriteria";

/** One sheet's text and the name a reviewer can find it by. */
export interface PlanSheet {
  sheet: string;
  /** Upper-cased, whitespace-collapsed. */
  text: string;
}

/** The sheet id a page's own title block states ("SHEET: PV 1.1", "SHEET NO. S-1", "SHEET NUMBER:
 *  E 1.2"), or "" when it states none or more than one (a page that cites another sheet). */
export function sheetIdOf(page: string): string {
  const ids = new Set([...page.matchAll(/\bSHEET\s*(?:NO\.?|NUMBER|#|ID)?\s*[:#]?\s*([A-Z]{1,3}\s?-?\s?\d{1,2}(?:\.\d{1,2})?)\b/g)].map((m) => m[1].replace(/\s+/g, " ")));
  return ids.size === 1 ? [...ids][0] : "";
}

/** The package's sheets, one per page (pdf.js text is one line per page): the uploaded documents,
 *  then the plan set's text. A page with no sheet id is named by its document and page number. */
export function planSheets(project: Pick<ProjectRecord, "parserSnapshot">, documentTexts: DesignTextSource[] = []): PlanSheet[] {
  const sources = [
    ...documentTexts.map((d) => ({ label: d.label, text: String(d.text ?? "") })),
    { label: "Plan set", text: String(project.parserSnapshot?.planSetExtractedText ?? "") },
  ];
  const out: PlanSheet[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    s.text.split(/\n/).forEach((raw, i) => {
      const text = raw.toUpperCase().replace(/\s+/g, " ").trim();
      if (!text || text === "[NO TEXT LAYER]" || seen.has(text)) return;
      seen.add(text);
      out.push({ sheet: sheetIdOf(text) || `${s.label} page ${i + 1}`, text });
    });
  }
  return out;
}

/** A statement read off a sheet. */
export interface SheetQuote {
  sheet: string;
  excerpt: string;
}

// A clause that negates is a rule against the thing, not a statement of it: "ATTACHMENTS SHALL NOT BE
// FASTENED INTO THE DECKING ALONE", "NO DECK MOUNTS".
// "NO." is a number sign ("NO. 10 SCREW"), never a negation.
const NEGATION = /\b(?:NOT|NEVER|NOR|WITHOUT|PROHIBITED)\b|\bNO\b(?!\.)/;

function clauses(text: string): string[] {
  // A sentence ends at ". " — but "M6.3 X 65." and "O.C." end nothing that matters here, and a
  // decimal never has a space after its point.
  return text.split(/;|\.(?=\s|$)/).map((c) => c.trim()).filter(Boolean);
}

function quotes(sheets: PlanSheet[], patterns: RegExp[]): SheetQuote[] {
  const out: SheetQuote[] = [];
  for (const { sheet, text } of sheets) {
    for (const clause of clauses(text)) {
      for (const re of patterns) {
        const m = re.exec(clause);
        if (!m) continue;
        if (NEGATION.test(clause.slice(0, m.index + m[0].length))) continue;
        out.push({ sheet, excerpt: clause.slice(0, 200) });
        break;
      }
    }
  }
  return out;
}

// FASTENERS INTO THE DECKING. A named deck mount, or a fastener the detail drives INTO the decking /
// sheathing. "THROUGH THE SHEATHING INTO THE RAFTER" is a framing attachment and is not read here.
const DECK_MOUNT = [
  /\bDECK[-\s]?MOUNT(?:S|ED|ING)?\b/,
  /\b(?:PENETRAT\w*|FASTEN\w*|SCREW\w*|ANCHOR\w*|ATTACH\w*)\s+(?:[A-Z0-9().,"'-]+\s+){0,3}?INTO\s+(?:THE\s+)?(?:EXISTING\s+|\(E\)\s+)?(?:ROOF\s+)?(?:DECKING|DECK|SHEATHING)\b(?!\s+(?:AND|&)\s+(?:INTO\s+)?(?:THE\s+)?(?:RAFTER|TRUSS|JOIST|FRAMING))/,
];

// ATTACHED TO THE FRAMING: the note, the roof-plan legend, a lag into the member.
const TO_FRAMING = [
  /\bATTACHMENTS?\b[^;]{0,80}?\b(?:ROOF\s+)?FRAMING\s+MEMBERS?\b/,
  /\bATTACHMENT\s+POINTS?\s*[:=]\s*(?:RAFTERS?|TRUSS(?:ES)?|JOISTS?|FRAMING)\b/,
  /\bMOUNTED\s+TO\s+THE\s+ROOF\s*FRAMING\b/,
  /\b(?:LAG\w*|SCREW\w*|ATTACH\w*|FASTEN\w*|ANCHOR\w*)\s+(?:[A-Z0-9().,"'/-]+\s+){0,4}?INTO\s+(?:THE\s+)?(?:EXISTING\s+|\(E\)\s+)?(?:ROOF\s+)?(?:RAFTERS?|TRUSS(?:ES)?|JOISTS?|FRAMING(?:\s+MEMBERS?)?|STRUCTURAL\s+MEMBERS?)\b/,
];

// THE DECK-MOUNT BASIS: the sheathing it relies on (type AND thickness), and the listed capacity of
// the mount in that sheathing (a load in pounds, or the evaluation report that lists it).
const THICKNESS = String.raw`(?<![\d/.])(?:\d{1,2}\/\d{1,2}|0?\.\d{2,4})\s*(?:"|''|”|IN\b\.?|INCH(?:ES)?\b)?`;
const PANEL = String.raw`(?:PLYWOOD|OSB|ORIENTED\s+STRAND\s+BOARD)`;
const SHEATHING_SPEC = [
  new RegExp(String.raw`${THICKNESS}\s*(?:THICK\s+)?[^;.]{0,24}?\b${PANEL}\b`),
  new RegExp(String.raw`\b${PANEL}\b[^;.]{0,30}?${THICKNESS}`),
];
const CAPACITY = [
  /\b(?:PULL[-\s]?OUT|WITHDRAWAL|UPLIFT|TENSION|SHEAR|ALLOWABLE|DESIGN|LISTED|RATED)\s+(?:LOAD\s+)?(?:CAPACITY|VALUE|STRENGTH|RESISTANCE)\b[^;]{0,40}?\d+(?:\.\d+)?\s*(?:LBS?\b|LBF\b|#|POUNDS\b|KIPS?\b|KN\b)/,
  /\b(?:ICC[-\s]?ES|IAPMO(?:\s+UES)?)\b[^;]{0,20}?\b(?:ESR|ER)[-\s]?\d{3,5}\b/,
];

export interface DeckMountReading {
  /** Every clause that fastens into the decking. Empty: the set states no deck mount. */
  deckMount: SheetQuote[];
  /** Notes / legends / details that put the attachments on the framing members. */
  toFraming: SheetQuote[];
  /** The deck-mount basis the set states: sheathing type + thickness, and a listed capacity. */
  sheathing: SheetQuote[];
  capacity: SheetQuote[];
  /** A deck mount is stated and its basis (both halves) is not. */
  basisMissing: boolean;
}

export function readDeckMount(sheets: PlanSheet[]): DeckMountReading {
  const deckMount = quotes(sheets, DECK_MOUNT);
  const toFraming = quotes(sheets, TO_FRAMING);
  const sheathing = quotes(sheets, SHEATHING_SPEC);
  const capacity = quotes(sheets, CAPACITY);
  return { deckMount, toFraming, sheathing, capacity, basisMissing: deckMount.length > 0 && !(sheathing.length && capacity.length) };
}

/** "S 1.1: "…"; E 1.2: "…"" — at most `max` quotes, one line each. */
export function describeQuotes(qs: SheetQuote[], max = 3): string {
  const shown = qs.slice(0, max).map((q) => `${q.sheet}: "${q.excerpt}"`);
  return `${shown.join("; ")}${qs.length > max ? ` (+${qs.length - max} more)` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// ROOF SNOW vs GROUND SNOW. The prescriptive screen keys on GROUND snow (Pg). A sheet that labels a
// value ROOF snow while another labels the same value GROUND snow has one of them wrong, and the
// screen may be judging a roof snow load against a ground snow limit. The labels are read by the
// design-criteria extractor (designCriteria.ts — "a number is a ground snow load only when it is
// LABELLED ground snow"), one sheet at a time, so each reading carries its sheet.
// ---------------------------------------------------------------------------------------------

export type SnowLabelIssue =
  /** The same value is labelled ground snow on one sheet and roof snow on another. */
  | { kind: "conflict"; value: number; ground: SheetQuote[]; roof: SheetQuote[] }
  /** The sheets state a roof snow load and no ground snow load, and the parsed ground snow is that
   *  roof value: the screen's ground-snow input was never stated. */
  | { kind: "roof-only"; value: number; roof: SheetQuote[] };

export function readSnowLabels(sheets: PlanSheet[], parsedSnowPsf: number | null): SnowLabelIssue | null {
  if (!sheets.length) return null;
  const names = new Set(sheets.map((s) => s.sheet));
  // Labels must be unique per source for the extractor (it keys readings by label): suffix repeats.
  const used = new Map<string, number>();
  const labelled = sheets.map((s) => {
    const n = (used.get(s.sheet) ?? 0) + 1;
    used.set(s.sheet, n);
    return { label: n === 1 ? s.sheet : `${s.sheet} (${n})`, text: s.text, sheet: s.sheet };
  });
  const sheetOfLabel = new Map(labelled.map((l) => [l.label, l.sheet]));
  const stated = extractStatedDesignCriteria({ parserSnapshot: {} } as unknown as ProjectRecord, labelled.map(({ label, text }) => ({ label, text })))
    .criteria.filter((c) => !c.derived && typeof c.value === "number" && sheetOfLabel.has(c.source) && names.has(sheetOfLabel.get(c.source)!));
  const ground = stated.filter((c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground");
  // The governing roof snow labels: unqualified / design roof snow and flat pf. A sloped ps or the pm
  // minimum is a formula step, legitimately different from Pg.
  const roof = stated.filter((c) => c.criterion === "roofSnowPsf" && (c.qualifier === "roof" || c.qualifier === "flat"));
  const quote = (c: (typeof stated)[number]): SheetQuote => ({ sheet: sheetOfLabel.get(c.source)!, excerpt: c.excerpt });
  for (const g of ground) {
    const value = g.value as number;
    const gs = ground.filter((c) => c.value === value).map(quote);
    const rs = roof.filter((c) => c.value === value).map(quote);
    const gSheets = new Set(gs.map((q) => q.sheet));
    // Across SHEETS: one sheet printing both labels at one value is that sheet's own arithmetic.
    if (rs.some((r) => !gSheets.has(r.sheet))) return { kind: "conflict", value, ground: gs, roof: rs.filter((r) => !gSheets.has(r.sheet)) };
  }
  if (!ground.length && roof.length && parsedSnowPsf != null) {
    const rs = roof.filter((c) => c.value === parsedSnowPsf).map(quote);
    if (rs.length) return { kind: "roof-only", value: parsedSnowPsf, roof: rs };
  }
  return null;
}

/** One line for a checklist row or a finding: what the snow labels say, and why the screen cannot use it. */
export function describeSnowLabelIssue(issue: SnowLabelIssue): string {
  if (issue.kind === "conflict") {
    return `${issue.value} psf is labelled GROUND snow on ${[...new Set(issue.ground.map((q) => q.sheet))].join(", ")} `
      + `and ROOF snow on ${[...new Set(issue.roof.map((q) => q.sheet))].join(", ")} (${describeQuotes([...issue.ground, ...issue.roof], 4)})`;
  }
  return `the sheets state a ROOF snow load of ${issue.value} psf (${describeQuotes(issue.roof)}) and no ground snow load, `
    + `but the parsed ground snow load is that same ${issue.value} psf`;
}
