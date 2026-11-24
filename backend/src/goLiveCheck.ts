// ---------------------------------------------------------------------------
// GO-LIVE CHECK (owner, 2026-11-10): which switches and settings are on, which are missing, and what
// each one means for the business, in one plain line each — on a staff dashboard view
// (GET /api/go-live) and as `npm run golive:check` (scripts/golive-check.ts), which print the same
// report.
//
// READ-ONLY. It reads the process environment, the database (SELECTs only: total_changes() is
// unchanged, pinned by goLiveCheck.test) and the file system (does the browser exist, how old is the
// newest backup). It writes nothing, sends nothing and opens no network connection.
//
// NEVER A SECRET. No value read from the environment is ever printed, secret or not: each setting
// is reported as "set" or "not set" and the line says what that MEANS. The one exception is
// PUBLIC_BASE_URL, reduced to scheme://host[:port] (clientLinkGuard.publicBaseOrigin), because "which
// address do client links use" is the point of that line. goLiveCheck.test sets every setting to a
// sentinel and fails if any sentinel reaches the JSON or the text.
//
// EVERY SETTING THE CODE READS IS ACCOUNTED FOR. goLiveCheck.test greps the server-side source
// (backend/src, portal-bot/src, shared/src; not tests or smokes) for every environment read and fails
// on a name this file does not list, either on a line below, under OTHER_SETTINGS (tuning knobs and
// paths whose default is fine) or under TEST_ONLY_SETTINGS. A new switch cannot ship unseen.
//
// TENANCY (rule 6). The environment and the files are the process's own. The database counts
// (destinations waiting on a person, client emails held back, the job queue, saved inboxes) read
// only the caller's org; `null` reads every org (superadmin and the command line), like every scoped
// list. The route is admin-gated and passes reqOrgFilter (routeScope.test).
//
// Each line's verdict reuses the predicate the code itself decides by wherever one is exported
// (finalSubmitEnvAllows, filingEmailEnvAllows, staffAlertsOn, resolveListenHost, intakeRequiresAuth,
// modelPayloadScanIsStrict, filingContactEmailSetting, publicBaseUrlProblem); elsewhere it restates
// the module's own test of the value, with that module named beside it.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { currentSchemaVersion, latestSchemaVersion } from "./db";
import { filingEmailEnvAllows, finalSubmitEnvAllows } from "../../shared/src/portalSafety";
import { CLIENT_LINK_REFUSAL_PREFIX, publicBaseOrigin, publicBaseUrlProblem } from "./clientLinkGuard";
import { DEFAULT_STAFF_ORG_ID, staffAlertChannels, staffAlertsOn } from "./staffAlertConfig";
import { DEFAULT_LISTEN_HOST, isLoopbackListenHost, resolveListenHost } from "./listenHost";
import { intakeRequiresAuth } from "./intakeAuth";
import { modelPayloadScanIsStrict } from "./modelPayloadScan";
import { filingContactEmailSetting } from "./filingContact";
import { AUTOMATIC_SNAPSHOT_RE } from "./offboxBackup";
import { backupDir } from "./statePaths";

type Env = Record<string, string | undefined>;

/** ok = ready; off = deliberately off and safe; warn = works, but something a client or the team
 *  will notice; red = a blocker for going live. */
export type GoLiveState = "ok" | "off" | "warn" | "red";
export type GoLiveArea = "filing" | "client" | "access" | "lookups" | "integrations" | "browser" | "backups" | "data" | "test";

export interface GoLiveSetting { name: string; set: boolean }
export interface GoLiveLine {
  id: string;
  area: GoLiveArea;
  label: string;
  state: GoLiveState;
  /** One plain sentence: what this means right now. Never a setting's value. */
  meaning: string;
  /** The settings this line reads, each only as set / not set. */
  settings: GoLiveSetting[];
  /** A dashboard view that resolves it ("destinations" = Destinations to confirm). */
  view?: "destinations";
}
export interface GoLiveReport {
  generatedAt: string;
  /** Where the check ran: inside the server (it can see its own job worker) or the command line. */
  source: "server" | "cli";
  /** The org the database counts are scoped to; null = every org. */
  orgId: string | null;
  ready: boolean;
  counts: Record<GoLiveState, number>;
  lines: GoLiveLine[];
  /** Every other setting the code reads, only as set / not set (defaults are fine for these). */
  other: GoLiveSetting[];
}

export const AREA_TITLES: Record<GoLiveArea, string> = {
  filing: "Filing switches",
  client: "Client links and email",
  access: "Sign-in and secrets",
  lookups: "Lookups and research",
  integrations: "Integrations",
  browser: "Browser",
  backups: "Backups",
  data: "Database and jobs",
  test: "Test-only settings",
};

const has = (env: Env, name: string): boolean => String(env[name] ?? "").trim() !== "";
const settings = (env: Env, ...names: string[]): GoLiveSetting[] => names.map((name) => ({ name, set: has(env, name) }));
const offBy = (re: RegExp) => (env: Env, name: string): boolean => re.test(String(env[name] ?? "").trim());
/** "off", "0" or "false" (any case): the common kill-switch spelling (clientNotifier, documentFetch…). */
const offWord = offBy(/^(off|0|false)$/i);
const PLACEHOLDER_KEY = "replace-with-a-long-random-secret"; // .env.example's value (preflight reads the same)

// ── the environment lines ─────────────────────────────────────────────────────────────────────────

function filingLines(env: Env, authOn: boolean): GoLiveLine[] {
  const finalSubmit = finalSubmitEnvAllows(env);
  const email = filingEmailEnvAllows(env);
  const automationOff = offWord(env, "PORTAL_AUTOMATION"); // portal-bot/src/browser.ts
  const mock = String(env.MOCK_PORTAL ?? "") === "1"; // repository.ts simulationEnabled
  return [
    {
      id: "final-submit", area: "filing", label: "Automatic portal submit",
      state: !finalSubmit ? "off" : authOn ? "ok" : "red",
      meaning: !finalSubmit
        ? "Off: automation never clicks a portal's final submit. A person submits every filing."
        : authOn
          ? "On: Approve & auto-submit may click a portal's final submit, only after a named person approves that run."
          : "On with sign-in off: anyone who can reach the server could approve a filing into a real submission. Turn sign-in on first.",
      settings: settings(env, "PORTAL_ALLOW_FINAL_SUBMIT"),
    },
    {
      id: "filing-email", area: "filing", label: "Automatic filing email",
      state: !email ? "off" : authOn ? "ok" : "red",
      meaning: !email
        ? "Off: a filing sent by email is saved as a draft for a person to send."
        : authOn
          ? "On: Approve & auto-submit may email an application to an authority's person-verified address, after a named person approves that run."
          : "On with sign-in off: anyone who can reach the server could approve a real application email. Turn sign-in on first.",
      settings: settings(env, "FILING_EMAIL_ALLOW_SEND"),
    },
    {
      id: "portal-automation", area: "filing", label: "Portal automation",
      state: automationOff ? "warn" : "ok",
      meaning: automationOff
        ? "Switched off: no portal application is staged or learned on this server."
        : "On: staging fills portal applications and stops at review for a person.",
      settings: settings(env, "PORTAL_AUTOMATION", "MAX_CONCURRENT_PORTAL_RUNS", "PORTAL_HEADLESS"),
    },
    {
      id: "mock-portal", area: "test", label: "Simulated portal",
      state: mock ? "red" : "ok",
      meaning: mock ? "On: portal runs are SIMULATED, nothing real is staged. Remove MOCK_PORTAL before going live." : "Off: portal runs are real.",
      settings: settings(env, "MOCK_PORTAL"),
    },
    {
      id: "autopilot", area: "filing", label: "Pipeline runs itself",
      state: "ok",
      meaning: [
        offBy(/^(0|false|off)$/i)(env, "AUTO_STAGE_STEPS") // autoStageSteps.ts
          ? "A new job waits for a person to run QC and the package."
          : "A new job runs QC, the document package and the reviewer gate by itself and stops before staging.",
        String(env.AUTOPILOT_AUTO_START ?? "") === "1" // autopilot.ts
          ? "Autopilot also starts staging on its own."
          : "Staging is started by a person.",
      ].join(" "),
      settings: settings(env, "AUTO_STAGE_STEPS", "AUTOPILOT_AUTO_START"),
    },
  ];
}

function clientLines(env: Env): GoLiveLine[] {
  const problem = publicBaseUrlProblem(env);
  const origin = publicBaseOrigin(env);
  const clientMailOff = offBy(/^(0|false|off)$/i)(env, "CLIENT_NOTIFICATIONS"); // clientNotifier.clientEmailsOffFor
  const allowList = String(env.CLIENT_NOTIFICATIONS_ALLOW_CLIENTS ?? "").split(/[\s,;]+/).filter(Boolean).length;
  const smtpOn = has(env, "SMTP_HOST") && has(env, "SMTP_FROM"); // clientNotifier.smtpConfigured
  const staff = staffAlertChannels(DEFAULT_STAFF_ORG_ID, env as NodeJS.ProcessEnv);
  const staffOn = staffAlertsOn(DEFAULT_STAFF_ORG_ID, env as NodeJS.ProcessEnv);
  const contactRaw = has(env, "FILING_CONTACT_EMAIL");
  const contact = filingContactEmailSetting(env as NodeJS.ProcessEnv);
  const intake = String(env.EMAIL_INTAKE_ADDRESS ?? "").trim();
  return [
    {
      id: "public-base-url", area: "client", label: "Client link address",
      state: problem ? "red" : origin.startsWith("https://") ? "ok" : "warn",
      meaning: problem
        ? `${problem}. Every client email with a link is held as a draft instead of mailing a dead link.`
        : origin.startsWith("https://")
          ? `Client links start with ${origin}.`
          : `Client links start with ${origin}, which is not https: a client would type a portal password over plain http.`,
      settings: settings(env, "PUBLIC_BASE_URL"),
    },
    {
      id: "client-email", area: "client", label: "Client emails",
      state: clientMailOff ? "warn" : "ok",
      meaning: clientMailOff
        ? `Switched off: clients get no email${allowList ? `, except the ${allowList} client(s) on the allow list` : ""}. Updates still appear on their tracking page.`
        : `On: clients are emailed status updates, request links and the handoff packet.${allowList ? " The allow list only matters while client emails are off." : ""}`,
      settings: settings(env, "CLIENT_NOTIFICATIONS", "CLIENT_NOTIFICATIONS_ALLOW_CLIENTS", "CLIENT_REQUEST_AUTO_SEND", "CLIENT_REQUEST_REMINDER_DAYS"),
    },
    {
      id: "smtp", area: "client", label: "Outgoing mail server",
      state: !smtpOn ? "warn" : has(env, "SMTP_USER") && !has(env, "SMTP_PASS") ? "warn" : "ok",
      meaning: !smtpOn
        ? "Not set up: every client email is only saved as a draft, never sent."
        : has(env, "SMTP_USER") && !has(env, "SMTP_PASS")
          ? "A sign-in name is set without a password: the mail server will refuse it."
          : "Set up: emails go out. Prove it once with scripts/ops/test-email.ts --to <you>.",
      settings: settings(env, "SMTP_HOST", "SMTP_FROM", "SMTP_FROM_NAME", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS"),
    },
    {
      id: "staff-alerts", area: "client", label: "Staff alerts",
      state: staffOn ? "ok" : "warn",
      meaning: staffOn
        ? `On: the team hears when a run stops or a job changes state (${[staff.emails.length ? `${staff.emails.length} address(es)` : "", staff.webhooks.length ? "a webhook" : ""].filter(Boolean).join(" and ")}).`
        : "No recipient the server can reach: nobody is told when a run stops.",
      settings: settings(env, "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "STAFF_ALERT_WEBHOOK_FORMAT", "STAFF_DIGEST_HOUR"),
    },
    {
      id: "filing-contact", area: "client", label: "Filing contact email",
      state: !contactRaw ? "off" : contact ? "ok" : "warn",
      meaning: !contactRaw
        ? "Not set: a form's separate applicant contact email is left as the client's."
        : contact ? "Set: agency mail about a filing also reaches the tracking inbox." : "Set, but not shaped like an email address, so it is ignored.",
      settings: settings(env, "FILING_CONTACT_EMAIL"),
    },
    {
      id: "email-intake", area: "client", label: "Jobs by email",
      state: !intake ? "off" : "ok",
      meaning: !intake
        ? "Off: jobs arrive through the dashboard and request links only."
        : `On: jobs emailed to the intake address with a client tag become projects; sender check ${intakeRequiresAuth(env as NodeJS.ProcessEnv) ? "requires a pass" : "refuses a stated fail"}.`,
      settings: settings(env, "EMAIL_INTAKE_ADDRESS", "EMAIL_INTAKE_REQUIRE_AUTH", "EMAIL_INTAKE_AUTO_REPLY", "EMAIL_INTAKE_DEDUPE_DAYS", "EMAIL_INTAKE_MAX_FILE_MB"),
    },
  ];
}

function accessLines(env: Env, authOn: boolean): GoLiveLine[] {
  const sessionKey = String(env.SESSION_ENCRYPTION_KEY ?? "");
  const authSecret = String(env.AUTH_SECRET ?? "");
  const host = String(env.SERVER_HOST ?? "").trim() || DEFAULT_LISTEN_HOST;
  const listen = resolveListenHost(env);
  const loopback = isLoopbackListenHost(host);
  const strict = modelPayloadScanIsStrict(env as NodeJS.ProcessEnv);
  return [
    {
      id: "auth", area: "access", label: "Sign-in",
      state: authOn ? "ok" : "red",
      meaning: authOn ? "On: every staff page needs a login." : "Off: anyone who can reach the port can read client data and approve filings.",
      settings: settings(env, "AUTH_ENABLED", "AUTH_SESSION_HOURS", "AUTH_COOKIE_SECURE", "ADMIN_EMAIL", "ADMIN_PASSWORD"),
    },
    {
      id: "session-key", area: "access", label: "Saved-login encryption key",
      state: !sessionKey || sessionKey === PLACEHOLDER_KEY ? "red" : sessionKey.length < 32 ? "warn" : "ok",
      meaning: !sessionKey || sessionKey === PLACEHOLDER_KEY
        ? "Missing or still the example value: saved portal logins cannot be read."
        : sessionKey.length < 32 ? "Set, but shorter than 32 characters." : "Set. It is in no backup: keep a copy in a password manager.",
      settings: settings(env, "SESSION_ENCRYPTION_KEY"),
    },
    {
      id: "auth-secret", area: "access", label: "Login cookie secret",
      state: !authSecret ? "warn" : authSecret === sessionKey ? "red" : authSecret.length < 32 ? "warn" : "ok",
      meaning: !authSecret ? "Not set: login cookies are signed with the encryption key (works, but one secret does two jobs)."
        : authSecret === sessionKey ? "The same as the encryption key: give it its own value."
          : authSecret.length < 32 ? "Set, but shorter than 32 characters." : "Set, separate from the encryption key.",
      settings: settings(env, "AUTH_SECRET"),
    },
    {
      id: "listen", area: "access", label: "Who can reach the server",
      state: loopback ? "ok" : authOn ? "warn" : "red",
      meaning: loopback
        ? "Only this machine (client links then need a tunnel or a proxy in front)."
        : authOn ? "Listening beyond this machine with sign-in on: keep it behind a firewall or a tunnel."
          : listen.ok ? "Listening beyond this machine with sign-in OFF." : "Set to listen beyond this machine with sign-in off: the server refuses to start.",
      settings: settings(env, "SERVER_HOST", "PORT", "ALLOW_UNAUTHENTICATED_NETWORK", "TRUST_PROXY", "ALLOWED_ORIGINS", "SERVER_IS_SHARED", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"),
    },
    {
      id: "model-key", area: "access", label: "AI model key",
      state: has(env, "ANTHROPIC_API_KEY") || has(env, "ANTHROPIC_AUTH_TOKEN") ? "ok" : "red",
      meaning: has(env, "ANTHROPIC_API_KEY") || has(env, "ANTHROPIC_AUTH_TOKEN")
        ? "Set: plan sets are read, portals learned and requirements researched."
        : "Not set: plan sets are not read, portals are not learned and no lookup runs.",
      settings: settings(env, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AUTOPILOT_LLM_MODEL"),
    },
    {
      id: "payload-scan", area: "access", label: "Secret scan on model requests",
      state: "ok",
      meaning: strict
        ? "Strict: a model request that tried to carry an account or meter number fails loudly (it is redacted either way)."
        : "Standard: an account or meter number in a model request is redacted and the request goes on.",
      settings: settings(env, "MODEL_PAYLOAD_SCAN_STRICT"),
    },
  ];
}

/** Background reads that each have their own off switch. `off` restates the module's own test. */
const LOOKUPS: Array<{ id: string; name: string; label: string; on: string; off: (env: Env) => boolean; needsKey: boolean; extra?: string[] }> = [
  { id: "parcel-lookup", name: "PARCEL_LOOKUP", label: "Parcel jurisdiction check", needsKey: false,
    on: "On: a permit job's address is checked against the county parcel record its source data names, in the job worker.",
    off: (env) => String(env.PARCEL_LOOKUP ?? "") === "off" }, // parcelJurisdiction.ts
  { id: "permit-process-lookup", name: "PERMIT_PROCESS_LOOKUP", label: "Permit process lookup", needsKey: true,
    on: "On: an AHJ with no process on file is looked up from its own pages.",
    off: (env) => String(env.PERMIT_PROCESS_LOOKUP ?? "") === "off", extra: ["PERMIT_PROCESS_LOOKUP_TIMEOUT_MS", "PERMIT_LOOKUP_PAGE_READ", "PERMIT_CHECK_HOST_GAP_MS"] }, // permitProcessLookup.ts
  { id: "utility-filing-lookup", name: "UTILITY_FILING_LOOKUP", label: "Utility filing lookup", needsKey: true,
    on: "On: where a utility takes its interconnection application is looked up from its own pages.",
    off: (env) => offWord(env, "UTILITY_FILING_LOOKUP"), extra: ["UTILITY_FILING_LOOKUP_TIMEOUT_MS"] }, // utilityFilingLookup.ts
  { id: "code-research", name: "CODE_RESEARCH", label: "Code cycle research", needsKey: true,
    on: "On: an AHJ's adopted code editions are researched when missing.",
    off: (env) => offBy(/^(off|0|false|no)$/i)(env, "CODE_RESEARCH") || String(env.SKIP_CODE_RESEARCH ?? "") === "1", extra: ["SKIP_CODE_RESEARCH"] }, // codeProfiles.ts
  { id: "fee-research", name: "FEE_RESEARCH", label: "Fee research", needsKey: true,
    on: "On: permit fee schedules are researched when missing.",
    off: (env) => String(env.FEE_RESEARCH ?? "") === "off", extra: ["FEE_RESEARCH_TIMEOUT_MS", "FEE_RESEARCH_BACKOFF_HOURS"] }, // feeSchedules.ts
  { id: "form-research", name: "AHJ_FORM_RESEARCH", label: "Form research", needsKey: true,
    on: "On: an AHJ's blank application forms are found and downloaded.",
    off: (env) => String(env.AHJ_FORM_RESEARCH ?? "") === "off", extra: ["AHJ_FORM_DOWNLOADS", "AHJ_FORM_REFRESH_DAYS", "AHJ_FORM_LOOKUP_TIMEOUT_MS", "AHJ_FORM_RECOVER_MAX"] }, // formAcquisitionPlan.ts
  { id: "maker-spec-sheets", name: "MAKER_SPEC_SHEETS", label: "Maker spec sheets", needsKey: true,
    on: "On: a microinverter's datasheet is fetched from its maker's own site and attached when it says the product is listed rapid-shutdown equipment.",
    off: (env) => String(env.MAKER_SPEC_SHEETS ?? "") === "off" }, // makerSpecSheets.ts
  { id: "portal-url-research", name: "PORTAL_URL_RESEARCH", label: "Portal address research", needsKey: true,
    on: "On: a missing portal address is researched (a person still confirms where a filing goes).",
    off: (env) => String(env.PORTAL_URL_RESEARCH ?? "") === "off" }, // repository.ts
  { id: "correction-agent", name: "CORRECTION_AGENT", label: "Correction drafts", needsKey: true,
    on: "On: a correction notice gets a drafted fix for a person to approve.",
    off: (env) => String(env.CORRECTION_AGENT ?? "") === "off" }, // repository.ts
  { id: "document-fetch", name: "DOCUMENT_FETCH", label: "Public document fetch", needsKey: false,
    on: "On: public documents an authority links (forms, fee sheets) are fetched, never from a private address.",
    off: (env) => offWord(env, "DOCUMENT_FETCH"), extra: ["DOCUMENT_FETCH_BROWSER"] }, // documentFetch.ts
];

function lookupLines(env: Env): GoLiveLine[] {
  const key = has(env, "ANTHROPIC_API_KEY");
  return LOOKUPS.map((l) => {
    const off = l.off(env);
    const noKey = l.needsKey && !key;
    return {
      id: l.id, area: "lookups" as const, label: l.label,
      state: off || noKey ? "off" as const : "ok" as const,
      meaning: off ? "Switched off on this server." : noKey ? "Off: it needs the AI model key." : l.on,
      settings: settings(env, l.name, ...(l.extra ?? [])),
    };
  });
}

function integrationLines(env: Env): GoLiveLine[] {
  const on = String(env.QUICKBOOKS_SYNC ?? "").trim() === "1"; // quickbooks.quickBooksSyncOn
  const creds = has(env, "QUICKBOOKS_CLIENT_ID") && has(env, "QUICKBOOKS_CLIENT_SECRET");
  const qbEnv = String(env.QUICKBOOKS_ENVIRONMENT ?? "").trim().toLowerCase();
  const where = qbEnv === "production" ? "the live QuickBooks company" : qbEnv === "sandbox" || !qbEnv ? "a QuickBooks sandbox" : "an unrecognised QuickBooks environment";
  const imap = has(env, "EMAIL_IMAP_HOST") && has(env, "EMAIL_IMAP_USER") && has(env, "EMAIL_IMAP_PASS"); // emailPoller.envImapConfig
  const gmail = has(env, "GMAIL_REFRESH_TOKEN");
  return [
    {
      id: "quickbooks", area: "integrations", label: "QuickBooks push",
      state: !on ? "off" : creds ? "ok" : "red",
      meaning: !on ? "Off: nothing is sent to or read from QuickBooks."
        : creds ? `On: invoices a person pushes go to ${where}; payment status is read daily. It never emails a client or takes a payment.`
          : "On, but the app's client id or secret is not set: every push is refused.",
      settings: settings(env, "QUICKBOOKS_SYNC", "QUICKBOOKS_ENVIRONMENT", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REDIRECT_URI", "QUICKBOOKS_AUTH_URL", "QUICKBOOKS_TOKEN_URL", "QUICKBOOKS_API_BASE"),
    },
    {
      id: "tracking-inbox-env", area: "integrations", label: "Tracking inbox settings",
      state: imap || gmail ? "ok" : "off",
      meaning: imap && gmail ? "An IMAP inbox and Gmail are set up here." : imap ? "An IMAP inbox is set up here." : gmail ? "Gmail is authorized here."
        : "No inbox in the settings (one may be saved in the database: see Database and jobs).",
      settings: settings(env, "EMAIL_IMAP_HOST", "EMAIL_IMAP_USER", "EMAIL_IMAP_PASS", "EMAIL_IMAP_PORT", "EMAIL_IMAP_TLS", "EMAIL_IMAP_MAILBOX", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_REDIRECT_URI"),
    },
  ];
}

function browserLine(env: Env, executable: string | null): GoLiveLine {
  const found = Boolean(executable && fs.existsSync(executable));
  return {
    id: "browser", area: "browser", label: "Portal browser",
    state: found ? "ok" : "red",
    meaning: found ? "Installed: staging can open a portal." : "Not found: staging cannot open a portal. Run npm run portal:install.",
    settings: settings(env, "PLAYWRIGHT_BROWSERS_PATH", "PORTAL_HEADLESS", "HTTPS_PROXY", "PORTAL_PROXY_BYPASS"),
  };
}

function backupLines(env: Env, now: number): GoLiveLine[] {
  const dir = backupDir({ env });
  const newest = (d: string): number | null => {
    try {
      const ages = fs.readdirSync(d).filter((f) => AUTOMATIC_SNAPSHOT_RE.test(f)).map((f) => fs.statSync(path.join(d, f)).mtimeMs);
      return ages.length ? (now - Math.max(...ages)) / 3_600_000 : null;
    } catch { return null; }
  };
  const interval = Number(env.BACKUP_INTERVAL_HOURS || 24); // backup.ts
  const ageH = newest(dir);
  const fresh = ageH !== null && ageH <= Math.max(interval, 1) * 1.5 + 1;
  const second = String(env.BACKUP_SECOND_DIR ?? "").trim();
  const secondAge = second ? newest(path.resolve(second)) : null;
  return [
    {
      id: "backups", area: "backups", label: "Automatic backups",
      state: fresh ? "ok" : "red",
      meaning: ageH === null ? "No automatic snapshot found in the backup folder."
        : `Newest snapshot ${ageH.toFixed(1)} h old${fresh ? "" : `, older than the ${interval} h schedule allows`}; one every ${interval > 0 ? `${interval} h` : "boot only"}.`,
      settings: settings(env, "BACKUP_DIR", "BACKUP_INTERVAL_HOURS", "BACKUP_KEEP"),
    },
    {
      id: "offbox-backups", area: "backups", label: "Off-machine copy",
      state: !second ? "red" : secondAge === null ? "warn" : "ok",
      meaning: !second ? "Not set: every backup is on this one machine."
        : secondAge === null ? "Set, but no snapshot has been copied there (or the folder is not reachable)." : `Newest off-machine copy ${secondAge.toFixed(1)} h old.`,
      settings: settings(env, "BACKUP_SECOND_DIR", "BACKUP_SECOND_KEEP"),
    },
  ];
}

function testOnlyLines(env: Env): GoLiveLine[] {
  const seams = String(env.AUTOPILOT_TEST_SEAMS ?? "") === "1";
  const seed = String(env.SEED_TEST_INSTALLER ?? "") === "true"; // db.ts
  const allowOrigins = has(env, "DOCUMENT_FETCH_ALLOW_ORIGINS");
  return [
    { id: "test-seams", area: "test", label: "Test seams",
      state: seams ? "red" : "ok",
      meaning: seams ? "On: test hooks that can replace safety checks are installable. Remove AUTOPILOT_TEST_SEAMS." : "Off.",
      settings: settings(env, "AUTOPILOT_TEST_SEAMS") },
    { id: "seed-installer", area: "test", label: "Test installer seed",
      state: seed ? "warn" : "ok",
      meaning: seed ? "On: a fresh database gains a pre-filled test installer." : "Off.",
      settings: settings(env, "SEED_TEST_INSTALLER") },
    { id: "fetch-allow-origins", area: "test", label: "Private-address fetch exceptions",
      state: allowOrigins ? "warn" : "ok",
      meaning: allowOrigins ? "Set: the listed origins are fetched even though they are private addresses (meant for tests)." : "Off: no private address is ever fetched.",
      settings: settings(env, "DOCUMENT_FETCH_ALLOW_ORIGINS") },
  ];
}

// ── the database lines ────────────────────────────────────────────────────────────────────────────

export interface GoLiveDbOptions {
  /** The server's own answer (jobQueue.jobWorkerRunning). Unset on the command line, which cannot
   *  see the server process and reads the queue instead. */
  workerRunning?: boolean;
  /** The Destinations to confirm queue's counts for an org (filingDestinationProposals.filingDestinationQueue,
   *  handed in by the caller: only server.ts, of the server-side modules, may import the proposals
   *  module — filingDestinationProposals.test). Unset: the line says it was not checked. */
  destinationCounts?: (orgId: string | null) => { authorities: number; oneClick: number; serviceArea?: number };
}

const scoped = (orgId: string | null, col = "org_id"): { clause: string; params: string[] } =>
  orgId === null ? { clause: "", params: [] } : { clause: ` AND ${col} = ?`, params: [orgId] };

async function dataLines(env: Env, db: AppDb | null, orgId: string | null, opts: GoLiveDbOptions, source: "server" | "cli", now: number): Promise<GoLiveLine[]> {
  const workersOff = String(env.BACKGROUND_WORKERS ?? "") === "off"; // server.ts, scheduler.ts
  const workerSettings = settings(env, "BACKGROUND_WORKERS", "JOB_CONCURRENCY", "JOB_WORKER_INTERVAL_MS", "JOB_MAX_RUNTIME_MS", "MAX_JOBS_PER_TICK", "MONITOR_INTERVAL_MINUTES");
  if (!db) {
    return [{ id: "database", area: "data", label: "Database", state: "red", meaning: "The database could not be opened read-only, so nothing in it was checked.", settings: settings(env, "AUTOPILOT_DB_PATH", "AUTOPILOT_STATE_DIR") }];
  }
  const out: GoLiveLine[] = [];
  const unreadable = (id: string, label: string, s: GoLiveSetting[] = []): GoLiveLine => ({ id, area: "data", label, state: "warn", meaning: "Could not be read from this database.", settings: s });

  // Schema version against the newest migration this build carries.
  const have = currentSchemaVersion(db);
  const want = latestSchemaVersion();
  out.push({
    id: "schema", area: "data", label: "Database version",
    state: have === want ? "ok" : "red",
    meaning: have === want ? `Up to date (v${have}).`
      : have < want ? `v${have}, this build expects v${want}: start the server once and it upgrades (take a backup first).`
        : `v${have}, newer than this build's v${want}: this code is older than the database. Deploy the newer build.`,
    // AUTOPILOT_ALLOW_OLDER_BUILD=1 is the boot guard's override (db.ts): shown here so a person sees it is set.
    settings: settings(env, "AUTOPILOT_DB_PATH", "AUTOPILOT_STATE_DIR", "AUTOPILOT_ALLOW_OLDER_BUILD"),
  });

  // The job worker.
  try {
    const q = scoped(orgId);
    const pending = db.get<{ n: number; oldest: string | null }>(
      `SELECT COUNT(*) AS n, MIN(COALESCE(scheduled_at, created_at)) AS oldest FROM job_queue WHERE status = 'pending' AND COALESCE(scheduled_at, created_at) <= ?${q.clause}`,
      [new Date(now).toISOString(), ...q.params],
    );
    const running = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM job_queue WHERE status = 'running'${q.clause}`, q.params)?.n ?? 0);
    const waitMin = pending?.oldest ? (now - Date.parse(pending.oldest)) / 60_000 : 0;
    const stuck = Number(pending?.n ?? 0) > 0 && waitMin > 10 && running === 0;
    let state: GoLiveState; let meaning: string;
    if (workersOff) { state = "red"; meaning = "Background work is switched off: no job runs, no portal status is checked, no inbox is read."; }
    else if (source === "server") {
      state = opts.workerRunning ? (stuck ? "warn" : "ok") : "red";
      meaning = opts.workerRunning
        ? (stuck ? `Running, but ${pending?.n} job(s) have waited over ${Math.round(waitMin)} min with nothing running.` : `Running (${running} job(s) running, ${Number(pending?.n ?? 0)} waiting).`)
        : "Not running in this server: queued work never starts.";
    } else {
      state = stuck ? "red" : "ok";
      meaning = stuck
        ? `${pending?.n} job(s) have waited over ${Math.round(waitMin)} min with nothing running: is the server running?`
        : `The queue is moving (${running} running, ${Number(pending?.n ?? 0)} waiting). This command runs outside the server; the dashboard's Go-live check shows the worker itself.`;
    }
    out.push({ id: "job-worker", area: "data", label: "Job worker", state, meaning, settings: workerSettings });
  } catch { out.push(unreadable("job-worker", "Job worker", workerSettings)); }

  // Authorities whose filing door no person has verified (the Destinations to confirm queue).
  if (!opts.destinationCounts) {
    out.push({ id: "destinations", area: "data", label: "Filing destinations to confirm", state: "warn", meaning: "Not checked by this caller.", settings: [] });
  } else {
    try {
      const c = opts.destinationCounts(orgId);
      const n = c.authorities;
      out.push({
        id: "destinations", area: "data", label: "Filing destinations to confirm",
        state: n ? "warn" : "ok",
        meaning: n
          ? `${n} authority(ies) an open job files with have no person-verified destination, so nothing files there automatically (${c.oneClick} can be confirmed in one click).${c.serviceArea ? ` ${c.serviceArea} of them are only in a client's service area, with no job yet.` : ""}`
          : "Every authority an open job or a client's service area names has a person-verified destination.",
        settings: [],
        ...(n ? { view: "destinations" as const } : {}),
      });
    } catch { out.push(unreadable("destinations", "Filing destinations to confirm")); }
  }

  // Client emails held back by the dead-link guard, and the whole unsent backlog.
  try {
    const q = scoped(orgId);
    const held = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM communications WHERE direction = 'outbound' AND channel = 'email' AND delivery_status = 'draft' AND delivery_detail LIKE ?${q.clause}`,
      [`${CLIENT_LINK_REFUSAL_PREFIX}%`, ...q.params],
    )?.n ?? 0);
    const r = db.get<{ draft: number | null; failed: number | null }>(
      `SELECT SUM(delivery_status = 'draft') AS draft, SUM(delivery_status = 'failed') AS failed FROM communications WHERE direction = 'outbound' AND channel = 'email' AND delivery_status IN ('draft','failed')${q.clause}`,
      q.params,
    );
    const draft = Number(r?.draft ?? 0); const failed = Number(r?.failed ?? 0);
    out.push({
      id: "held-links", area: "client", label: "Emails held for a dead link",
      state: held ? "red" : "ok",
      meaning: held ? `${held} client email(s) were not sent because their link could not open. Fix the client link address, then send them with scripts/undelivered.ts.` : "None.",
      settings: [],
    });
    out.push({
      id: "unsent", area: "client", label: "Unsent client emails",
      state: draft + failed ? "warn" : "ok",
      meaning: draft + failed ? `${draft} draft (never tried) and ${failed} failed. List them with scripts/undelivered.ts.` : "None: every automated email on record was sent.",
      settings: [],
    });
  } catch { out.push(unreadable("unsent", "Unsent client emails")); }

  // Saved tracking inboxes (the database side of the inbox line).
  try {
    const q = scoped(orgId);
    const n = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM email_tracking_sources WHERE source_type = 'imap' AND active = 1 AND imap_host != ''${q.clause}`, q.params)?.n ?? 0);
    const envInbox = (has(env, "EMAIL_IMAP_HOST") && has(env, "EMAIL_IMAP_USER") && has(env, "EMAIL_IMAP_PASS")) || has(env, "GMAIL_REFRESH_TOKEN");
    out.push({
      id: "tracking-inbox", area: "client", label: "Agency and utility email",
      state: n || envInbox ? "ok" : "warn",
      meaning: n || envInbox ? `Read every monitor tick (${[envInbox ? "inbox in the settings" : "", n ? `${n} saved inbox(es)` : ""].filter(Boolean).join(" + ")}).`
        : "No tracking inbox: correction, approval and utility emails are never read.",
      settings: [],
    });
  } catch { out.push(unreadable("tracking-inbox", "Agency and utility email")); }
  return out;
}

// ── every other setting ───────────────────────────────────────────────────────────────────────────

/** Settings the code reads whose default is right for going live: tuning knobs, paths and limits.
 *  Shown only as set / not set. A name here or on a line above, or in TEST_ONLY_SETTINGS — the test
 *  fails on any environment read the server-side code makes that none of them lists. */
export const OTHER_SETTINGS: readonly string[] = [
  "API_BASE", "ARTIFACT_PRUNE_INTERVAL_HOURS", "AUTOLEARN_CLICK_BUDGET_MS", "AUTOLEARN_DEBUG", "AUTOLEARN_DEBUG_SCREENSHOTS",
  "AUTOLEARN_NAV_DWELL_MS", "AUTOLEARN_NO_ACTIVE_SCOPE", "AUTOLEARN_PAGE_CAPTURE", "AUTOLEARN_PLANNER_STALL_MS", "AUTOLEARN_RUN_DEBUG", "AUTOLEARN_RUN_DIR", "AUTOLEARN_RUN_KEEP",
  "AUTOLEARN_SAVE_SETTLE_MS", "AUTOLEARN_STALL_MS", "AUTOLEARN_TRACE", "AUTOPILOT_ADVISOR_MAX_REQUESTS", "AUTOPILOT_KEEP_QUICKEDIT",
  "AUTOPILOT_LOG_FILE", "AUTOPILOT_LOG_MAX_BYTES", "AUTO_RELEARN_STALE", "AHJ_NEAR_MISS_CHECK", "AHJ_PROCESS_REFERENCE_PATH",
  "BATCH_REPORT_DIR", "BATCH_UPLOAD_DIR", "BATCH_ZIP_LIMIT", "BRAND_NAME", "BULK_DROP_MAX_JOBS", "CEC_INVERTERS_URL", "CEC_MODULES_URL",
  "CEC_SYNC_DAYS", "CODE_PROFILE_REFERENCE_PATH", "DEBUG", "DOC_UPLOAD_LIMIT", "DRAIN_MAX_MS", "ELIGIBILITY_LIMITS_REFERENCE_PATH",
  "EMAIL_IMAP_MAX_MESSAGES", "EMAIL_TRACKER_MAX_BYTES", "ENTRY_SETTLE_MS", "FEE_ACCURACY_THRESHOLD_PCT", "FEE_FLOAT_LIMIT_USD", "FEE_MATCH_BADGE",
  "FLAT_FORM_ROW_SNAP", "FRONTEND_DIR", "GMAIL_MAX_MESSAGES_PER_TICK", "HAND_CHECK_PAGES_PATH", "HEADLESS", "INVOICE_TERMS_DAYS",
  "JURISDICTION_LOOKUP_SOURCES_PATH", "JURISDICTION_PERMIT_PATHS_REFERENCE_PATH", "JURISDICTION_QC_RULES_REFERENCE_PATH",
  "KB_BACKFILL_BATCH", "KB_LINK_CHECK_DAYS", "KB_LINK_CHECK_MAX", "KB_LINK_RESEARCH_MAX", "KEEP_RUN_DIR", "LLM_MBOX_ENRICHMENT",
  "LOG_LEVEL", "MBOX_IMPORT_BASE_DIR", "MBOX_IMPORT_MAX_BYTES", "MBOX_JSON_LIMIT", "MONITOR_BOOT_DELAY_MS", "NEM_FEE_ESTIMATE_USD",
  "OUT_DIR", "OVERLAY_NUDGE_X", "OVERLAY_NUDGE_Y", "PAGE_IMAGE_CACHE_DIR", "PERMIT_FEE_ESTIMATE_MAX_USD", "PERMIT_FEE_ESTIMATE_MIN_USD",
  "PERMIT_FEE_ESTIMATE_RATE", "PERMIT_VALUATION_CONTRACT_FACTOR", "PERMIT_VALUATION_PER_WATT", "PORTAL_ACCEPT_COOKIE_BANNER",
  "PORTAL_AUTOSEED", "PORTAL_CREDENTIAL_LOCKOUT", "PORTAL_DEBUG_KEEP", "PORTAL_FEE_BROWSER_READ", "PORTAL_FEE_READ", "PORTAL_HEADED_RETRY",
  "PORTAL_IGNORE_HTTPS_ERRORS", "PORTAL_ISSUED_DOCS", "PORTAL_LOGIN_PARK", "PORTAL_POLICY_DEFAULTS", "PORTAL_PROFILES_DIR",
  "PORTAL_ACCOUNT_WAIT_MS", "PORTAL_PROFILE_WAIT_MS", "PORTAL_REPLAY_SELFTEST", "PORTAL_REPLAY_STALL_MINUTES", "PORTAL_RUN_MAX_MS", "PORTAL_SAVE_REVIEW_SCREENSHOT",
  "PORTAL_SCREENSHOT_DIR", "PORTAL_SECTION_READY_MS", "PORTAL_UPLOAD_MAX_MB", "PORTAL_VISION_PLAN", "PORTAL_VISION_RESCAN",
  "PORTAL_VISION_VERIFY", "POWERCLERK_DEBUG", "POWERCLERK_INTRO_PROBE_MS", "POWERCLERK_SECTION_READY_MS", "POWERCLERK_SETTLE_MS",
  "PROJECT_DOCS_DIR", "RECIPE_DRIFT_SETTLE_MS", "RECIPE_RECORDING_STALE_MS", "RECIPE_SELF_HEAL", "RECORDER_TOKEN", "REPLAY_CAPTURE_DIR",
  "REPLAY_CAPTURE_KEEP", "REPLAY_RUN_DIR", "REPLAY_RUN_KEEP", "REVIEW_DAILY_LIMIT", "REVIEW_SAVE_DRAIN_MS", "RUN_TRIAGE",
  "SCREENSHOT_KEEP", "SHUTDOWN_DRAIN_MS", "SOFFICE_BIN", "STAGED_REVIEW_WALK", "STATE_RULES_REFERENCE_PATH", "SUBMISSION_SERVICE_FEE_USD",
  "UTILITY_REQUIREMENTS_REFERENCE_PATH", "WAL_CHECKPOINT_MS", "WEB_RESEARCH_TIMEOUT_MS",
];

/** Read only by benchmarks, probes and smokes that share server modules. Never needed live; shown
 *  only when set. */
export const TEST_ONLY_SETTINGS: readonly string[] = [
  "BENCHMARK_CLIENT_ID", "PC_BUCKET", "PC_CREDS_FILE", "PC_PROJECT", "PC_TAG", "PC_VIEWONLY",
  "SMOKE_AHJ", "SMOKE_ARTIFACT_DIRS_QUIET", "SMOKE_STATE", "SMOKE_UTILITY",
];

// ── the report ────────────────────────────────────────────────────────────────────────────────────

export interface GoLiveOptions extends GoLiveDbOptions {
  source?: "server" | "cli";
  /** The portal browser's executable path (playwright chromium.executablePath()); null = unknown. */
  browserExecutable?: string | null;
  now?: number;
}

/** The browser path playwright would launch, or null when it cannot say. Reads only. */
export async function defaultBrowserExecutable(): Promise<string | null> {
  try {
    const { chromium } = await import("playwright");
    return chromium.executablePath() || null;
  } catch { return null; }
}

export async function goLiveReport(env: Env, db: AppDb | null, orgId: string | null, opts: GoLiveOptions = {}): Promise<GoLiveReport> {
  const now = opts.now ?? Date.now();
  const source = opts.source ?? "server";
  const authOn = String(env.AUTH_ENABLED ?? "").toLowerCase() === "true"; // exactly how auth.ts reads it
  const executable = opts.browserExecutable !== undefined ? opts.browserExecutable : await defaultBrowserExecutable();
  const lines: GoLiveLine[] = [
    ...filingLines(env, authOn),
    ...clientLines(env),
    ...accessLines(env, authOn),
    ...lookupLines(env),
    ...integrationLines(env),
    browserLine(env, executable),
    ...backupLines(env, now),
    ...(await dataLines(env, db, orgId, opts, source, now)),
    ...testOnlyLines(env),
  ];
  const onLines = new Set(lines.flatMap((l) => l.settings.map((s) => s.name)));
  const other = [...OTHER_SETTINGS, ...TEST_ONLY_SETTINGS.filter((n) => has(env, n))]
    .filter((n) => !onLines.has(n)).sort().map((name) => ({ name, set: has(env, name) }));
  const counts: Record<GoLiveState, number> = { ok: 0, off: 0, warn: 0, red: 0 };
  for (const l of lines) counts[l.state]++;
  return { generatedAt: new Date(now).toISOString(), source, orgId, ready: counts.red === 0, counts, lines, other };
}

/** Every setting name the report knows, on a line or in the lists above. */
export function goLiveKnownSettings(): Set<string> {
  // Every line's settings are fixed names; build them once from an empty environment.
  const names = new Set<string>([...OTHER_SETTINGS, ...TEST_ONLY_SETTINGS, "ANTHROPIC_AUTH_TOKEN"]);
  const env: Env = {};
  for (const l of [...filingLines(env, false), ...clientLines(env), ...accessLines(env, false), ...lookupLines(env), ...integrationLines(env),
    browserLine(env, null), ...backupLines(env, 0), ...testOnlyLines(env)]) for (const s of l.settings) names.add(s.name);
  for (const n of ["BACKGROUND_WORKERS", "JOB_CONCURRENCY", "JOB_WORKER_INTERVAL_MS", "JOB_MAX_RUNTIME_MS", "MAX_JOBS_PER_TICK", "MONITOR_INTERVAL_MINUTES", "AUTOPILOT_DB_PATH", "AUTOPILOT_STATE_DIR", "AUTOPILOT_ALLOW_OLDER_BUILD"]) names.add(n);
  return names;
}

const MARK: Record<GoLiveState, string> = { ok: "ok  ", off: "off ", warn: "WARN", red: "RED " };

/** The command line's rendering of the same report. */
export function renderGoLiveText(r: GoLiveReport): string {
  const out: string[] = [];
  out.push(`Go-live check   ${r.generatedAt}   (read-only; ${r.orgId === null ? "every org" : `org ${r.orgId}`})`);
  for (const area of Object.keys(AREA_TITLES) as GoLiveArea[]) {
    const ls = r.lines.filter((l) => l.area === area);
    if (!ls.length) continue;
    out.push("", `  ${AREA_TITLES[area].toUpperCase()}`);
    for (const l of ls) {
      out.push(`    ${MARK[l.state]}  ${l.label.padEnd(32)} ${l.meaning}`);
      if (l.settings.length) out.push(`          ${"".padEnd(32)} ${l.settings.map((s) => `${s.name}: ${s.set ? "set" : "not set"}`).join(", ")}`);
      if (l.view === "destinations") out.push(`          ${"".padEnd(32)} Open the dashboard, then Destinations to confirm.`);
    }
  }
  const setOther = r.other.filter((s) => s.set);
  out.push("", `  OTHER SETTINGS (defaults are fine; ${setOther.length} of ${r.other.length} set)`);
  if (setOther.length) out.push(`    set: ${setOther.map((s) => s.name).join(", ")}`);
  out.push("", `GO-LIVE: ${r.ready ? "no red line" : `${r.counts.red} red`}, ${r.counts.warn} warn, ${r.counts.off} off, ${r.counts.ok} ok`);
  return out.join("\n");
}
