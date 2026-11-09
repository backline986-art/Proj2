// WHICH STATE'S SEAL IS ON THE ENGINEERING? (#595)
//
// A real Oregon job carried a sealed structural letter in its package, and the city returned it: the
// engineer's seal was from another state, which Oregon (OSBEELS) does not accept. The package had the
// letter, so "stamped engineering missing" stayed quiet, and nothing named the seal's state as the
// problem. Every US state licenses engineers to practise within its own borders; a seal is valid only
// in the state that registered the engineer. An engineer licensed in several states seals each job
// with that job's state's seal.
//
// This reads the state a seal or a licence statement names, from the sheets' own words: the seal's
// text layer ("REGISTERED PROFESSIONAL ENGINEER … STATE OF CALIFORNIA") and the letter's licence line
// ("I am a professional engineer licensed in the State of Colorado"). A seal that is only an image has
// no text, so it names nothing here, and nothing is inferred from it. A clause that states a RULE
// ("calculations shall be sealed by an engineer registered in the State of Oregon") is not a seal and
// is skipped. Only the state is kept: never the engineer's name or licence number.

const STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT",
  DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
  KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI",
  MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH",
  OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
  WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
};
const CODE_NAMES: Record<string, string> = Object.fromEntries(Object.entries(STATE_NAMES).map(([n, c]) => [c, n]));

// Longest first, so "WEST VIRGINIA" is never read as "VIRGINIA".
const NAME = `(?:${Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length).map((n) => n.replace(/ /g, "\\s+")).join("|")})`;
const NAME_RE = new RegExp(`\\b${NAME}\\b`, "gi");
const ENGINEER = String.raw`(?:(?:REGISTERED|LICENSED)\s+)?(?:PROFESSIONAL|STRUCTURAL)\s+ENGINEER\b`;
// The seal's ring: the credential and "STATE OF <name>" within a short span, in either order.
const SEAL_FORWARD = new RegExp(String.raw`${ENGINEER}[^.;\n]{0,60}?\bSTATE\s+OF\s+(${NAME})\b`, "gi");
const SEAL_REVERSE = new RegExp(String.raw`\bSTATE\s+OF\s+(${NAME})\b[^.;\n]{0,60}?${ENGINEER}`, "gi");
// The letter's licence line, which may list several states: "an engineer licensed in the States of
// Utah, Idaho and Oregon", "registered professional engineer in California and Nevada".
const LICENSED_IN = new RegExp(
  String.raw`\b(?:(?:LICENSED|REGISTERED)\s+(?:AS\s+AN?\s+)?(?:PROFESSIONAL\s+|STRUCTURAL\s+|CIVIL\s+)?ENGINEER|ENGINEER\s+(?:LICENSED|REGISTERED))\s+IN\s+(?:THE\s+)?(?:STATES?\s+OF\s+)?(${NAME}(?:\s*(?:,|AND|&)\s*(?:THE\s+STATE\s+OF\s+)?${NAME})*)`,
  "gi",
);
// A rule about seals, not a seal: a requirement, a condition or a negation in the same clause.
const RULE_CLAUSE = /\b(?:SHALL|MUST|SHOULD|REQUIRED|REQUIRES?|IF|UNLESS|WHEN|WHERE|MAY|NOT|NO|NEITHER|NOR|WITHOUT)\b/i;

export interface SealState {
  /** Two-letter code of the state the seal / licence names. */
  state: string;
  /** Where it was read (the document's label). */
  source: string;
}

function codeOf(name: string): string {
  return STATE_NAMES[name.toUpperCase().replace(/\s+/g, " ").trim()] ?? "";
}

/** "OR" -> "Oregon". */
export function stateName(code: string): string {
  const n = CODE_NAMES[code] ?? code;
  return n.toLowerCase().replace(/(^|\s)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/** The states the seals / licence statements in one document name (deduplicated, in order). */
export function engineerSealStatesIn(text: string): string[] {
  const out: string[] = [];
  const push = (code: string) => { if (code && !out.includes(code)) out.push(code); };
  // A seal's own abbreviations are not sentence ends, and "NO. 12345" is a licence number, not a
  // denial: normalise them before the text is cut into clauses and tested for a rule.
  const normalised = String(text ?? "")
    .replace(/\bNO\s*\.\s*(?=#?\s*[A-Z]{0,2}\s*-?\d)/gi, "NUMBER ")
    .replace(/\bP\.\s?E\./gi, "PE")
    .replace(/\b(EXP|EXPIRES|LIC|REG)\./gi, "$1");
  for (const raw of normalised.split(/[\n;]|\.(?=\s|$)/)) {
    const clause = raw.replace(/\s+/g, " ").trim();
    if (!/ENGINEER/i.test(clause)) continue;
    if (RULE_CLAUSE.test(clause)) continue;
    for (const m of clause.matchAll(SEAL_FORWARD)) push(codeOf(m[1]));
    for (const m of clause.matchAll(SEAL_REVERSE)) push(codeOf(m[1]));
    for (const m of clause.matchAll(LICENSED_IN)) for (const n of m[1].matchAll(NAME_RE)) push(codeOf(n[0]));
  }
  return out;
}

/** Every seal state named across the package's documents, each with the document it came from. */
export function engineerSealStates(sources: Array<{ label: string; text: string }>): SealState[] {
  const out: SealState[] = [];
  for (const src of sources) {
    for (const state of engineerSealStatesIn(src.text)) {
      if (!out.some((s) => s.state === state && s.source === src.label)) out.push({ state, source: src.label });
    }
  }
  return out;
}
