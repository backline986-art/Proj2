// EACH STATE'S PERMIT-FEE RULES, READ AS CITED DATA (#663, part 2 of #586).
//
// The state surcharge on permit fees used to be a constant on Oregon's entry in permitProcess
// (STATE_PERMIT_RULES.OR.surcharge = 0.12). A Utah, Idaho or Washington job got its state's
// surcharge only if someone wrote it into code, and a state with no constant read as "no surcharge":
// silently zero. Now each state's fee rules are rows of state_permit_rules (migration v63, family
// "fee"), seeded from backend/data/reference-state-permit-rules.json or landed by research
// (stateFeeResearch.ts), each quoting its statute verbatim with its URL; a row a person verified is
// never written again (rule 3).
//
// This module is the READ side only and imports nothing heavy, so feeSchedules / submissionFees /
// permitProcessLookup can read it without a cycle. No state is named here: states live in the
// reference JSON and the table.
//
// Keys of the "fee" family:
//   surcharge          { percent, appliesTo: "permit_fees", maximum?, section }  percent 0 = the
//                      state levies none (a cited, researched answer — never a default).
//   solarPermitFeeCap  { maxUsd, section, formula? }  a statutory ceiling on a residential solar
//                      permit fee. Held as data; nothing prices from it yet.
import type { AppDb } from "./db";
import { usStateCode } from "./permitPath";

export const STATE_FEE_FAMILY = "fee" as const;
export const STATE_SURCHARGE_KEY = "surcharge";
export const STATE_SOLAR_FEE_CAP_KEY = "solarPermitFeeCap";
/** The only `appliesTo` the evaluator models: the permit fees themselves (the permit line and the
 *  services/feeders lines that are permit fees), never plan review or other ancillaries. */
export const SURCHARGE_APPLIES_TO_PERMIT_FEES = "permit_fees";

type Row = Record<string, unknown>;

interface SurchargeCitation {
  state: string;
  /** Short, display-safe: "<section>: state surcharge on permit fees, at most 12%". Never holds " — "
   *  (the quote's clauses split on it). The verbatim words are `citation`. */
  quote: string;
  /** The row's verbatim citation (the statute's own words). */
  citation: string;
  sourceUrl: string;
  /** "official" is #683's tier (a quote read from an official page, used at once): accepted here as
   *  usable like the others — every row on file is applied; the tier is shown, never a gate. */
  confidence: "seeded" | "official" | "verified";
  /** When the citation's words were read ('' = not recorded). */
  fetchedAt: string;
}

/** THE STATE'S SURCHARGE ON PERMIT FEES, as the fee code reads it. One answer for the evaluator
 *  (feeSchedules.stateSurchargeFor), the per-job lookup (citedStateSurcharge) and the quote. */
export type StateSurchargeAnswer =
  /** A cited percentage of the permit fees. */
  | (SurchargeCitation & { status: "rule"; percent: number; maximum: boolean })
  /** Researched and cited: the state levies no surcharge on permit fees. */
  | (SurchargeCitation & { status: "none" })
  /** A row is on file but this code cannot apply it (an `appliesTo` it does not model, a value it
   *  cannot read). Said in the quote, never priced and never read as zero. */
  | (SurchargeCitation & { status: "unmodeled"; why: string })
  /** Nothing on file for the state (or no state at all). Unknown is a question, not a pass. */
  | { status: "not_researched"; state: string };

function fold(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** The state's fee-family row for one key, or null. Reads write nothing. */
function feeRow(db: AppDb, state: string, key: string): Row | null {
  return db.get<Row>(
    "SELECT state, rule_key, value_json, citation, source_url, confidence, verified_at, fetched_at FROM state_permit_rules WHERE state = ? AND family = ? AND rule_key = ?",
    [state, STATE_FEE_FAMILY, key],
  ) ?? null;
}

export function stateSurchargeRuleFor(db: AppDb, state: string | null | undefined): StateSurchargeAnswer {
  const code = usStateCode(state);
  if (!code) return { status: "not_researched", state: fold(state) };
  let row: Row | null = null;
  try { row = feeRow(db, code, STATE_SURCHARGE_KEY); } catch { row = null; }
  if (!row) return { status: "not_researched", state: code };
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(String(row.value_json ?? "null"));
    value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { value = null; }
  const section = fold(value?.section).replace(/\s+—\s+/g, " - ").slice(0, 120) || `${code} state rule`;
  const base = {
    state: code,
    citation: fold(row.citation),
    sourceUrl: fold(row.source_url),
    confidence: fold(row.verified_at) ? "verified" as const : fold(row.confidence) === "official" ? "official" as const : "seeded" as const,
    fetchedAt: fold(row.fetched_at),
  };
  const percent = typeof value?.percent === "number" && Number.isFinite(value.percent) ? value.percent : null;
  if (percent == null || percent < 0 || percent > 100) {
    return { ...base, status: "unmodeled", why: "its percentage is not readable", quote: `${section}: state surcharge on permit fees` };
  }
  if (percent === 0) return { ...base, status: "none", quote: `${section}: no state surcharge on permit fees` };
  const appliesTo = fold(value?.appliesTo) || SURCHARGE_APPLIES_TO_PERMIT_FEES;
  const maximum = value?.maximum === true;
  const quote = `${section}: state surcharge on permit fees, ${maximum ? "at most " : ""}${round2(percent)}%`;
  if (appliesTo !== SURCHARGE_APPLIES_TO_PERMIT_FEES) {
    return { ...base, status: "unmodeled", why: `it applies to "${appliesTo.slice(0, 60)}", which this quote does not model`, quote };
  }
  return { ...base, status: "rule", percent: round2(percent), maximum, quote };
}

/** Does the state have ANY researched answer for its surcharge (a rule, a cited "none", or a row
 *  the quote names as unmodeled)? The research trigger asks only where this is false. */
export function stateSurchargeResearched(db: AppDb, state: string | null | undefined): boolean {
  return stateSurchargeRuleFor(db, state).status !== "not_researched";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
