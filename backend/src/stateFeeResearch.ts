// RESEARCH A STATE'S PERMIT-FEE RULES THE FIRST TIME A JOB LANDS THERE (#663).
//
// The quote reads each state's fee rules from state_permit_rules (stateFeeRules.ts). A state nobody
// has researched is said in the quote as "state surcharge: not researched" — and this is what goes
// and looks, once, in the background: QC queues a `state_fee_research` job for a permit-track
// project in a state with no surcharge record (ensureStateFeeRulesResearched), and the job runs one
// web-grounded lookup for the state's statute (runStateFeeResearch).
//
// ONLY WHAT A RETRIEVED PAGE PRINTS LANDS (Helm's #637 bar: a seeded row changes an amount only when
// it quotes its source verbatim). Every rule the lookup returns must:
//   - cite a URL the lookup's own searches returned or a page it opened, on an official host;
//   - quote that page verbatim, every excerpt found in the page we fetch ourselves — gently: one
//     plain-HTTP fetch per document through fetchPublicDocument, never a browser;
//   - print its own amount: a surcharge's excerpts state the percentages that add up to it, a cap's
//     excerpt prints its dollar figure.
// What passes goes through the one write path (stateRules.writeSeededStatePermitRule), whose landing
// function decides the tier (#683): OFFICIAL when every quote that names the amount is in the bytes we
// read from a government page, else seeded. It never writes a verified row (rule 3). An answer of "the state levies none" is NOT stored: there is
// rarely a sentence that says so, and an uncited zero is exactly the silent assumption this replaces.
// The prompt carries the state's name and nothing about the project (rule 2: no secret can ride it).
//
// Universal by construction: no state is named in code. The state comes from the project.
import type { LLMProvider, WebLookupResult } from "../../shared/src/types";
import type { AppDb } from "./db";
import { fetchPublicDocument } from "./documentFetch";
import { isOfficialCodeSource } from "./llm";
import { logger } from "./logger";
import { extractPdfTextItems } from "./pdfTables";
import { usStateCode } from "./permitPath";
import { foldForQuote } from "./pvPlacementRules";
import { writeSeededStatePermitRule, type RuleLandingEvidence } from "./stateRules";
import {
  STATE_FEE_FAMILY, STATE_SOLAR_FEE_CAP_KEY, STATE_SURCHARGE_KEY, SURCHARGE_APPLIES_TO_PERMIT_FEES, stateSurchargeResearched,
} from "./stateFeeRules";

type Row = Record<string, unknown>;

export const STATE_FEE_RESEARCH_JOB = "state_fee_research" as const;
/** A lookup that found nothing leaves no row, so the job row is the backoff marker. */
const RESEARCH_BACKOFF_MS = 30 * 24 * 3600_000;

export const STATE_FEE_LOOKUP_SYSTEM = `You look up ONE US state's STATUTORY rules on LOCAL building / electrical PERMIT FEES that apply to a residential rooftop solar permit:
1. A STATE SURCHARGE on permit fees that every local building department must collect and remit to the state (a percentage of the permit fee).
2. A STATUTORY CAP on the permit fee a local jurisdiction may charge for a residential solar energy system (a dollar ceiling or formula).

SEARCH the state legislature's statutes and the state building-codes agency's pages. OPEN the statute or rule page before quoting it.

RULES
- Quote the statute EXACTLY as the page prints it: each excerpt a verbatim sentence or clause from ONE page. Never paraphrase, never add a number the page does not print.
- A surcharge made of several parts (e.g. three subsections each imposing a percentage) is ONE rule: give each part as its own verbatim excerpt; "percent" is their total.
- "appliesTo": "permit_fees" when the surcharge is a percentage of the permit fees themselves; otherwise describe what it is a percentage of in a few words.
- "atMost": true when the statute sets a maximum ("may not exceed") rather than a fixed rate.
- Only the state's own law (legislature, state agency, administrative code). A city's fee schedule, a blog, or another state's law is not this state's rule.
- If the state imposes no such surcharge or cap, return an empty list. An honest empty list is a correct answer.

Return ONLY JSON:
{"rules":[{"key":"surcharge","percent":<number>,"appliesTo":"permit_fees","atMost":<bool>,"section":"<statute citation, e.g. 'Stat. 12.345(4)'>","excerpts":["<verbatim>", "..."],"sourceUrl":"<the page that prints every excerpt>"},
{"key":"solarPermitFeeCap","maxUsd":<number>,"formula":"<the cap in a few words, or empty>","section":"<citation>","excerpts":["<verbatim>"],"sourceUrl":"<url>"}]}`;

export interface StateFeeRuleFinding {
  key: typeof STATE_SURCHARGE_KEY | typeof STATE_SOLAR_FEE_CAP_KEY;
  value: Record<string, unknown>;
  section: string;
  excerpts: string[];
  sourceUrl: string;
  /** The text this process read from `sourceUrl` (verifyStateFeeQuotes), for the landing function.
   *  In-process only: never stored, never sent to a model. */
  retrievedText?: string;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const PERCENT_DIGITS = /(\d+(?:\.\d+)?)\s*(?:%|percent\b|per\s+cent\b)/i;
const PERCENT_WORDS = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})(\\s+and\\s+one[-\\s]half)?\\s+(?:percent|per\\s+cent)\\b`, "i");

/** The percentage one excerpt imposes, as printed ("4%", "4 percent", "four percent"); null if none. */
export function percentStated(excerpt: string): number | null {
  const d = PERCENT_DIGITS.exec(excerpt);
  const w = PERCENT_WORDS.exec(excerpt);
  // The first one printed wins: an excerpt is one clause, and its rate comes first.
  if (d && (!w || d.index <= w.index)) return Number(d[1]);
  if (w) return WORD_NUMBERS[w[1].toLowerCase()] + (w[2] ? 0.5 : 0);
  return null;
}

/** Does an excerpt print this dollar figure ("$500", "$500.00", "$1,000")? */
function printsDollars(excerpt: string, usd: number): boolean {
  for (const m of excerpt.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)) {
    if (Math.abs(Number(m[1].replace(/,/g, "")) - usd) < 0.005) return true;
  }
  return false;
}

function normUrl(u: string): string {
  return String(u || "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}
function clean(v: unknown, max = 600): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Pure: the lookup's answer as the rules that MAY be stored — grounded, cited to a page the lookup
 *  found, on an official host, and printing their own amounts. The page check is separate. */
export function parseStateFeeLookup(result: Pick<WebLookupResult, "text" | "groundedSearches" | "resultUrls" | "fetchedUrls">, state: string): { rules: StateFeeRuleFinding[]; dropped: string[] } {
  const dropped: string[] = [];
  if (!result.groundedSearches) return { rules: [], dropped: ["no web search returned results — nothing is stored from model memory"] };
  let parsed: unknown;
  try {
    const m = String(result.text || "").match(/```(?:json)?\s*([\s\S]*?)```/) ?? String(result.text || "").match(/(\{[\s\S]*\})/);
    parsed = JSON.parse(m ? m[1] : String(result.text || ""));
  } catch {
    return { rules: [], dropped: ["the answer did not parse"] };
  }
  const seen = new Set([...(result.resultUrls ?? []), ...(result.fetchedUrls ?? [])].map(normUrl));
  const raw = Array.isArray((parsed as { rules?: unknown })?.rules) ? (parsed as { rules: unknown[] }).rules : [];
  const out: StateFeeRuleFinding[] = [];
  const keys = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const key = o.key === STATE_SURCHARGE_KEY || o.key === STATE_SOLAR_FEE_CAP_KEY ? o.key : null;
    const section = clean(o.section, 120).replace(/\s+—\s+/g, " - ");
    const sourceUrl = clean(o.sourceUrl, 500);
    const excerpts = (Array.isArray(o.excerpts) ? o.excerpts : []).map((e) => clean(e, 1200)).filter((e) => e.length >= 15).slice(0, 6);
    if (!key || !section || !excerpts.length) { dropped.push(`malformed rule: ${clean(o.key, 40) || "(no key)"}`); continue; }
    if (keys.has(key)) { dropped.push(`a second ${key} rule — only the first is kept`); continue; }
    if (!sourceUrl || !seen.has(normUrl(sourceUrl))) { dropped.push(`uncited (the URL was not a page the lookup found or opened): ${sourceUrl || "(none)"}`); continue; }
    if (!isOfficialCodeSource(sourceUrl, null)) { dropped.push(`not an official source for ${state}: ${sourceUrl}`); continue; }
    if (key === STATE_SURCHARGE_KEY) {
      const percent = Number(o.percent);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) { dropped.push(`surcharge without a usable percent (${clean(o.percent, 20)})`); continue; }
      // THE AMOUNT IS THE WORDS' OWN: each excerpt states a percentage, and they add up to it.
      const stated = excerpts.map(percentStated);
      if (stated.some((p) => p == null)) { dropped.push(`surcharge excerpt prints no percentage — ${section}`); continue; }
      const total = stated.reduce<number>((sum, p) => sum + (p ?? 0), 0);
      if (Math.abs(total - percent) > 0.001) { dropped.push(`surcharge ${percent}% is not what its excerpts print (${total}%) — ${section}`); continue; }
      const appliesTo = clean(o.appliesTo, 80) || SURCHARGE_APPLIES_TO_PERMIT_FEES;
      out.push({ key, section, excerpts, sourceUrl, value: { percent, appliesTo, maximum: o.atMost === true, section } });
    } else {
      const maxUsd = Number(o.maxUsd);
      if (!Number.isFinite(maxUsd) || maxUsd <= 0) { dropped.push(`cap without a usable dollar figure — ${section}`); continue; }
      if (!excerpts.some((e) => printsDollars(e, maxUsd))) { dropped.push(`cap $${maxUsd} is not printed in its excerpts — ${section}`); continue; }
      const formula = clean(o.formula, 200);
      out.push({ key, section, excerpts, sourceUrl, value: { maxUsd, section, ...(formula ? { formula } : {}) } });
    }
    keys.add(key);
  }
  return { rules: out, dropped };
}

/** The text of one page, for the quote check: ok false when it could not be retrieved. */
export type StateFeePageReader = (url: string) => Promise<{ ok: boolean; text: string; status: number }>;

async function readPageText(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  // Plain HTTP only — a background job never opens a browser window for this.
  const doc = await fetchPublicDocument(url, { allowBrowser: false, timeoutMs: 20_000, maxBytes: 12 * 1024 * 1024 });
  if (!doc.ok) return { ok: false, text: "", status: doc.status };
  if (/pdf/i.test(doc.contentType) && doc.bytes) {
    try {
      const items = await extractPdfTextItems(doc.bytes, { maxPages: 80 });
      return { ok: true, text: items.map((i) => i.str ?? "").join(" "), status: doc.status };
    } catch { return { ok: false, text: "", status: doc.status }; }
  }
  return { ok: true, text: decodeEntities(String(doc.text ?? "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")), status: doc.status };
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", sect: "§", quot: '"', apos: "'", lt: "<", gt: ">", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
/** A page's character references as the characters a reader sees ("&sect;&nbsp;12" is "§ 12"). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

let pageReaderForTests: StateFeePageReader | null = null;
/** Test seam: read pages without the network. null restores the real reader. */
export function setStateFeePageReaderForTests(fn: StateFeePageReader | null): void {
  pageReaderForTests = fn;
}

/** EVERY EXCERPT IS ON THE PAGE WE RETRIEVED — one fetch per document, however many rules cite it.
 *  A page we cannot retrieve keeps nothing: an unverifiable rule is an unknown, not a rule. */
export async function verifyStateFeeQuotes(rules: StateFeeRuleFinding[]): Promise<{ rules: StateFeeRuleFinding[]; dropped: string[]; fetched: number; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString();
  const reader = pageReaderForTests ?? readPageText;
  const pages = new Map<string, { ok: boolean; text: string; raw: string; status: number }>();
  const kept: StateFeeRuleFinding[] = [];
  const dropped: string[] = [];
  for (const r of rules) {
    const key = normUrl(r.sourceUrl);
    if (!pages.has(key)) {
      let page = { ok: false, text: "", status: 0 };
      try { page = await reader(r.sourceUrl); } catch { /* unreadable */ }
      pages.set(key, { ...page, raw: page.text, text: foldForQuote(page.text) });
    }
    const page = pages.get(key)!;
    if (!page.ok) { dropped.push(`page not retrievable (status ${page.status}) — ${r.key} not stored: ${r.sourceUrl}`); continue; }
    const missing = r.excerpts.find((e) => { const n = foldForQuote(e); return n.length < 12 || !page.text.includes(n); });
    if (missing) { dropped.push(`quote not found on the page we retrieved — "${missing.slice(0, 60)}": ${r.sourceUrl}`); continue; }
    kept.push({ ...r, retrievedText: page.raw });
  }
  return { rules: kept, dropped, fetched: pages.size, fetchedAt };
}

/** The quotes that NAME the amount, each with the amount it names, for the landing function (#683):
 *  a surcharge's parts each print their own percentage, a cap's excerpt prints its dollar figure. A
 *  percentage printed in words ("four percent") names no digits, so such a rule lands seeded. */
export function feeRuleLandingEvidence(r: StateFeeRuleFinding): RuleLandingEvidence | undefined {
  if (r.retrievedText === undefined) return undefined;
  const quotes = r.key === STATE_SURCHARGE_KEY
    ? r.excerpts.map((e) => ({ quote: e, value: percentStated(e) ?? NaN }))
    : r.excerpts.filter((e) => printsDollars(e, Number(r.value.maxUsd))).map((e) => ({ quote: e, value: Number(r.value.maxUsd) }));
  return { retrievedText: r.retrievedText, quotes };
}

/** The citation a row carries: the section, then its words, verbatim. */
function citationOf(r: StateFeeRuleFinding): string {
  return `${r.section}: ${r.excerpts.map((e) => `"${e}"`).join(" … ")}`.slice(0, 4000);
}

/** THE JOB BODY. One lookup for the payload's state; what survives the checks lands seeded. */
export async function runStateFeeResearch(db: AppDb, payload: Record<string, unknown>, provider?: Pick<LLMProvider, "webLookup">): Promise<Record<string, unknown>> {
  const state = usStateCode(payload.state);
  if (!state) return { skipped: true, reason: "no US state on the job" };
  // Answered since it was queued (the reference seed, a person, or an earlier job): nothing to ask.
  if (stateSurchargeResearched(db, state)) return { skipped: true, state, reason: "the state's surcharge is already on file" };
  const llm = provider ?? (await import("./llm")).createLLMProvider();
  if (!llm.webLookup) return { state, saved: 0, error: "no web lookup available (no model key)" };
  const result = await llm.webLookup({
    label: "stateFeeRules",
    system: STATE_FEE_LOOKUP_SYSTEM,
    user: `State: ${state}\nSearches that find these pages: "${state} building permit fee state surcharge statute", "${state} statute solar permit fee cap residential".`,
    maxTokens: 4000,
    maxSearches: 4,
    readPages: true,
    maxFetches: 3,
    timeoutMs: 180_000,
  });
  if (result.error) return { state, saved: 0, error: result.error.slice(0, 300) };
  const parsed = parseStateFeeLookup(result, state);
  const checked = await verifyStateFeeQuotes(parsed.rules);
  let saved = 0;
  const now = new Date().toISOString();
  for (const r of checked.rules) {
    // The landing function decides the tier (#683) from the bytes verifyStateFeeQuotes read; fetchedAt
    // = when that page was read, so the row carries its full provenance.
    saved += writeSeededStatePermitRule(db, { state, family: STATE_FEE_FAMILY, key: r.key, value: r.value, citation: citationOf(r), sourceUrl: r.sourceUrl, fetchedAt: checked.fetchedAt }, now, feeRuleLandingEvidence(r));
  }
  const dropped = [...parsed.dropped, ...checked.dropped];
  if (saved) logger.info("state-fee-rules", `stored ${saved} researched fee rule(s) for ${state}`);
  return {
    state, saved, found: checked.rules.map((r) => r.key), documentsFetched: checked.fetched, webGrounded: result.groundedSearches > 0,
    ...(dropped.length ? { dropped: dropped.slice(0, 8) } : {}),
    ...(!checked.rules.some((r) => r.key === STATE_SURCHARGE_KEY) ? { surcharge: "no cited state surcharge found — the quote keeps saying not researched" } : {}),
  };
}

/**
 * QUEUE THE STATE'S FEE RESEARCH THE FIRST TIME A PERMIT JOB LANDS THERE. Only where the state has
 * no surcharge record; one job per state, backed off 30 days after any attempt (the job row is the
 * marker — a lookup that found nothing writes no row). Same switches as fee research: off with
 * FEE_RESEARCH=off, without a model key, or in a process that runs no job worker (the smoke, unit
 * tests and scripts must never start background spending by running QC). Best-effort: never throws.
 */
export async function ensureStateFeeRulesResearched(db: AppDb, project: { id: string; state: string }): Promise<number> {
  try {
    if (process.env.FEE_RESEARCH === "off") return 0;
    if (!String(process.env.ANTHROPIC_API_KEY ?? "").trim()) return 0;
    const state = usStateCode(project.state);
    if (!state || stateSurchargeResearched(db, state)) return 0;
    const jobQueue = await import("./jobQueue");
    if (!jobQueue.jobWorkerRunning()) return 0;
    const recent = db.get<Row>(
      `SELECT id FROM job_queue WHERE job_type = ? AND payload LIKE ?
         AND (status IN ('pending','running') OR created_at > ?) LIMIT 1`,
      [STATE_FEE_RESEARCH_JOB, `%"state":"${state}"%`, new Date(Date.now() - RESEARCH_BACKOFF_MS).toISOString()],
    );
    if (recent) return 0;
    // maxRetries 2: the worker's retry math (`retryCount+1 < maxRetries`) means 1 yields ZERO retries.
    jobQueue.enqueueJob(db, STATE_FEE_RESEARCH_JOB, { state }, { priority: 3, maxRetries: 2, projectId: project.id });
    logger.info("state-fee-rules", `state fee-rule research queued for ${state}`);
    return 1;
  } catch {
    return 0;
  }
}
