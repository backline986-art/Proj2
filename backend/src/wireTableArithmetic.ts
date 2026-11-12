// CHECK THE WIRE TABLE'S ARITHMETIC (#334).
//
// electricalSizing.ts recomputes ONE circuit: the inverter output circuit the parser names
// (acConductor / pvBreaker). A plan reviewer reads the whole wire / OCPD table, tag by tag, and an
// audit of a live line-side-tap package found the gate silent on what an inspector fails as drawn:
// #2 THWN-2 behind 90 A fuses with a #10 ground (Table 250.122 asks #8 Cu; the tap's supply-side
// bonding jumper is sized from the #2 by Table 250.102(C)(1), #8 Cu), eleven #10 conductors in a
// 3/4" EMT (over 40 % fill), and five 2-pole breakers in an 8-space load center.
//
// This module reads those values straight off the sheet text, deterministically (no vision call,
// no LLM call, no new text to any model) and checks, per wire tag:
//   - the EGC against Table 250.122 for the tag's OCPD (250.122(A): never larger than the circuit
//     conductors);
//   - on a supply-side interconnection, a tag the table itself names as the tap / line side: the
//     supply-side bonding jumper against Table 250.102(C)(1) for the tag's ungrounded conductor;
//   - the conductor's ampacity after the 310.15(C)(1) fill adjustment and 110.14(C) terminations
//     against the tag's OCPD (240.4);
//   - 40 % raceway fill (Chapter 9 Tables 1, 4, 5, 8) ONLY when the tag states the raceway's trade
//     size and type and a count for every conductor;
// and, as a callout, a load center's stated spaces against the breaker poles listed with it.
//
// AN UNCERTAIN READING NEVER PRODUCES A FINDING. A row counts only when its tag is printed ("TAG 3")
// and it states, each under its own label, ONE phase conductor size, ONE ground size and ONE OCPD
// rating. A table pdf.js read column by column puts several sizes in one row's span: that row is
// skipped, not guessed at. A tag read twice with different values (two tables, a revision) is
// skipped. Every message names the values it read and the tag and sheet it read them from.
//
// Severity is "warning" (an inspection failure, not a filing blocker: a misread row must never
// block on its own); the panel-spaces check is a callout. Every id here is in reviewerVision's
// MEASURED_FINDING_IDS: a picture of the table shows it is there, never that it adds up.
import type { CodeReference, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import type { DesignTextSource } from "./designCriteria";
import { AMPACITY, fillAdjustment, parseConductor, SMALL_CONDUCTOR_MAX, type ParsedConductor } from "./electricalSizing";
import { nextStandardOcpd } from "./iowaPvWorksheet";
import { sheetIdOf } from "./planAttachmentRead";
import { notCheckedRecord, passRecord } from "./checkRecords";
import { makeRuleBasis } from "../../shared/src/ruleBasis";

export const WIRE_TABLE_FINDING_IDS = [
  "city.elec.wire-table-egc-undersized",
  "city.elec.wire-table-bonding-jumper-undersized",
  "city.elec.wire-table-ocpd-over-ampacity",
  "city.elec.wire-table-raceway-fill",
  "city.elec.panel-spaces-short",
] as const;

const NEC_URL = "https://www.nfpa.org/codes-and-standards/nfpa-70-standard-development/70";
const egcRef: CodeReference = {
  code: "NEC", section: "250.122", title: "Size of equipment grounding conductors",
  adoptionScope: "Equipment grounding conductors of every circuit.", sourceUrl: NEC_URL,
  note: "Not smaller than Table 250.122 for the rating of the overcurrent device ahead of the circuit; 250.122(A): need not be larger than the circuit conductors.",
};
const bondingRef: CodeReference = {
  code: "NEC", section: "250.102(C)(1)", title: "Supply-side bonding jumper size",
  adoptionScope: "Bonding jumpers on the supply side of service (and PV supply-side disconnect) equipment.", sourceUrl: NEC_URL,
  note: "Not smaller than Table 250.102(C)(1) for the largest ungrounded supply conductor; an overcurrent device's rating does not size it.",
};
const ampacityRef: CodeReference = {
  code: "NEC", section: "240.4 / 310.15 / 110.14(C)", title: "Conductor protection against overcurrent",
  adoptionScope: "Every conductor and its overcurrent device.", sourceUrl: NEC_URL,
  note: "The OCPD may not exceed the conductor's ampacity after the 310.15(C)(1) fill adjustment and the 110.14(C) termination limit (next standard size up per 240.4(B); 240.4(D) small-conductor limits).",
};
const fillRef: CodeReference = {
  code: "NEC", section: "Chapter 9, Table 1 (Tables 4, 5, 8)", title: "Raceway fill",
  adoptionScope: "Conductors in conduit and tubing.", sourceUrl: NEC_URL,
  note: "Over two conductors: total conductor area at most 40 percent of the raceway's internal area (Table 4), conductor areas per Table 5 (insulated) and Table 8 (bare).",
};
const spacesRef: CodeReference = {
  code: "NEC", section: "110.3(B)", title: "Installation per listing and labeling",
  adoptionScope: "Panelboards and load centers.", sourceUrl: NEC_URL,
  note: "A load center takes only the breakers, and the number of poles, its listing and label allow; more poles than spaces needs a larger panel or breakers the label lists (tandem / quad).",
};

// Conductor sizes small to large; index order compares sizes.
const SIZES = ["14", "12", "10", "8", "6", "4", "3", "2", "1", "1/0", "2/0", "3/0", "4/0"];
const rank = (size: string): number => SIZES.indexOf(size);

// NEC Table 250.122: OCPD rating (at most) -> minimum EGC [copper, aluminum].
const TABLE_250_122: Array<[number, string, string]> = [
  [15, "14", "12"], [20, "12", "10"], [60, "10", "8"], [100, "8", "6"], [200, "6", "4"], [300, "4", "2"],
  [400, "3", "1"], [500, "2", "1/0"], [600, "1", "2/0"], [800, "1/0", "3/0"], [1000, "2/0", "4/0"],
];
function minEgc(ocpd: number, material: "CU" | "AL"): string | null {
  const row = TABLE_250_122.find(([amps]) => ocpd <= amps);
  return row ? (material === "CU" ? row[1] : row[2]) : null;
}

// NEC Table 250.102(C)(1): largest ungrounded conductor -> minimum bonding jumper [copper, aluminum].
function minSupplyBondingJumper(phase: ParsedConductor, material: "CU" | "AL"): string | null {
  const r = rank(phase.size);
  const bands: Array<[string, string, string]> = phase.material === "CU"
    ? [["2", "8", "6"], ["1/0", "6", "4"], ["3/0", "4", "2"], ["4/0", "2", "1/0"]]
    : [["1/0", "8", "6"], ["3/0", "6", "4"], ["4/0", "4", "2"]];
  const band = bands.find(([upTo]) => r <= rank(upTo));
  return band ? (material === "CU" ? band[1] : band[2]) : null;
}

// NEC Chapter 9 Table 5: approximate area (in^2) of THHN/THWN/THWN-2 and XHHW/XHHW-2 conductors.
const AREA_THWN: Record<string, number> = { "14": 0.0097, "12": 0.0133, "10": 0.0211, "8": 0.0366, "6": 0.0507, "4": 0.0824, "3": 0.0973, "2": 0.1158, "1": 0.1562, "1/0": 0.1855, "2/0": 0.2223, "3/0": 0.2679, "4/0": 0.3237 };
const AREA_XHHW: Record<string, number> = { "14": 0.0139, "12": 0.0181, "10": 0.0243, "8": 0.0437, "6": 0.0590, "4": 0.0814, "3": 0.0962, "2": 0.1146, "1": 0.1534, "1/0": 0.1825, "2/0": 0.2190, "3/0": 0.2642, "4/0": 0.3197 };
// NEC Chapter 9 Table 8: bare SOLID conductor area (the smaller, favourable reading of a bare EGC).
const AREA_BARE: Record<string, number> = { "14": 0.004, "12": 0.006, "10": 0.008, "8": 0.013, "6": 0.021, "4": 0.033 };
// NEC Chapter 9 Table 4: 40 percent of the raceway's internal area (in^2), by trade size.
const RACEWAY_40: Record<string, Record<string, number>> = {
  EMT: { "1/2": 0.122, "3/4": 0.213, "1": 0.346, "1-1/4": 0.598, "1-1/2": 0.814, "2": 1.342 },
  "PVC SCH 40": { "1/2": 0.114, "3/4": 0.203, "1": 0.333, "1-1/4": 0.581, "1-1/2": 0.794, "2": 1.316 },
  "PVC SCH 80": { "1/2": 0.087, "3/4": 0.164, "1": 0.275, "1-1/4": 0.495, "1-1/2": 0.684, "2": 1.15 },
  RMC: { "1/2": 0.125, "3/4": 0.22, "1": 0.355, "1-1/4": 0.61, "1-1/2": 0.829, "2": 1.363 },
  IMC: { "1/2": 0.137, "3/4": 0.235, "1": 0.384, "1-1/4": 0.659, "1-1/2": 0.89, "2": 1.452 },
};

/** The table area of one conductor, or null when its insulation is not one the tables here carry. */
function conductorArea(c: ParsedConductor, role: Role): number | null {
  if (!c.insulation) return role === "ground" ? AREA_BARE[c.size] ?? null : null;
  if (/^(THWN-2|THHN|THWN)$/.test(c.insulation)) return AREA_THWN[c.size] ?? null;
  if (/^(XHHW-2|XHHW)$/.test(c.insulation)) return AREA_XHHW[c.size] ?? null;
  return null;
}

// --- reading one tag's row ----------------------------------------------------------------------

type Role = "phase" | "ground" | "neutral" | "gec" | "noise";
interface Callout { qty: number | null; conductor: ParsedConductor; role: Role; raw: string }
export interface WireTableRow {
  tag: string;
  sheet: string;
  phase: ParsedConductor;
  phaseQty: number | null;
  ground: ParsedConductor;
  ocpd: number;
  supplySide: boolean;
  /** Present only when the row states the raceway and a count for every conductor in it. */
  fill: { raceway: string; tradeSize: string; allowance: number; area: number; parts: string[] } | null;
  neutralLabelled: boolean;
  text: string;
}

const SIZE = String.raw`[1-4]\s*\/\s*0|14|12|10|8|6|4|3|2|1`;
// One conductor callout, with its quantity when printed: "(3) #2", "#10 AWG", "(1) 6 AWG".
const CALLOUT = new RegExp(String.raw`(?:\(\s*(\d{1,2})\s*\)\s*)?(?:#\s*(${SIZE})(?![\d\/])(?:\s*AWG\b)?|\b(${SIZE})\s*AWG\b)`, "g");
const GEC_WORDS = /\bGEC\b|ELECTRODE/;
const GROUND_WORDS = /\b(?:EGC|E\.G\.C|GND|GRD|GROUND(?:ING)?|EQUIP(?:MENT)?\.?\s+GROUND(?:ING)?|BARE|BOND(?:ING)?\s+JUMPER|SSBJ)\b/;
const NEUTRAL_WORDS = /\bNEUT(?:RAL)?\b|\bNEU\b/;
const CONDUCTOR_WORDS = /\b(?:AWG|CU|AL|COPPER|ALUMINUM|THWN-2|THWN|THHN|XHHW-2|XHHW|USE-2|RHW-2|PV\s*WIRE|THW|UF-B|UF|NM-B|TW|TRUNK|CABLE|WIRE|CONDUCTORS?)\b/;
// A label written BEFORE the callout it names: "EGC: #10", "GROUND - (1) #8".
const LEADING_LABEL = /(?:\b(EGC|GND|GRD|GROUND|NEUTRAL|NEUT|GEC))\s*[:=\-–]?\s*$/;

/** Split a row's text into conductor callouts and give each the role its own label says. */
function readCallouts(row: string): Callout[] {
  const matches = [...row.matchAll(CALLOUT)];
  const out: Callout[] = [];
  let carried = "";
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const next = i + 1 < matches.length ? matches[i + 1].index ?? row.length : row.length;
    let trailing = row.slice(end, next);
    // A label at the very end of this callout's tail belongs to the NEXT callout.
    const lead = i + 1 < matches.length ? LEADING_LABEL.exec(trailing) : null;
    const nextCarried = lead ? lead[1] : "";
    if (lead) trailing = trailing.slice(0, lead.index);
    const before = i === 0 ? (LEADING_LABEL.exec(row.slice(Math.max(0, start - 20), start))?.[1] ?? "") : carried;
    carried = nextCarried;
    const own = trailing.split(/[,;+&]|\bAND\b|\bWITH\b|\bIN\b/)[0].slice(0, 40);
    const size = (m[2] ?? m[3]).replace(/\s/g, "");
    const label = `${before} ${own}`;
    const conductor = parseConductor(`#${size} AWG ${own}`);
    if (!conductor) return;
    const role: Role = GEC_WORDS.test(label) ? "gec"
      : GROUND_WORDS.test(label) ? "ground"
        : NEUTRAL_WORDS.test(label) ? "neutral"
          : CONDUCTOR_WORDS.test(own) || /AWG/.test(m[0]) ? "phase"
            : "noise";
    out.push({ qty: m[1] ? Number(m[1]) : null, conductor, role, raw: `${m[0]}${own}`.replace(/\s+/g, " ").trim() });
  });
  return out;
}

// The tag's OCPD, only under an OCPD word: "OCPD 90A", "OCPD: 90 A", "(2) 90A FUSES", "20A BREAKER".
// A MAIN breaker's rating is never the row's OCPD.
const OCPD_AFTER = /\b(?:OCPD|FUSES?|FUSED|BREAKER|CB|OVERCURRENT(?:\s+PROTECTION)?)\b\s*(?:\(\s*A\s*\)|RATING)?\s*[:=]?\s*(\d{2,4})\s*A(?:MPS?)?\b/g;
const OCPD_BEFORE = /\b(\d{2,4})\s*A(?:MPS?)?\s*(?:,\s*)?(?:[123]\s*-?\s*P(?:OLE)?\s+)?(?:FUSES?|BREAKERS?|CB|OCPD)\b/g;
function readOcpd(row: string): number[] {
  const values: number[] = [];
  for (const re of [OCPD_AFTER, OCPD_BEFORE]) {
    for (const m of row.matchAll(re)) {
      const at = m.index ?? 0;
      if (/\bMAIN\b[^#]{0,12}$/.test(row.slice(Math.max(0, at - 16), at)) || /\bMAIN\b/.test(m[0])) continue;
      values.push(Number(m[1]));
    }
  }
  return [...new Set(values.filter((v) => v > 0))];
}

// "3/4\" EMT", "1-1/4 IN. PVC SCH 80", "1\" RMC". The inch mark (or IN) is required: a bare "2 EMT"
// is not a trade size anyone can be sure of.
const RACEWAY = /(?<![#\/\d-])(1[-\s]1\/[24]|[13]\/[24]|[12])\s*(?:"|”|″|''|\bIN\b\.?|\bINCH(?:ES)?\b)\s*(?:CONDUIT\s+)?(EMT|PVC|RMC|IMC|RIGID|SCH(?:EDULE)?\.?\s*(?:40|80)\s*PVC)(\s*,?\s*SCH(?:EDULE)?\.?\s*(?:40|80))?/g;
function readRaceway(row: string): Array<{ tradeSize: string; raceway: string }> {
  const seen = new Map<string, { tradeSize: string; raceway: string }>();
  for (const m of row.matchAll(RACEWAY)) {
    const tradeSize = m[1].replace(/\s+/, "-");
    const type = `${m[2]}${m[3] ?? ""}`;
    // Plain "PVC" reads as Schedule 40 — the larger area, the favourable assumption.
    const raceway = /PVC/.test(type) ? (/80/.test(type) ? "PVC SCH 80" : "PVC SCH 40") : /RIGID/.test(type) ? "RMC" : type.trim();
    seen.set(`${tradeSize}|${raceway}`, { tradeSize, raceway });
  }
  return [...seen.values()];
}

// A row names the supply-side segment of a line-side interconnection.
const SUPPLY_ROW = /\bTAP\b|\bLINE[-\s]?SIDE\b|\bSUPPLY[-\s]?SIDE\b|\bSERVICE\s+(?:ENTRANCE\s+)?CONDUCTORS?\b|\bPOINT\s+OF\s+INTERCONNECTION\b|\bPOI\b/;

const TAG_MARK = /\b(?:WIRE\s+|CONDUCTOR\s+|CIRCUIT\s+)?TAG\s*(?:NO\.?\s*|#\s*)?(\d{1,2})\b\s*[:.)\-–]?/g;
// A row ends at the next tag, a notes block, a sentence break, or 260 characters.
const ROW_END = /\bNOTES?\b|(?<!\b(?:IN|NO|SCH|MAX|MIN))\.\s/;

// The sheet id a page's title block states: one predicate, shared with the attachment readers.
const sheetOf = sheetIdOf;

/** Every wire-table row the sheets state clearly enough to check; ambiguous rows are left out. */
export function readWireTableRows(pages: Array<{ label: string; text: string }>, supplySideProject: boolean): WireTableRow[] {
  const byTag = new Map<string, WireTableRow[]>();
  for (const { label, text } of pages) {
    const page = text.toUpperCase().replace(/\s+/g, " ");
    const sheet = sheetOf(page) || label;
    const marks = [...page.matchAll(TAG_MARK)];
    marks.forEach((mark, i) => {
      const start = (mark.index ?? 0) + mark[0].length;
      let row = page.slice(start, i + 1 < marks.length ? marks[i + 1].index : page.length).slice(0, 260);
      const cut = ROW_END.exec(row);
      if (cut) row = row.slice(0, cut.index);
      const callouts = readCallouts(row);
      const phases = callouts.filter((c) => c.role === "phase");
      const grounds = callouts.filter((c) => c.role === "ground");
      const distinct = (cs: Callout[]) => new Set(cs.map((c) => `${c.conductor.size}|${c.conductor.material}`));
      const ocpd = readOcpd(row);
      if (distinct(phases).size !== 1 || distinct(grounds).size !== 1 || ocpd.length !== 1) return;
      const phase = phases[0];
      const ground = grounds[0];
      // Fill: the raceway stated once, and a count printed for every conductor in the row.
      let fill: WireTableRow["fill"] = null;
      const raceways = readRaceway(row);
      const counted = callouts.filter((c) => c.role !== "noise" && c.role !== "gec");
      if (raceways.length === 1 && counted.every((c) => c.qty != null && c.qty > 0)) {
        const { tradeSize, raceway } = raceways[0];
        const allowance = RACEWAY_40[raceway]?.[tradeSize];
        const areas = counted.map((c) => conductorArea(c.conductor, c.role));
        const total = counted.reduce((n, c) => n + (c.qty ?? 0), 0);
        if (allowance && total > 2 && areas.every((a) => a != null)) {
          fill = {
            raceway, tradeSize, allowance,
            area: counted.reduce((sum, c, k) => sum + (c.qty ?? 0) * (areas[k] as number), 0),
            parts: counted.map((c, k) => `${c.qty} x #${c.conductor.size}${c.conductor.insulation ? ` ${c.conductor.insulation}` : " bare"} (${areas[k]} in²)`),
          };
        }
      }
      const read: WireTableRow = {
        tag: mark[1], sheet,
        phase: phase.conductor, phaseQty: phase.qty, ground: ground.conductor, ocpd: ocpd[0],
        supplySide: supplySideProject && SUPPLY_ROW.test(row),
        fill, neutralLabelled: callouts.some((c) => c.role === "neutral"),
        text: row.trim(),
      };
      byTag.set(read.tag, [...(byTag.get(read.tag) ?? []), read]);
    });
  }
  const rows: WireTableRow[] = [];
  for (const reads of byTag.values()) {
    const key = (r: WireTableRow) => JSON.stringify([r.phase, r.phaseQty, r.ground, r.ocpd, r.supplySide, r.fill]);
    // The same tag read twice with different values: a second table or a revision. Not a guess.
    if (new Set(reads.map(key)).size === 1) rows.push(reads[0]);
  }
  return rows.sort((a, b) => Number(a.tag) - Number(b.tag));
}

// --- load center spaces against breaker poles ---------------------------------------------------

const SPACES = /\b(\d{1,2})\s*-?\s*SPACES?\b/g;
const PANEL_WORDS = /\bLOAD\s*CENTER\b|\bPANEL(?:BOARD)?\b|\bCOMBINER\b|\bSUB-?PANEL\b/;
const BREAKER_SET = /\(\s*(\d{1,2})\s*\)\s*(?:(\d{2,3})\s*A(?:MPS?)?\s*,?\s*)?([123])\s*-?\s*P(?:OLE)?\b(?:\s*,?\s*(\d{2,3})\s*A(?:MPS?)?\b)?/g;
const POLE_SAVERS = /\bTANDEM|\bQUAD|\bTWIN\b|\bDUPLEX\b|\bHALF[-\s]?SIZE|\bTHIN\b/;

interface PanelRead { spaces: number; poles: number; sets: string[]; sheet: string }
function readPanelSpaces(pages: Array<{ label: string; text: string }>): PanelRead[] {
  const out: PanelRead[] = [];
  for (const { label, text } of pages) {
    const page = text.toUpperCase().replace(/\s+/g, " ");
    const sheet = sheetOf(page) || label;
    for (const m of page.matchAll(SPACES)) {
      const at = m.index ?? 0;
      const from = Math.max(0, at - 160);
      let lo = from;
      let hi = Math.min(page.length, at + m[0].length + 160);
      // The window stays inside the statement: a sentence break or another spaces statement ends it.
      for (const stop of page.slice(lo, at).matchAll(/\.\s|\b\d{1,2}\s*-?\s*SPACES?\b/g)) lo = Math.max(lo, from + (stop.index ?? 0) + stop[0].length);
      const stopAfter = page.slice(at + m[0].length, hi).search(/\.\s|\b\d{1,2}\s*-?\s*SPACES?\b/);
      if (stopAfter >= 0) hi = at + m[0].length + stopAfter;
      const window = page.slice(lo, hi);
      if (!PANEL_WORDS.test(window) || !/BREAKER/.test(window) || POLE_SAVERS.test(window)) continue;
      const sets = [...window.matchAll(BREAKER_SET)];
      if (!sets.length) continue;
      const poles = sets.reduce((n, s) => n + Number(s[1]) * Number(s[3]), 0);
      const spaces = Number(m[1]);
      if (spaces > 0 && poles > spaces) out.push({ spaces, poles, sets: sets.map((s) => s[0].trim()), sheet });
    }
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.spaces}|${p.poles}|${p.sets.join(",")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --- the findings ---------------------------------------------------------------------------------

export interface WireTableOptions {
  /** Per-document texts (one per uploaded document); the snapshot's plan-set text is read too. */
  documentTexts?: DesignTextSource[];
  /** The interconnection classifies as SUPPLY (line) side only — the tap's bonding jumper is then
   *  sized by 250.102(C)(1) on a row the table names as the tap. */
  supplySide?: boolean;
  cite?: (code: string, fallback: CodeReference) => CodeReference;
}

const desc = (c: ParsedConductor): string => `#${c.size} ${c.material}${c.insulation ? ` ${c.insulation}` : ""}`;
const where = (r: WireTableRow): string => `Tag ${r.tag}${r.sheet ? ` (${r.sheet})` : ""}`;
const fmt = (n: number, d = 3): string => String(Math.round(n * 10 ** d) / 10 ** d);

function finding(input: Omit<ReviewerFinding, "category" | "installerCallout">): ReviewerFinding {
  return { ...input, category: "electrical", installerCallout: true };
}

/** The sheet texts, split into pages (pdf.js text is one line per page). */
function pagesOf(project: ProjectRecord, documentTexts: DesignTextSource[]): Array<{ label: string; text: string }> {
  const sources = [
    ...documentTexts.map((d) => ({ label: d.label, text: String(d.text ?? "") })),
    { label: "Uploaded plan-set document text", text: String(project.parserSnapshot?.planSetExtractedText ?? "") },
  ];
  return sources.flatMap((s) => s.text.split(/\n/).map((text) => ({ label: s.label, text })).filter((p) => p.text.trim()));
}

export function evaluateWireTableFindings(project: ProjectRecord, opts: WireTableOptions = {}): ReviewerFinding[] {
  const cite = opts.cite ?? ((_code: string, fallback: CodeReference) => fallback);
  // CHECK RECORDS (review-audit draft 07, checkRecords.ts): each table check that ran clean, and one
  // "not checked" when no wire table row could be read at all. Display only.
  const basis = (ref: CodeReference) => { const c = cite("NEC", ref); return makeRuleBasis("model_code", `NEC ${c.section}`, c.sourceUrl); };
  const pages = pagesOf(project, opts.documentTexts ?? []);
  const rows = pages.length ? readWireTableRows(pages, opts.supplySide === true) : [];
  if (!rows.length) {
    return [notCheckedRecord({
      ruleId: "city.elec.wire-table", category: "electrical", title: "Wire table arithmetic (EGC, ampacity vs OCPD, raceway fill)",
      inputs: ["a wire table (conductor, OCPD, ground and raceway per tag)"], codeReferences: [cite("NEC", egcRef), cite("NEC", ampacityRef)], ruleBasis: basis(egcRef),
    })];
  }
  const out: ReviewerFinding[] = [];
  const records: ReviewerFinding[] = [];

  // (a) EGC against Table 250.122, or (on the tap) the supply-side bonding jumper against 250.102(C)(1).
  const egcShort: string[] = [];
  const bondShort: string[] = [];
  const egcOk: string[] = [];
  const bondOk: string[] = [];
  for (const r of rows) {
    const g = r.ground;
    if (r.supplySide) {
      const need = minSupplyBondingJumper(r.phase, g.material);
      if (need && rank(g.size) >= rank(need)) bondOk.push(`${where(r)}: #${g.size} ${g.material} >= #${need} ${g.material} for ${desc(r.phase)}`);
      if (need && rank(g.size) < rank(need)) {
        bondShort.push(`${where(r)}: ungrounded ${desc(r.phase)} on the supply side -> Table 250.102(C)(1) requires at least #${need} ${g.material}; the table shows a #${g.size} ${g.material} ground`);
      }
      continue;
    }
    let need = minEgc(r.ocpd, g.material);
    // 250.122(A): the EGC need not be larger than the circuit conductors (same material only).
    if (need && g.material === r.phase.material && rank(r.phase.size) < rank(need)) need = r.phase.size;
    if (need && rank(g.size) >= rank(need)) egcOk.push(`${where(r)}: #${g.size} ${g.material} EGC >= #${need} ${g.material} behind ${r.ocpd} A`);
    if (need && rank(g.size) < rank(need)) {
      egcShort.push(`${where(r)}: ${desc(r.phase)} behind a ${r.ocpd} A OCPD -> Table 250.122 requires at least #${need} ${g.material}; the table shows a #${g.size} ${g.material} EGC`);
    }
  }
  if (!egcShort.length && egcOk.length) {
    records.push(passRecord({ ruleId: "city.elec.wire-table-egc-undersized", category: "electrical", title: "Equipment grounding conductors against Table 250.122", codeReferences: [cite("NEC", egcRef)], ruleBasis: basis(egcRef), arithmetic: `250.122, from the plan set's own wire table: ${egcOk.join("; ")}.` }));
  }
  if (!bondShort.length && bondOk.length) {
    records.push(passRecord({ ruleId: "city.elec.wire-table-bonding-jumper-undersized", category: "electrical", title: "Supply-side bonding jumper against Table 250.102(C)(1)", codeReferences: [cite("NEC", bondingRef)], ruleBasis: basis(bondingRef), arithmetic: `250.102(C)(1), from the plan set's own wire table: ${bondOk.join("; ")}.` }));
  }
  if (egcShort.length) {
    out.push(finding({
      id: "city.elec.wire-table-egc-undersized",
      severity: "warning",
      title: "Equipment grounding conductor smaller than Table 250.122 for its OCPD",
      message: `250.122, from the plan set's own wire table: ${egcShort.join("; ")}. Values as read from the sheet text; confirm against the sheet.`,
      cityFeedback: "The equipment grounding conductor shown is smaller than NEC Table 250.122 requires for the overcurrent device protecting the circuit. Upsize the EGC and update the wire table.",
      designTeamAction: "Upsize the EGC on each listed tag to at least the Table 250.122 size for its OCPD and revise the wire table / three-line.",
      evidenceNeeded: ["Wire table: OCPD rating, conductor size and EGC size per tag"],
      codeReferences: [cite("NEC", egcRef)],
    }));
  }
  if (bondShort.length) {
    out.push(finding({
      id: "city.elec.wire-table-bonding-jumper-undersized",
      severity: "warning",
      title: "Supply-side bonding jumper smaller than Table 250.102(C)(1)",
      message: `250.102(C)(1), from the plan set's own wire table on a supply-side (line-side tap) interconnection: ${bondShort.join("; ")}. On the supply side the jumper is sized from the ungrounded conductor, not from an OCPD. Values as read from the sheet text; confirm against the sheet.`,
      cityFeedback: "The bonding conductor on the supply side of the PV disconnect is smaller than NEC Table 250.102(C)(1) requires for the ungrounded conductors. Upsize it and update the wire table.",
      designTeamAction: "Size the supply-side bonding jumper from the largest ungrounded tap conductor per Table 250.102(C)(1) and revise the wire table / three-line.",
      evidenceNeeded: ["Wire table: tap conductor size and bonding jumper / ground size"],
      codeReferences: [cite("NEC", bondingRef)],
    }));
  }

  // (b) Conductor ampacity after fill and terminations against the tag's OCPD. The inverter output
  // circuit electricalSizing already recomputes (with the design ambient) is not repeated here.
  const sizedConductor = parseConductor(String(project.parserSnapshot?.acConductor ?? ""));
  const sizedBreaker = Number.parseFloat(String(project.parserSnapshot?.pvBreaker ?? ""));
  const overAmpacity: string[] = [];
  const ampacityOk: string[] = [];
  for (const r of rows) {
    const c = r.phase;
    if (sizedConductor && sizedConductor.size === c.size && sizedConductor.material === c.material && sizedBreaker === r.ocpd) continue;
    const column = c.column ?? 90;
    const base = AMPACITY[c.material][c.size][column === 60 ? 0 : column === 75 ? 1 : 2];
    // A stated count may include a neutral that 310.15(E) does not count; with no neutral labelled
    // apart, one is assumed (the favourable reading).
    const counted = r.phaseQty != null ? (r.neutralLabelled ? r.phaseQty : r.phaseQty - 1) : null;
    const factor = counted != null ? fillAdjustment(counted) : 1;
    const derated = base * factor;
    const terminal = AMPACITY[c.material][c.size][column === 60 ? 0 : 1];
    const ampacity = Math.min(derated, terminal);
    const small = SMALL_CONDUCTOR_MAX[c.material][c.size];
    const maxOcpd = Math.min(nextStandardOcpd(ampacity) ?? Infinity, small ?? Infinity);
    if (r.ocpd <= maxOcpd + 1e-9) ampacityOk.push(`${where(r)}: ${desc(c)} ${fmt(ampacity, 2)} A, largest permitted OCPD ${maxOcpd} A >= ${r.ocpd} A`);
    if (r.ocpd > maxOcpd + 1e-9) {
      overAmpacity.push(`${where(r)}: ${desc(c)}${c.insulation ? "" : " (insulation not stated; 90 C column assumed)"} ${base} A (Table 310.16, ${column} C)${counted != null ? ` x ${factor} for ${counted} current-carrying conductors` : ""} = ${fmt(derated, 2)} A${ampacity < derated ? `, ${fmt(ampacity, 2)} A at ${column === 60 ? 60 : 75} C terminations (110.14(C))` : ""}; largest permitted OCPD ${maxOcpd} A${small != null && small <= maxOcpd ? " (240.4(D))" : ""}, but the table shows ${r.ocpd} A`);
    }
  }
  if (!overAmpacity.length && ampacityOk.length) {
    records.push(passRecord({ ruleId: "city.elec.wire-table-ocpd-over-ampacity", category: "electrical", title: "Wire table OCPD within each conductor's adjusted ampacity", codeReferences: [cite("NEC", ampacityRef)], ruleBasis: basis(ampacityRef), arithmetic: `240.4 / 310.15, from the plan set's own wire table (30 C ambient assumed): ${ampacityOk.join("; ")}.` }));
  }
  if (overAmpacity.length) {
    out.push(finding({
      id: "city.elec.wire-table-ocpd-over-ampacity",
      severity: "warning",
      title: "Wire table OCPD larger than the conductor's adjusted ampacity",
      message: `240.4 / 310.15, from the plan set's own wire table (30 C ambient assumed): ${overAmpacity.join("; ")}. Values as read from the sheet text; confirm against the sheet.`,
      cityFeedback: "A conductor in the wire table is not protected by the overcurrent device shown once conduit fill and termination limits are applied. Upsize the conductor or reduce the OCPD.",
      designTeamAction: "Upsize the listed conductors (or reduce the OCPD where 125 percent of the load allows) and show the ampacity calculation in the wire table.",
      evidenceNeeded: ["Wire table: conductor size, insulation, count per raceway and OCPD per tag"],
      codeReferences: [cite("NEC", ampacityRef)],
    }));
  }

  // (c) 40 percent raceway fill, only where the tag states the raceway and every conductor's count.
  const overFill = rows.filter((r) => r.fill && r.fill.area > r.fill.allowance + 1e-9).map((r) => {
    const f = r.fill!;
    return `${where(r)}: ${f.parts.join(" + ")} = ${fmt(f.area)} in² in a ${f.tradeSize}" ${f.raceway}, above its 40 % allowance of ${f.allowance} in² (Chapter 9 Table 4)`;
  });
  const fillOk = rows.filter((r) => r.fill && r.fill.area <= r.fill.allowance + 1e-9).map((r) => `${where(r)}: ${fmt(r.fill!.area)} in² <= ${r.fill!.allowance} in² in a ${r.fill!.tradeSize}" ${r.fill!.raceway}`);
  if (!overFill.length && fillOk.length) {
    records.push(passRecord({ ruleId: "city.elec.wire-table-raceway-fill", category: "electrical", title: "Raceway fill within 40 percent", codeReferences: [cite("NEC", fillRef)], ruleBasis: basis(fillRef), arithmetic: `Chapter 9 Table 1, from the plan set's own wire table: ${fillOk.join("; ")}.` }));
  }
  if (overFill.length) {
    out.push(finding({
      id: "city.elec.wire-table-raceway-fill",
      severity: "warning",
      title: "Raceway over 40 percent fill in the wire table",
      message: `Chapter 9 Table 1, from the plan set's own wire table: ${overFill.join("; ")}. Values as read from the sheet text; confirm against the sheet.`,
      cityFeedback: "The conductors listed for a raceway exceed the 40 percent fill NEC Chapter 9 Table 1 allows. Use a larger raceway or split the circuits.",
      designTeamAction: "Upsize the raceway (or split the circuits) for each listed tag and revise the wire table.",
      evidenceNeeded: ["Wire table: raceway trade size and type, conductor count, size and insulation per tag"],
      codeReferences: [cite("NEC", fillRef)],
    }));
  }

  // (d) A load center's stated spaces against the breaker poles listed with it (callout).
  const panels = readPanelSpaces(pages);
  if (panels.length) {
    out.push(finding({
      id: "city.elec.panel-spaces-short",
      severity: "callout",
      title: "Load center has fewer spaces than the breaker poles listed for it",
      message: `110.3(B): ${panels.map((p) => `${p.sheet ? `${p.sheet}: ` : ""}load center stated as ${p.spaces} spaces, listed with ${p.sets.join(" + ")} = ${p.poles} poles`).join("; ")}. More poles than spaces needs a larger load center or tandem / quad breakers its label lists. Values as read from the sheet text; confirm against the sheet.`,
      cityFeedback: "The load center shown does not have enough spaces for the breakers listed. Show a larger load center or breakers listed for it (tandem / quad).",
      designTeamAction: "Revise the combiner / load center selection or specify listed tandem / quad breakers, and update the SLD.",
      evidenceNeeded: ["Load center spaces and the breakers (quantity and poles) installed in it"],
      codeReferences: [cite("NEC", spacesRef)],
    }));
  }
  return [...out, ...records];
}
