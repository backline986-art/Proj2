// A REVIEW TIME AND A PRINTED AMOUNT, AS A PAGE STATES THEM (lookup-battery-and-fees, 2026-11-10).
// The permit lookup and the utility lookup both ask a page for its review time ("Allow 10 business
// days for review"), and the utility lookup for its fees ("Residential net meter fee $250"). Each is
// display only, and each is kept only when the page's own words carry it: one test for each, here.
// Universal: no place, utility or portal is named.

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** "up to 10 business days", "2-3 weeks": a number (or a range) and a day / week unit. */
const REVIEW_SPAN = /\b(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\s+(?:business\s+|working\s+|calendar\s+)?(?:days?|weeks?)\b/i;
/** …in a sentence about review / processing (never "permits expire after 180 days"). */
const REVIEW_WORDS = /\breview\w*|\bprocess\w*|\ballow\b|\bturn-?around\b|\btakes?\b|\bapprov\w*/i;
const NOT_REVIEW = /\bexpir\w*|\bvoid\b|\bvalid for\b|\bcommenc\w*|\bwithin \d+ days? of (?:issuance|approval)/i;

/** The quote states this review time: its span is the value's span (the same number or range), and
 *  the sentence is about review or processing. */
export function quoteStatesReviewTime(value: string, quote: string): boolean {
  const q = str(quote).replace(/\s+/g, " ");
  const m = REVIEW_SPAN.exec(q);
  if (!m || !REVIEW_WORDS.test(q) || NOT_REVIEW.test(q)) return false;
  const vm = REVIEW_SPAN.exec(str(value));
  return Boolean(vm) && vm![1] === m[1] && (vm![2] ?? "") === (m[2] ?? "");
}

/** Every dollar amount the quote prints ("$1,033.00" is 1033; "$3.50" is 3.5). */
export function dollarAmounts(quote: string): number[] {
  return [...str(quote).matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/g)].map((m) => Number(`${m[1].replace(/,/g, "")}.${m[2] ?? "0"}`));
}
/** A fee line: the quote prints the amount, and the label's distinctive words. */
export function quoteStatesFee(fee: { label: string; amountUsd: number }, quote: string): boolean {
  if (!Number.isFinite(fee.amountUsd) || fee.amountUsd <= 0) return false;
  if (!dollarAmounts(quote).some((n) => Math.abs(n - fee.amountUsd) < 0.005)) return false;
  const q = str(quote).toLowerCase();
  const words = str(fee.label).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !["the", "and", "for", "fee", "fees"].includes(w));
  return words.length > 0 && words.some((w) => q.includes(w));
}
