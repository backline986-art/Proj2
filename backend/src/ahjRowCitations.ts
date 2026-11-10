// ---------------------------------------------------------------------------
// WHAT A REFERENCE ROW'S CITATIONS SAY, READ AS STRUCTURE (worker-trackissuer, 2026-11-10).
//
// A shipped AHJ process row (backend/data/reference-ahj-processes.json) can carry `citations`: per
// field, the page it was read on, the page's own words and when. Until now they were evidence for a
// person only, and the tracks were derived from the row's free-text notes by word ("separate" +
// "electric" split the permit; "email" anywhere made the channel email). This module reads the
// citations as STRUCTURE, so the fields decide and the words are only a fallback:
//
//   · electricalPermitIssuer — who issues the electrical permit. The value's FIRST WORD is the
//     vocabulary: "state" (the state's electrical authority issues it) or the AHJ itself ("city",
//     "county", "town", "village", "ahj", "same"); anything after it ("city (bought at City Hall)")
//     is a note for the person. Citations that disagree on the kind answer nothing.
//   · electricalSubmissionMethod — the electrical permit is filed at ANOTHER COUNTER of the same AHJ
//     (its value says where, e.g. in person at City Hall). The AHJ's own door is then never the
//     electrical track's door.
//   · permitStructure — "separate" / "combo", where a page says it outright.
//   · requiresBuildingPermitApplication / requiresElectricalPermitApplication — the row's flag, backed
//     by a page. Both backed and both true = two permits.
//   · ess — what a storage job owes, in the page's words.
//
// A STATE AUTHORITY is data too: a row of the same file whose `stateAuthorityFor` lists the permit
// kinds it issues for the whole state ("electrical"). No state, city or agency is named here.
//
// A citation counts only WHOLE: an http(s) page, a quote of 8+ characters and a fetched-at time. It
// never raises a row's tier (the row stays seeded, rule 3) and never makes a door launchable or
// verified: a door is still a person's Confirm (filingDestinationProposals) and rule 1's gate.
// Pure: reads the shipped reference only, writes nothing.
// ---------------------------------------------------------------------------
import type { AhjProcessProfile } from "../../shared/src/types";
import { allAhjProcessProfiles, findAhjProcessProfile } from "./processProfiles";

export interface WholeCitation {
  field: string;
  value: string;
  sourceUrl: string;
  quote: string;
  fetchedAt: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** The row's whole citations (optionally of one field), in file order. */
export function wholeCitations(profile: AhjProcessProfile | null | undefined, field?: string): WholeCitation[] {
  const raw = (profile as unknown as { citations?: unknown } | null | undefined)?.citations;
  if (!Array.isArray(raw)) return [];
  const out: WholeCitation[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const w = { field: str(r.field), value: str(r.value), sourceUrl: str(r.sourceUrl), quote: str(r.quote), fetchedAt: str(r.fetchedAt) };
    if (!w.field || (field && w.field !== field)) continue;
    if (!/^https?:\/\/\S+$/i.test(w.sourceUrl) || w.quote.length < 8 || !w.fetchedAt) continue;
    out.push(w);
  }
  return out;
}

export type ElectricalIssuerKind = "ahj" | "state";

/** The issuer vocabulary: the value's first word. null = a value this reader does not understand. */
export function electricalIssuerKindOf(value: string): ElectricalIssuerKind | null {
  const first = str(value).toLowerCase().split(/[^a-z]+/).find(Boolean) ?? "";
  if (first === "state") return "state";
  if (["city", "county", "town", "village", "borough", "township", "ahj", "same"].includes(first)) return "ahj";
  return null;
}

export interface CitedElectricalIssuer {
  kind: ElectricalIssuerKind;
  /** The first citation of that kind (the page that says who issues it). */
  citation: WholeCitation;
  /** kind "ahj" only: the cited OTHER COUNTER the electrical permit is filed at, or null (same door). */
  separateCounter: WholeCitation | null;
}

/** Who issues this AHJ's electrical permit, as its row's citations say it. null when no whole
 *  citation says, a value is not in the vocabulary, or two citations disagree on the kind. */
export function citedElectricalIssuer(profile: AhjProcessProfile | null | undefined): CitedElectricalIssuer | null {
  const cites = wholeCitations(profile, "electricalPermitIssuer");
  if (!cites.length) return null;
  const kinds = cites.map((c) => electricalIssuerKindOf(c.value));
  if (kinds.some((k) => k === null)) return null;
  const kind = kinds[0]!;
  if (kinds.some((k) => k !== kind)) return null;
  const counter = kind === "ahj" ? wholeCitations(profile, "electricalSubmissionMethod").find((c) => c.value) ?? null : null;
  return { kind, citation: cites[0], separateCounter: counter };
}

/** A row flag as a page backs it: true/false when a whole citation of that field exists and agrees with
 *  the row's own flag (a citation value, when given, must say the same); null otherwise. */
export function citedFlag(profile: AhjProcessProfile | null | undefined, field: "requiresBuildingPermitApplication" | "requiresElectricalPermitApplication"): { value: boolean; citation: WholeCitation } | null {
  if (!profile) return null;
  const own = Boolean((profile as unknown as Record<string, unknown>)[field]);
  for (const c of wholeCitations(profile, field)) {
    const v = c.value.toLowerCase();
    if (v && v !== String(own)) return null;
    return { value: own, citation: c };
  }
  return null;
}

/** THE PERMIT STRUCTURE THE ROW'S FIELDS STATE, with the page that states it — or, when the row
 *  carries a structure field that does not settle it, `{ structured: true }` (its words are then NOT
 *  read for a structure: a field outranks prose). null = the row has no structure field at all (the
 *  word reading stays the fallback). */
export function citedRowStructure(profile: AhjProcessProfile | null | undefined):
  { structure: "separate" | "combo"; citation: WholeCitation; why: string } | { structured: true } | null {
  if (!profile) return null;
  const explicit = wholeCitations(profile, "permitStructure").filter((c) => c.value === "separate" || c.value === "combo");
  if (explicit.length && explicit.every((c) => c.value === explicit[0].value)) {
    return { structure: explicit[0].value as "separate" | "combo", citation: explicit[0], why: "the page states the permit structure" };
  }
  const issuer = citedElectricalIssuer(profile);
  if (issuer?.kind === "state") return { structure: "separate", citation: issuer.citation, why: "the electrical permit is issued by the state, the building permit by the AHJ" };
  if (issuer?.separateCounter) return { structure: "separate", citation: issuer.separateCounter, why: "the electrical permit is filed separately, at another counter" };
  const b = citedFlag(profile, "requiresBuildingPermitApplication");
  const e = citedFlag(profile, "requiresElectricalPermitApplication");
  if (b?.value && e?.value) return { structure: "separate", citation: e.citation, why: "the page requires a building permit and an electrical permit" };
  const structuredFields = ["permitStructure", "electricalPermitIssuer", "electricalSubmissionMethod", "requiresBuildingPermitApplication", "requiresElectricalPermitApplication"];
  return wholeCitations(profile).some((c) => structuredFields.includes(c.field)) ? { structured: true } : null;
}

/** The row of the state's own authority for a permit kind (`stateAuthorityFor`), when exactly one
 *  row in that state says so; null when none (or more than one: never guessed between). */
export function stateAuthorityRowFor(state: string | null | undefined, permitKind: "electrical"): AhjProcessProfile | null {
  const st = str(state).toUpperCase();
  if (!st) return null;
  let rows: AhjProcessProfile[];
  try { rows = allAhjProcessProfiles(); } catch { return null; }
  const hits = rows.filter((p) => str(p.state).toUpperCase() === st && Array.isArray(p.stateAuthorityFor) && p.stateAuthorityFor.includes(permitKind));
  return hits.length === 1 ? hits[0] : null;
}

/** Is this row a state authority's (not a local jurisdiction's)? */
export function isStateAuthorityRow(profile: AhjProcessProfile | null | undefined): boolean {
  return Array.isArray(profile?.stateAuthorityFor) && profile!.stateAuthorityFor.length > 0;
}

/** THIS TRACK FILES AT ANOTHER COUNTER OF THE SAME AHJ: the electrical (or MPU) track of a project whose
 *  issuer is the AHJ itself (no track view: no other agency issues it), where the AHJ's row cites a
 *  separate counter (citedElectricalIssuer.separateCounter). Its door is that counter, which starts
 *  unknown — never the AHJ's own door, not even one a person verified for the AHJ (that person
 *  verified where the BUILDING permit files). null for every other track. */
export function separateCounterFor(
  trackProject: { state?: string | null; ahj?: string | null; city?: string | null; trackView?: unknown },
  track: string | null | undefined,
): WholeCitation | null {
  const t = str(track).toLowerCase();
  if ((t !== "electrical" && t !== "mpu") || trackProject.trackView || !str(trackProject.ahj)) return null;
  let row: AhjProcessProfile | null;
  try { row = findAhjProcessProfile(trackProject as never); } catch { row = null; }
  if (!row || isStateAuthorityRow(row)) return null;
  return citedElectricalIssuer(row)?.separateCounter ?? null;
}
