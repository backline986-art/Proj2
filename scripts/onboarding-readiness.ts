// IS THIS COMPANY ACTUALLY READY TO HAVE WORK FILED FOR THEM, AND WHAT IS STILL MISSING?
// Run this after onboarding a new solar company and BEFORE promising them anything.
//
// It exists because "onboarded" and "ready to file" are different states, and the gap
// between them produces a first-run failure that reads like a bug in the tool. Three
// shapes of that, all observed:
//
//   - A client row with a blank standard AC disconnect make/model. Nothing throws. The
//     interconnection application stages "successfully" with two required utility fields
//     empty, and the utility rejects the filing days later. clientStagingOverlay drops
//     empty values on purpose (so a blank never overwrites a real snapshot value), which
//     is correct behaviour and also why a blank is silent.
//   - A stored portal credential the portal has since refused. The engine records that
//     (last_login_failed_at newer than last_login_ok_at = stale) and the benchmark then
//     refuses to retry it, because seventy retries against real accounts locks people
//     out. Nobody looks at the flag, so an operator-fixable password reads as "the bot
//     can't log in".
//   - An AHJ or utility the shared knowledge base has never seen, with no recorded
//     recipe and no known portal URL. Stage stops there with nothing to drive (the mock
//     adapter stands in only on an explicit MOCK_PORTAL=1 rehearsal), so the filing cannot
//     be staged at all until a person supplies the portal.
//   - A licence check that only knew Oregon. The named CCB / electrical columns fill ONLY
//     Oregon jobs, so a Utah or Idaho company with every licence on file under State
//     licences was warned "ccbLicenseNumber missing" forever (#682). Licences are now
//     checked per state the client files in and per track, through clients.licenceFor —
//     the one answer the submit gate, the portal overlay and the form fill all use.
//
// And one that destroys everything at once: SESSION_ENCRYPTION_KEY rotated without
// running `npm run rekey:credentials`. Every decrypt then fails, and every failure is
// caught and returned as null — so the symptom is "no stored credential for this
// client/portal", never a crypto error. This script attempts one real decrypt so that
// shows up here instead of halfway through a live portal run.
//
//   npx tsx scripts/onboarding-readiness.ts
//   npx tsx scripts/onboarding-readiness.ts --client tml-international-llc
//   npx tsx scripts/onboarding-readiness.ts --client "TML International" --db backend/data/autopilot.sqlite
//   npx tsx scripts/onboarding-readiness.ts --client <id> --jurisdictions "OR|Portland|Portland General Electric, IL|Chicago|Ameren Illinois"
//
// --client accepts a client id or a case-insensitive substring of the company name or
//          legal business name. Omitted: used automatically only when the database holds
//          exactly one client, otherwise the candidates are listed and nothing runs.
// --jurisdictions accepts comma-separated "STATE|AHJ|UTILITY" triples. Any part may be
//          empty ("IL||Ameren Illinois" is a utility-only NEM jurisdiction). Omitted:
//          the distinct (state, ahj|city, utility) triples of the client's own projects
//          are used, which is the set the engine would actually resolve against.
//
// READ-ONLY IN ITS OWN CODE: this script issues no INSERT, UPDATE or DELETE, and it never
// repairs anything it finds. Fixing is a human decision, and several of the fixes are
// operator work on a portal's own website that no automation is allowed to do.
//
// BUT "read-only" IS NOT TRUE OF A RUN, and the caveat this comment used to carry was
// measured with the one metric that cannot catch the difference. openDatabase() calls
// seedInitialKnowledgeBase() UNVERSIONED, on every open (backend/src/db.ts:1005 ->
// knowledgeBase.ts:1864), which re-upserts the baseline knowledge rows and bumps
// permit_utility_knowledge.updated_at on every one of them. Measured, not assumed: 385
// rows' updated_at moved on a copy of the live database, while row counts across every
// table stayed IDENTICAL — which is why the old row-count comparison here reported "the
// DATA does not change" and was wrong. No content moved: notes, portal_url,
// portal_link_status and link_checked_at were byte-identical, and no row was added or
// removed. Nothing here causes that write, and nothing here can avoid it — the backend
// server does the same thing on every boot, so the live file's mtime and checksum are not
// evidence of anything. But do not describe this script to an operator as leaving the
// database untouched. If a run must not move those timestamps, point --db at a copy.
//
// Never prints secrets: no credentials, no password hashes, no encryption keys, and
// account/meter numbers and EIN are shown only as "set"/"missing", never their values.
// A portal login is reported as its username_reference plus set/missing, which is the
// non-secret reference the API itself returns. The decrypt probe opens one envelope and
// discards the contents without printing them.
import "dotenv/config";

// ENV BEFORE IMPORT — openDatabase() is async, takes no path, and reads
// AUTOPILOT_DB_PATH at import time. An explicit --db beats the environment so a copy of
// the operator's database can be checked without touching the live one; both --db <path>
// and --db=<path> are accepted.
const args = process.argv.slice(2);
function flag(name: string): string {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3).trim();
  const at = args.indexOf(`--${name}`);
  if (at >= 0) {
    const next = args[at + 1];
    if (next && !next.startsWith("--")) return next.trim();
  }
  return "";
}
const dbFlag = flag("db");
process.env.AUTOPILOT_DB_PATH = dbFlag || process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const { openDatabase } = await import("../backend/src/db");
const { listClients, clientStagingOverlay, licenceFor, licenceJobState, parseStateLicenses } = await import("../backend/src/clients");
const { licenceKindWords } = await import("../shared/src/licenceKinds");
const { usStateCode } = await import("../backend/src/permitPath");
const { filingChannel } = await import("./coverage-report");
const { orgEntitlements } = await import("../backend/src/entitlements");
const { listPortalCredentials } = await import("../backend/src/portalCredentials");
const { findKnowledgeForLearn, isVerifiedKnowledge } = await import("../backend/src/knowledgeBase");
const { findCompleteRecipeForProject, findAnyRecipeForProject } = await import("../backend/src/portalRecipes");

const clientArg = flag("client");
const jurisdictionsArg = flag("jurisdictions");

// --- Output helpers (house style: sectioned plain text, no colour, no emoji) --------
const line = (s = "") => console.log(s);
const rule = (t: string) => {
  line();
  line(`── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
};

type Level = "ok" | "warn" | "fail";
interface Finding {
  level: "warn" | "fail";
  what: string;
  nextStep: string;
}
const findings: Finding[] = [];
const TAG: Record<Level, string> = { ok: "ok  ", warn: "WARN", fail: "FAIL" };

/** Report one check. Anything that is not "ok" also becomes a line in the verdict's
 *  what-a-human-must-do-next list, so a warning can never be printed and then lost.
 *  `context` names WHICH thing the check was about (a jurisdiction, say) and is carried
 *  into the verdict only — without it, three jurisdictions missing a portal URL produce
 *  three identical numbered lines. */
function check(level: Level, label: string, detail: string, nextStep = "", context = ""): void {
  line(`  [${TAG[level]}] ${label.padEnd(30)} ${detail}`);
  if (level !== "ok") {
    findings.push({
      level,
      what: `${context ? `${context} — ` : ""}${label.trim()}: ${detail}`,
      nextStep: nextStep || detail,
    });
  }
}
const blank = (v: unknown): boolean => !String(v ?? "").trim();

const db = await openDatabase();

// --- Which client -------------------------------------------------------------------
// listClients with an EXPLICIT null org filter: null means "across every org", which is
// what an operator running a readiness check needs. CLAUDE.md forbids an omitted
// trailing orgId precisely because omission fails open silently; here the cross-org read
// is the deliberate choice, so it is spelled out.
const allClients = listClients(db, null);
if (!allClients.length) {
  line("No clients in this database. Onboard the company first (createClient), then re-run.");
  db.close();
  process.exit(1);
}

function resolveClient(): (typeof allClients)[number] {
  if (!clientArg) {
    if (allClients.length === 1) return allClients[0];
    line("More than one client in this database — name which one with --client <id-or-name>:");
    for (const c of allClients) line(`  ${c.id.padEnd(28)} ${c.companyName || c.legalBusinessName}`);
    db.close();
    process.exit(1);
  }
  const byId = allClients.find((c) => c.id === clientArg);
  if (byId) return byId;
  const needle = clientArg.toLowerCase();
  const byName = allClients.filter(
    (c) =>
      c.companyName.toLowerCase().includes(needle) ||
      c.legalBusinessName.toLowerCase().includes(needle),
  );
  if (byName.length === 1) return byName[0];
  if (!byName.length) {
    line(`No client matches "${clientArg}". Known clients:`);
    for (const c of allClients) line(`  ${c.id.padEnd(28)} ${c.companyName || c.legalBusinessName}`);
  } else {
    line(`"${clientArg}" matches ${byName.length} clients — be more specific:`);
    for (const c of byName) line(`  ${c.id.padEnd(28)} ${c.companyName || c.legalBusinessName}`);
  }
  db.close();
  process.exit(1);
}
const client = resolveClient();

line();
line(`ONBOARDING READINESS — ${client.companyName || client.legalBusinessName}`);
line(`  database   ${process.env.AUTOPILOT_DB_PATH}`);
line(`  client id  ${client.id}`);

// --- Which jurisdictions are in scope ------------------------------------------------
// Scope decides which blanks are BLOCKERS rather than warnings: an interconnection (NEM)
// filing demands the installer's electrical licence and the standard AC disconnect
// make/model, and an Illinois interconnection additionally demands the ICC docket
// number. A permit-only client is not blocked by any of those.
interface Jurisdiction {
  state: string;
  ahj: string;
  utility: string;
  source: string;
}
function parseJurisdictions(raw: string): Jurisdiction[] {
  return raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [state = "", ahj = "", utility = ""] = chunk.split("|").map((p) => p.trim());
      return { state, ahj, utility, source: "--jurisdictions" };
    });
}
function jurisdictionsFromProjects(): Jurisdiction[] {
  // ahj || city mirrors what the knowledge base itself keys on (knowledgeBase.ts:413),
  // so a project whose ahj was never filled in resolves the same way here as in a run.
  const rows = db.query<{ state: string; ahj: string; city: string; utility: string }>(
    "SELECT DISTINCT state, ahj, city, utility FROM projects WHERE client_id = ?",
    [client.id],
  );
  const seen = new Set<string>();
  const out: Jurisdiction[] = [];
  for (const r of rows) {
    const j = {
      state: String(r.state ?? "").trim(),
      ahj: String(r.ahj ?? "").trim() || String(r.city ?? "").trim(),
      utility: String(r.utility ?? "").trim(),
      source: "existing projects",
    };
    const key = `${j.state}|${j.ahj}|${j.utility}`.toLowerCase();
    if (seen.has(key) || key === "||") continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}
const jurisdictions = jurisdictionsArg ? parseJurisdictions(jurisdictionsArg) : jurisdictionsFromProjects();
const nemJurisdictions = jurisdictions.filter((j) => !blank(j.utility));
const anyNem = nemJurisdictions.length > 0;
const anyIllinoisNem = nemJurisdictions.some((j) => /^(il|illinois)$/i.test(j.state.trim()));
line(
  `  scope      ${jurisdictions.length} jurisdiction(s)` +
    (jurisdictions.length ? ` from ${jurisdictions[0].source}` : "") +
    `; ${nemJurisdictions.length} with a utility (NEM/interconnection)`,
);

// --- Licence and business fields -----------------------------------------------------
// Grading, not just presence. Everything below is quiet: the value feeds
// clientStagingOverlay, blanks are dropped so the portal field is simply left empty, and
// the filing is rejected later rather than refused now. LICENCES are not here: they are
// per state and per track, in the next section.
rule("CLIENT — BUSINESS FIELDS");
type Grade = "gate" | "nem" | "ilNem" | "portal" | "info";
const FIELDS: [keyof typeof client, Grade, string][] = [
  ["standardDisconnectMake", "nem", "utility portals require a disconnect make"],
  ["standardDisconnectModel", "nem", "utility portals require a disconnect model"],
  ["docketNumber", "ilNem", "ICC docket number — required on every Illinois interconnection application"],
  ["legalBusinessName", "portal", "installerCompanyName (falls back to companyName)"],
  ["businessAddress", "portal", "installerStreet / installerAddress"],
  ["businessCity", "portal", "installerCity"],
  ["businessState", "portal", "installerState"],
  ["businessZip", "portal", "installerZip (ACA validates exactly 5 digits)"],
  ["businessPhone", "portal", "installerPhone + phone segments (falls back to phone)"],
  ["businessEmail", "portal", "installerEmail (falls back to contactEmail)"],
  ["contactName", "portal", "installerContactName (falls back to authorizedSignerName)"],
  ["authorizedSignerName", "portal", "who signs the application — many AHJ forms require a named signer"],
  ["authorizedSignerTitle", "portal", "the signer's title, asked for beside the signature on most forms"],
  ["metroCityLicenseNumber", "info", "metro/city contractor licence — required by some AHJ forms"],
  ["ein", "info", "EIN — value never printed by this script"],
  ["bondCarrier", "info", "bond carrier"],
  ["insuranceCarrier", "info", "insurance carrier"],
];
// Identity fields are printed as values because that is how the operator confirms they
// are looking at the right company. Everything else is set/blank only.
check(
  blank(client.companyName) && blank(client.legalBusinessName) ? "fail" : "ok",
  "companyName",
  client.companyName || `(blank; legal name "${client.legalBusinessName}")`,
  "Set a company name or legal business name on the client row.",
);
for (const [field, grade, why] of FIELDS) {
  const isBlank = blank(client[field]);
  if (!isBlank) {
    check("ok", String(field), "set");
    continue;
  }
  let level: Level = "warn";
  let note = `blank — ${why}`;
  let next = `Fill ${String(field)} on the client row (${why}).`;
  if (grade === "gate") {
    level = "fail";
    next = `Fill ${String(field)} on the client row — staging is refused outright without it.`;
  } else if (grade === "nem") {
    level = anyNem ? "fail" : "warn";
    note = anyNem
      ? `blank — BLOCKS interconnection: ${why}`
      : `blank — ${why} (no NEM jurisdiction in scope, so not blocking today)`;
  } else if (grade === "ilNem") {
    level = anyIllinoisNem ? "fail" : "warn";
    note = anyIllinoisNem
      ? `blank — BLOCKS Illinois interconnection: ${why}`
      : `blank — ${why} (no Illinois NEM jurisdiction in scope)`;
    if (!anyIllinoisNem) level = "ok";
    if (level === "ok") note = "blank — Illinois only, not in scope";
  } else if (grade === "info") {
    // No current gate reads these, and no portal fill depends on them, so a blank is not
    // a gap in itself — it only matters if a specific AHJ form asks for it.
    level = "ok";
    note = `blank — ${why} (no gate reads it; supply it if an AHJ form asks)`;
  }
  check(level, String(field), note, next);
}

// --- Licences, per state and per track --------------------------------------------
// Asked of clients.licenceFor, the ONE answer every licence door uses (the submit gate, the
// portal overlay, the form fill, the cover sheet), for each state this client's jobs are in
// and each track they file. The named CCB / electrical / electrician columns are Oregon's and
// fill only Oregon jobs; every other state reads Clients → State licences. Defaults start at
// the strictest real requirement: a permit job with no contractor licence for its state is a
// blocker (the authority rejects a blank licence slot), an Oregon job without the CCB column
// is refused outright (prepareSubmission's needsCcb gate), and an interconnection job with no
// electrical contractor licence for its state is a blocker (interconnection applications ask
// for it). A building- or electrical-only slot that finds nothing is a gap: it bites only on an
// AHJ that issues that trade's permit separately.
rule("CLIENT — LICENCES BY STATE AND TRACK");
interface StateScope { state: string; permit: boolean; nem: boolean; assumed: boolean }
const stateScopes = new Map<string, StateScope>();
for (const j of jurisdictions) {
  const st = licenceJobState(j.state);
  if (!st) continue;
  const scope = stateScopes.get(st) ?? { state: st, permit: false, nem: false, assumed: false };
  if (!blank(j.ahj)) scope.permit = true;
  if (!blank(j.utility)) scope.nem = true;
  stateScopes.set(st, scope);
}
if (jurisdictions.some((j) => !licenceJobState(j.state))) {
  check("warn", "jurisdiction state", "a jurisdiction in scope names no state — which state's licence it takes is unknown", "Give every jurisdiction its state (\"STATE|AHJ|UTILITY\").");
}
if (!stateScopes.size) {
  // No job states known yet: the state the client says issued its licence, else its home state —
  // and say it is an assumption, so a clean result is not read as proof about other states.
  const assumed = usStateCode(client.licenseState) || usStateCode(client.businessState);
  if (assumed) stateScopes.set(assumed, { state: assumed, permit: true, nem: true, assumed: true });
}
if (!stateScopes.size) {
  check("fail", "licence state", "no jurisdiction in scope and no licence or business state on the client — no state's licence can be checked",
    "Set licenseState on the client, or re-run with --jurisdictions naming where this company files.");
}
const typedLicences = parseStateLicenses(client.stateLicenses);
for (const scope of [...stateScopes.values()].sort((a, b) => a.state.localeCompare(b.state))) {
  const st = scope.state;
  const ctx = `${st}${scope.assumed ? " (assumed: no jurisdiction in scope)" : ""}`;
  line();
  line(`  ${ctx}`);
  const onFile = typedLicences.filter((l) => l.state === st).map((l) => licenceKindWords(l.kind as never));
  line(`         on file   ${st === "OR" ? `named columns (CCB ${blank(client.ccbLicenseNumber) ? "blank" : "set"})${onFile.length ? " + " : ""}` : ""}${onFile.length ? onFile.join(", ") : st === "OR" ? "" : "no State licences entry for this state"}`);
  // Labels and kinds only, never a licence number (this script reports identifiers as set/missing);
  // licenceFor's own reason can quote numbers, so it is summarised here, not printed.
  const describe = (a: ReturnType<typeof licenceFor>): string => {
    if (a.number) return `${a.label || "set"} — set`;
    if (a.candidates.length) return `several ${st} licences could fill it (${onFile.join(", ")}) and neither the slot nor the permit says which — left blank`;
    const notes = [
      /placeholder/.test(a.reason) ? "a test / placeholder value is on file — correct it under Clients" : "",
      /no recognised type/.test(a.reason) ? `a ${st} licence with no recognised type is on file — set its type under Clients` : "",
    ].filter(Boolean);
    return `none on file for this slot${notes.length ? ` (${notes.join("; ")})` : ""}`;
  };
  if (st === "OR") {
    check(blank(client.ccbLicenseNumber) ? "fail" : "ok", "  CCB (Oregon's gate)",
      blank(client.ccbLicenseNumber) ? "blank — an Oregon job is refused at staging (prepareSubmission 409 needsCcb)" : "set",
      "Fill ccbLicenseNumber on the client row — every Oregon job is refused at staging without it.", ctx);
  }
  if (scope.permit) {
    const generic = licenceFor(client, st, { track: "permit" });
    check(generic.number ? "ok" : generic.candidates.length ? "warn" : "fail", "  permit: contractor slot", describe(generic),
      generic.candidates.length
        ? `Keep only the ${st} licence that applies under Clients → State licences, or a slot that does not name its kind cannot pick one.`
        : `Add this company's ${st} contractor licence under Clients → State licences — a ${st} permit stages with its licence slot blank and the AHJ rejects it.`,
      ctx);
    for (const track of ["building", "electrical"] as const) {
      const a = licenceFor(client, st, { track });
      check(a.number ? "ok" : "warn", `  permit: ${track} slot`, describe(a),
        `Add the ${st} licence a ${track} permit takes under Clients → State licences (needed where the AHJ issues the ${track} permit separately).`, ctx);
    }
  }
  if (scope.nem) {
    const ec = licenceFor(client, st, "electrical_contractor");
    check(ec.number ? "ok" : "fail", "  NEM: electrical licence", ec.number ? describe(ec) : `${describe(ec)} — interconnection applications ask for the installer's electrical licence`,
      `Add this company's ${st} electrical contractor licence under Clients → State licences before any ${st} interconnection filing.`, ctx);
  }
}

// The overlay is the ground truth for what staging actually hands a portal: blanks are
// dropped, so a missing key here IS a portal field that will be left empty. Asked per state
// and track the jobs actually file (ccbLicenseNumber is "the contractor licence this filing
// takes" — Oregon's CCB on an Oregon job, the generic-by-track licence anywhere else).
rule("CLIENT — WHAT STAGING WOULD ACTUALLY SUPPLY (clientStagingOverlay)");
const OVERLAY_EXPECTED = [
  "installerCompanyName",
  "installerEmail",
  "installerPhone",
  "installerAddress",
  "installerCity",
  "installerState",
  "installerZip",
  "installerContactName",
  "ccbLicenseNumber",
];
for (const scope of stateScopes.values()) {
  for (const track of [...(scope.permit ? ["permit"] : []), ...(scope.nem ? ["nem"] : [])]) {
    const overlay = clientStagingOverlay(db, client.id, "", { state: scope.state, track });
    const overlayMissing = OVERLAY_EXPECTED.filter((k) => blank(overlay[k]));
    check(
      overlayMissing.length ? "warn" : "ok",
      `overlay ${scope.state} ${track}`,
      `${Object.keys(overlay).length} key(s); ${overlayMissing.length} core key(s) missing` +
        (overlayMissing.length ? ` — ${overlayMissing.join(", ")}` : ""),
      overlayMissing.length
        ? `These portal fields will be filled blank on a ${scope.state} ${track} filing, which is a rejected filing rather than an error: ${overlayMissing.join(", ")}.`
        : "",
    );
  }
}
if (anyNem) {
  // The disconnect is the client's own default, the same in every state (the overlay copies it).
  const dm = blank(client.standardDisconnectMake) || blank(client.standardDisconnectModel);
  check(
    dm ? "fail" : "ok",
    "disconnect make/model",
    dm ? "not supplied — the utility application has two required fields with nothing to put in them" : "supplied",
    "Set standardDisconnectMake and standardDisconnectModel on the client row before any NEM filing.",
  );
}

// --- Org and entitlements ------------------------------------------------------------
// clients.org_id is not part of ClientRecord, so read it directly. This is the grain
// that decides whether anyone can reach a staging route at all.
rule("ORG / ENTITLEMENTS");
const orgRow = db.get<{ org_id: string }>("SELECT org_id FROM clients WHERE id = ?", [client.id]);
const orgId = String(orgRow?.org_id ?? "").trim();
const org = orgId ? db.get<{ id: string; name: string; edition: string }>("SELECT id, name, edition FROM orgs WHERE id = ?", [orgId]) : null;
check(
  org ? "ok" : "fail",
  "org row",
  org ? `${org.id}  "${org.name}"  (edition "${org.edition}" is a legacy display label)` : `no orgs row for org_id "${orgId || "(blank)"}"`,
  `Create the org (POST /api/orgs) or repoint clients.org_id — an unknown org resolves to an EMPTY product set and 403s on every /api/* path.`,
);
const products = orgId ? [...orgEntitlements(db, orgId)].sort() : [];
check(
  products.length ? "ok" : "fail",
  "entitlements",
  products.length ? products.join(", ") : "none — entitlementGate 403s every /api/* path except /api/auth/, /api/public/, /health",
  "Grant at least one product: PUT /api/orgs/:id/products, or grantProduct(db, orgId, 'autopilot').",
);
check(
  products.includes("autopilot") ? "ok" : "fail",
  "autopilot product",
  products.includes("autopilot")
    ? "held — staging routes reachable"
    : "NOT held — staging and provisioning routes are unreachable for this org",
  "Grant 'autopilot' to this org. It is the wildcard product and the only one that covers staging; note it is deliberately never API-key authenticated, so staging always needs a human session.",
);

// --- Users -------------------------------------------------------------------------
rule("USERS (LOGIN POSSIBLE?)");
const { AUTH_ENABLED } = await import("../backend/src/auth");
const users = orgId
  ? db.query<{ id: string; name: string; email: string; role: string; password_hash: string }>(
      "SELECT id, name, email, role, password_hash FROM users WHERE org_id = ? AND active = 1 ORDER BY role, email",
      [orgId],
    )
  : [];
// Boolean only. The stored value is a scrypt "salt:hash" pair and is never printed.
const withPassword = users.filter((u) => !blank(u.password_hash));
check(
  users.length ? "ok" : "warn",
  "active users",
  users.length ? `${users.length} in org ${orgId}` : `none active in org "${orgId}"`,
  "Create a login with POST /api/orgs/:id/users — it is the only route that writes a password.",
);
for (const u of users) {
  line(`         ${(u.role || "operator").padEnd(12)} ${u.email.padEnd(34)} login ${blank(u.password_hash) ? "no" : "yes"}`);
}
check(
  withPassword.length ? "ok" : AUTH_ENABLED ? "fail" : "warn",
  "password set (can log in)",
  `${withPassword.length} of ${users.length}` +
    (AUTH_ENABLED
      ? " — AUTH_ENABLED=true, so a user with no password cannot sign in at all"
      : " — AUTH_ENABLED is false, so logins are not required today"),
  AUTH_ENABLED
    ? "Create the login through POST /api/orgs/:id/users. createUser() and POST /api/users write no password, and there is no password-reset route."
    : "Before turning AUTH_ENABLED on, create at least one login through POST /api/orgs/:id/users.",
);
const admins = users.filter((u) => u.role === "admin" || u.role === "superadmin");
check(
  admins.length ? "ok" : "warn",
  "admin in this org",
  admins.length ? `${admins.length}` : "none — no API path can promote a user to admin; only seedAdminUser or raw SQL can",
  "If this org must administer itself, set the role directly in the database — POST /api/orgs/:id/users hardcodes 'operator'.",
);

// --- Portal credentials ------------------------------------------------------------
// A refused login is OPERATOR WORK, not a defect. The engine records the outcome and the
// benchmark then refuses to retry, so nothing surfaces it unless something like this
// prints the flag.
rule("PORTAL CREDENTIALS");
const creds = listPortalCredentials(db, client.id);
const host = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return u ? "(unparseable url)" : "(no url)";
  }
};
check(
  creds.length ? "ok" : "warn",
  "credentials stored",
  creds.length ? `${creds.length} across ${new Set(creds.map((c) => host(c.portalUrl))).size} host(s)` : "none — every portal login will stall for human capture",
  "Store the portal logins under this client (createPortalCredential, or npm run import:portal-processes). Portal ACCOUNTS themselves must be registered by a human on each portal's own site first.",
);
const stale = creds.filter((c) => c.stale);
const noSecret = creds.filter((c) => !c.hasSecret);
const neverTried = creds.filter((c) => !c.lastLoginOkAt && !c.lastLoginFailedAt);
// One line per credential — 83 rows at four lines each buries the verdict under the
// inventory, and the verdict is the point of this script. The extra detail (what the
// portal actually said, when it refused) is printed only for the rows that are somebody's
// work: refused, no stored secret, or no URL to match a login against.
const needsWork = (c: (typeof creds)[number]): boolean => c.stale || !c.hasSecret || blank(c.portalUrl);
line(`         health    portal                               host`);
for (const c of creds) {
  const health = c.stale ? "STALE  " : !c.hasSecret ? "NO PW  " : blank(c.portalUrl) ? "NO URL " : c.lastLoginOkAt ? "ok     " : "untried";
  line(`         ${health} ${(c.portalType || "(no portal type)").slice(0, 34).padEnd(36)} ${host(c.portalUrl)}`);
  if (!needsWork(c)) continue;
  // username_reference is the non-secret reference the API itself returns; the password is
  // reported only as set/missing, never its value.
  line(`           username ${c.usernameReference ? `ref "${c.usernameReference}"` : "(no reference)"}   password ${c.hasSecret ? "set" : "MISSING"}`);
  if (c.lastLoginNote) line(`           portal said: ${c.lastLoginNote.replace(/\s+/g, " ").slice(0, 110)}`);
  if (c.stale) line(`           refused ${String(c.lastLoginFailedAt).slice(0, 19)}; last accepted ${c.lastLoginOkAt ? String(c.lastLoginOkAt).slice(0, 19) : "never"}`);
}
check(
  stale.length ? "warn" : "ok",
  "stale logins",
  stale.length
    ? `${stale.length} refused more recently than accepted — OPERATOR WORK, not a bot defect`
    : creds.length
      ? "none"
      : "n/a",
  stale.length
    ? `Fix the credential for EACH of the ${stale.length} host(s) marked STALE above, then clear each flag with: npm run learn:benchmark -- --host <host>  (e.g. --host ${host(stale[0].portalUrl)}). A success clears staleness by itself; the benchmark will not retry a refused login, so real accounts do not get locked out.`
    : "",
);
check(
  noSecret.length ? "warn" : "ok",
  "credentials without a secret",
  noSecret.length ? `${noSecret.length} row(s) hold no encrypted secret` : "none",
  "Re-save the password for those rows — a credential row with no envelope can never log in.",
);
check(
  neverTried.length ? "warn" : "ok",
  "never attempted",
  neverTried.length ? `${neverTried.length} login(s) have never been tried against their portal` : creds.length ? "none" : "n/a",
  "An untried login is an unknown, not a pass. Run npm run learn:benchmark -- --host <host> for each before promising coverage.",
);
// A credential whose portal_url carries no host is unfindable at run time: selection is
// by hostname (and first path segment), and it REFUSES rather than falling back to a
// neighbouring jurisdiction, because Accela serves many cities from one host.
const noUrl = creds.filter((c) => blank(c.portalUrl));
check(
  noUrl.length ? "warn" : "ok",
  "credential portal_url",
  noUrl.length ? `${noUrl.length} row(s) have no portal_url — credential selection is by URL host, so these will not be found` : "all set",
  "Set the real login/entry URL on those rows, including the jurisdiction path segment (…/sandiego). portal_type is mostly display; portal_url is the load-bearing field.",
);

// --- Encryption: is the key right, and does a stored secret still open? --------------
// The failure this catches is silent by construction: every decrypt path catches and
// returns null, so a rotated key looks like "no stored credential", never a crypto
// error. Repeated attempts of that kind are how portal accounts get locked out.
rule("ENCRYPTION KEY / DECRYPT PROBE");
const rawKey = process.env.SESSION_ENCRYPTION_KEY || "";
const keyState = !rawKey ? "missing" : rawKey === "replace-with-a-long-random-secret" ? "default placeholder" : "set";
check(
  keyState === "set" ? "ok" : "fail",
  "SESSION_ENCRYPTION_KEY",
  keyState === "set" ? "set" : `${keyState} — encryptStorageState/decryptStorageState throw, so every credential read fails`,
  "Set SESSION_ENCRYPTION_KEY to a real secret (openssl rand -base64 32). The literal placeholder from .env.example counts as unset.",
);
check(
  process.env.AUTH_SECRET ? "ok" : "warn",
  "AUTH_SECRET",
  process.env.AUTH_SECRET
    ? "set (session signing decoupled from the encryption key)"
    : "missing — session signing falls back to SESSION_ENCRYPTION_KEY, so rotating that key logs every user out",
  "Set AUTH_SECRET to its own stable value so an encryption-key rotation is not a fleet-wide logout.",
);
const probeRow = db.get<{ id: string; portal_type: string; portal_url: string; encrypted_secret: string }>(
  "SELECT id, portal_type, portal_url, encrypted_secret FROM portal_credentials WHERE client_id = ? AND encrypted_secret <> '' ORDER BY updated_at DESC LIMIT 1",
  [client.id],
);
if (!probeRow) {
  check("ok", "decrypt probe", "n/a — this client has no stored secret to test");
} else {
  const { decryptStorageState } = await import("../portal-bot/src/cryptoStorage");
  try {
    const opened = decryptStorageState(probeRow.encrypted_secret) as Record<string, unknown> | null;
    // The plaintext is deliberately reduced to booleans here and then dropped. Nothing
    // derived from it is printed, logged, or returned.
    const hasUser = Boolean(opened && typeof opened === "object" && String(opened.username ?? "").trim());
    const hasPass = Boolean(opened && typeof opened === "object" && String(opened.password ?? "").trim());
    check(
      hasUser && hasPass ? "ok" : "warn",
      "decrypt probe",
      `envelope opened for ${probeRow.portal_type || host(probeRow.portal_url)} — username ${hasUser ? "set" : "MISSING"}, password ${hasPass ? "set" : "MISSING"} (contents discarded, never printed)`,
      hasUser && hasPass ? "" : "The envelope decrypts but is missing a username or password — re-save that credential.",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const keyUnset = /must be set/i.test(msg);
    check(
      "fail",
      "decrypt probe",
      keyUnset
        ? "cannot decrypt — SESSION_ENCRYPTION_KEY is unset or is the placeholder"
        : "DECRYPT FAILED — the stored secret does not open with the current key",
      keyUnset
        ? "Set SESSION_ENCRYPTION_KEY, then re-run."
        : "The key was almost certainly rotated without rekeying. Restore the OLD key and run: npm run rekey:credentials -- --old=<old> --new=<new> --dry-run, then for real. Do NOT let portal runs retry in the meantime — every decrypt returns null, which looks like a wrong password and locks accounts out.",
    );
  }
}

// --- Knowledge coverage per jurisdiction --------------------------------------------
// Resolved through the engine's OWN lookups, fuzzy name-alias fallback included, so this
// reports what a real staging run would find rather than a naive key match. A jurisdiction
// with neither a recipe nor a known portal URL cannot be staged: Stage stops with nothing to
// drive (the mock adapter stands in only on a MOCK_PORTAL=1 rehearsal).
//
// NOT EVERY TRACK FILES ON A PORTAL (#682), and the authority's DATA says which — read through
// coverage-report's filingChannel, the same records production reads: an authority a person
// recorded as taking applications BY EMAIL (#667) needs a usable verified address, not a portal,
// recipe or login; a utility a person verified as filed INSIDE THE AHJ PERMIT (#664) has no NEM
// filing of its own. A seeded "email" is only a hint until a person verifies the address.
rule("KNOWLEDGE / RECIPE COVERAGE");
if (!jurisdictions.length) {
  check(
    "warn",
    "jurisdictions in scope",
    "none — this client has no projects yet and no --jurisdictions was given",
    'Re-run with --jurisdictions "STATE|AHJ|UTILITY, ..." naming where this company will file. Until then, coverage is unknown, not proven.',
  );
}
for (const j of jurisdictions) {
  const label = [j.state, j.ahj || "(no ahj)", j.utility || "(no utility)"].join(" | ");
  line();
  line(`  ${label}`);
  const kb = findKnowledgeForLearn(db, { state: j.state, ahj: j.ahj, utility: j.utility });

  const spec = { state: j.state, ahj: j.ahj, utility: j.utility, discipline: "", source: j.source };
  /** The email channel's verdict for one track — true when it decided the track (skip the portal checks). */
  const emailChannel = (ch: ReturnType<typeof filingChannel>, side: string, who: string): boolean => {
    if (ch.kind === "email") {
      check(
        ch.problems.length ? "fail" : "ok",
        `  ${side} files by email`,
        ch.problems.length
          ? `verified address needed — the recorded address ${ch.address} is not usable: ${ch.problems.join("; ")}`
          : `${ch.address} (verified by ${ch.verifiedBy}${ch.verifiedAt ? `, ${ch.verifiedAt.slice(0, 10)}` : ""}) — no portal, recipe or login is used`,
        `A named person records ${who}'s filing address again on the track card's "Filing by email" panel, from the authority's own page.`,
        label,
      );
      return true;
    }
    if (ch.kind === "email_hint") {
      check("warn", `  ${side} email (unverified)`, `${ch.evidence} — files by email only once a person verifies the address`,
        `If ${who} takes applications by email, a named person records the address on the track card's "Filing by email" panel, from the authority's own page.`, label);
    }
    return false;
  };

  // Permit side (AHJ).
  if (!blank(j.ahj) && !emailChannel(filingChannel(db, spec, "permit"), "permit", j.ahj)) {
    const row = kb.ahj;
    const recipe =
      findCompleteRecipeForProject(db, { scopeType: "ahj", state: j.state, ahj: j.ahj, utility: j.utility, discipline: "" }) ||
      null;
    const draft = recipe
      ? null
      : findAnyRecipeForProject(db, { scopeType: "ahj", state: j.state, ahj: j.ahj, utility: j.utility, discipline: "" });
    check(
      row ? (isVerifiedKnowledge(row) ? "ok" : "warn") : "warn",
      "  permit KB row",
      row
        ? `${row.profileKey}  confidence "${row.confidence}"${isVerifiedKnowledge(row) ? " (human-verified)" : " (unverified research — trust it only after a human confirms it)"}, portal_url ${row.portalUrl ? "set" : "MISSING"}`
        : "none — no permit_utility_knowledge row resolves for this AHJ",
      row
        ? isVerifiedKnowledge(row)
          ? ""
          : `Verify the ${j.ahj} permit profile against the AHJ's own site and mark it verified; until then it is seeded research.`
        : `Research the ${j.ahj} permit portal into the knowledge base before filing there.`,
      label,
    );
    check(
      recipe ? "ok" : draft ? "warn" : "warn",
      "  permit recipe",
      recipe
        ? `complete (v${recipe.version}, ${recipe.steps.length} steps, auto-submit ${recipe.autoSubmitEnabled ? "TRUSTED" : "off"})`
        : draft
          ? `draft only (status "${draft.status}", ${draft.steps.length} steps) — replays are not trustworthy yet`
          : "none — the first filing will try to learn this portal from scratch",
      recipe ? "" : `Point the recorder at the ${j.ahj} portal and record a complete recipe, or accept that the first run is a learn attempt.`,
      label,
    );
    const mockRisk = !recipe && !draft && !(row && row.portalUrl);
    if (mockRisk) {
      check(
        "fail",
        "  permit portal URL",
        "no recipe and no known portal URL — Stage stops with nothing to drive, so no permit can be filed here (the mock adapter stands in only on a MOCK_PORTAL=1 rehearsal)",
        `Give ${j.ahj} a real portal URL (record a draft recipe, or set permit_utility_knowledge.portal_url), or have a person verify its filing-email address, before filing there.`,
        label,
      );
    }
  }

  // Utility side (NEM / interconnection).
  const nemChannel = blank(j.utility) ? null : filingChannel(db, spec, "nem");
  if (nemChannel?.kind === "with_permit") {
    check(
      blank(j.ahj) ? "fail" : "ok",
      "  utility files with permit",
      `"${nemChannel.name}" (verified by ${nemChannel.verifiedBy}${nemChannel.verifiedAt ? `, ${nemChannel.verifiedAt.slice(0, 10)}` : ""}) — ` +
        (blank(j.ahj) ? "but no AHJ is named, so there is no permit application for it to ride in" : `rides in the ${j.ahj} permit application; no NEM portal, recipe or login is used`),
      `Name the AHJ for this jurisdiction (--jurisdictions "STATE|AHJ|UTILITY").`,
      label,
    );
  }
  if (nemChannel && nemChannel.kind !== "with_permit" && !emailChannel(nemChannel, "utility", j.utility)) {
    const row = kb.utility;
    const recipe = findCompleteRecipeForProject(db, { scopeType: "utility", state: j.state, utility: j.utility, discipline: "" });
    const draft = recipe ? null : findAnyRecipeForProject(db, { scopeType: "utility", state: j.state, utility: j.utility, discipline: "" });
    check(
      row ? (isVerifiedKnowledge(row) ? "ok" : "warn") : "warn",
      "  utility KB row",
      row
        ? `${row.profileKey}  confidence "${row.confidence}"${isVerifiedKnowledge(row) ? " (human-verified)" : " (unverified research)"}, portal_url ${row.portalUrl ? "set" : "MISSING"}`
        : "none — no permit_utility_knowledge row resolves for this utility",
      row
        ? isVerifiedKnowledge(row)
          ? ""
          : `Verify the ${j.utility} interconnection profile with a human before relying on it.`
        : `Research the ${j.utility} interconnection portal into the knowledge base before filing there.`,
      label,
    );
    check(
      recipe ? "ok" : "warn",
      "  utility recipe",
      recipe
        ? `complete (v${recipe.version}, ${recipe.steps.length} steps, auto-submit ${recipe.autoSubmitEnabled ? "TRUSTED" : "off"})`
        : draft
          ? `draft only (status "${draft.status}", ${draft.steps.length} steps)`
          : "none — the first NEM filing will try to learn this portal from scratch",
      recipe ? "" : `Record a complete recipe for the ${j.utility} interconnection portal.`,
      label,
    );
    const mockRisk = !recipe && !draft && !(row && row.portalUrl);
    if (mockRisk) {
      check(
        "fail",
        "  utility portal URL",
        "no recipe and no known portal URL — Stage stops with nothing to drive, so no interconnection can be filed here (the mock adapter stands in only on a MOCK_PORTAL=1 rehearsal)",
        `Give ${j.utility} a real interconnection portal URL, or have a person verify its filing-email address or that it files with the permit, before filing there.`,
        label,
      );
    }
    // Credential/track safety: a NEM filing needs a utility login, and a permit track
    // must never resolve a utility portal URL or vice versa. A utility jurisdiction with
    // no credential whose host matches anything is a stall waiting to happen.
    const utilityHosts = creds.map((c) => host(c.portalUrl).toLowerCase());
    const kbHost = row && row.portalUrl ? host(row.portalUrl).toLowerCase() : "";
    if (kbHost) {
      const covered = utilityHosts.some((h) => h === kbHost || h.endsWith(`.${kbHost}`) || kbHost.endsWith(`.${h}`));
      check(
        covered ? "ok" : "warn",
        "  utility login stored",
        covered ? `a credential matches ${kbHost}` : `no stored credential matches ${kbHost} — the run will stall for human capture`,
        covered ? "" : `Store this client's ${j.utility} portal login against ${kbHost}. Credential selection matches on hostname and first path segment and refuses rather than using a neighbour's login.`,
        label,
      );
    }
  }
}

// --- Verdict ------------------------------------------------------------------------
rule("VERDICT");
const blockers = findings.filter((f) => f.level === "fail");
const gaps = findings.filter((f) => f.level === "warn");
if (blockers.length) line(`  NOT READY (${blockers.length} blocker${blockers.length === 1 ? "" : "s"}, ${gaps.length} gap${gaps.length === 1 ? "" : "s"})`);
else if (gaps.length) line(`  READY WITH GAPS (${gaps.length})`);
else line("  READY");

const steps = [...blockers, ...gaps].filter((f) => f.nextStep.trim());
if (steps.length) {
  line();
  line("  WHAT A HUMAN MUST DO NEXT");
  let n = 0;
  const seen = new Set<string>();
  for (const f of steps) {
    if (seen.has(f.nextStep)) continue;
    seen.add(f.nextStep);
    n += 1;
    line(`  ${String(n).padStart(2)}. [${f.level === "fail" ? "BLOCKER" : "gap"}] ${f.what}`);
    line(`      → ${f.nextStep}`);
  }
} else {
  line();
  line("  Nothing outstanding. Note that a portal ACCOUNT still has to be registered by a human on each");
  line("  portal's own site, and that final submit, fee payment and CAPTCHA/MFA are always a human's job.");
}
line();
line("  Reminder: nothing here is a claim that a filing will succeed. A recipe that reaches a portal's");
line("  review screen is evidence, not proof — confirm the first real filing exists on the portal itself.");

line();
db.close();
process.exitCode = blockers.length ? 1 : 0;
