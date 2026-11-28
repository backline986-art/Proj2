import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import { extractPdfPages } from "./batchImport";
import { portalUploadCapBytes } from "../../portal-bot/src/uploadCap";
import type { AppDb } from "./db";
import type { LLMProvider, PlanSheetKind, ProjectRecord } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { outlinedTextPagesOfPdf } from "./outlinedTextPages";
import { recordOutlinedPagesValue, saveProjectDocument, listProjectDocuments, projectDocsByType, shippedPlanSet, shippedPlanSetDocumentId, documentTypesDeletedSince, withdrawSplitPart } from "./projectDocuments";

// Sheet/content patterns → upload doc category. Ported from the parser's detectSplitPages;
// pages are scored against each category and assigned to the best match. The categories are
// the files an AHJ/utility upload package needs.
//
// Real plan sets identify each sheet by the Sheet Name spelled out in the title block —
// present as extractable text even when the body of the sheet is an image (equipment
// cut-sheets, spec sheets). So we match the sheet-name text, and a single page may satisfy
// MORE THAN ONE category (e.g. Infinity's "PV MODULE / INV SPECIFICATION SHEET" is both the
// module spec and the inverter spec). The general-notes / sheet-index page lists every sheet
// name, so it would match everything — it is detected and skipped before classification.
//
// `vocabulary` patterns are words a sheet USES rather than the sheet's NAME, and together they
// count as at most ONE hit. The roof words (RAFTER / TRUSS / ROOF SECTION) are the case: the
// site plan's roof legend ("= RAFTER"), its "ROOF SECTION(S)" block and a "TRUSS SIZE &
// SPACING" note carry all three, so as full patterns they out-scored SITE PLAN + PV 1.0 (3 to 2)
// and the winner-take-all below filed the site plan as structural — no site_plan part was
// written and the submit gate owed a sheet the plan set contained (#29). A real structural
// sheet still wins on its name (MOUNT/ATTACHMENT DETAIL, S 1.x, STRUCTURAL).
//
// `words` are full hits on most pages, but on an ELECTRICAL sheet (an E x.x sheet number) they —
// and the vocabulary — are words the sheet uses, not its name, and do not count. The electrical
// NOTES sheet (E 1.2) carries a "STRUCTURAL NOTES" block (design loads, rafter spacing, truss
// capacity); the bare STRUCTURAL plus that vocabulary scored it structural, and with no
// electrical category naming E 1.2 it was filed into the structural upload (#33). On an E sheet
// only a structural sheet NAME (MOUNT/ATTACHMENT DETAIL, S 1.x) pulls it into structural;
// otherwise it stays in its named category or unclassified.
const ELECTRICAL_SHEET = /\bE\s*-?\s*\d+\.\d+\b/i;
// `patterns` are sheet NAMES (and labels drawn only on that sheet); `sheetNumbers` are the bare
// sheet-number regexes (E 1.1, PV 1.0…). Both score the same — filing sums them — but a number is
// also how other sheets CITE a sheet ("SEE E 1.1 FOR WIRING"), so only a `patterns` hit counts as
// the page's own title-block name for the undecided-spec report (#119).
//
// `wordsSkipNotes`: the category's `words` do not count on a NOTES sheet either (NOTES_SHEET below).
// The #33 rule only knows an E x.x number, and a "PV-2 GENERAL NOTES" or "E-2 NOTES" sheet that says
// "PROVIDE PLACARD" is a notes sheet, not a placard (#67 review).
export const CATEGORY_PATTERNS: Array<{ docType: string; label: string; patterns: RegExp[]; sheetNumbers?: RegExp[]; words?: RegExp[]; vocabulary?: RegExp[]; wordsSkipNotes?: boolean }> = [
  // "ELECTRICAL LINE DIAGRAM" is how the Synthetic-style sets title their SLD (sheet PV-6) —
  // neither "one-line" nor "3-line" appears anywhere on the sheet, so the whole electrical
  // diagram went unsplit and the submit gate reported the SLD missing from a plan set that
  // plainly contains one. Anchored on LINE DIAGRAM with an electrical qualifier; a bare
  // /LINE DIAGRAM/ is deliberately NOT used ("property line", "setback line" prose risk).
  //
  // A SPACE IS A HYPHEN IN A SHEET TITLE (#691). "-?" let "SINGLE-LINE" and "3-LINE DIAGRAM" through
  // but not "SINGLE LINE DIAGRAM" or "3 LINE DIAGRAM", and "THREE LINE DIAGRAM" / "ELECTRICAL
  // SCHEMATIC" had no pattern, so a NEM package reported the SLD missing from a set that has one.
  // Hyphen OR whitespace now, by title wording, never by jurisdiction. Two words stay anchored so prose
  // cannot pass for a title: the 3 / THREE form needs DIAGRAM ("THREE LINE ITEMS", "PROPERTY LINE"),
  // and a SPACED "ONE LINE" needs a diagram noun after it ("ONE LINE PER CIRCUIT" is a note).
  { docType: "sld", label: "SLD / one-line", patterns: [/\b(?:3|THREE)[\s-]?LINE\s+DIAGRAM\b/i, /\bONE(?:-?LINE\b|\s+LINE\s+(?:DIAGRAM|DWG|DRAWING|SCHEMATIC)\b)/i, /\bSINGLE[\s-]?LINE\b/i, /\bELECTRICAL\s+LINE\s+DIAGRAM\b/i, /\bELECTRICAL\s+SCHEMATIC\b/i], sheetNumbers: [/\bE\s*1\.1\b/i] },
  // Fire access pathways / setbacks are drawn and labeled on the site plan (the fire-access
  // sheet the gate asks for), so they identify it alongside the sheet name.
  { docType: "site_plan", label: "Site / plot plan", patterns: [/\bSITE PLAN\b/i, /\bPLOT PLAN\b/i, /\bFIRE\s+(?:PATHWAYS?|SETBACKS?|ACCESS)\b/i], sheetNumbers: [/\bPV\s*1\.[01]\b/i] },
  { docType: "structural", label: "Structural / roof framing", patterns: [/\bMOUNT DETAIL\b/i, /\bATTACHMENT DETAIL\b/i], sheetNumbers: [/\bS\s*1\.\d\b/i], words: [/STRUCTURAL/i], vocabulary: [/\bROOF SECTION\b/i, /\bRAFTER\b/i, /\bTRUSS\b/i] },
  // Match the dedicated SPEC SHEET by its title-block Sheet Name only. Model strings
  // (Q.TRON, Q.MI) and the word "PV MODULE" appear in the spec-callout block on the site
  // plan, SLD, etc., so they are NOT reliable — only the sheet name "… SPEC(IFICATION) SHEET"
  // identifies the actual cut-sheet page. The combined "MODULE / INV SPECIFICATION SHEET"
  // counts as BOTH module and inverter spec.
  //
  // A WIRING CALCULATIONS sheet carries text TABLES headed "INVERTER SPECIFICATIONS" and
  // "PV MODULE SPECIFICATIONS" — the same words as a spec sheet's name, and that sheet's only
  // hit, so winner-take-all had nothing to rescue it with and it shipped as the inverter spec
  // (#66). It is excluded by what the sheet IS (CALCS_SHEET below), not by tightening the names:
  // the text layer joins the title block's lines, so "… SPECIFICATION SHEET" vs "… SPECIFICATIONS"
  // only tests what label happens to follow the name ("SHEET NUMBER" or not).
  //
  // "EQUIPMENT SPECIFICATION(S)" is deliberately NOT a pattern here (#66). Those pages (Synthetic
  // PV-11+) are image cut-sheets whose only text is the title block, and the section holds the
  // module, the combiner, the racking brochure… all with the same text. Filing them as
  // module_spec (and "counting as both") put a combiner and a racking brochure in the spec parts
  // with no way to tell. They are reported as undecided instead (SPEC_SHEET_NAME below).
  { docType: "module_spec", label: "Module spec", patterns: [/MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i, /MODULE\s+SPECIFICATION\s+SHEET/i, /PV MODULE SPEC/i] },
  // NOTE: do NOT match on the UL listing standard (/UL 1741/) — that number is cited on the
  // SLD, general notes, and most electrical sheets, so it pulled those dense pages into the
  // inverter_spec split and bloated it past PowerClerk's 5 MB upload limit. Match the dedicated
  // SPEC SHEET by its title-block name only, per this file's stated discipline.
  { docType: "inverter_spec", label: "Inverter spec", patterns: [/MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i, /MICRO-?INVERTER\s+SPEC(?:IFICATION)?S?\b/i, /\bINVERTER\s+SPEC(?:IFICATION)?S?\b/i] },
  // The battery / ESS datasheet (#261), by its sheet NAME here and by its CONTENT in batteryPage()
  // below — never by a sheet code one design firm uses (the parser page only read DS-coded sheets).
  // Scored only when batteryPage() says "spec": a calcs sheet, or a page that reads as an inverter
  // (MPPT / PV input / a combined INVERTER-BATTERY name), never takes it. After the inverter spec, so
  // an "INVERTER SPECIFICATIONS" + "BATTERY SPECIFICATIONS" tie goes to the inverter; before labels,
  // which stays last.
  { docType: "battery_spec", label: "Battery / ESS spec", patterns: [/\b(?:BATT(?:ERY|ERIES)?|ESS|ENERGY\s+STORAGE(?:\s+SYSTEMS?)?)\s*(?:SPEC(?:IFICATION)?S?|DATA\s*-?\s*SHEETS?|DATASHEETS?|CUT\s*-?\s*SHEETS?)\b/i] },
  // PLACARD is the sheet name of the service / PV directory plaque sheet (NEC 690.56, 705.10). It
  // scored 0 everywhere and was left out of the labels part (#67). It is a `words` hit, not a sheet
  // name: a NOTES sheet says "PROVIDE PLACARD …" too, and there it does not count (the #33 rule on
  // an E x.x sheet, `wordsSkipNotes` on any other notes sheet). An SLD or site plan whose notes mention a placard ties at best, and the
  // tie goes to the earlier category, so labels stays last. "DIRECTORY" / "PLAQUE" are deliberately
  // not patterns: the 705.10 directory note is common on SLDs and site plans, and a second hit would
  // out-score the sheet's own name.
  { docType: "labels", label: "Labels / placards", patterns: [/\bWARNING LABELS\b/i, /\bLABEL LOCATION\b/i], sheetNumbers: [/\bE\s*1\.3\b/i], words: [/\bPLACARDS?\b/i], wordsSkipNotes: true },
];

// A calculations sheet (WIRING CALCULATIONS, ELECTRICAL CALCULATIONS). Its body tabulates the
// module and inverter specs, so it is never a spec part — the spec categories and the combined
// MODULE / INV fan-out do not apply to it (#66). Other categories still score as before.
const CALCS_SHEET = /\b(?:WIR(?:E|ING)|ELECTRICAL)\s+CALC(?:ULATION)?S?\b/i;
const SPEC_DOC_TYPES = new Set(["module_spec", "inverter_spec", "battery_spec"]);

// BATTERY / ESS DATASHEETS BY CONTENT (#261). A storage job owes the battery's cut sheet (UL 9540,
// essRequirements.ts), and its make, model and kWh feed the NEM portal and the AHJ's ESS review. The
// sheet is found by what it SAYS, whatever the plan set numbers it:
//   - a battery body: a labelled energy capacity in kWh (USABLE / NOMINAL / TOTAL ENERGY 13.5 kWh,
//     ENERGY (kWh) 10.1), storage words (BATTERY, ENERGY STORAGE, ESS, LITHIUM, LFP, UL 1973), and at
//     least BATTERY_DATASHEET_MARKS_MIN of the performance-table rows a datasheet prints and a drawing
//     sheet does not (round-trip efficiency, depth of discharge, cycle life, warranty, operating
//     temperature, scalability, chemistry, continuous / peak power). An SLD or ESS detail that calls
//     out "13.5 kWh LITHIUM ION UL 9540" has the first two and not the table;
//   - or the sheet's own name (CATEGORY_PATTERNS battery_spec: BATTERY SPEC SHEET, ESS DATA SHEET…).
// MUST-EXCLUDE (Helm's triage on #261): an inverter datasheet, an ESS / hybrid-inverter datasheet and a
// calculation sheet are never the battery spec. A page that reads as an inverter (MPPT, PV input, CEC
// efficiency, a HYBRID / BATTERY / STORAGE INVERTER, a combined INVERTER / BATTERY name) is not filed
// as the battery even when it also states a kWh capacity (a hybrid inverter's compatible battery range;
// an all-in-one with PV inputs): it is reported UNDECIDED, so the existing page-index read (#79) or a
// person decides — never guessed. A calcs, index or cover page never qualifies. On an E x.x sheet the
// body test does not run (the #33 rule: there the words are words the sheet uses).
// Text only: no model call here. A page with no text layer is the scanned / hybrid path's (scannedPlanSet).
const BATTERY_CAPACITY = /\b(?:USABLE|NOMINAL|TOTAL|RATED|AVAILABLE|STORAGE|ENERGY|BATTERY)\s+(?:ENERGY|CAPACITY)\d?\b[^.;]{0,40}?\b\d{1,3}(?:\.\d{1,2})?\s*kWh\b|\b(?:ENERGY|CAPACITY)\s*\(\s*kWh\s*\)\s*:?\s*\d{1,3}(?:\.\d{1,2})?\b/i;
const STORAGE_WORDS = /\bBATTER(?:Y|IES)\b|\bENERGY\s+STORAGE\b|\bESS\b|\bLITHIUM\b|\bLFP\b|\bLiFePO4\b|\bUL\s*-?\s*1973\b/i;
const BATTERY_DATASHEET_MARKS: RegExp[] = [
  /\bROUND[\s-]*TRIP\s+EFFICIENCY\b/i,
  /\bDEPTH\s+OF\s+DISCHARGE\b|\bDoD\b/,
  /\bCYCLE\s+LIFE\b|\b\d[\d,]*\s*CYCLES\b/i,
  /\bWARRANTY\b/i,
  /\bOPERATING\s+TEMP(?:ERATURE)?\b/i,
  /\bSCALAB(?:LE|ILITY)\b|\bSTACKABLE\b|\bEXPANDABLE\b/i,
  /\bCHEMISTRY\b|\bLiFePO4\b|\bLFP\b|\bLITHIUM[\s-]+(?:ION|IRON)\b|\bNMC\b/i,
  /\b(?:CONTINUOUS|PEAK)\s+(?:POWER|OUTPUT|DISCHARGE|CHARGE)\b/i,
];
const BATTERY_DATASHEET_MARKS_MIN = 3;
const INVERTER_BODY = /\bMPPTs?\b|\bPV\s+INPUTS?\b|\bMAX(?:IMUM)?\.?\s+PV\b|\bCEC\s+(?:WEIGHTED\s+)?EFFICIENCY\b|\bMAX(?:IMUM)?\.?\s+(?:DC\s+)?INPUT\s+(?:VOLTAGE|CURRENT)\b|\bSTRINGS?\s+PER\b|\b(?:HYBRID|BATTERY|STORAGE|ESS)\s+INVERTERS?\b|\bINVERTERS?\s*(?:[\/&+]|AND)\s*BATT|\bBATT(?:ERY|ERIES)?\s*(?:[\/&+]|AND)\s*INVERTER/i;
const BATTERY_SHEET_NAME = CATEGORY_PATTERNS.find((c) => c.docType === "battery_spec")!.patterns[0];

/** Does the page's own text read as a battery datasheet? "spec": file it as the battery spec;
 *  "undecided": it names or describes a battery but also reads as an inverter — a person or the
 *  page-index read decides; null: not a battery datasheet. */
export function batteryPage(text: string): "spec" | "undecided" | null {
  if (isIndexOrNotesPage(text) || CALCS_SHEET.test(text)) return null;
  const named = BATTERY_SHEET_NAME.test(text);
  const body = !ELECTRICAL_SHEET.test(text) && BATTERY_CAPACITY.test(text) && STORAGE_WORDS.test(text)
    && BATTERY_DATASHEET_MARKS.filter((re) => re.test(text)).length >= BATTERY_DATASHEET_MARKS_MIN;
  if (!named && !body) return null;
  return INVERTER_BODY.test(text) ? "undecided" : "spec";
}

// A notes sheet: NOTES anywhere on the page (GENERAL NOTES, ELECTRICAL NOTES, a bare NOTES sheet
// name) except the placard sheet's own "LABELING NOTES" / "PLACARD NOTES" heading. Read only for a
// category with `wordsSkipNotes` (labels): the other categories' words keep their #33 behavior.
const NOTES_SHEET = /(?<!\b(?:LABEL(?:ING|S)?|PLACARDS?)\s+)\bNOTES\b/i;

// A page that NAMES a spec sheet. One that did not land in a spec part is reported in
// `undecidedSpecPages`, so a spec-named page is never dropped silently: a title-only
// "EQUIPMENT SPECIFICATION" cut-sheet (module datasheet? combiner? racking brochure?) is the
// expected case, and the split says it could not decide rather than guessing (#66). That holds
// whatever else the page scored (#91): a racking brochure whose vendor title block says STRUCTURAL
// wins the structural category on that one stray hit, and before, only a page NO category claimed
// was reported — so it went into the structural part with nothing said. It still goes there (the
// winner-take-all scoring is unchanged); `undecidedSpecFiledAs` names the category that took it.
// A calculations sheet is not undecided — it is known not to be a spec sheet. Neither is a page whose
// winning category hit a title-block sheet NAME (#119): a dense SLD whose callout cites "INVERTER
// SPECIFICATIONS" won sld on its own sheet name, so the filing has a strong reason and the report
// would be noise. A winner on `words`/`vocabulary` only (the STRUCTURAL brochure) or on a bare sheet
// NUMBER only (an EQUIPMENT SPECIFICATION page whose body says "SEE E 1.1") is still reported.
const SPEC_SHEET_NAME = /(?:MICRO-?)?(?:INVERTERS?|MODULES?|EQUIPMENT)\s+SPEC(?:IFICATION)?S?\b/i;

// The general-notes / sheet-index cover page lists every sheet name and would otherwise
// match every category. It is never an uploadable single-category doc, so skip it.
function isIndexOrNotesPage(text: string): boolean {
  return /SHEET INDEX/i.test(text) || /GENERAL NOTES AND PROJECT DATA/i.test(text);
}

// SPEC SHEETS NAMED ONLY IN THE COVER'S SHEET INDEX (#199). An image-only datasheet page whose text
// layer is just the title block and its sheet number ("S-1") names nothing, so SPEC_SHEET_NAME never
// saw it: it was filed nowhere and not reported undecided, and the page-index read (#79) never ran
// on it. Its name lives on the cover: "S-1 SPEC SHEET". The index is read for the sheet numbers it
// names as a spec sheet ("SPEC SHEET", "CUT SHEET", "DATA SHEET", "SPECIFICATION SHEET", with or
// without an equipment word, or SPEC_SHEET_NAME's own wording), and a page carrying one of those
// numbers is a spec-named page like any other: undecided unless a spec category claims it. Nothing
// else changes: the read decides from the page image, under the same rule 2 screen and budget.
//
// A calculations entry ("S-1 STRUCTURAL CALCS") is never a spec sheet, whatever else its name says.
// A page the index cannot name (no index, its number absent, or two index numbers and no labelled
// SHEET NUMBER on it) is not guessed: with no category it stays in `unclassifiedPages`.
//
// Sheet numbers are UPPERCASE letters then a number, a hyphen or a space between or not: S-1, S1,
// S 1.1, PV-4, E-1.2. The key drops the separator, so the cover's "S-1" is the page's "S1".
// A word that precedes a number in prose or a title block ("SHEET 2 OF 3", "REV 1", "QTY 24") is not
// a sheet number: as one it splits an index row, or forms a stray group in a column run.
const INDEX_SHEET_NUMBER = /\b([A-Z]{1,3})\s?-?\s?(\d{1,2}(?:\.\d{1,2})?)\b(?!\.\d)/g;
const NOT_A_SHEET_PREFIX = /^(?:OF|REV|QTY|NO|AT|TO|IN|ON|BY|OR|AND|FOR|PER|THE|UL|NEC|IBC|IRC|IFC|AWG|KW|AMP|MIN|MAX|TYP|EA|FT)$/;
const INDEX_SPEC_NAME = new RegExp(`${SPEC_SHEET_NAME.source}|\\b(?:SPEC(?:IFICATION)?S?|CUT|DATA)\\s*-?\\s*SHEETS?\\b`, "gi");
const INDEX_CALCS_NAME = /\bCALC(?:ULATION)?S?\b/i;
// A row's name is the words up to the next sheet number, at most this many: the last row runs into
// whatever the cover says next, and a notes paragraph that mentions a "DATA SHEET" is not its name.
const INDEX_NAME_WORDS = 6;
// Where the index's names end on the cover: the notes or project-data block that follows it. A
// column run's names stop there, and at INDEX_NAME_WORDS per number in the run, so "NOTES: SEE MODULE
// SPEC" after the table is never counted as a row (#212 review). The block is a NOTE(S) heading with
// a colon or dash ("NOTE:", "GENERAL NOTES - …"), any other NOTE(S) word ("ELECTRICAL NOTES SEE …"),
// the first numbered note ("1. SEE …"), or PROJECT DATA — in any case. A sheet NAMED "GENERAL NOTES"
// in the name column (no colon or dash) is a name, not that block, and does not end it.
const INDEX_NAMES_END = /\bNOTES?\b\s*(?:[:\-\u2013]|1\b)|(?<!\bGENERAL\s+)\bNOTES?\b|(?:^|\s)1\.\s|\bPROJECT\s+DATA\b/i;
// A PAPER SIZE IS NOT A SHEET NUMBER (audit 2026-11-28). A title block that prints its sheet size
// ("ANSI B 11" X 17"", "ARCH D 24 X 36") gave every page, the cover included, two more numbers:
// B 11 and X 17. With three listed numbers on a page no page had a number of its own, so a data
// sheet the index names was never reported undecided. A size is told by its SHAPE, in any paper
// family, never by a list of letters: the number carries an inch mark, or is one side of
// "<number> X <number>" (the X being the candidate's own letter when it is the second side).
// A number in quotes (SEE "E-1") is a quoted sheet number, not inches: the mark must not be the
// closing half of a pair opened right before the letters.
const SIZE_AFTER = /^(?:"|''|”|″|\s*[xX×]\s*\d)/;
const SIZE_BEFORE = /\d\s*(?:"|''|”|″)?\s*$/;
const QUOTE_BEFORE = /(?:"|'|“)$/;
const sheetNumbers = (text: string) => [...text.matchAll(INDEX_SHEET_NUMBER)]
  .filter((m) => !NOT_A_SHEET_PREFIX.test(m[1]))
  .map((m) => ({ key: `${m[1]}${m[2]}`, letters: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
  .filter((n) => {
    const before = text.slice(Math.max(0, n.start - 8), n.start);
    if (SIZE_AFTER.test(text.slice(n.end, n.end + 8)) && !QUOTE_BEFORE.test(before)) return false;
    return !(n.letters === "X" && SIZE_BEFORE.test(before));
  });
/** The first `words` words of `text`, cut at the notes / project-data block. */
const indexNames = (text: string, words: number) => {
  const end = INDEX_NAMES_END.exec(text);
  return (end ? text.slice(0, end.index) : text).trim().split(/\s+/).slice(0, words).join(" ");
};
const isIndexSpecName = (name: string) => new RegExp(INDEX_SPEC_NAME.source, "i").test(name) && !INDEX_CALCS_NAME.test(name);

/**
 * The sheet numbers the cover's sheet index names as a spec sheet, and every number it lists.
 * Two layouts, as the text layer joins them:
 *   - ROWS: "S-1 SPEC SHEET S-2 SPEC SHEET" — each number, then its name.
 *   - COLUMNS: "SHEET # CS-1 PV-1 S-1 S-2 SHEET NAME COVER SITE PLAN SPEC SHEET SPEC SHEET" — a run
 *     of numbers with nothing between them, then every name. The names cannot be split back into
 *     rows, so the run's spec names are COUNTED, and they belong to a group only when exactly one
 *     same-letter group of the run, back to back, has that many numbers (S-1, S-2 above). Any other
 *     count, or two groups that size, names nothing: the pages stay listed as they were.
 */
export function indexSpecSheets(pageTexts: string[]): { spec: Set<string>; listed: Set<string>; names: Map<string, string> } {
  const spec = new Set<string>();
  const listed = new Set<string>();
  // The name a ROW gives its sheet number (the first row that names it): how a page's own sheet
  // name is known when the title block's text does not put it beside its label. Columns cannot be
  // split back into rows, so they name nothing here.
  const names = new Map<string, string>();
  for (const text of pageTexts) {
    if (!isIndexOrNotesPage(text)) continue;
    const nums = sheetNumbers(text);
    for (let i = 0; i < nums.length; ) {
      // The run of numbers starting here with nothing (but separators) between them.
      let j = i;
      while (j + 1 < nums.length && !/[A-Z0-9]/i.test(text.slice(nums[j].end, nums[j + 1].start))) j++;
      const after = text.slice(nums[j].end, j + 1 < nums.length ? nums[j + 1].start : text.length);
      const run = nums.slice(i, j + 1);
      for (const n of run) listed.add(n.key);
      if (run.length === 1) {
        const name = indexNames(after, INDEX_NAME_WORDS);
        if (!names.has(run[0].key)) names.set(run[0].key, name);
        if (isIndexSpecName(name)) spec.add(run[0].key);
      } else {
        const count = [...indexNames(after, run.length * INDEX_NAME_WORDS).matchAll(INDEX_SPEC_NAME)].length;
        const prefix = (k: string) => k.replace(/[\d.]+$/, "");
        const groups = new Map<string, number[]>();
        run.forEach((n, at) => groups.set(prefix(n.key), [...(groups.get(prefix(n.key)) ?? []), at]));
        const fits = [...groups.values()].filter((at) => count > 0 && at.length === count && at[at.length - 1] - at[0] === at.length - 1);
        if (fits.length === 1) for (const at of fits[0]) spec.add(run[at].key);
      }
      i = j + 1;
    }
  }
  return { spec, listed, names };
}

// The label in any case ("Sheet Number"), and a paper size the text layer puts between the label
// and its value skipped ("Sheet Size Sheet Number ANSI B 11" X 17" DS 01": the label row, then the
// value row). The value itself is still UPPERCASE letters then a number.
const SHEET_NUMBER_LABEL = /\bSHEET\s*(?:NUMBER|NO\.?|#)\s*:?\s*/i;
const LEADING_PAPER_SIZE = /^(?:(?:ANSI|ARCH|ISO)\s+)?(?:[A-E]\d?\s+)?\d{1,2}(?:\.\d+)?\s*(?:"|''|”|″)?\s*[xX×]\s*\d{1,2}(?:\.\d+)?\s*(?:"|''|”|″)?\s*/i;

/** The page's own sheet number among the index's: the labelled SHEET NUMBER / SHEET NO / SHEET #
 *  when the page has one (a labelled PV-11 that cites "SEE S-1" is PV-11, not S-1), else the only
 *  index number on the page. Anything else is no answer. */
export function pageSheetNumber(text: string, listed: Set<string>): string | null {
  const label = SHEET_NUMBER_LABEL.exec(text);
  const labelled = label
    ? /^([A-Z]{1,3}\s?-?\s?\d{1,2}(?:\.\d{1,2})?)\b/.exec(text.slice(label.index + label[0].length).replace(LEADING_PAPER_SIZE, ""))
    : null;
  if (labelled) {
    const key = sheetNumbers(labelled[1])[0]?.key;
    return key && listed.has(key) ? key : null;
  }
  const onPage = new Set(sheetNumbers(text).map((n) => n.key).filter((k) => listed.has(k)));
  return onPage.size === 1 ? [...onPage][0] : null;
}

// Assign a page to its SINGLE best-matching category (most pattern hits wins), the original
// winner-take-all discipline. Returning EVERY matching category instead let a dense SLD page
// that merely cites "INVERTER SPECIFICATIONS" / "UL 1741" in a callout block leak into the
// inverter_spec split alongside the real cut-sheet — several heavy pages per category, which
// blew the per-file size past PowerClerk's 5 MB upload limit (every required upload failed).
//
// The one legitimate multi-category case is preserved explicitly: a COMBINED
// "MODULE / INV SPECIFICATION SHEET" genuinely IS both the module spec and the inverter spec,
// so that single sheet is added to both — and nothing else fans out.
//
// `byPattern` says whether the winning category scored at least one title-block sheet-NAME
// (`patterns`) hit, as opposed to only a sheet number or `words` / `vocabulary` — the undecided-spec
// report reads it (#119). Filing never does: the score is the same sum it always was.
//
// Exported for docSplitterMirror.test.ts, which pins frontend/parser-review.js scoreSplitPage /
// specSheetPages (the parser page's split map, read by the submit gate) to this answer (#193).
//
// `sheetName` is the name the cover's sheet index gives THIS page's sheet number (indexSpecSheets
// `names`), when the caller knows it. ON AN ELECTRICAL-NUMBERED SHEET A `words` HIT COUNTS WHEN THE
// WORD IS THE SHEET'S OWN NAME (audit 2026-11-28): the #33 rule drops `words` on an E x.x sheet
// because there they are words the sheet uses, and that left a sheet NAMED "PLACARD" and numbered
// E 1.4 scoring nothing and out of the labels part. The index says what the sheet is called; a
// notes sheet that only says "PROVIDE PLACARD" is not called that, and a NOTES name never counts for
// a `wordsSkipNotes` category.
export function scorePage(text: string, sheetName = ""): { docTypes: string[]; byPattern: boolean } {
  if (isIndexOrNotesPage(text)) return { docTypes: [], byPattern: false };
  const electricalSheet = ELECTRICAL_SHEET.test(text);
  const calcsSheet = CALCS_SHEET.test(text);
  const notesSheet = NOTES_SHEET.test(text);
  const battery = batteryPage(text);
  const namedBy = (cat: { words?: RegExp[]; wordsSkipNotes?: boolean }) => (!sheetName || (cat.wordsSkipNotes && NOTES_SHEET.test(sheetName))
    ? 0 : (cat.words ?? []).reduce((n, re) => (re.test(sheetName) ? n + 1 : n), 0));
  let best: { docType: string; score: number; patternHits: number } | null = null;
  for (const cat of CATEGORY_PATTERNS) {
    if (calcsSheet && SPEC_DOC_TYPES.has(cat.docType)) continue;
    // Only a page batteryPage() files as the battery spec scores for it (#261): an inverter-reading
    // page named "BATTERY SPEC" is undecided, not filed.
    if (cat.docType === "battery_spec" && battery !== "spec") continue;
    const hits = (res: RegExp[] | undefined) => (res ?? []).reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
    const patternHits = hits(cat.patterns);
    const score = patternHits + hits(cat.sheetNumbers)
      + (electricalSheet ? namedBy(cat) : (cat.wordsSkipNotes && notesSheet ? 0 : hits(cat.words)) + (cat.vocabulary?.some((re) => re.test(text)) ? 1 : 0));
    if (score > 0 && (!best || score > best.score)) best = { docType: cat.docType, score, patternHits };
  }
  // A battery datasheet found by its BODY (no battery sheet name) is the battery spec unless another
  // category won on its own title-block sheet NAME (an SLD or site plan that calls out the battery).
  // A stray `words` / vocabulary / sheet-number win (STRUCTURAL in a wall-mount note) does not keep it.
  if (battery === "spec" && best?.docType !== "battery_spec" && !(best && best.patternHits > 0)) {
    best = { docType: "battery_spec", score: 1, patternHits: BATTERY_SHEET_NAME.test(text) ? 1 : 0 };
  }
  if (!best) return { docTypes: [], byPattern: false };
  const out = [best.docType];
  if (!calcsSheet && /MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i.test(text)) {
    if (!out.includes("module_spec")) out.push("module_spec");
    if (!out.includes("inverter_spec")) out.push("inverter_spec");
  }
  return { docTypes: out, byPattern: best.patternHits > 0 };
}

// Which documents each submission TYPE needs in its upload package. The package is
// assembled from project_documents of these types — split sheets AND separately-uploaded
// files (e.g. the meter photo, which is never in the plan set). Extend as new portals
// surface their needs; eventually this can be driven by the learned KB requiredDocuments.
//
// SLD splitting is only needed for two cases:
//   • utility NEM submittals (nem) — utility portals want the SLD, site plan, and inverter
//     spec as separate files alongside the meter photo.
//   • ProjectDox/permit AHJ submittals (permit) — ProjectDox requires each sheet uploaded
//     to its own document slot. Standard Accela/EnerGov portals receive the FULL plan set
//     as a single PDF (no splitting needed there).
const PACKAGE_SETS: Record<string, string[]> = {
  // Utility NEM/interconnection upload set (PGE PowerClerk, Pacific Power, etc.).
  // Meter photo is uploaded separately and never in the plan set.
  nem: ["meter_photo", "sld", "site_plan", "inverter_spec", "battery_spec"],
  // ProjectDox AHJ permit upload set — each sheet in its own slot.
  permit: ["sld", "site_plan", "structural", "structural_letter", "module_spec", "inverter_spec", "battery_spec", "labels"],
  // Everything we could split/attach — for debug or portals with no defined set yet.
  all: ["sld", "site_plan", "structural", "structural_letter", "module_spec", "inverter_spec", "battery_spec", "labels", "meter_photo", "utility_bill"],
};

// Doc types packaged WHEN PRESENT but never reported as missing. The sealed structural
// letter is only required for some projects (engineered path, or a jurisdiction stamp
// threshold) and requiredDocuments() is the single authority on which — duplicating that
// rule here would give two places to keep in sync and would flag every clean prescriptive
// job as incomplete. What this set fixes is the other half: before, "structural_letter"
// was absent from PACKAGE_SETS entirely, so a stamped letter the operator had uploaded
// was silently left out of the AHJ package.
//
// The battery / ESS spec (#261) is the same: owed only on a storage job (essRequirements.ts, the one
// battery predicate), so it is cut and packaged when the plan set carries one — the NEM portals ask
// for it too (recipe uploads of docType battery_spec) — and never reported missing here.
const CONDITIONAL_PACKAGE_DOC_TYPES = new Set(["structural_letter", "utility_bill", "battery_spec"]);

export interface UtilityPackageResult {
  target: string;
  planSetDocId: string;
  pages: number;
  parts: Array<{ docType: string; label: string; pages: number[]; documentId: string }>;
  packagedDocTypes: string[];
  missingDocTypes: string[];
  zipDocumentId: string;
  unclassifiedPages: number[];
  /** Plan-set sheet types this target wanted that no page classified as — the split log names
   *  them, so a sheet the classifier missed is visible where the split ran, not only later as a
   *  gate's "missing" (#29). Never includes separately-uploaded types (meter photo, bill). */
  missingSheetTypes: string[];
  /** 1-based pages that name a spec sheet but that no category claimed — typically a title-only
   *  "EQUIPMENT SPECIFICATION" cut-sheet, whose text cannot tell module / inverter / combiner /
   *  racking apart (#66). Never filed into a spec part; a person (or a vision read) decides. */
  undecidedSpecPages: number[];
  /** For an undecided spec page a NON-spec category took on a stray hit (#91): 1-based page →
   *  the doc type it was filed into. Absent for a page no category claimed. */
  undecidedSpecFiledAs: Record<string, string>;
  /** Undecided spec pages the page-index read labelled (#79): 1-based page → its datasheet kind.
   *  A module_spec / inverter_spec / battery_spec page went into that part (#261); any other kind (combiner, racking…)
   *  into neither. Such a page is no longer in `undecidedSpecPages`. Absent when no read ran. */
  specPagesByVision?: Record<string, PlanSheetKind>;
  /** Undecided spec pages never sent to the read because their text reads as a bill or meter
   *  record (rule 2). They stay undecided. */
  specPagesWithheld?: number[];
  /** 1-based pages whose text is DRAWN AS OUTLINES (#696, outlinedTextPages.ts): "unread: text drawn
   *  as outlines; a person reads this page". Always in `unclassifiedPages` too — never filed under a
   *  type on whatever stray text they carry, and never sent to the page-index read. */
  outlinedTextPages: number[];
  /** 1-based module data sheet pages ALSO cut into the inverter spec: an AC module's one data sheet,
   *  which shows the integrated microinverter's AC output and UL 1741 listing. Absent when none. */
  acModuleSheetPages?: number[];
}

// A split part that holds a page the page-index read decided (#79) says so in its filename. The
// text classifier never puts an undecided page in a spec part, so without this mark the next
// reconcile pass (#77) would take the part for a stale pre-#66 cut and withdraw it. A splitter
// row only: reconcile never touches a person's upload whatever its name.
const VISION_PART_MARK = " (page-index read)";

// AN AC MODULE'S ONE DATA SHEET IS THE INVERTER'S DATA SHEET TOO (audit 2026-11-28). A module with a
// factory-integrated microinverter has no standalone inverter sheet: the module data sheet carries
// the microinverter's AC output table and its UL 1741 certificate line. That page is named a MODULE
// spec sheet, so it was filed as the module spec only; no inverter spec was cut and the document gate
// held the job for a sheet the plan set does not have and never will.
//
// The rule, for any plan set: on a MICROINVERTER job (codeReviewRules.isMicroinverterDesign, the one
// predicate — the trigger for looking, never the answer) with no page filed as the inverter spec, a
// page filed as the module spec is ALSO the inverter spec when the SHEET shows it:
//   - its text carries an AC output rating AND the UL 1741 listing words (the reviewer's own
//     INVERTER_LISTING_PATTERNS), or
//   - its body is an image and the existing page-index read (scannedPlanSet.readUndecidedSpecPages,
//     same rule 2 screen and budget) says the sheet carries the integrated inverter's AC ratings and
//     UL 1741 listing. The read is asked once per plan set and its answer is noted by the plan set's
//     bytes (planSetImageReads.recordModuleSheetReads), so reconcile classifies the same way without a
//     model call and a pass never asks twice — also when the read could not run.
// A module sheet that shows neither stays the module spec only, and the gate still asks for the
// inverter's sheet. The inverter part names the sheet in its filename, which is what the gate words.
const AC_OUTPUT_ON_SHEET = /\bAC\s+OUTPUT\b|\b(?:MAX(?:IMUM)?\.?|NOMINAL|RATED|PEAK|CONTINUOUS)\s+(?:CONTINUOUS\s+)?(?:AC\s+)?OUTPUT\s+(?:POWER|CURRENT|VOLTAGE)\b/i;
const AC_MODULE_PART_MARK = " (AC module data sheet p";
/** The plan-set pages an inverter-spec split part says are the AC module's own data sheet, from its
 *  filename; [] for any other file. Read by the document gate to say which sheet covers the row. */
export function acModuleSheetPagesOfPart(filename: string): number[] {
  const at = String(filename ?? "").indexOf(AC_MODULE_PART_MARK);
  if (at < 0) return [];
  const m = /^([0-9]+(?:,[0-9]+)*)\)/.exec(String(filename).slice(at + AC_MODULE_PART_MARK.length));
  return m ? m[1].split(",").map(Number) : [];
}

interface SplitJob { snapshot: Record<string, unknown>; reads: Record<string, string> }
/** What the classifier needs to know about the job: its parsed fields (for the microinverter
 *  predicate) and what the page-index read already said about this plan set's module sheets. */
async function splitJob(db: AppDb, projectId: string, planSetFile: string): Promise<SplitJob> {
  let snapshot: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(db.get<{ parser_json: string | null }>("SELECT parser_json FROM projects WHERE id = ?", [projectId])?.parser_json || "{}"));
    if (parsed && typeof parsed === "object") snapshot = parsed as Record<string, unknown>;
  } catch { snapshot = {}; }
  let reads: Record<string, string> = {};
  try { reads = (await import("./planSetImageReads")).moduleSheetReads(db, projectId, planSetFile); } catch { reads = {}; }
  return { snapshot, reads };
}

/** The undecided spec pages for a log line: "4,5,6(structural)" — each page, and the category that
 *  took it when one did (#91). No spaces, so it stays one `key=value` field. */
export function undecidedSpecSummary(pages: number[], filedAs: Record<string, string>): string {
  return pages.map((n) => (filedAs[String(n)] ? `${n}(${filedAs[String(n)]})` : String(n))).join(",");
}

// Find the project's stored plan set (doc_type plan_set, else the largest PDF upload).
function findPlanSet(db: AppDb, projectId: string): { id: string; path: string; name: string } {
  const docs = listProjectDocuments(db, projectId);
  // An alias-typed plan set (combined_plan_set…) is the one projectDocsByType ships, so it is cut
  // before the newest-PDF fallback — which could otherwise pick an earlier split part (#198 lineage).
  const shippedId = shippedPlanSetDocumentId(db, projectId);
  // The newest-PDF fallback (an untyped '(general)' / 'other' plan set) never takes a split part:
  // a part is a cut OF the plan set, never one. Without this the part a split just saved became
  // "the plan set", so the mid-split re-check refused every untyped split (Helm, a6ef1b62) and a
  // later split re-cut a part.
  const planSet = docs.find((d) => d.docType === "plan_set") ?? docs.find((d) => d.id === shippedId) ?? docs.find((d) => d.source !== "split" && /\.pdf$/i.test(d.originalFilename));
  if (!planSet) throw new HttpError(400, "No plan-set PDF uploaded for this project. Upload the plan set (doc type: plan_set) first.");
  const row = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [planSet.id]);
  const stored = row?.stored_path ?? "";
  if (!stored || !fs.existsSync(stored)) throw new HttpError(404, "Plan-set file is missing on disk.");
  return { id: planSet.id, path: stored, name: planSet.originalFilename || "plan-set.pdf" };
}

// Split the uploaded plan set into individual sheets, then assemble the upload ZIP for
// the requested submission TYPE (nem | permit | all) — pulling split sheets AND separately
// uploaded docs (meter photo, utility bill). Backend equivalent of the parser's splitter,
// run in the submission slot; the bot then attaches these by doc_type.
//
// UNDECIDED SPEC PAGES BY VISION (#79). With an `llm`, the title-only EQUIPMENT SPECIFICATION pages
// the text could not place are labelled by the existing page-index read (scannedPlanSet
// readUndecidedSpecPages): a module datasheet goes into module_spec, an inverter datasheet into
// inverter_spec, an AC module carrying its integrated micro's ratings and UL 1741 listing into
// both, a battery datasheet into battery_spec (#261), and a combiner / racking / other datasheet into
// none of them. No undecided page → no call.
// Only those pages' images are sent, never a page that reads as a bill or meter (rule 2).
export async function buildUtilityPackage(
  db: AppDb, projectId: string, target = "all", opts: { llm?: Pick<LLMProvider, "classifyPlanPages"> } = {},
): Promise<UtilityPackageResult> {
  const project = db.get<{ id: string }>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new HttpError(404, "Project not found.");
  const wanted = PACKAGE_SETS[target] ?? PACKAGE_SETS.all;
  const planSet = findPlanSet(db, projectId);

  const planBytes = fs.readFileSync(planSet.path);
  const source = await PDFDocument.load(planBytes);
  const total = source.getPageCount();
  const classified = await classifyPlanSetPages(planSet.path, total, await splitJob(db, projectId, planSet.path));
  const { byCategory, unclassified, pageTexts, outlined } = classified;
  // Module data sheets that are the inverter's sheet too (AC module), and the ones still to ask about.
  const acModulePages = [...classified.acModule.pages];
  const askModuleSheets = classified.acModule.ask;
  // The shipped plan set's unread pages, for QC and the submit gate (#696): the split read them anyway.
  try { recordOutlinedPagesValue(db, planSet.id, outlined); } catch { /* the gate reads '' as not checked */ }
  let { undecidedSpec, undecidedSpecFiledAs } = classified;
  const visionTypes = new Set<string>();
  let specPagesByVision: Record<string, PlanSheetKind> | undefined;
  let specPagesWithheld: number[] | undefined;
  if (opts.llm && (undecidedSpec.length || askModuleSheets.length)) {
    const { readUndecidedSpecPages } = await import("./scannedPlanSet");
    // A read that cannot run (the renderer failed) leaves every page undecided, as before #79 —
    // never a failed split.
    const { projectSecretValuesById } = await import("./projectSecrets");
    // Rule 2 (#612): every thumbnail is masked with the project's own secrets; unreadable → no read.
    // One call: the module data sheets to ask about go first, so the page cap never drops them.
    const read = await readUndecidedSpecPages(opts.llm, planBytes, [...askModuleSheets, ...undecidedSpec], pageTexts, { secrets: projectSecretValuesById(db, projectId) })
      .catch(() => ({ decided: {} as Record<string, PlanSheetKind>, integratedInverter: [] as number[], withheld: [] as number[] }));
    const asked = new Set(askModuleSheets);
    if (undecidedSpec.length) specPagesByVision = Object.fromEntries(Object.entries(read.decided).filter(([p]) => !asked.has(Number(p))));
    if (read.withheld.length) specPagesWithheld = read.withheld;
    if (askModuleSheets.length) {
      // Every page asked is noted, whatever came back: "unread" stops the next pass asking again.
      const { recordModuleSheetReads, MODULE_SHEET_WITH_INVERTER, MODULE_SHEET_UNREAD } = await import("./planSetImageReads");
      const noted: Record<string, string> = {};
      for (const page of askModuleSheets) {
        const kind = read.decided[String(page)];
        const withInverter = kind === "module_spec" && read.integratedInverter.includes(page);
        noted[String(page)] = withInverter ? MODULE_SHEET_WITH_INVERTER : kind ?? MODULE_SHEET_UNREAD;
        if (withInverter) acModulePages.push(page);
      }
      try { recordModuleSheetReads(db, projectId, planBytes, noted); } catch { /* not noted: the next pass asks again */ }
      if (acModulePages.length) byCategory.set("inverter_spec", [...new Set([...(byCategory.get("inverter_spec") ?? []), ...acModulePages.map((p) => p - 1)])].sort((a, b) => a - b));
    }
    for (const [pageKey, kind] of Object.entries(read.decided)) {
      const page = Number(pageKey);
      // A module data sheet asked about above is already filed; the read does not re-file it.
      if (asked.has(page)) continue;
      const into = kind === "module_spec"
        ? (read.integratedInverter.includes(page) ? ["module_spec", "inverter_spec"] : ["module_spec"])
        : kind === "inverter_spec" ? ["inverter_spec"]
        // A battery datasheet the read named (#261): the battery spec part, never module / inverter.
        : kind === "battery_spec" ? ["battery_spec"] : [];
      for (const docType of into) {
        const arr = byCategory.get(docType) ?? [];
        if (!arr.includes(page - 1)) arr.push(page - 1);
        byCategory.set(docType, arr.sort((a, b) => a - b));
        visionTypes.add(docType);
      }
    }
    undecidedSpec = undecidedSpec.filter((p) => !read.decided[String(p)]);
    undecidedSpecFiledAs = Object.fromEntries(Object.entries(undecidedSpecFiledAs).filter(([p]) => undecidedSpec.includes(Number(p))));
  }

  const baseName = planSet.name.replace(/\.pdf$/i, "");
  const parts: UtilityPackageResult["parts"] = [];
  // A PLAN SET THAT LANDS MID-SPLIT (#198 J2, Helm's review at 0116f98a). Classifying (and any page
  // read) awaits, so a newer plan set can be uploaded meanwhile; parts cut from the old one would then
  // land as the newest rows of their types and ship. Re-checked right before EACH save (the check and
  // the synchronous save cannot interleave with another upload); a changed plan set refuses the split.
  const assertStillThePlanSet = (): void => {
    let now: string | null = null;
    try { now = findPlanSet(db, projectId).id; } catch { now = null; }
    if (now !== planSet.id) throw new HttpError(409, "The plan set changed while it was being split. Split the current plan set again.");
  };

  // Split only the sheet categories this submission type needs (plus any already split).
  for (const cat of CATEGORY_PATTERNS) {
    if (!wanted.includes(cat.docType)) continue;
    const pages = byCategory.get(cat.docType);
    if (!pages || pages.length === 0) continue;
    // No save-time timestamp in the part (updateMetadata: false): an unchanged plan set re-cuts
    // byte-identically, so the stage pass's repair re-split keeps the engineer's-letter
    // confirmation standing (it is bound to the cut's sha256, structuralLetterVoid.ts), while a cut
    // whose pages changed does not.
    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(source, pages);
    copied.forEach((p) => out.addPage(p));
    let bytes = Buffer.from(await out.save());
    // SIZE CAP (utility "nem" packages ONLY — split-mode portals like PowerClerk enforce
    // a 5 MB per-file limit; override with PORTAL_UPLOAD_MAX_MB, the shared knob in
    // portalUploadCapBytes). A multi-page split that blew the cap gets trimmed to its
    // LEAD page — the dedicated sheet is always first-matched; a heavy raster tail page
    // (a vendor manual scan) is what pushes it over. Better one on-point sheet the portal
    // accepts than a "complete" file it bounces. The permit/all targets are NOT trimmed:
    // AHJ portals accept large files, and silently dropping structural-calc pages from a
    // permit package would ship an incomplete filing with no error anywhere.
    const CAP = target === "nem" ? portalUploadCapBytes("split") : Number.POSITIVE_INFINITY;
    if (bytes.length > CAP && pages.length > 1) {
      const lead = await PDFDocument.create({ updateMetadata: false });
      const [first] = await lead.copyPages(source, [pages[0]]);
      lead.addPage(first);
      const leadBytes = Buffer.from(await lead.save());
      if (leadBytes.length <= CAP) bytes = leadBytes;
    }
    assertStillThePlanSet();
    const saved = saveProjectDocument(db, projectId, {
      docType: cat.docType,
      filename: `${baseName} - ${cat.label}${visionTypes.has(cat.docType) ? VISION_PART_MARK : ""}${cat.docType === "inverter_spec" && acModulePages.length ? `${AC_MODULE_PART_MARK}${[...acModulePages].sort((a, b) => a - b).join(",")})` : ""}.pdf`,
      contentType: "application/pdf",
      buffer: bytes,
      source: "split",
      // The cut's lineage: the structural-letter confirmation stands only while this is the plan set
      // the package ships (structuralLetterVoid.ts).
      sourceDocumentId: planSet.id,
    });
    parts.push({ docType: cat.docType, label: cat.label, pages: pages.map((n) => n + 1), documentId: saved.id });
  }

  // Assemble the ZIP from the wanted doc set — split sheets AND separately uploaded files
  // (meter photo, utility bill come from uploads, not the plan set).
  const available = projectDocsByType(db, projectId);
  const zip = new AdmZip();
  const packaged: string[] = [];
  const missing: string[] = [];
  for (const docType of wanted) {
    // Separately-uploaded types (meter photo, utility bill, the sealed structural
    // letter) come straight from project_documents; projectDocsByType has already
    // resolved the aliases operators file them under.
    const filePath = available[docType];
    if (filePath && fs.existsSync(filePath)) {
      zip.addFile(`${docType}${path.extname(filePath) || ".pdf"}`, fs.readFileSync(filePath));
      packaged.push(docType);
    } else if (!CONDITIONAL_PACKAGE_DOC_TYPES.has(docType)) {
      missing.push(docType);
    }
  }
  if (packaged.length === 0) throw new HttpError(422, "No documents available for this package. Upload the plan set (and meter photo for NEM), then rebuild.");

  const zipDoc = saveProjectDocument(db, projectId, {
    docType: "utility_package_zip",
    filename: `${baseName} - ${target} package.zip`,
    contentType: "application/zip",
    buffer: zip.toBuffer(),
    source: "split",
  });

  const missingSheetTypes = CATEGORY_PATTERNS
    .map((c) => c.docType)
    .filter((t) => wanted.includes(t) && !CONDITIONAL_PACKAGE_DOC_TYPES.has(t) && !parts.some((p) => p.docType === t));
  return { target, planSetDocId: planSet.id, pages: total, parts, packagedDocTypes: packaged, missingDocTypes: missing, zipDocumentId: zipDoc.id, unclassifiedPages: unclassified, missingSheetTypes, undecidedSpecPages: undecidedSpec, undecidedSpecFiledAs, outlinedTextPages: outlined,
    ...(specPagesByVision ? { specPagesByVision } : {}), ...(specPagesWithheld ? { specPagesWithheld } : {}),
    ...(acModulePages.length ? { acModuleSheetPages: [...acModulePages].sort((a, b) => a - b) } : {}) };
}

// Assign each page of the plan set to its categories (scorePage). 1-based unclassified pages;
// the pages that name a spec sheet but landed in no spec part are listed as undecided spec pages,
// with the category that took each one, if any (#91) — unless that category won on a title-block
// sheet-name hit (#119).
//
// OUTLINED TEXT (#696). A page whose text is drawn as outlines (outlinedTextPages.ts: no or near-no
// text layer, no raster, a vector-heavy drawing) is UNCLASSIFIED, whatever its few stray text items
// score: the text cannot say what the sheet is, so filing it would be a guess. It is named in
// `outlined` so every report says why it was not read. Only pages whose text is already short are
// opened to check; a normal text page is classified exactly as before.
//
// `job` (the splitter's and reconcile's callers pass it) adds the AC-module rule above: `acModule.pages`
// are the module data sheets also put in inverter_spec, `acModule.ask` the ones only the page-index
// read can answer and that it has not been asked about yet.
async function classifyPlanSetPages(planSetPath: string, total: number, job?: SplitJob): Promise<{ byCategory: Map<string, number[]>; unclassified: number[]; undecidedSpec: number[]; undecidedSpecFiledAs: Record<string, string>; pageTexts: string[]; outlined: number[]; acModule: { pages: number[]; ask: number[] } }> {
  const pageTexts = await extractPdfPages(planSetPath, 80);
  let outlined: number[] = [];
  try {
    outlined = (await outlinedTextPagesOfPdf(new Uint8Array(fs.readFileSync(planSetPath)), { pageTexts: pageTexts.slice(0, total), maxPages: Math.min(total, 80) }))
      .filter((p) => p <= total);
  } catch { outlined = []; /* unreadable drawing: classified by its text, as before */ }
  const outlinedSet = new Set(outlined);
  const byCategory = new Map<string, number[]>();
  const unclassified: number[] = [];
  const undecidedSpec: number[] = [];
  const undecidedSpecFiledAs: Record<string, string> = {};
  const index = indexSpecSheets(pageTexts.slice(0, total));
  for (let i = 0; i < total; i++) {
    if (outlinedSet.has(i + 1)) { unclassified.push(i + 1); continue; }
    const text = pageTexts[i] ?? "";
    const { docTypes, byPattern } = scorePage(text, index.names.get(pageSheetNumber(text, index.listed) ?? "") ?? "");
    for (const docType of docTypes) {
      const arr = byCategory.get(docType) ?? [];
      arr.push(i);
      byCategory.set(docType, arr);
    }
    if (!docTypes.length) unclassified.push(i + 1);
    // A page whose winner came from a title-block sheet name (a dense SLD citing "INVERTER
    // SPECIFICATIONS" in a callout, won by its own sheet name) is filed right, so reporting it is
    // noise (#119). A stray `words`-only winner (#91's STRUCTURAL racking brochure), a winner on a
    // cited sheet number only ("SEE E 1.1"), or no winner at all leaves the page undecided.
    if (isUndecidedSpecPage(text, { docTypes, byPattern }, index)) {
      undecidedSpec.push(i + 1);
      if (docTypes.length) undecidedSpecFiledAs[String(i + 1)] = docTypes[0];
    }
  }
  const acModule = { pages: [] as number[], ask: [] as number[] };
  const modulePages = byCategory.get("module_spec") ?? [];
  if (job && modulePages.length && !(byCategory.get("inverter_spec")?.length)) {
    const { isMicroinverterDesign, INVERTER_LISTING_PATTERNS } = await import("./codeReviewRules");
    if (isMicroinverterDesign({ parserSnapshot: job.snapshot } as unknown as ProjectRecord, pageTexts.slice(0, total).join("\n"))) {
      for (const i of modulePages) {
        const text = pageTexts[i] ?? "";
        const noted = job.reads[String(i + 1)];
        if ((AC_OUTPUT_ON_SHEET.test(text) && INVERTER_LISTING_PATTERNS.some((re) => re.test(text))) || noted === "module_spec+inverter") acModule.pages.push(i + 1);
        else if (!noted) acModule.ask.push(i + 1);
      }
      // One sheet that answers is the answer: nothing is left to ask.
      if (acModule.pages.length) {
        acModule.ask = [];
        byCategory.set("inverter_spec", acModule.pages.map((p) => p - 1));
      }
    }
  }
  return { byCategory, unclassified, undecidedSpec, undecidedSpecFiledAs, pageTexts, outlined, acModule };
}

// A page that names a spec sheet, is not a calculations or index page, landed in no spec part, and
// whose winning category (if any) did not hit a title-block sheet name: undecided (#66, #91, #119).
// It names a spec sheet in its own text, or through its sheet number the cover's index names as a
// spec sheet (`index`, from indexSpecSheets over the whole plan set) (#199).
export function isUndecidedSpecPage(
  text: string, scored: { docTypes: string[]; byPattern: boolean }, index?: { spec: Set<string>; listed: Set<string> },
): boolean {
  // A battery page that also reads as an inverter (#261) is spec-named too: never filed, never dropped.
  const named = SPEC_SHEET_NAME.test(text) || batteryPage(text) === "undecided"
    || Boolean(index?.spec.size && index.spec.has(pageSheetNumber(text, index.listed) ?? ""));
  return named && !CALCS_SHEET.test(text) && !isIndexOrNotesPage(text)
    && !scored.docTypes.some((t) => SPEC_DOC_TYPES.has(t)) && !scored.byPattern;
}

// A page's identity for comparing a split part against the plan set: its text with whitespace
// collapsed. copyPages carries the content stream over unchanged, so a part's page reads the same
// as the plan-set page it was cut from.
const pageKey = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * RECONCILE THE SPLIT PARTS WITH THE CURRENT CLASSIFIER, then name the gaps.
 *
 * STALE PARTS (#77). A split row whose pages are not all pages the CURRENT classifier puts in that
 * type (including when it puts none there) was cut by an older classifier — the pre-#66 scoring
 * filed the WIRING CALCULATIONS sheet as inverter_spec and title-only EQUIPMENT SPECIFICATION
 * cut-sheets as module_spec. Such a row is withdrawn (withdrawSplitPart): left standing, the gate
 * counted it present ("attached file") and every guard skipped the re-split because the type
 * "existed". A subset is not stale: the NEM size cap trims a part to its lead page. Only rows the
 * splitter wrote (`source = 'split'`) are ever withdrawn — a document a person uploaded is theirs
 * whatever it holds — and a type a person deleted is left alone entirely.
 *
 * GAPS (#29). Sheet types the current classifier finds in the newest plan set that no remaining
 * split row cut from that plan set carries — re-cut by the caller. A type a PERSON deleted since
 * this plan set landed is never a gap: removing a split part is an operator's ruling on it (wrong
 * sheet, bad cut), and re-cutting it behind their back would undo that and hide the "not attached"
 * verdict QC owes them (qcRejudgedOnDocs 2c). Empty when nothing has been split from this plan set
 * yet (the ordinary split path owns that case).
 *
 * UNDECIDED SPEC PAGES (#91). The same classification names the spec-named pages no spec part holds
 * (classifyPlanSetPages); they are returned so a pass that withdraws without re-splitting can still
 * say which pages need a person's decision — before, they were computed here and dropped.
 *
 * No plan set on disk → nothing to compare against, no writes. A part that cannot be read is left
 * standing; a plan set with no text at all withdraws nothing (no classifier answer to judge by).
 */
export async function reconcileSplitParts(db: AppDb, projectId: string): Promise<ReconcileResult> {
  // The plan set the package ships (#198): one "newest" rule, so reconcile judges the same plan set.
  const shipped = shippedPlanSet(db, projectId);
  const latest = shipped ? { stored_path: shipped.storedPath, uploaded_at: shipped.uploadedAt } : undefined;
  const none: ReconcileResult = { withdrawn: [], gaps: [], undecidedSpecPages: [], undecidedSpecFiledAs: {}, outlinedTextPages: [], moduleSheetsToRead: [] };
  if (!latest?.stored_path || !fs.existsSync(latest.stored_path)) return none;
  const sheetTypes = CATEGORY_PATTERNS.map((c) => c.docType);
  const splitParts = db.query<{ id: string; doc_type: string; stored_path: string; uploaded_at: string; original_filename: string }>(
    `SELECT id, doc_type, stored_path, uploaded_at, original_filename FROM project_documents
      WHERE project_id = ? AND source = 'split' AND doc_type IN (${sheetTypes.map(() => "?").join(", ")})`,
    [projectId, ...sheetTypes],
  );
  if (splitParts.length === 0) return none;
  const deletedByPerson = documentTypesDeletedSince(db, projectId, latest.uploaded_at);
  const total = (await PDFDocument.load(fs.readFileSync(latest.stored_path))).getPageCount();
  const { byCategory, pageTexts, undecidedSpec, undecidedSpecFiledAs, outlined, acModule } = await classifyPlanSetPages(latest.stored_path, total, await splitJob(db, projectId, latest.stored_path));
  // MODULE DATA SHEETS STILL TO PUT TO THE PAGE-INDEX READ (the AC-module rule above). Its own field,
  // never a gap: a gap re-splits at every door, and only a split that holds a model can ask. Nothing
  // to ask once the job has an inverter spec from anywhere, or a person removed that part.
  const moduleSheetsToRead = acModule.ask.length && !deletedByPerson.has("inverter_spec") && !projectDocsByType(db, projectId).inverter_spec ? acModule.ask : [];
  const undecided = { undecidedSpecPages: undecidedSpec, undecidedSpecFiledAs, outlinedTextPages: outlined, moduleSheetsToRead };

  const withdrawn = new Set<string>();
  if (pageTexts.some((t) => pageKey(t))) {
    for (const part of splitParts) {
      if (deletedByPerson.has(part.doc_type) || !part.stored_path || !fs.existsSync(part.stored_path)) continue;
      let partPages: string[];
      try { partPages = await extractPdfPages(part.stored_path, 80); } catch { continue; }
      const allowed = new Set((byCategory.get(part.doc_type) ?? []).map((i) => pageKey(pageTexts[i] ?? "")));
      // A spec part the page-index read cut (#79) may also hold the undecided pages it placed.
      if (SPEC_DOC_TYPES.has(part.doc_type) && String(part.original_filename ?? "").includes(VISION_PART_MARK)) {
        for (const p of undecidedSpec) allowed.add(pageKey(pageTexts[p - 1] ?? ""));
      }
      if (partPages.some((t) => !allowed.has(pageKey(t))) && withdrawSplitPart(db, projectId, part.id)) withdrawn.add(part.doc_type);
    }
    // A package ZIP the splitter built bundles the withdrawn part (the bot's last-resort upload
    // fallback): it goes too, and the next package build writes a fresh one.
    if (withdrawn.size > 0) {
      for (const zip of db.query<{ id: string }>(
        "SELECT id FROM project_documents WHERE project_id = ? AND source = 'split' AND doc_type = 'utility_package_zip'", [projectId],
      )) withdrawSplitPart(db, projectId, zip.id);
    }
  }

  const splitTypes = new Set(db.query<{ doc_type: string }>(
    "SELECT DISTINCT doc_type FROM project_documents WHERE project_id = ? AND source = 'split' AND uploaded_at >= ?",
    [projectId, latest.uploaded_at],
  ).map((r) => r.doc_type));
  if (splitTypes.size === 0) return { withdrawn: [...withdrawn], gaps: [], ...undecided };
  for (const t of deletedByPerson) splitTypes.add(t);
  const gaps = sheetTypes.filter((t) => PACKAGE_SETS.all.includes(t) && (byCategory.get(t)?.length ?? 0) > 0 && !splitTypes.has(t));
  return { withdrawn: [...withdrawn], gaps, ...undecided };
}

export interface ReconcileResult {
  withdrawn: string[];
  gaps: string[];
  /** As UtilityPackageResult's: the newest plan set's spec-named pages no spec part holds (#91). */
  undecidedSpecPages: number[];
  undecidedSpecFiledAs: Record<string, string>;
  /** As UtilityPackageResult's: the newest plan set's pages whose text is drawn as outlines (#696). */
  outlinedTextPages: number[];
  /** 1-based module data sheet pages of a microinverter job with no inverter spec that the page-index
   *  read has not been asked about yet (the AC-module rule). The stage pass, the one caller that holds
   *  a model, splits again to ask; once asked, a page is never listed again. */
  moduleSheetsToRead: number[];
}

/**
 * THE STAGE / LEARN SPLIT GUARD. Withdraw stale parts, then split the plan set for `target` only
 * when a sheet it needs is still absent AND the split can change that: nothing has been split from
 * the newest plan set yet, or the current classifier finds one of the target's sheet types that no
 * split row carries (reconcileSplitParts gaps). Before (#75 review), the guard re-split whenever a
 * wanted type had no row — and a set whose only spec pages are title-only EQUIPMENT SPECIFICATION
 * cut-sheets never gets a spec row, so it was re-split on every stage pass.
 */
export async function ensurePlanSetSplit(
  db: AppDb, projectId: string, target: string, sheetTypes: string[],
): Promise<{ split: boolean; withdrawn: string[]; gaps: string[] }> {
  const { withdrawn, gaps: allGaps } = await reconcileSplitParts(db, projectId);
  const wanted = PACKAGE_SETS[target] ?? PACKAGE_SETS.all;
  const gaps = allGaps.filter((t) => wanted.includes(t));
  const existing = projectDocsByType(db, projectId);
  if (sheetTypes.every((t) => existing[t])) return { split: false, withdrawn, gaps };
  const planSet = shippedPlanSet(db, projectId);
  const splitSince = planSet
    ? Number(db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND source = 'split' AND uploaded_at >= ?",
        [projectId, planSet.uploadedAt],
      )?.n ?? 0)
    : 0;
  if (splitSince > 0 && gaps.length === 0) return { split: false, withdrawn, gaps };
  await buildUtilityPackage(db, projectId, target);
  return { split: true, withdrawn, gaps };
}
