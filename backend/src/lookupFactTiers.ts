// OFFICIAL FACTS ON A PERMIT-PROCESS LOOKUP (owner, 2026-11-11: "If its from an offical source we can
// use it to come into us as verified already ... the same for the other stuff we find too"; plan doc
// slice 3). The lookup panel already shows a fact's official tier ("Verified from <host>, <date>",
// lookup-verify.js); until now the lookup never set it, so every fact read seeded.
//
// A fact is stamped `tier: "official"` with its `fetchedAt` only when ALL of these hold, through the
// one shared predicate (shared/src/officialSource.landingTierFor):
//   - its page is on a government host, or a domain recorded as the authority's own (by a person, or by
//     a government page Keelix read, governmentVouches.ts);
//   - its quote names its value (a string value; for a list, every item);
//   - the quote is in the bytes Keelix itself retrieved from that page in this run (never a model's
//     answer about a page Keelix did not read).
// Otherwise it carries no tier (seeded). A tier arriving any other way is stripped.
//
// WHICH FACTS: only the ones that say WHAT the authority is or asks for: the issuing agency, the
// documents a permit needs, steps at another office, the unincorporated-zoning answer, the review time
// and the adopted codes. NEVER a filing door or anything that decides one (portal, record type,
// filing channel, a second stage), never a fee (fees have their own official grade, feeOfficial.ts),
// and never a yes/no or a category (a quote cannot "contain" the value "required" or "combo"; a
// person reads those). The ROW stays seeded: a person's "Verified by" is the only row-level verify.
//
// At read (withHonouredFactTiers), each stamp is re-checked against the hosts as they stand today, so
// a person un-recording a domain takes the tier away. It never touches a person-verified row (rule 3).

import type { CitedFact, PermitProcessLookup } from "../../shared/src/types";
import { isOfficialSourceHost, landingTierFor, quoteText } from "../../shared/src/officialSource";

type Stamped = CitedFact<unknown> & { tier?: "official"; fetchedAt?: string };
/** The parts of a lookup row this module reads (a stored row, or the fields about to be saved). */
type FactRow = Partial<Pick<PermitProcessLookup, "issuingAgency" | "prerequisites" | "unincorporatedZoning" | "reviewTime" | "codes"
  | "permits" | "permitStructure" | "buildingProgram" | "groundMountZoning" | "batteryPermitting" | "confidence">>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const isIso = (s: unknown): boolean => /^\d{4}-\d{2}-\d{2}T/.test(str(s)) && !Number.isNaN(Date.parse(str(s)));

/** The values a quote must name: a string, or every string in a list. null = not a stampable value. */
function namedValues(value: unknown): string[] | null {
  if (typeof value === "string") return str(value) ? [str(value)] : null;
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === "string" && str(v))) return value.map(str);
  return null;
}

/** A fact without any tier it carried. */
function bare<T extends Stamped | null | undefined>(f: T): T {
  if (!f || typeof f !== "object") return f;
  const { tier: _t, fetchedAt: _f, ...rest } = f as Stamped;
  return rest as T;
}

const factKey = (f: Stamped): string => `${str(f.sourceUrl)}\u0000${str(f.quote)}\u0000${JSON.stringify(f.value ?? null)}`;

export interface StampContext {
  /** The text Keelix retrieved this run, by page (the lookup's own pageKey). */
  pageText: (url: string) => string | undefined;
  /** Hosts recorded as this authority's own (a person's, or a government page's vouch). Government hosts need none. */
  hosts: readonly string[];
  /** The read time stamped on a fact landed this run. */
  now: string;
  /** The earlier row: a fact carried from it unchanged keeps the stamp it earned then. */
  earlier?: PermitProcessLookup | null;
}

/** One fact, stamped or bare. */
export function stampFact<T extends Stamped | null | undefined>(f: T, ctx: StampContext, earlierStamps: Map<string, string>): T {
  if (!f || typeof f !== "object") return f;
  const clean = bare(f) as Stamped;
  const values = namedValues(clean.value);
  if (!values) return clean as T;
  const carried = earlierStamps.get(factKey(clean));
  if (carried && isOfficialSourceHost(str(clean.sourceUrl), ctx.hosts)) return { ...clean, tier: "official", fetchedAt: carried } as T;
  const retrievedText = ctx.pageText(str(clean.sourceUrl));
  const official = values.every((v) => landingTierFor({
    sourceUrl: str(clean.sourceUrl), quote: str(clean.quote), value: v, fetchedAt: ctx.now,
    retrievedText, verifiedAuthorityHosts: ctx.hosts,
  }).tier === "official");
  return (official ? { ...clean, tier: "official", fetchedAt: ctx.now } : clean) as T;
}

/** Every stampable fact on a row, through `fn`, on a copy. */
function eachFact<R extends FactRow>(row: R, fn: (f: Stamped) => Stamped): R {
  const out: R = { ...row };
  if (out.issuingAgency) out.issuingAgency = fn(out.issuingAgency as Stamped) as typeof out.issuingAgency;
  if (Array.isArray(out.prerequisites)) out.prerequisites = out.prerequisites.map((p) => fn(p as Stamped) as typeof p);
  if (out.unincorporatedZoning) out.unincorporatedZoning = fn(out.unincorporatedZoning as Stamped) as typeof out.unincorporatedZoning;
  if (out.reviewTime) out.reviewTime = fn(out.reviewTime as Stamped) as typeof out.reviewTime;
  if (out.codes) out.codes = fn(out.codes as Stamped) as typeof out.codes;
  if (Array.isArray(out.permits)) {
    out.permits = out.permits.map((p) => ({
      ...p,
      ...(p.issuingAgency ? { issuingAgency: fn(p.issuingAgency as Stamped) as typeof p.issuingAgency } : {}),
      ...(p.documents ? { documents: fn(p.documents as Stamped) as typeof p.documents } : {}),
    }));
  }
  return out;
}

/** Every fact a lookup must never stamp, bare (a door, a fee, a category): nothing official there. */
function stripNeverStamped<R extends FactRow>(row: R): R {
  const out: R = { ...row };
  if (out.permitStructure) out.permitStructure = bare(out.permitStructure as Stamped) as typeof out.permitStructure;
  if (out.buildingProgram) out.buildingProgram = bare(out.buildingProgram as Stamped) as typeof out.buildingProgram;
  if (out.groundMountZoning) out.groundMountZoning = bare(out.groundMountZoning as Stamped) as typeof out.groundMountZoning;
  if (Array.isArray(out.batteryPermitting)) out.batteryPermitting = out.batteryPermitting.map((b) => bare(b as Stamped) as typeof b);
  if (Array.isArray(out.permits)) {
    out.permits = out.permits.map((p) => ({
      ...p,
      portalUrl: bare(p.portalUrl as Stamped) as typeof p.portalUrl,
      recordType: bare(p.recordType as Stamped) as typeof p.recordType,
      fee: bare(p.fee as Stamped) as typeof p.fee,
      ...(p.channel ? { channel: bare(p.channel as Stamped) as typeof p.channel } : {}),
      ...(p.alternateChannels ? { alternateChannels: p.alternateChannels.map((c) => bare(c as Stamped) as typeof c) } : {}),
      ...(p.secondStage ? { secondStage: bare(p.secondStage as Stamped) as typeof p.secondStage } : {}),
    }));
  }
  return out;
}

/** THE LANDING: a lookup's fields about to be saved, with each stampable fact stamped or bare. */
export function stampOfficialLookupFacts<R extends FactRow>(row: R, ctx: StampContext): R {
  const earlierStamps = new Map<string, string>();
  if (ctx.earlier) {
    eachFact(ctx.earlier, (f) => {
      if (f && f.tier === "official" && isIso(f.fetchedAt)) earlierStamps.set(factKey(bare(f)), str(f.fetchedAt));
      return f;
    });
  }
  return eachFact(stripNeverStamped(row), (f) => stampFact(f, ctx, earlierStamps));
}

/** THE READ: a stored row with each stamp re-checked against today's hosts (and its own evidence).
 *  A person-verified row is returned as it is. Reads only. */
export function withHonouredFactTiers<R extends FactRow>(row: R | null, hosts: readonly string[]): R | null {
  if (!row || row.confidence === "verified") return row;
  return eachFact(stripNeverStamped(row), (f) => {
    if (!f || typeof f !== "object" || f.tier !== "official") return bare(f);
    const values = namedValues(f.value);
    const holds = Boolean(values) && isIso(f.fetchedAt) && isOfficialSourceHost(str(f.sourceUrl), hosts)
      && values!.every((v) => quoteText(str(f.quote)).length >= 3 && landingTierFor({ sourceUrl: str(f.sourceUrl), quote: str(f.quote), value: v, fetchedAt: str(f.fetchedAt), retrievedText: str(f.quote), verifiedAuthorityHosts: hosts }).tier === "official");
    return holds ? f : bare(f);
  });
}
