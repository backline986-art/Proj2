// THE US STATE NORMALISER: a stored state spelling to its two-letter code (moved out of permitPath.ts
// by review-audit draft 14 so the per-jurisdiction permit-path data can use it without an import cycle;
// permitPath.ts re-exports it, so every existing import keeps working). A LOOKUP TABLE, NOT A RULE: it
// says which code a spelling means and decides nothing about any state. Fail-closed: a spelling it
// does not recognise is "" and the callers ask rather than guess.

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

// THE STATE IS AN ALLOWLIST, NOT "ANYTHING THAT IS NOT OR" (2026-09-24, D1 verification MF2).
//
// Intake stores the state as typed (createProject has no normaliser), and the standard-review
// rule below routes every non-Oregon state past Oregon's prescriptive-vs-engineered confirmation.
// Its first normaliser only knew "OREGON" and "ORE", so a Portland project stored as "Oreg.",
// "OR 97201", "Portland, OR", "97201", "OR, USA", "O.R." or "Oregon State" was NOT "OR", routed to
// the standard review, and skipped the confirmation with no gate blocker at all — the fail-open
// the previous "unknown" fallback had prevented. Now a state routes only when it normalises to a
// recognised two-letter US code: full names and the common abbreviations map to their code;
// anything else resolves UNKNOWN with the "add the project's state" basis, which the gate blocks
// on. Inlined (designCriteria.US_STATES is the same list) because this module must not import
// the design-criteria engine for a two-line lookup.
const US_STATE_CODES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
const US_STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT",
  DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
  KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI",
  MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH",
  OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
  WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
  // Common abbreviations (AP style and the ones operators type).
  ORE: "OR", OREG: "OR", CALIF: "CA", CAL: "CA", TEX: "TX", FLA: "FL", WASH: "WA", ARIZ: "AZ", COLO: "CO", ILL: "IL",
  MASS: "MA", MICH: "MI", MINN: "MN", MISS: "MS", NEB: "NE", NEV: "NV", OKLA: "OK", PENN: "PA", PENNA: "PA", TENN: "TN",
  WIS: "WI", WISC: "WI", WYO: "WY", KANS: "KS", CONN: "CT", DEL: "DE", IND: "IN",
};

/** The two-letter US state code a stored state spelling means, or "" when it is not one we
 *  recognise. "Oregon", "Ore.", "oreg", " or " → "OR"; "OR 97201", "Portland, OR", "97201",
 *  "OR, USA", "O.R.", "OR-Oregon", "Oregon State" → "" (never guessed: the gate asks). */
export function usStateCode(value: unknown): string {
  const raw = clean(value).toUpperCase().replace(/\.+$/, "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (US_STATE_CODES.has(raw)) return raw;
  return US_STATE_NAMES[raw] ?? "";
}
