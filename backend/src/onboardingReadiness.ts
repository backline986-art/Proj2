// ---------------------------------------------------------------------------
// WHAT A CLIENT STILL HAS TO GIVE US BEFORE WE CAN FILE FOR THEM — ONE ANSWER, TWO READERS.
//
// scripts/onboarding-readiness.ts (the operator's full readiness report) and the client's own Company
// setup page (clientOnboarding.ts) ask the SAME questions of a client record: which business fields
// are blank and how much that matters, which licence each state and track the company files in takes,
// and whether the standard AC disconnect is on file. The grading lived inline in the script; it lives
// here now so the page's "still missing" checklist cannot drift from what the report calls a blocker.
//
// PURE: no database, no I/O. The callers read the client record and the places it files in, and print
// (the script) or render (the page) what comes back. Licences are asked of clients.licenceFor, the one
// answer the submit gate, the portal overlay and the form fill all use.
//
// Each check carries `ask`: the same finding in plain words a client can act on, with no internal
// detail (no column, function or gate names, never a licence number). A check with no `ask` is staff
// work the client cannot do on the page.
//
// Universal: states are data (two-letter codes from the jurisdictions given); no state, city, utility
// or portal is named here. The one state-specific rule the report keeps (a docket number one state's
// interconnection asks for) stays in the script, as its own data.
// ---------------------------------------------------------------------------
import type { ClientRecord, ClientServiceAreaEntry } from "../../shared/src/types";
import { licenceKindWords } from "../../shared/src/licenceKinds";
import { licenceFor, licenceJobState, parseStateLicenses, type LicenceClient } from "./clients";
import { usStateCode } from "./usState";

export type ReadinessLevel = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  level: ReadinessLevel;
  /** The report's label column. */
  label: string;
  /** The report's detail column (never a secret or a licence number). */
  detail: string;
  /** What a person does about it (the report's verdict list). */
  nextStep: string;
  /** Which state / jurisdiction it is about ("" = the company as a whole). */
  context: string;
  /** The client-facing line, when the client can supply it on the Company setup page. */
  ask?: string;
  /** Stable key for the page (a field name, or "licence:<ST>:<slot>"). */
  key: string;
}

/** A place the client files in: an AHJ (permit), a utility (NEM), or both. */
export interface ReadinessJurisdiction { state: string; ahj: string; utility: string; source: string }

export interface ReadinessScope { state: string; permit: boolean; nem: boolean; assumed: boolean }

const blank = (v: unknown): boolean => !String(v ?? "").trim();

// --- Business fields ---------------------------------------------------------------------------
// Grading, not just presence. Everything here is quiet at run time: the value feeds
// clientStagingOverlay, blanks are dropped so the portal field is simply left empty, and the filing is
// rejected later rather than refused now.
//   gate   staging is refused without it (a blocker always)
//   nem    an interconnection application requires it (a blocker when any NEM place is in scope)
//   portal a portal or form fills it (a gap)
//   info   no gate reads it and no portal fill depends on it (never a gap by itself)
export type FieldGrade = "gate" | "nem" | "portal" | "info";
export interface FieldRule {
  field: keyof ClientRecord;
  grade: FieldGrade;
  /** Why it matters, in the report's words. */
  why: string;
  /** The client-facing name of the thing ("Your business street address"). */
  ask: string;
}

export const CLIENT_FIELD_RULES: readonly FieldRule[] = [
  { field: "standardDisconnectMake", grade: "nem", why: "utility portals require a disconnect make", ask: "The make of the AC disconnect you usually install" },
  { field: "standardDisconnectModel", grade: "nem", why: "utility portals require a disconnect model", ask: "The model of the AC disconnect you usually install" },
  { field: "legalBusinessName", grade: "portal", why: "installerCompanyName (falls back to companyName)", ask: "Your legal business name" },
  { field: "businessAddress", grade: "portal", why: "installerStreet / installerAddress", ask: "Your business street address" },
  { field: "businessCity", grade: "portal", why: "installerCity", ask: "Your business city" },
  { field: "businessState", grade: "portal", why: "installerState", ask: "Your business state" },
  { field: "businessZip", grade: "portal", why: "installerZip (ACA validates exactly 5 digits)", ask: "Your business ZIP code" },
  { field: "businessPhone", grade: "portal", why: "installerPhone + phone segments (falls back to phone)", ask: "Your business phone number" },
  { field: "businessEmail", grade: "portal", why: "installerEmail (falls back to contactEmail)", ask: "Your business email address" },
  { field: "contactName", grade: "portal", why: "installerContactName (falls back to authorizedSignerName)", ask: "The name of your main contact for permits" },
  { field: "authorizedSignerName", grade: "portal", why: "who signs the application — many AHJ forms require a named signer", ask: "The person who signs applications for your company" },
  { field: "authorizedSignerTitle", grade: "portal", why: "the signer's title, asked for beside the signature on most forms", ask: "That signer's job title" },
  { field: "metroCityLicenseNumber", grade: "info", why: "metro/city contractor licence — required by some AHJ forms", ask: "" },
  { field: "ein", grade: "info", why: "EIN — value never printed by this script", ask: "" },
  { field: "bondCarrier", grade: "info", why: "bond carrier", ask: "" },
  { field: "insuranceCarrier", grade: "info", why: "insurance carrier", ask: "" },
];

/** One business field, graded. `anyNem`: some place in scope files an interconnection application. */
export function gradeField(client: Partial<ClientRecord>, rule: FieldRule, opts: { anyNem: boolean }): ReadinessCheck {
  const field = String(rule.field);
  if (!blank(client[rule.field])) return { level: "ok", label: field, detail: "set", nextStep: "", context: "", key: field };
  let level: ReadinessLevel = "warn";
  let detail = `blank — ${rule.why}`;
  let nextStep = `Fill ${field} on the client row (${rule.why}).`;
  if (rule.grade === "gate") {
    level = "fail";
    nextStep = `Fill ${field} on the client row — staging is refused outright without it.`;
  } else if (rule.grade === "nem") {
    level = opts.anyNem ? "fail" : "warn";
    detail = opts.anyNem ? `blank — BLOCKS interconnection: ${rule.why}` : `blank — ${rule.why} (no NEM jurisdiction in scope, so not blocking today)`;
  } else if (rule.grade === "info") {
    // No current gate reads these, and no portal fill depends on them, so a blank is not a gap in
    // itself — it only matters if a specific AHJ form asks for it.
    level = "ok";
    detail = `blank — ${rule.why} (no gate reads it; supply it if an AHJ form asks)`;
  }
  return { level, label: field, detail, nextStep, context: "", key: field, ...(level !== "ok" && rule.ask ? { ask: rule.ask } : {}) };
}

/** The company name check (identity: the report prints the value so the operator knows the company). */
export function companyNameCheck(client: Partial<ClientRecord>): ReadinessCheck {
  const missing = blank(client.companyName) && blank(client.legalBusinessName);
  return {
    level: missing ? "fail" : "ok",
    label: "companyName",
    detail: client.companyName || `(blank; legal name "${client.legalBusinessName ?? ""}")`,
    nextStep: "Set a company name or legal business name on the client row.",
    context: "",
    key: "companyName",
    ...(missing ? { ask: "Your company name" } : {}),
  };
}

// --- Where the company files ---------------------------------------------------------------------

/** The places a service area names: a whole state files both tracks there, a city or county files
 *  permits, a utility files interconnection. Read from the entries' kinds only (data). */
export function jurisdictionsFromServiceArea(entries: ClientServiceAreaEntry[]): ReadinessJurisdiction[] {
  return (entries ?? []).map((e) => ({
    state: e.state,
    ahj: e.kind === "city" || e.kind === "county" ? e.name : e.kind === "state" ? "(any)" : "",
    utility: e.kind === "utility" ? e.name : e.kind === "state" ? "(any)" : "",
    source: "service area",
  }));
}

/** Which states' licences to check, and for which tracks. With no state known, the state the client
 *  says issued its licence, else its home state — marked as an assumption. */
export function readinessScopes(client: Partial<ClientRecord>, jurisdictions: ReadinessJurisdiction[]): { scopes: ReadinessScope[]; checks: ReadinessCheck[] } {
  const map = new Map<string, ReadinessScope>();
  const checks: ReadinessCheck[] = [];
  for (const j of jurisdictions) {
    const st = licenceJobState(j.state);
    if (!st) continue;
    const scope = map.get(st) ?? { state: st, permit: false, nem: false, assumed: false };
    if (!blank(j.ahj)) scope.permit = true;
    if (!blank(j.utility)) scope.nem = true;
    map.set(st, scope);
  }
  if (jurisdictions.some((j) => !licenceJobState(j.state))) {
    checks.push({ level: "warn", label: "jurisdiction state", detail: "a jurisdiction in scope names no state — which state's licence it takes is unknown",
      nextStep: "Give every jurisdiction its state (\"STATE|AHJ|UTILITY\").", context: "", key: "jurisdiction-state" });
  }
  if (!map.size) {
    const assumed = usStateCode(client.licenseState) || usStateCode(client.businessState);
    if (assumed) map.set(assumed, { state: assumed, permit: true, nem: true, assumed: true });
  }
  if (!map.size) {
    checks.push({ level: "fail", label: "licence state", detail: "no jurisdiction in scope and no licence or business state on the client — no state's licence can be checked",
      nextStep: "Set licenseState on the client, or re-run with --jurisdictions naming where this company files.", context: "", key: "serviceArea",
      ask: "Where you work: the states, cities or counties, and utilities you file with" });
  }
  return { scopes: [...map.values()].sort((a, b) => a.state.localeCompare(b.state)), checks };
}

// --- Licences, per state and per track ------------------------------------------------------------
// Defaults start at the strictest real requirement: a permit job with no contractor licence for its
// state is a blocker (the authority rejects a blank licence slot), and an interconnection job with no
// electrical contractor licence for its state is a blocker (interconnection applications ask for it).
// A building- or electrical-only slot that finds nothing is a gap: it bites only on an AHJ that issues
// that trade's permit separately.

/** What is on file in this state, as kinds (never numbers). */
export function licenceKindsOnFile(client: LicenceClient, state: string): string[] {
  const c = (client ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(c.stateLicenses) ? c.stateLicenses : c.state_licenses_json;
  return parseStateLicenses(raw).filter((l) => l.state === state).map((l) => licenceKindWords(l.kind as never));
}

/** The licence checks for one state scope. Labels and kinds only, never a licence number. */
export function licenceChecks(client: Partial<ClientRecord>, scope: ReadinessScope): ReadinessCheck[] {
  const st = scope.state;
  const ctx = `${st}${scope.assumed ? " (assumed: no jurisdiction in scope)" : ""}`;
  const onFile = licenceKindsOnFile(client, st);
  const describe = (a: ReturnType<typeof licenceFor>): string => {
    if (a.number) return `${a.label || "set"} — set`;
    if (a.candidates.length) return `several ${st} licences could fill it (${onFile.join(", ")}) and neither the slot nor the permit says which — left blank`;
    const notes = [
      /placeholder/.test(a.reason) ? "a test / placeholder value is on file — correct it under Clients" : "",
      /no recognised type/.test(a.reason) ? `a ${st} licence with no recognised type is on file — set its type under Clients` : "",
    ].filter(Boolean);
    return `none on file for this slot${notes.length ? ` (${notes.join("; ")})` : ""}`;
  };
  const out: ReadinessCheck[] = [];
  if (scope.permit) {
    const generic = licenceFor(client, st, { track: "permit" });
    const level: ReadinessLevel = generic.number ? "ok" : generic.candidates.length ? "warn" : "fail";
    out.push({
      level, label: "  permit: contractor slot", detail: describe(generic), context: ctx, key: `licence:${st}:contractor`,
      nextStep: generic.candidates.length
        ? `Keep only the ${st} licence that applies under Clients → State licences, or a slot that does not name its kind cannot pick one.`
        : `Add this company's ${st} contractor licence under Clients → State licences — a ${st} permit stages with its licence slot blank and the AHJ rejects it.`,
      ...(level !== "ok" ? { ask: generic.candidates.length ? `Which of your ${st} licences goes on a building permit` : `Your ${st} contractor licence (type, number and expiry)` } : {}),
    });
    for (const track of ["building", "electrical"] as const) {
      const a = licenceFor(client, st, { track });
      out.push({
        level: a.number ? "ok" : "warn", label: `  permit: ${track} slot`, detail: describe(a), context: ctx, key: `licence:${st}:${track}`,
        nextStep: `Add the ${st} licence a ${track} permit takes under Clients → State licences (needed where the AHJ issues the ${track} permit separately).`,
        ...(a.number ? {} : { ask: `Your ${st} licence for ${track} permits, if cities there issue them separately` }),
      });
    }
  }
  if (scope.nem) {
    const ec = licenceFor(client, st, "electrical_contractor");
    out.push({
      level: ec.number ? "ok" : "fail", label: "  NEM: electrical licence", context: ctx, key: `licence:${st}:nem-electrical`,
      detail: ec.number ? describe(ec) : `${describe(ec)} — interconnection applications ask for the installer's electrical licence`,
      nextStep: `Add this company's ${st} electrical contractor licence under Clients → State licences before any ${st} interconnection filing.`,
      ...(ec.number ? {} : { ask: `Your ${st} electrical contractor licence (number and expiry)` }),
    });
  }
  return out;
}

/** The disconnect is the client's own default, the same in every state (the overlay copies it). */
export function disconnectCheck(client: Partial<ClientRecord>): ReadinessCheck {
  const dm = blank(client.standardDisconnectMake) || blank(client.standardDisconnectModel);
  return {
    level: dm ? "fail" : "ok", label: "disconnect make/model", context: "", key: "disconnect",
    detail: dm ? "not supplied — the utility application has two required fields with nothing to put in them" : "supplied",
    nextStep: "Set standardDisconnectMake and standardDisconnectModel on the client row before any NEM filing.",
  };
}

// --- The client's checklist ----------------------------------------------------------------------

export interface ChecklistLine { key: string; level: "fail" | "warn"; text: string }

/**
 * What the Company setup page shows the client as still missing: the findings above that the client
 * can supply, in plain words. `fail` = needed before we can file; `warn` = recommended. Read through
 * the same grading the readiness report uses, over the record the page would leave (the client's
 * draft laid over what is on file).
 */
export function clientOnboardingChecklist(client: Partial<ClientRecord>, jurisdictions: ReadinessJurisdiction[]): ChecklistLine[] {
  const { scopes, checks } = readinessScopes(client, jurisdictions);
  const anyNem = scopes.some((s) => s.nem);
  const all: ReadinessCheck[] = [
    companyNameCheck(client),
    ...CLIENT_FIELD_RULES.map((r) => gradeField(client, r, { anyNem })),
    ...checks,
    ...scopes.flatMap((s) => licenceChecks(client, s)),
  ];
  const out: ChecklistLine[] = [];
  const seen = new Set<string>();
  for (const c of all) {
    if (c.level === "ok" || !c.ask || seen.has(c.ask)) continue;
    seen.add(c.ask);
    out.push({ key: c.key, level: c.level, text: c.ask });
  }
  if (!(client.serviceArea ?? []).length && !seen.has("Where you work: the states, cities or counties, and utilities you file with")) {
    out.push({ key: "serviceArea", level: "fail", text: "Where you work: the states, cities or counties, and utilities you file with" });
  }
  // Blockers first, then recommendations; within each, the order above (company, fields, licences).
  return [...out.filter((l) => l.level === "fail"), ...out.filter((l) => l.level === "warn")];
}
