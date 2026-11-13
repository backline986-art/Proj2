// AN OFFICIAL SOURCE, AND WHAT LANDS FROM ONE (#683).
//
// The owner's decision (2026-11-09): a fact the bot read on the authority's OWN official page is
// used at once, labelled with where it came from, without waiting for a person. Rule 3 is unchanged:
// such a fact is "official", never "verified by" anyone; it never overwrites a person's verified row,
// and it never decides WHERE a filing goes or WHETHER one is sent (the rule 5 carve-out, the filing
// email recipient, a NEM filed inside a permit and rule 1 all stay person-verified).
//
// One predicate and one landing function, shared by every writer that stores a cited fact:
//   - isGovernmentHost(host): .gov / .mil, a US locality's or state's .us, a country's gov. second level;
//   - isOfficialSourceHost(url, verifiedAuthorityHosts): a government host, or the authority's own
//     domain where that domain is RECORDED as that authority's own (many cities and utilities run on
//     .org / .com): by a person, or (owner, 2026-11-13) by a government page Keelix read that links
//     it in the authority's name (backend/src/governmentVouches.ts). A seeded or inferred domain never
//     qualifies; a vendor, an aggregator or a file on someone else's CDN never qualifies. A filing
//     door's caller passes person-verified hosts only;
//   - landingTierFor(...): "official" only when the host passes, the quote names the value, and the
//     quote is found in the bytes this process RETRIEVED from that page at `fetchedAt` (never a
//     model's memory, never a model's own quote of a page we did not read); else "seeded".
//   - shippedRowTier(...): a shipped reference row's own "official" claim, honoured at load only when
//     the row's host, quote and fetched-at pass (its bytes were checked when it was built); else "seeded".
// Pure: no DB, no network.

export type LandingTier = "official" | "seeded";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();

/** A government host: .gov / .mil, a US locality's or state's .us (ci.salem.or.us, state.ut.us),
 *  or a country's gov second level (gov.uk). Unknown suffixes are not reassurance. */
export function isGovernmentHost(host: string): boolean {
  const d = str(host).toLowerCase().replace(/\.$/, "");
  return /\.(gov|mil)$/.test(d) || /\.[a-z]{2}\.us$/.test(d) || /(^|\.)state\.[a-z]{2}\.us$/.test(d) || /\.gov\.[a-z]{2}$/.test(d);
}

/** The host of an http(s) URL, lower-case; "" for anything else. */
export function sourceHostOf(url: string): string {
  const u = str(url);
  if (!/^https?:\/\//i.test(u)) return "";
  try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; }
}

/** The registrable part of a host, for "is this the authority's own domain": its last two labels
 *  (a .us locality keeps its own, since isGovernmentHost already answers for those). */
export function siteOfHost(host: string): string {
  return str(host).toLowerCase().replace(/\.$/, "").replace(/^www\./, "").split(".").slice(-2).join(".");
}

/**
 * IS THIS PAGE THE AUTHORITY'S OWN OFFICIAL PAGE? A government host, or a host on a domain recorded as
 * this authority's own (`verifiedAuthorityHosts`: hosts cited by the authority's human-verified rows,
 * and hosts a government page vouched for — governmentVouches.ts; never a seeded row, never a guess
 * from the name). Callers deciding a filing door pass person-verified hosts only.
 */
export function isOfficialSourceHost(url: string, verifiedAuthorityHosts: readonly string[] = []): boolean {
  const host = sourceHostOf(url);
  if (!host) return false;
  if (isGovernmentHost(host)) return true;
  const site = siteOfHost(host);
  return verifiedAuthorityHosts.some((h) => { const s = siteOfHost(h); return !!s && s.includes(".") && s === site; });
}

/** Whitespace and table-cell separators collapsed: a table row "Roof Snow Load | 30 pounds" and the
 *  quote "Roof Snow Load 30 pounds" are the same words in the same order. Case is kept. */
export function quoteText(s: string): string {
  return str(s).replace(/[ \t|]+/g, " ").replace(/\s+/g, " ").trim();
}

const numbersOf = (s: string): number[] =>
  (s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1").match(/(?<![\d.])\d+(?:\.\d+)?/g) ?? []).map(Number);

/** The quote names the value: a number among its numbers, or the words bounded as words. */
export function quoteNamesValue(quote: string, value: number | string): boolean {
  const q = quoteText(quote);
  if (!q) return false;
  if (typeof value === "number") return Number.isFinite(value) && numbersOf(q).includes(value);
  const v = quoteText(value);
  if (!v) return false;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(q);
}

export interface LandingInput {
  sourceUrl: string;
  quote?: string;
  /** The value as stored, and (when a unit was converted) the value as the page printed it. */
  value: number | string;
  publishedValue?: number | string;
  /** When this process read the page (ISO). */
  fetchedAt?: string;
  /** The text this process retrieved from `sourceUrl`. Absent = nothing was read (a model's answer). */
  retrievedText?: string;
  /** Hosts cited by this authority's HUMAN-verified rows (see isOfficialSourceHost). */
  verifiedAuthorityHosts?: readonly string[];
}

/** What a citation can show on its own: the host passes the one predicate, the quote states the
 *  value (the caller's test: a number among its numbers, the item named), and it carries a fetched-at
 *  time. Every reason it falls short (empty when it does not). */
export interface CitationEvidence {
  sourceUrl: string;
  quote?: string;
  fetchedAt?: string;
  /** Does the quote state the row's value? */
  quoteStatesValue: (quote: string) => boolean;
  /** Hosts cited by this authority's HUMAN-verified rows (see isOfficialSourceHost). */
  verifiedAuthorityHosts?: readonly string[];
}
export function citationShortfalls(input: CitationEvidence): { host: string; quote: string; reasons: string[] } {
  const reasons: string[] = [];
  const host = sourceHostOf(input.sourceUrl);
  if (!host) reasons.push("no http(s) source page");
  else if (!isOfficialSourceHost(input.sourceUrl, input.verifiedAuthorityHosts ?? [])) reasons.push(`${host} is not a government host or a domain a person verified as the authority's own`);
  const quote = quoteText(input.quote ?? "");
  if (quote.length < 3) reasons.push("no verbatim quote");
  else if (!input.quoteStatesValue(quote)) reasons.push("the quote does not contain the value");
  const fetched = str(input.fetchedAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(fetched) || Number.isNaN(Date.parse(fetched))) reasons.push("no fetched-at time");
  return { host, quote, reasons };
}

/** "official" or "seeded", and every reason it is not official (empty when it is). */
export function landingTierFor(input: LandingInput): { tier: LandingTier; host: string; reasons: string[] } {
  const { host, quote, reasons } = citationShortfalls({
    sourceUrl: input.sourceUrl, quote: input.quote, fetchedAt: input.fetchedAt, verifiedAuthorityHosts: input.verifiedAuthorityHosts,
    quoteStatesValue: (q) => quoteNamesValue(q, input.value) || (input.publishedValue !== undefined && quoteNamesValue(q, input.publishedValue)),
  });
  if (input.retrievedText === undefined) reasons.push("the page's bytes were not retrieved (a model's answer, not a read)");
  else if (quote && !quoteText(input.retrievedText).includes(quote)) reasons.push("the quote is not in the retrieved page");
  return { tier: reasons.length ? "seeded" : "official", host, reasons };
}

/**
 * A SHIPPED REFERENCE ROW THAT CLAIMS "official" (Helm, 2026-11-10). The page's bytes were read when
 * the row was built, and the delivery's evidence folder holds that text with the quote in it; at load
 * the row is re-checked against what it can show itself (citationShortfalls). The claim is honoured
 * only when it holds; otherwise the row lands seeded, with the reasons. It never throws. Callers never
 * pass a filing door (a portal, an email address, where a filing goes or whether one is sent): those
 * stay seeded until a person verifies them, whatever the host.
 */
export function shippedRowTier(claimed: unknown, input: CitationEvidence): { tier: LandingTier; host: string; reasons: string[] } {
  const { host, reasons } = citationShortfalls(input);
  if (str(claimed) !== "official") return { tier: "seeded", host, reasons: ["the row does not claim official", ...reasons] };
  return { tier: reasons.length ? "seeded" : "official", host, reasons };
}

/** The newest citation backing `field` ("designCriteria.frostDepthIn") on a row, when it is an
 *  OFFICIAL one (tier "official" with its fetched-at and an http(s) source); null when the field's
 *  value is seeded or a person's. */
export function officialCitationFor(
  citations: ReadonlyArray<{ field?: string; sourceUrl: string; tier?: "official"; fetchedAt?: string }> | undefined,
  field: string,
): { host: string; sourceUrl: string; fetchedAt: string } | null {
  const c = (citations ?? []).filter((x) => x && x.field === field).pop();
  if (!c || c.tier !== "official" || !str(c.fetchedAt)) return null;
  const host = sourceHostOf(c.sourceUrl);
  return host ? { host, sourceUrl: c.sourceUrl, fetchedAt: str(c.fetchedAt) } : null;
}
