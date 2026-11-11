// ONE STORE FOR FEES: the utility lookup's cited application fee lands in the fee schedule.
//
// The utility lookup already keeps a utility's own fees, each cited, for display on the utility
// card. Measured on saved pages (fee round, 2026-11): a utility whose page prints "non-refundable
// $100 application fee" had that fee on its card and NOTHING in the fee schedule, so the fee quote
// on the approval sheet read "no published interconnection fee schedule found ... unknown". Two
// stores for one fact.
//
// This module lands that fee through the REAL save path (feeSchedules.saveFeeSchedule, which owns
// every refusal and writes 'seeded'), and only when all of these hold:
//
//   1. EXACTLY ONE fee is the one every application owes (utilityFeeKind). A return trip, a
//      modification, a transfer, a study is a charge owed in some cases only: it stays on the card
//      and never becomes the application fee. Two application fees, a fee priced by size or level,
//      or a fee Keelix cannot classify is a question for a person, never a pick.
//   2. Its source is the site the lookup's own kept answers come from, a government host, or a host
//      a person verified as the utility's (never a third party's summary of the utility's fee).
//   3. Keelix re-read that page in this run and the quoted words are on it. A refused or failed
//      read lands nothing (the refusal is listed for a person by the caller).
//   4. Hard rule 3: a person-verified fee row is never changed. The same amount needs nothing; a
//      different one is recorded in the row's notes by saveFeeSchedule and held for a person.
//   5. A fee row research already saved from another document is not replaced by a single line:
//      the same amount needs nothing, a different one is held for a person.
//
// Everything not landed is returned as `held`, with its reason, and the caller stores it on the
// lookup row so the fee quote can say which page a person reads. Nothing here pays anything, opens
// a portal or changes where anything is filed.

import type { AppDb } from "./db";
import type { CitedFact } from "../../shared/src/types";
import { isGovernmentHost, siteOfHost, sourceHostOf } from "../../shared/src/officialSource";
import { quoteOnPage, type PageReader } from "./agencyPageReader";
import { dollarAmounts } from "./citedReviewTime";
import { feeScheduleProfileKey, getFeeSchedule, saveFeeSchedule, scheduleHasPersonVerification, type FeeScheduleRecord } from "./feeSchedules";
import { logger } from "./logger";
import type { UtilityFee, UtilityFilingLookup } from "./utilityFilingLookup";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();

/** What a printed utility fee is, read off its own label and the sentence that prints its amount. */
export type UtilityFeeKind = "application" | "conditional" | "banded" | "unclear";

/** A charge owed only in some cases: named by what triggers it. */
const CONDITIONAL_CHARGE = /\b(?:return(?:ed)?[- ]trip|trip charge|re-?inspect\w*|re-?visit\w*|repeat\w*|additional (?:trip|visit|inspection|review|stud(?:y|ies))|modif\w*|amend\w*|revis\w*|transfer\w*|change of (?:owner\w*|customer|name|account)|assign\w*|re-?submi\w*|re-?appl\w*|late|expedit\w*|rush|upgrade\w*|stud(?:y|ies)|supplemental|witness test\w*|cancel\w*|withdraw\w*|returned (?:check|payment)|reconnect\w*|after[- ]hours|per (?:additional|extra)|deposit|unable to|fail(?:s|ed|ure)?)\b/i;
/** The fee an application itself carries. */
const APPLICATION_FEE = /\b(?:application|interconnect\w*|net[- ]?meter\w*|net billing|customer generation|enrol\w*|processing|filing|meter)\b/i;
/** Priced by the system's size or the application's level: more than one amount, one per band. */
const SIZE_OR_LEVEL = /\b(?:over|above|greater than|more than|exceed\w*|less than|up to|under|below|between|through)\b[^.$]{0,40}\bk(?:w|va)\b|\bk(?:w|va)\b[^.$]{0,20}\bor (?:less|smaller|larger|greater|more)\b|\b(?:level|tier)\s*(?:[1-4]|i{1,3}|iv)\b|\bper k(?:w|va)\b/i;

/** The sentence(s) of the quote that print this amount (the whole quote when none can be cut out). */
function amountSentences(quote: string, amountUsd: number): string {
  const parts = str(quote).split(/(?<=[.;!?])\s+|\s*\.\.\.\s*|\s*…\s*|\s\|\s|\n/).filter(Boolean);
  const hit = parts.filter((p) => dollarAmounts(p).some((n) => Math.abs(n - amountUsd) < 0.005));
  return hit.length ? hit.join(" ") : str(quote);
}

/** WHICH KIND OF FEE THIS IS. Conditional wins over application ("system modification application
 *  fee" is a modification's fee); a size or level band is its own kind; a label that names neither an
 *  application nor a trigger is unclear, and unclear is never guessed into an application fee. */
export function utilityFeeKind(fee: UtilityFee, quote: string): UtilityFeeKind {
  const label = str(fee.label);
  const sentence = amountSentences(quote, fee.amountUsd);
  if (CONDITIONAL_CHARGE.test(label) || CONDITIONAL_CHARGE.test(sentence)) return "conditional";
  if (SIZE_OR_LEVEL.test(label) || SIZE_OR_LEVEL.test(sentence)) return "banded";
  if (APPLICATION_FEE.test(label)) return "application";
  return "unclear";
}

export interface UtilityFeeHeld { label: string; amountUsd: number; sourceUrl: string; reason: string }
export interface UtilityFeeLanding {
  /** The fee that landed in the fee schedule this run, or null. */
  landed: { label: string; amountUsd: number; sourceUrl: string; scheduleId: string; readAt: string } | null;
  /** Fees not landed that a person settles, each with why. Conditional charges are never here. */
  held: UtilityFeeHeld[];
  /** One line on what happened, for the run's notes. */
  reason: string;
}

const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

/** The single flat amount a stored NEM row states, or null when it is anything else (brackets by
 *  size, a delegation, a conflict). */
function flatAmountOf(row: FeeScheduleRecord | null): number | null {
  if (!row || row.status === "conflicted" || row.brackets.length !== 1) return null;
  const b = row.brackets[0];
  return b.minKw == null && b.maxKw == null && typeof b.feeUsd === "number" ? b.feeUsd : null;
}

/** The mark this landing leaves on its own rows (fee_schedules.source_kind). Research writes
 *  "official" / "third_party" there, so a row research has since replaced no longer carries it. Not
 *  a tier: the row is 'seeded' like every automatic fee. */
export const UTILITY_LOOKUP_FEE_KIND = "utility_lookup";
const landedFromLookup = (row: FeeScheduleRecord): boolean => str(row.sourceKind) === UTILITY_LOOKUP_FEE_KIND;

/**
 * LAND THE LOOKUP'S APPLICATION FEE in fee_schedules (track "nem"), or say why not. `reader` is the
 * lookup's own polite reader (one try, host back-off); null lands nothing. `verifiedHosts` are hosts
 * a person verified as this utility's own. Never throws.
 */
export async function landUtilityLookupFees(
  db: AppDb,
  lookup: Pick<UtilityFilingLookup, "state" | "utility" | "fees" | "filing" | "program">,
  opts: { reader: PageReader | null; verifiedHosts?: readonly string[]; now?: string },
): Promise<UtilityFeeLanding> {
  const fees = (lookup.fees ?? []).filter((f) => f.value);
  const out: UtilityFeeLanding = { landed: null, held: [], reason: "" };
  if (!fees.length) return { ...out, reason: "no cited utility fee" };
  const hold = (f: CitedFact<UtilityFee>, reason: string) => {
    out.held.push({ label: f.value!.label, amountUsd: f.value!.amountUsd, sourceUrl: str(f.sourceUrl), reason });
  };
  const kinds = fees.map((f) => ({ f, kind: utilityFeeKind(f.value!, f.quote) }));
  const application = kinds.filter((k) => k.kind === "application");
  const open = kinds.filter((k) => k.kind === "banded" || k.kind === "unclear");
  if (open.length || application.length > 1) {
    // One application amount printed on two pages is one fee, not two.
    const distinct = new Set(application.map((k) => k.f.value!.amountUsd));
    if (open.length || distinct.size > 1) {
      for (const k of [...application, ...open]) {
        hold(k.f, k.kind === "banded"
          ? "priced by system size or application level: a person reads which amount this job owes"
          : k.kind === "unclear"
            ? "Keelix cannot tell whether every application owes this fee: a person reads it"
            : "more than one application fee is printed: a person reads which one this job owes");
      }
      return { ...out, reason: "more than one fee could be the application fee — none landed" };
    }
  }
  if (!application.length) return { ...out, reason: "no application fee among the cited fees (charges owed in some cases only)" };

  const fee = application[0].f;
  const value = fee.value!;
  const url = str(fee.sourceUrl);
  // 2. The utility's own site as this lookup found it, a government host, or a person-verified host.
  const site = siteOfHost(sourceHostOf(url));
  const ownSites = new Set([lookup.filing?.sourceUrl, lookup.filing?.value?.url, lookup.program?.sourceUrl, ...(opts.verifiedHosts ?? []).map((h) => `https://${h}/`)]
    .map((u) => siteOfHost(sourceHostOf(str(u)))).filter(Boolean));
  if (!site || !(isGovernmentHost(sourceHostOf(url)) || ownSites.has(site))) {
    hold(fee, "cited to a page that is not the utility's own site as this lookup found it: a person reads the utility's page");
    return { ...out, reason: "the fee's source is not the utility's own site — not landed" };
  }
  // 3. Re-read by this process; the quoted words are on the page.
  if (!opts.reader) {
    hold(fee, "the page was not re-read by Keelix in this run: a person reads it");
    return { ...out, reason: "no page reader — not landed" };
  }
  let text = "";
  let readReason = "";
  try {
    const page = await opts.reader.read(url);
    if (page.ok) text = str(page.text); else readReason = str(page.reason).slice(0, 100);
  } catch (err) {
    readReason = (err instanceof Error ? err.message : String(err)).slice(0, 100);
  }
  if (!text) {
    hold(fee, `Keelix could not read the page that prints this fee (${readReason || "no readable text"}): a person reads it`);
    return { ...out, reason: "the fee's page could not be read — not landed" };
  }
  if (!quoteOnPage(fee.quote, text)) {
    hold(fee, "the quoted words are not on the page as Keelix read it: a person reads it");
    return { ...out, reason: "the fee's quote is not on its page as read — not landed" };
  }

  const where = { state: lookup.state, utility: lookup.utility, track: "nem" as const };
  const existing = getFeeSchedule(db, feeScheduleProfileKey(where, "nem"), "nem", "");
  const onFile = flatAmountOf(existing);
  const same = onFile != null && Math.abs(onFile - value.amountUsd) < 0.005;
  const personVerified = Boolean(existing) && (existing!.confidence === "verified" || scheduleHasPersonVerification(db, existing!.id));
  // 4. A person's row: the same amount needs nothing written at all.
  if (personVerified && same) return { ...out, reason: "a person already verified this fee at the same amount — nothing written" };
  // 5. A researched row from another document is not replaced by one line.
  if (existing && !personVerified && existing.status !== "conflicted" && !landedFromLookup(existing)) {
    if (same) return { ...out, reason: "the fee schedule already holds this amount from fee research — nothing written" };
    hold(fee, `differs from the researched fee on file (${onFile != null ? money(onFile) : `${existing.brackets.length} lines`}, ${existing.sourceUrl}): a person compares the two`);
    return { ...out, reason: "differs from the researched fee on file — not landed" };
  }
  const readAt = opts.now ?? new Date().toISOString();
  let saved: ReturnType<typeof saveFeeSchedule>;
  try {
    saved = saveFeeSchedule(db, where, {
      found: true, reason: "", basis: "flat",
      brackets: [{ feeUsd: value.amountUsd, label: value.label }],
      sourceUrl: url, sourceQuote: fee.quote, sourceKind: UTILITY_LOOKUP_FEE_KIND,
      notes: `Utility lookup (seeded): ${value.label} ${money(value.amountUsd)}, read on the utility's page`.slice(0, 300),
    }, { fetchedAt: readAt });
  } catch (err) {
    logger.warn("utility-filing", `fee landing failed for ${lookup.utility}: ${err instanceof Error ? err.message : String(err)}`);
    return { ...out, reason: "fee landing failed" };
  }
  if (saved.saved && saved.schedule) {
    out.landed = { label: value.label, amountUsd: value.amountUsd, sourceUrl: url, scheduleId: saved.schedule.id, readAt };
    return { ...out, reason: `landed in the fee schedule (seeded): ${value.label} ${money(value.amountUsd)}` };
  }
  // saveFeeSchedule refused: a person-verified row (the finding is in its notes) or an open conflict.
  hold(fee, saved.refusedVerified
    ? `differs from the fee a person verified${onFile != null ? ` (${money(onFile)})` : ""}: recorded in the fee row's notes, a person compares the two`
    : saved.refusedConflicted
      ? "the fee row has an open conflict a person must settle first"
      : `not saved: ${str(saved.reason).slice(0, 120)}`);
  return { ...out, reason: `not landed: ${str(saved.reason).slice(0, 160)}` };
}

/** THE NEM FEE THE LOOKUP LANDED, still standing: the fee row's source and single amount are one of
 *  the lookup's own cited fees. Fee research reads this to skip a second paid search for a fee the
 *  lookup already read on the utility's page (the permit side's lookupLandedPermitFee, for NEM). */
export function lookupLandedUtilityFee(
  schedule: FeeScheduleRecord | null,
  lookup: Pick<UtilityFilingLookup, "fees"> | null,
): { schedule: FeeScheduleRecord; summary: string } | null {
  const amount = flatAmountOf(schedule);
  if (!schedule || amount == null || !lookup) return null;
  const fees = (lookup.fees ?? []).filter((f) => f.value);
  const from = fees.find((f) => str(f.sourceUrl).toLowerCase() === str(schedule.sourceUrl).toLowerCase() && Math.abs(f.value!.amountUsd - amount) < 0.005);
  if (!from || !landedFromLookup(schedule)) return null;
  return { schedule, summary: `flat ${money(amount)} — ${from.value!.label}` };
}
