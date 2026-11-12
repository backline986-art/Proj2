// ---------------------------------------------------------------------------
// FEE LINE KINDS — the vocabulary of a residential solar filing's bill, and a
// reader that finds each kind's PRINTED line in a document this process retrieved.
//
// WHY THIS EXISTS (#661, part 1 of #586). Research for an AHJ we have never filed
// in used to come back as "the permit line": one bracket, maybe a plan review.
// The real bill has more lines than that — a plan review, a state or local
// surcharge, a technology or administrative fee, sometimes a zoning or fire
// review, a minimum, and the overage fees (revisions, reinspections) and card
// fees that are not part of this filing's total but are part of what the
// operator needs to see. A line nobody asked for is a line nobody held, and a
// quote missing a line reads as finished.
//
// So every line kind is either PRICED (a held, corroborated charge — that path
// lives in feeSchedules.ts and is unchanged) or NAMED UNPRICED, and an unpriced
// line turns the quote into "at least $X" with the line named beside it. This
// module owns the two halves that make "named unpriced" possible without a guess:
//
//   · the catalogue: which kinds exist, which ones the STRICTEST default expects
//     on every residential permit filing (absent from everything we read ⇒ named
//     unpriced, never assumed to be $0), and which ones sit outside the total;
//   · the itemiser: a deterministic, line-by-line reader that says, for each kind,
//     "this document prints a line of that kind HERE", verbatim and with its URL.
//
// KEEP IT UNIVERSAL (owner, 2026-11-09). Nothing here names a jurisdiction, a
// state or a portal. The patterns are the generic words fee schedules use; a
// jurisdiction's own wording arrives as data (the printed line), never as code.
//
// A LEAF MODULE: it imports nothing from the fee code, so feeSchedules.ts can
// import it without a cycle. The trade/scope exclusions feeSchedules already owns
// are handed in as a predicate rather than copied here — a second copy of a
// regex is how two readers of the same document come to disagree.
// ---------------------------------------------------------------------------

/** Every kind of line a residential solar permit filing's bill can carry besides
 *  the base permit itself (which is the schedule's own bracket table). */
export type FeeLineKind =
  | "plan_review"
  | "surcharge"
  | "technology"
  | "processing"
  | "land_use_review"
  | "fire_review"
  | "minimum"
  | "revision"
  | "reinspection"
  | "convenience";

export interface FeeLineKindSpec {
  kind: FeeLineKind;
  /** What an operator reads when the document never named the line. */
  name: string;
  /** The generic words a fee schedule prints for this kind. */
  pattern: RegExp;
  /** THE STRICTEST DEFAULT (owner, 2026-11-09): a residential permit filing is
   *  presumed to carry this line until a document we read prices it or says it is
   *  included. Absent from everything we read ⇒ named unpriced, and the quote
   *  reads "at least". Never assumed to be $0 — an absence of report is not a
   *  finding that nothing is charged. */
  expected: boolean;
  /** A printed line of this kind that research did not price is named unpriced,
   *  cited to the line. */
  fromSighting: boolean;
  /** Charged only when something happens later (a revision, a failed inspection)
   *  or by how the fee is paid (a card processor). LISTED, never inside the total
   *  and never holding it open: a filing not yet made has not failed anything. */
  outsideFilingTotal: boolean;
  /** Only a line that ALSO names this filing (solar / photovoltaic / residential /
   *  every permit) counts. Zoning and fire lines in a consolidated schedule are
   *  mostly about other work; one that names solar or residential work is this
   *  filing's. */
  needsFilingWord: boolean;
  /** A line naming another trade (plumbing, mechanical…) is that trade's line.
   *  False for the kinds levied across every permit (a surcharge, a technology
   *  fee), whose printed sentence routinely lists every trade it applies to. */
  tradeScoped: boolean;
}

/** CLASSIFICATION ORDER IS PRIORITY ORDER: a line takes the FIRST kind it matches.
 *  "Fire plan review" is a fire review, not a plan review; "plan revision fee" is
 *  a revision; "credit card processing fee" is a card fee, not an administrative
 *  one. Literals, so each can be read against the strings it must match. */
export const FEE_LINE_KINDS: readonly FeeLineKindSpec[] = [
  {
    kind: "reinspection", name: "Reinspection fee",
    pattern: /\bre-?inspect(?:ion|ions)?\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: true, needsFilingWord: false, tradeScoped: false,
  },
  {
    kind: "revision", name: "Revision / resubmittal fee",
    pattern: /\brevisions?\b|\bresubmitt?als?\b|\bchanges?\s+to\s+(?:approved\s+|issued\s+)?plans\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: true, needsFilingWord: false, tradeScoped: false,
  },
  {
    kind: "convenience", name: "Card / payment-processor fee",
    pattern: /\bconvenience\s+(?:fee|charge)s?\b|\b(?:credit|debit)\s+cards?\b|\bcard\s+(?:processing|transaction|payment)\b|\bpayment\s+processing\b|\bprocessor\s+fees?\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: true, needsFilingWord: false, tradeScoped: false,
  },
  {
    kind: "minimum", name: "Minimum fee",
    pattern: /\bminimum\s+(?:permit\s+|plan\s+review\s+|inspection\s+)?(?:fee|charge)s?\b|\b(?:fee|charge)\b[^|$]{0,30}\bminimum\b|\bmin\.?\s+fee\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: false, needsFilingWord: false, tradeScoped: true,
  },
  {
    kind: "surcharge", name: "State / local surcharge",
    pattern: /\bsurcharges?\b|\bst\.?\s*sur\b/i,
    expected: true, fromSighting: true, outsideFilingTotal: false, needsFilingWord: false, tradeScoped: false,
  },
  {
    kind: "technology", name: "Technology fee",
    pattern: /\btechnology\b|\btech\s+fees?\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: false, needsFilingWord: false, tradeScoped: false,
  },
  {
    kind: "fire_review", name: "Fire review",
    pattern: /\bfire\b[^|$]{0,40}\b(?:review|plan|marshal|prevention|inspection)\b|\bfire\s+marshal\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: false, needsFilingWord: true, tradeScoped: true,
  },
  {
    kind: "plan_review", name: "Plan review",
    pattern: /\bplans?\s*(?:review|check|rvw|examination)\b/i,
    expected: true, fromSighting: true, outsideFilingTotal: false, needsFilingWord: false, tradeScoped: true,
  },
  {
    kind: "land_use_review", name: "Zoning / land-use review",
    pattern: /\b(?:land[\s-]?use|zoning|planning)\b[^|$]{0,40}\b(?:review|fee|clearance|approval|check|compliance|verification)\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: false, needsFilingWord: true, tradeScoped: true,
  },
  {
    kind: "processing", name: "Administrative / processing fee",
    pattern: /\b(?:administrative|admin|processing|records?(?:\s+management)?|filing|issuance|application)\s+(?:fee|charge)s?\b/i,
    expected: false, fromSighting: true, outsideFilingTotal: false, needsFilingWord: false, tradeScoped: false,
  },
];

const SPEC_BY_KIND = new Map(FEE_LINE_KINDS.map((s) => [s.kind, s] as const));

export function feeLineKindSpec(kind: string): FeeLineKindSpec | null {
  return SPEC_BY_KIND.get(kind as FeeLineKind) ?? null;
}

/** Kinds charged only on a later event or by payment method — listed, never totalled. */
export function feeLineKindOutsideTotal(kind: string): boolean {
  return feeLineKindSpec(kind)?.outsideFilingTotal === true;
}

/** A line that names THIS filing: solar / photovoltaic work, residential work, or
 *  every permit. Used only by the kinds marked needsFilingWord. */
const FILING_WORD_RE = /\b(?:solar|photovoltaics?|pv|renewable|residential|single[- ]family|dwelling|all\s+(?:building\s+)?permits|every\s+permit|each\s+permit)\b/i;

/** One printed line of one kind, as the document printed it. */
export interface FeeLineSighting {
  kind: FeeLineKind;
  /** The line verbatim (a label cell joined to the value cell below it when the
   *  document prints them on two lines), without the extractor's page tag. */
  printedLine: string;
  /** The document it is printed in. */
  sourceUrl: string;
  /** The first dollar amount on the line, or null. Never used to PRICE anything
   *  here — a printed number beside a line is not proof that it applies to this
   *  filing. It is carried so the operator sees what the document printed. */
  amountUsd: number | null;
  /** The first percentage on the line, or null. Same rule as amountUsd. */
  percent: number | null;
}

const MONEY_RE = /\$\s*([\d,]+(?:\.\d{1,2})?)/;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/;
const PAGE_TAG_RE = /^p\d+\s+/;

/** Which kind a printed line is, or null. Exported for the tests and the report. */
export function classifyFeeLine(line: string): FeeLineKindSpec | null {
  for (const spec of FEE_LINE_KINDS) if (spec.pattern.test(line)) return spec;
  return null;
}

/** READ EVERY LINE OF EVERY DOCUMENT AND SAY WHICH LINE KINDS ARE PRINTED WHERE.
 *
 *  Deterministic and offline: it reads the bytes a research pass already
 *  retrieved (the ledger's corpus), never fetches anything. One sighting per
 *  (kind, printed line); the same line printed in two documents is two
 *  sightings, because each is its own citation.
 *
 *  `skip` is the caller's own exclusion (another trade's line, a commercial-only
 *  line), applied to the kinds marked tradeScoped. */
export function itemiseFeeDocuments(
  docs: ReadonlyArray<{ url: string; text: string }>,
  opts: { skip?: (line: string, spec: FeeLineKindSpec) => boolean } = {},
): FeeLineSighting[] {
  const out: FeeLineSighting[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const lines = String(doc.text ?? "").split("\n").map((l) => l.trim().replace(PAGE_TAG_RE, ""));
    for (const [index, raw] of lines.entries()) {
      if (!raw) continue;
      // A LABEL CELL ABOVE ITS VALUE CELL IS ONE ROW — the same narrow pairing the
      // ancillary corroborator uses: joined only when this line names no money of
      // its own and the next one does.
      const next = lines[index + 1] ?? "";
      const hasMoney = (s: string): boolean => /[$%]/.test(s);
      const text = !hasMoney(raw) && next && hasMoney(next) && !classifyFeeLine(next) ? `${raw} — ${next}` : raw;
      const spec = classifyFeeLine(raw);
      if (!spec) continue;
      if (spec.needsFilingWord && !FILING_WORD_RE.test(text)) continue;
      if (spec.tradeScoped && opts.skip?.(text, spec)) continue;
      const key = `${spec.kind}|${text.toLowerCase()}|${doc.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const money = MONEY_RE.exec(text);
      const pct = PERCENT_RE.exec(text);
      const amountUsd = money ? Number(money[1].replace(/,/g, "")) : NaN;
      const percent = pct ? Number(pct[1]) : NaN;
      out.push({
        kind: spec.kind,
        printedLine: text.slice(0, 300),
        sourceUrl: doc.url,
        amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
        percent: Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : null,
      });
    }
  }
  return out;
}
