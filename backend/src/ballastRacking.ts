// BALLASTED / NON-PENETRATING RACKING — the one predicate (#689 3d). Both the permit path
// (permitPath.ts), the state prescriptive rules (stateRules.ts) and the reviewer's attachment rule
// (codeReviewRules.ts) read the same answer. A leaf: no import reaches back into any of them.
//
// WHY A VERDICT AND NOT A YES/NO. A ballasted array takes a jurisdiction off its prescriptive path
// (Oregon BCD 440-5952 admits only direct attachment; a city's own worksheet may ask "Is this a
// ballasted roof system?" and stop there), so a wrong answer files the wrong application either way.
// The reading is therefore one of:
//   - "ballasted": the package says so where it counts — the racking / attachment / mounting fields
//     name ballast or a ballasted product, or the plan text does and nothing in the package says
//     otherwise;
//   - "unclear": something points at ballast but the package also points away from it (an attachment
//     to the framing, a pitched shingle / tile roof, a stated slope no ballasted array sits on), or the
//     only mention is conditional ("IF BALLASTED…") or about the ROOFING (gravel-ballasted membrane).
//     A person settles it; it is never guessed either way;
//   - "none": nothing points at ballast.
// A clause that denies it ("NON-BALLASTED", "NO BALLAST") is never evidence.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRecord } from "../../shared/src/types";
import { classifyRoofCovering } from "./roofCovering";

export type BallastVerdict = "ballasted" | "unclear" | "none";

export interface BallastReading {
  verdict: BallastVerdict;
  /** Where the package says it, quoted ("rackingSystem: Unirac RM10 EVO", `Plan set: "…"`); "" = none. */
  evidence: string;
  /** "unclear" only: why a person must settle it, in words for the page. */
  doubt: string;
}

const BALLAST = /\bballast(?:ed|ing|s)?\b|\bnon[-\s]?penetrat(?:ing|ive)\b/i;
const BALLAST_DENIED = /\bnon[-\s]?ballast|\b(?:no|not|without|never)\s+(?:\w+\s+){0,2}?ballast|\bballast(?:ed)?\s*(?::|=)?\s*(?:no|none|n\/a)\b/i;
// A mention that only says what to do IF the array were ballasted is not a statement that it is.
const CONDITIONAL = /\b(?:if|where|when|whether|unless|should)\b[^.;:]{0,40}?\bballast|\bballast\w*\s+systems?\s+(?:shall|must|may)\b/i;
// The ROOFING's ballast (gravel / stone / pavers on a membrane) is not the racking's.
const ROOFING_BALLAST = /\b(?:gravel|stone|river\s*rock|rock|pea\s*gravel)\s*(?:-|\s)?ballast|\bballast(?:ed)?\s+(?:roof(?:ing)?\s+)?(?:membrane|epdm|tpo|pvc|single[-\s]ply|built[-\s]up|bur)\b|\broof(?:ing)?\s+ballast\b/i;
// What the racking IS, named in a field. Attachment hardware is read separately (an attachment
// product named there is evidence AGAINST ballast).
const FIELD_KEYS = ["rackingSystem", "attachmentHardware", "mounting", "tileAttachmentMethod"] as const;

// ---------------------------------------------------------------------------------------------
// BALLASTED PRODUCTS, AS DATA (backend/data/reference-ballasted-racking.json). A plan set that names
// "UNIRAC RM10 EVO" has said ballasted without the word.
// ---------------------------------------------------------------------------------------------
interface BallastedProduct { maker: string; family: string; patterns: string[] }
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
let productCache: { file: string; products: BallastedProduct[] } | null = null;
function productsFile(): string {
  return path.resolve(moduleDir, "..", "data", "reference-ballasted-racking.json");
}
const wordsOf = (text: string): string => ` ${text.toUpperCase().replace(/[^A-Z0-9+]+/g, " ").replace(/\+/g, "").trim()} `;
/** The shipped product list (read once per file; a missing or broken file is an empty list). */
export function ballastedProducts(file = productsFile()): BallastedProduct[] {
  if (productCache && productCache.file === file) return productCache.products;
  let products: BallastedProduct[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { products?: unknown };
    products = (Array.isArray(raw.products) ? raw.products : []).flatMap((p): BallastedProduct[] => {
      const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      const patterns = (Array.isArray(o.patterns) ? o.patterns : []).map((x) => wordsOf(String(x)).trim()).filter((x) => x.length >= 4);
      const maker = String(o.maker ?? "").trim();
      return maker && patterns.length ? [{ maker, family: String(o.family ?? "").trim(), patterns }] : [];
    });
  } catch { /* no list */ }
  productCache = { file, products };
  return products;
}
/** The ballasted product a text names, as "Maker Family"; "" when it names none. */
export function ballastedProductNamed(text: string): string {
  const words = wordsOf(text);
  if (words.trim().length < 4) return "";
  const hit = ballastedProducts().find((p) => p.patterns.some((pat) => words.includes(` ${pat} `)));
  return hit ? `${hit.maker} ${hit.family}`.trim() : "";
}

/** What a text says about ballast: a clear statement, a doubtful mention, or nothing. */
function clauseReading(text: string): "clear" | "doubtful" | "" {
  const product = ballastedProductNamed(text);
  const word = BALLAST.test(text) && !BALLAST_DENIED.test(text);
  if (!product && !word) return "";
  if (product) return "clear";
  return CONDITIONAL.test(text) || ROOFING_BALLAST.test(text) ? "doubtful" : "clear";
}

/** The roof's stated slope as rise per 12, from "4:12", "4/12", "1/4:12", "4 in 12" or "18°"; null = not stated. */
export function roofRisePer12(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  const ratio = /(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*(?::|\/|\bin\b)\s*12\b/i.exec(s);
  if (ratio) {
    const rise = ratio[2] ? Number(ratio[1]) / Number(ratio[2]) : Number(ratio[1]);
    return Number.isFinite(rise) ? rise : null;
  }
  const deg = /(\d+(?:\.\d+)?)\s*(?:°|deg(?:rees?)?\b)/i.exec(s);
  if (deg) return Math.tan((Number(deg[1]) * Math.PI) / 180) * 12;
  return null;
}
/** Above 2:12 is a pitched roof: no ballasted array is designed to sit on it unattached. */
const PITCHED_RISE = 2;

/** The one reading. Pure: reads only the project's parser snapshot. */
export function readBallastedRacking(project: Pick<ProjectRecord, "parserSnapshot">): BallastReading {
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const field = (k: string) => String(snap[k] ?? "").replace(/\s+/g, " ").trim();

  // 1. The fields. A field that names ballast or a ballasted product is the package's own answer.
  let fieldEvidence = "";
  let fieldDoubt = "";
  for (const key of FIELD_KEYS) {
    const v = field(key);
    if (!v) continue;
    const r = clauseReading(v);
    const product = ballastedProductNamed(v);
    const quoted = `${key}: ${v.slice(0, 80)}${product && !BALLAST.test(v) ? ` (${product}: a ballasted system)` : ""}`;
    if (r === "clear" && !fieldEvidence) fieldEvidence = quoted;
    if (r === "doubtful" && !fieldDoubt) fieldDoubt = quoted;
  }

  // 2. The plan text, clause by clause.
  let textEvidence = "";
  let textDoubt = "";
  for (const raw of String(snap.planSetExtractedText ?? "").split(/[\n;]|\.(?=\s|$)/)) {
    const clause = raw.replace(/\s+/g, " ").trim();
    if (!clause) continue;
    const r = clauseReading(clause);
    if (!r) continue;
    const product = ballastedProductNamed(clause);
    const quoted = `Plan set: "${clause.slice(0, 120)}"${product && !BALLAST.test(clause) ? ` (${product}: a ballasted system)` : ""}`;
    if (r === "clear" && !textEvidence) textEvidence = quoted;
    if (r === "doubtful" && !textDoubt) textDoubt = quoted;
    if (textEvidence) break;
  }

  // 3. What points AWAY from ballast.
  const attachment = field("attachmentHardware");
  const attachedField = (attachment && !clauseReading(attachment) ? `attachmentHardware: ${attachment.slice(0, 60)}` : "")
    || (/^y/i.test(field("attachmentToFraming")) ? "the plans answer the attachment-to-framing row Yes" : "");
  const rise = roofRisePer12(snap.roofSlope);
  const pitched = rise != null && rise > PITCHED_RISE ? `the stated roof slope (${field("roofSlope")}) is a pitched roof` : "";
  const family = classifyRoofCovering(snap.roofMaterial, snap.roofMaterialSubtype).family;
  const steepCovering = family === "composition" || family === "tile" || family === "wood" || family === "slate"
    ? `the roof is ${field("roofMaterial")}, a pitched-roof covering` : "";

  const unclear = (evidence: string, doubt: string): BallastReading => ({ verdict: "unclear", evidence, doubt });
  if (fieldEvidence) {
    // The package's own field says ballasted; only a stated pitched slope contradicts it.
    return pitched ? unclear(fieldEvidence, `${pitched}, which no ballasted array sits on unattached`) : { verdict: "ballasted", evidence: fieldEvidence, doubt: "" };
  }
  if (textEvidence) {
    const against = [attachedField, pitched, steepCovering].filter(Boolean);
    return against.length
      ? unclear(textEvidence, `the plan text names ballast, but ${against.join(", and ")}`)
      : { verdict: "ballasted", evidence: textEvidence, doubt: "" };
  }
  const doubtful = fieldDoubt || textDoubt;
  if (doubtful) {
    return unclear(doubtful, ROOFING_BALLAST.test(doubtful)
      ? "the only mention of ballast may be the ROOFING's (gravel / stone on a membrane), not the racking's"
      : "the only mention of ballast is conditional, not a statement about this array");
  }
  return { verdict: "none", evidence: "", doubt: "" };
}

/** Where the package says the racking is ballasted or non-penetrating, quoted; "" when it does not
 *  say so clearly (an "unclear" reading is "" here: callers that need it read readBallastedRacking). */
export function ballastedRackingEvidence(project: Pick<ProjectRecord, "parserSnapshot">): string {
  const r = readBallastedRacking(project);
  return r.verdict === "ballasted" ? r.evidence : "";
}
