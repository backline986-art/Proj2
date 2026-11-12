// DOES THE PLAN SET AGREE WITH ITSELF? (#338)
//
// A plan reviewer reads a set across its sheets. On a live line-side-tap job (2026-10-14) the gate's
// findings stayed generic while the set contradicted itself: the point of interconnection was the
// INTERIOR main service panel on one sheet and the EXTERIOR main service disconnect on the next; the
// interconnection notes carried the load-side 120 % rule and a "DO NOT RELOCATE THIS OVERCURRENT
// DEVICE" label on a supply-side tap; an attic-run note said "SHUTDOWN – NO" beside a rapid shutdown
// note and placard; every label cited "NEC: 2020" on a 2023-NEC job; and the supply-side disconnect
// was never called suitable for use as service equipment. Each is something the designer fixes in one
// pass once both places are named.
//
// These readers are deterministic and read only the sheets' own words (planSheets: one page per
// sheet, named by its own title block). They make no model call and send nothing anywhere. Each one
// reports QUOTES, sheet by sheet; the caller (codeReviewRules) decides whether two quotes contradict
// and words the callout. A fact a reader did not find stays unread and yields no finding: the absence
// of a quote is never read as a contradiction. Nothing here names a state, utility, city or portal.
//
// An excerpt is the MATCHED PHRASE, never the clause around it: a page's text runs straight into its
// title block (homeowner name, address), so a window would carry it into the report.
//
// Synthetic strings only in tests: no plan excerpt from a real job goes into this repo.
import type { PlanSheet, SheetQuote } from "./planAttachmentRead";

/** One clause of a sheet: sentences end at "; " or ". " — but a decimal point has no space after it,
 *  and "NO. 2" is a number sign, so the clause keeps its number rather than ending in a bare "NO". */
function clauses(text: string): string[] {
  return text.split(/;|(?<!\bNO)\.(?=\s|$)|(?<=\bNO)\.(?=\s*$|\s+[^\d\s])/).map((c) => c.trim()).filter(Boolean);
}

// A mention is not a statement when it is negated ("NO LINE SIDE TAP", "120% RULE N/A") or offered
// as a condition ("WHERE A LINE SIDE TAP IS USED …", general notes written to cover both methods).
// The window is short on purpose: a page with no full stops is one long clause, and a "DO NOT TOUCH
// TERMINALS" forty words away negates nothing here.
const NEGATED_BEFORE = /\b(?:NOT|NO(?!\.)|NEVER|WITHOUT|NON|EXCEPT|OTHER\s+THAN)\b[^.;:]{0,20}$/;
const CONDITIONAL_BEFORE = /\b(?:IF|WHERE|WHEN|WHENEVER|UNLESS|OPTIONAL|ALTERNATE|ALTERNATIVE)\b[^.;:]{0,40}$/;
const NEGATED_AFTER = /^[^.;]{0,30}?\b(?:NOT\s+(?:APPLICABLE|APPLY|APPLIES|USED|REQUIRED|PROVIDED|PROPOSED)|DOES\s+NOT\s+APPLY|DO\s+NOT\s+APPLY|N\/A)(?![A-Z0-9])|^\s*[:=–—-]\s*(?:NO(?!\.)|NONE|N\/A)\b/;

function statedAt(clause: string, index: number, length: number): boolean {
  const before = clause.slice(Math.max(0, index - 50), index);
  const after = clause.slice(index + length, index + length + 40);
  return !NEGATED_BEFORE.test(before) && !CONDITIONAL_BEFORE.test(before) && !NEGATED_AFTER.test(after);
}

interface Match { sheet: string; clause: string; index: number; text: string; groups: string[] }

/** Every stated (not negated, not conditional) match of `re` on every sheet. */
function statedMatches(sheets: PlanSheet[], re: RegExp): Match[] {
  const out: Match[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const { sheet, text } of sheets) {
    for (const clause of clauses(text)) {
      g.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = g.exec(clause))) {
        if (m[0].length === 0) { g.lastIndex++; continue; }
        if (!statedAt(clause, m.index, m[0].length)) continue;
        out.push({ sheet, clause, index: m.index, text: m[0].replace(/\s+/g, " ").trim().slice(0, 120), groups: m.slice(1).map((x) => x ?? "") });
      }
    }
  }
  return out;
}

/** One quote per sheet and phrase: a label repeated on a sheet is one item. */
function uniqueQuotes(ms: Array<{ sheet: string; text: string }>): SheetQuote[] {
  const seen = new Set<string>();
  const out: SheetQuote[] = [];
  for (const m of ms) {
    const key = `${m.sheet}\u0000${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sheet: m.sheet, excerpt: m.text });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// (1) THE OTHER METHOD'S BOILERPLATE. The interconnection method comes from the gate's own classifier
// (codeReviewRules: supply side only, or its load-side branch) — this module never decides it. What it
// reads is the sheets' notes and labels that belong ONLY to the other method.
//
// Load side (705.12) only: the 120 % busbar rule, a 705.12(B)/(D) citation (load side in every
// edition the table knows; 705.12(A) is not read, because it was the SUPPLY side in 2014/2017 and is
// load side from 2020), the 705.12 output-connection label, a back-fed breaker, the opposite-end
// placement. A bare "PV BREAKER" label is not read: an AC combiner on a supply-side job has breakers.
// Supply side (705.11 / 230.82(6)) only: a line-/supply-side tap or connection, a 705.11 or 230.82(6)
// citation, a connection ahead of the service disconnect.
// ---------------------------------------------------------------------------------------------

export interface MethodItem { item: string; quote: SheetQuote }

const LOAD_SIDE_ONLY: Array<{ item: string; re: RegExp }> = [
  { item: "the 120 % busbar rule", re: /\b120\s*(?:%|PERCENT)[^;.]{0,60}?\b(?:BUS\s*BAR|BUSBAR|BUS\s+RATING|RULE)\b|\b(?:BUS\s*BAR|BUSBAR|BUS\s+RATING)\b[^;.]{0,60}?\b120\s*(?:%|PERCENT)/ },
  { item: "a 705.12 load-side citation", re: /\b705\.12\s*\(\s*[BD]\s*\)(?:\s*\(\s*[0-9A-Z]{1,2}\s*\)){0,3}/ },
  { item: "the load-side output-connection label", re: /\b(?:POWER\s+SOURCE|INVERTER|PV\s+SYSTEM|SOLAR)\s+OUTPUT\s+CONNECTION\b|\bDO\s+NOT\s+RELOCATE\s+THIS\s+OVERCURRENT\s+DEVICE\b/ },
  { item: "a back-fed breaker", re: /\bBACK[-\s]?FED\s+(?:PV\s+|SOLAR\s+)?BREAKER\b|\bBACK[-\s]?FEED(?:ING)?\s+(?:THE\s+)?(?:MAIN\s+)?(?:PANEL|BUS\s*BAR|BUSBAR|BUS)\b/ },
  { item: "breaker placement at the opposite end of the bus", re: /\bOPPOSITE\s+END\s+(?:OF\s+(?:THE\s+)?)?(?:BUS\s*BAR|BUSBAR|BUS)\b|\bOPPOSITE\s+(?:END\s+)?FROM\s+(?:THE\s+)?(?:MAIN|INPUT|FEEDER)\b/ },
];

const SUPPLY_SIDE_ONLY: Array<{ item: string; re: RegExp }> = [
  { item: "a line-/supply-side tap", re: /\b(?:LINE|SUPPLY)[-\s]?SIDE\s+(?:TAP|CONNECTION|INTERCONNECTION|SOURCE\s+CONNECTION)\b/ },
  { item: "a 705.11 supply-side citation", re: /\b705\.11\b(?:\s*\(\s*[A-Z0-9]{1,2}\s*\)){0,3}/ },
  { item: "a 230.82(6) citation", re: /\b230\.82\s*\(\s*6\s*\)/ },
  { item: "a connection ahead of the service disconnect", re: /\bAHEAD\s+OF\s+(?:THE\s+)?(?:MAIN\s+(?:BREAKER|DISCONNECT)|SERVICE\s+(?:DISCONNECT(?:ING\s+MEANS)?|MAIN))\b/ },
];

/** Notes and labels on the sheets that belong only to the OTHER interconnection method. */
export function readOtherMethodItems(sheets: PlanSheet[], method: "supply" | "load"): MethodItem[] {
  const rules = method === "supply" ? LOAD_SIDE_ONLY : SUPPLY_SIDE_ONLY;
  const out: MethodItem[] = [];
  for (const { item, re } of rules) {
    for (const quote of uniqueQuotes(statedMatches(sheets, re))) out.push({ item, quote });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// (2) WHERE IS THE SERVICE EQUIPMENT, AND THE POINT OF INTERCONNECTION? Interior vs exterior decides,
// among other things, where the supply-side OCPD sits and whether the service disconnect is at the
// point of entrance (230.70(A)(1)). Read per FACT, so an exterior meter-main and an interior
// distribution panel are two facts, not a contradiction. "<LOC> <EQUIPMENT> & POINT OF
// INTERCONNECTION" puts the POI at that equipment, so the POI inherits the location.
// ---------------------------------------------------------------------------------------------

export type ServiceFact = "point of interconnection" | "main service panel" | "main service disconnect";
export interface LocationConflict { fact: ServiceFact; interior: SheetQuote[]; exterior: SheetQuote[] }

const LOC = String.raw`(INTERIOR|EXTERIOR|INDOOR|OUTDOOR)`;
const POI = String.raw`POINT\s+OF\s+(?:INTER)?CONNECT(?:ION)?|\bPOI\b`;
const MSP = String.raw`MAIN\s+SERVICE\s+PANEL|\bMSP\b`;
const MSD = String.raw`(?:MAIN\s+)?SERVICE\s+DISCONNECT(?:ING\s+MEANS)?|MAIN\s+DISCONNECT`;
const NOUN = `(${POI}|${MSP}|${MSD})`;
const EXISTING = String.raw`(?:(?:EXISTING|\(E\)|NEW|\(N\))\s+)?`;
// "INTERIOR MAIN SERVICE PANEL [& POINT OF INTERCONNECTION]"
const LOC_BEFORE = new RegExp(String.raw`\b${LOC}\s+${EXISTING}${NOUN}(?:\s*(?:&|AND|\/|\+)\s*(?:THE\s+)?(${POI}))?`);
// "MSP (EXTERIOR)", "MSP LOCATED ON EXTERIOR WALL", "POINT OF INTERCONNECTION AT EXISTING EXTERIOR …"
const LOC_AFTER = new RegExp(String.raw`${NOUN}\s*(?:\(\s*${LOC}\s*\)|,?\s+(?:IS\s+)?(?:LOCATED\s+|MOUNTED\s+)?(?:ON|IN|AT)\s+(?:THE\s+|AN\s+)?${EXISTING}${LOC})`);

function factOf(noun: string): ServiceFact {
  if (new RegExp(`^(?:${POI})$`).test(noun)) return "point of interconnection";
  if (new RegExp(`^(?:${MSP})$`).test(noun)) return "main service panel";
  return "main service disconnect";
}
const INSIDE = (loc: string): boolean => loc === "INTERIOR" || loc === "INDOOR";

export function readServiceLocationConflicts(sheets: PlanSheet[]): LocationConflict[] {
  const readings: Array<{ fact: ServiceFact; inside: boolean; sheet: string; text: string }> = [];
  for (const m of statedMatches(sheets, LOC_BEFORE)) {
    const [loc, noun, poi] = m.groups;
    readings.push({ fact: factOf(noun.replace(/\s+/g, " ")), inside: INSIDE(loc), sheet: m.sheet, text: m.text });
    if (poi) readings.push({ fact: "point of interconnection", inside: INSIDE(loc), sheet: m.sheet, text: m.text });
  }
  for (const m of statedMatches(sheets, LOC_AFTER)) {
    const [noun, locParen, locAfter] = m.groups;
    readings.push({ fact: factOf(noun.replace(/\s+/g, " ")), inside: INSIDE(locParen || locAfter), sheet: m.sheet, text: m.text });
  }
  const out: LocationConflict[] = [];
  for (const fact of ["point of interconnection", "main service panel", "main service disconnect"] as ServiceFact[]) {
    const interior = uniqueQuotes(readings.filter((r) => r.fact === fact && r.inside));
    const exterior = uniqueQuotes(readings.filter((r) => r.fact === fact && !r.inside));
    if (interior.length && exterior.length) out.push({ fact, interior, exterior });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// (3) WHICH NEC EDITION DO THE SHEETS CITE? "NEC: 2020", "2020 NEC", "NFPA 70-2020". A clause that
// claims EQUIPMENT compliance ("COMPLIANT WITH NEC 2017 690.12") is the product's listing, not the
// design basis, and a list of editions ("NEC 2014, 2017 & 2020") is a datasheet's: neither is read.
// ---------------------------------------------------------------------------------------------

const YEAR = String.raw`(20[0-3]\d)(?![\d.]\d|\d)`;
const NEC_EDITION = new RegExp(String.raw`\bNEC\s*[:–-]?\s*${YEAR}|\b${YEAR}\s+(?:EDITION\s+(?:OF\s+)?(?:THE\s+)?)?(?:NEC|NATIONAL\s+ELECTRIC(?:AL)?\s+CODE)\b|\bNFPA\s*70\s*[:,–-]?\s*\(?${YEAR}`);
const EQUIPMENT_COMPLIANCE_BEFORE = /\b(?:COMPLIAN(?:T|CE)|COMPLIES|COMPLY|CONFORMS?|MEETS|CERTIFIED)\b[^.;:]{0,30}$/;
const EDITION_LIST_AFTER = /^\s*(?:,|\/|&|AND|OR)\s*(?:NEC\s*)?20[0-3]\d\b/;
const EDITION_LIST_BEFORE = /\b20[0-3]\d\s*(?:,|\/|&|AND|OR)\s*$/;

export interface EditionCitations { edition: number; quotes: SheetQuote[]; count: number }

/** Every NEC edition the sheets cite as their basis, with where. */
export function readNecEditionCitations(sheets: PlanSheet[]): EditionCitations[] {
  const by = new Map<number, Array<{ sheet: string; text: string }>>();
  for (const m of statedMatches(sheets, NEC_EDITION)) {
    const before = m.clause.slice(Math.max(0, m.index - 40), m.index);
    const after = m.clause.slice(m.index + m.text.length, m.index + m.text.length + 20);
    if (EQUIPMENT_COMPLIANCE_BEFORE.test(before) || EDITION_LIST_AFTER.test(after) || EDITION_LIST_BEFORE.test(before)) continue;
    const year = Number(m.groups.find((g) => /^20[0-3]\d$/.test(g)));
    if (!Number.isFinite(year)) continue;
    by.set(year, [...(by.get(year) ?? []), { sheet: m.sheet, text: m.text }]);
  }
  return [...by.entries()].sort(([a], [b]) => a - b).map(([edition, ms]) => ({ edition, quotes: uniqueQuotes(ms), count: ms.length }));
}

// ---------------------------------------------------------------------------------------------
// (4) RAPID SHUTDOWN: CLAIMED AND DENIED. A sheet that says "SHUTDOWN – NO" / "RSD: N/A" / "NO RAPID
// SHUTDOWN" while another carries the RSD note or the 690.56(C) placard; and whether any sheet names
// the initiation device (690.12(C), 2017+).
// ---------------------------------------------------------------------------------------------

const RSD_CLAIM = /\bRAPID\s+SHUTDOWN\b|\bRSD\b|\b690\.12\b|\b690\.56\s*\(\s*C\s*\)/;
const RSD_DENIAL = /\b(?:RAPID\s+)?SHUTDOWN\s*[:=–—-]\s*(?:NO(?!\.\s*\d)|NONE|N\/A|NOT\s+(?:REQUIRED|PROVIDED|USED|APPLICABLE))(?![A-Z0-9])|\bRSD\s*[:=–—-]\s*(?:NO(?!\.\s*\d)|NONE|N\/A|NOT\s+(?:REQUIRED|PROVIDED|USED|APPLICABLE))(?![A-Z0-9])|\bRAPID\s+SHUTDOWN\s+(?:IS\s+)?NOT\s+(?:REQUIRED|PROVIDED|USED|APPLICABLE)\b/;
const NO_RAPID_SHUTDOWN = /\bNO\s+RAPID\s+SHUTDOWN\b/;

export interface RapidShutdownReading { claimed: SheetQuote[]; denied: SheetQuote[]; initiation: SheetQuote[] }

/** `initiationPatterns`: the gate's own RSD_INITIATION_PATTERNS (codeReviewRules), passed in so the
 *  initiation device is recognised by one vocabulary. */
export function readRapidShutdownStatements(sheets: PlanSheet[], initiationPatterns: RegExp[]): RapidShutdownReading {
  // A denial IS a negated mention, so it is read without the negation guard (conditionals still drop).
  const denied: Array<{ sheet: string; text: string }> = [];
  for (const re of [RSD_DENIAL, NO_RAPID_SHUTDOWN]) {
    const g = new RegExp(re.source, "g");
    for (const { sheet, text } of sheets) {
      for (const clause of clauses(text)) {
        g.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = g.exec(clause))) {
          if (CONDITIONAL_BEFORE.test(clause.slice(Math.max(0, m.index - 50), m.index))) continue;
          denied.push({ sheet, text: m[0].replace(/\s+/g, " ").trim().slice(0, 120) });
        }
      }
    }
  }
  const claimed = statedMatches(sheets, RSD_CLAIM).filter((m) => !RSD_DENIAL.test(m.clause.slice(m.index, m.index + m.text.length + 25)));
  const initiation = initiationPatterns.flatMap((re) => statedMatches(sheets, re));
  return { claimed: uniqueQuotes(claimed), denied: uniqueQuotes(denied), initiation: uniqueQuotes(initiation) };
}

// ---------------------------------------------------------------------------------------------
// (5) THE SUPPLY-SIDE DISCONNECT'S RATING. A disconnect ahead of the service disconnect is permitted
// by 230.82(6) only when it is "suitable for use as service equipment". Read only where the sheets name
// a disconnect: a set whose disconnect was not read says nothing about its rating.
// ---------------------------------------------------------------------------------------------

const DISCONNECT = /\b(?:FUSED|NON[-\s]?FUSED|AC|PV|SOLAR|SUPPLY[-\s]?SIDE|LINE[-\s]?SIDE|TAP)\s+(?:AC\s+)?DISCONNECT(?:ING\s+MEANS|\s+SWITCH)?\b|\bSAFETY\s+SWITCH\b/;
const SERVICE_RATED = /\bSUITABLE\s+(?:FOR\s+)?(?:USE\s+)?AS\s+SERVICE\s+EQUIPMENT\b|\bSERVICE[-\s]?(?:ENTRANCE[-\s]?)?RATED\b|\bSUSE\b|\bRATED\s+(?:FOR\s+)?SERVICE\s+(?:ENTRANCE|EQUIPMENT)\b|\bSERVICE\s+ENTRANCE\s+(?:RATED|LISTED|LABEL(?:L)?ED)\b/;

export interface DisconnectRatingReading { disconnect: SheetQuote[]; serviceRated: SheetQuote[] }

export function readSupplySideDisconnectRating(sheets: PlanSheet[]): DisconnectRatingReading {
  return {
    disconnect: uniqueQuotes(statedMatches(sheets, DISCONNECT)),
    serviceRated: uniqueQuotes(statedMatches(sheets, SERVICE_RATED)),
  };
}
