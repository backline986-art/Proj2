/**
 * Portal recipe recorder — TEACH THE BOT A NEW AHJ OR UTILITY PORTAL BY DEMONSTRATION.
 *
 * Runs on the operator's machine (needs a browser + reachable portal + the running app).
 * It opens a headed browser, you log in and complete the application UP TO — but NOT
 * including — the final submit, and it captures each interaction (clicks, field fills,
 * dropdowns, checkboxes, file uploads) as a portable recipe. Values you type that match
 * the recording project's data are auto-bound to that field, so the recipe replays each
 * FUTURE project's own data. When you finish, type "save" and it stores the recipe; the
 * bot will then replay it for that AHJ/utility (always stopping at review — never submits).
 *
 * Usage:
 *   npm run portal:record -- \
 *     --scope ahj --ahj "City of Bend" --state OR \
 *     --url "https://aca-oregon.accela.com/oregon/" \
 *     --project <projectId> --profile ./.portal-profiles/accela \
 *     [--api http://localhost:4173] [--platform Accela]
 *
 * Recording to a SHARED SERVER with sign-in on (#433): make a recorder token in the dashboard
 * (Team, Recorder tokens) and put it in the RECORDER_TOKEN environment variable (or --token, which
 * your shell history keeps — the variable is better). When the server sits behind Cloudflare
 * Access, also set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (a service token your admin
 * gives you; or --cf-access-client-id / --cf-access-client-secret). With sign-in off none of these
 * are needed and nothing changes.
 *
 * Delete / re-record from the dashboard (Portal Recipes admin) if one wasn't completed.
 */
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import type { RecipeSelector, RecipeStep, StepFingerprint } from "../../shared/src/types";
import {
  capturedFieldIsSecret,
  classifyRecordedClick,
  PORTAL_SAFETY_IN_PAGE_SOURCE,
  recordingHasFormData,
  type FieldIdentity,
} from "../../shared/src/portalSafety";
import { openPortal } from "./browser";
import { tagUploadControls, UPLOAD_LABEL_PATTERNS } from "./adapters/autoLearnAdapter";

/** WHICH OF THE JOB'S DOCUMENTS A RECORDED UPLOAD SLOT TAKES, read off the slot's own label with the
 *  learner's table (autoLearnAdapter UPLOAD_LABEL_PATTERNS), so a hand recording names its documents
 *  the way a learned recipe does. "" when the label names none: the person is asked at save. An upload
 *  saved with no document type is skipped at replay, and the portal then refuses to go on. */
export function guessUploadDocType(label: string | undefined): string {
  const l = String(label ?? "").trim();
  if (!l) return "";
  return UPLOAD_LABEL_PATTERNS.find(({ re }) => re.test(l))?.docType ?? "";
}

/** The document types a person can pick for an upload slot (the learner's table, in its order). */
export const UPLOAD_DOC_TYPE_CHOICES: string[] = [...new Set(["plan_set", ...UPLOAD_LABEL_PATTERNS.map((p) => p.docType)])];

/** What the in-page capture reports for one interaction. Attribute names and labels only,
 *  except `value`, which crosses this in-memory binding so it can be bound to a field key. */
export interface RecordedPayload {
  kind: string;
  selector: RecipeSelector;
  value?: string;
  rawValue?: string;
  sensitive?: boolean;
  isFile?: boolean;
  viaFileChooser?: boolean;
  label?: string;
  fingerprint?: StepFingerprint;
  identity?: FieldIdentity;
  readOnlyPage?: boolean;
  /** For a click: the page named itself the review step (see reviewPageInPage). */
  reviewPage?: boolean;
  /** The page could not run the shared labeler: the click's label is UNKNOWN, so it is blocked. */
  safetyUnavailable?: boolean;
  /** kind "clickCandidate" / "clickChanged" / "clickSettled" (#280): a click on something that is not
   *  a control is held under this id until the page is seen to change (armRecorder). */
  candidateId?: string;
  /** For an upload: the slot's name as the page shows it (the learner's slot reader, painted text only). */
  slot?: string;
  /** For an upload: the chosen file's name and size. They cross this in-memory binding only, to be
   *  matched against the job's own documents; neither is stored in a step or printed. */
  fileName?: string;
  fileSize?: number;
}

/** Is the recording's last step the blocked FINAL-SUBMIT marker (targetless, flagged)? The click that
 *  follows it is the portal's own confirmation of that submit ("Yes", "Confirm", or its "Cancel"): it
 *  belongs to the submit the recorder blocked, and is never a step. */
export function followsBlockedFinalSubmit(steps: ReadonlyArray<RecipeStep>): boolean {
  const last = steps[steps.length - 1];
  return !!last && last.action === "click" && last.isFinalSubmit === true && !(last.selector && Object.keys(last.selector).length);
}

/** WHICH OF THE JOB'S DOCUMENTS THE PERSON CHOSE, by file name AND size (no contents are read). ""
 *  when none matches, when the match has no type, or when two matches disagree on the type: an
 *  unknown is asked about, never guessed. */
export function matchJobDocument(documents: ReadonlyArray<JobDocument>, fileName: string | undefined, fileSize: number | undefined): string {
  const base = (s: unknown): string => String(s ?? "").split(/[\\/]/).pop()!.trim().toLowerCase();
  const want = base(fileName);
  if (!want || typeof fileSize !== "number" || !Number.isFinite(fileSize)) return "";
  const types = new Set(documents
    .filter((d) => base(d.originalFilename) === want && Number(d.sizeBytes) === fileSize)
    .map((d) => String(d.docType ?? "").trim()));
  return types.size === 1 ? [...types][0] : "";
}

/** Has the recording entered real form data yet? The shared predicate (humanCapture asks the
 *  same one) — re-exported here for the callers that imported it from the recorder. */
export { recordingHasFormData };

/**
 * Map one captured interaction onto a recipe step and append it. Every safety decision comes
 * from shared/src/portalSafety.ts:
 *   - a click is classified by classifyRecordedClick with the page's read-only state and whether
 *     this recording has entered data yet. A submit/pay-worded click becomes a TARGETLESS optional
 *     placeholder (never replayable, but the recipe shows where it happened); only THE filing
 *     click is flagged isFinalSubmit.
 *   - a fill OR a select is secret when capturedFieldIsSecret says so (the payload's flag, its
 *     identity, or its label): the step is kept, the literal and the option text are not.
 *   - a click whose page could not run the shared labeler (safetyUnavailable) is blocked.
 */
export function createRecorderSink(
  steps: RecipeStep[],
  bindField: (typed: string) => string | undefined,
  opts: {
    /** The recording starts at the portal's front door (the CLI opened --url itself), so an
     *  empty recording KNOWS nothing was entered. false = it may start mid-flow (a resumed
     *  draft): until this recording enters data, formDataEntered stays UNKNOWN, never false. */
    startsFresh?: boolean;
    /** The document type of the job's own document with this file name and size, "" when it is not
     *  one of them (matchJobDocument). Node-side only: nothing the page sends can name a type. */
    docTypeForFile?: (fileName: string | undefined, fileSize: number | undefined) => string;
  } = {},
): (payload: RecordedPayload) => void {
  // UNKNOWN BY DEFAULT, like createHumanCaptureSink: only a caller that KNOWS it opened the
  // portal at its front door says so. Defaulting to fresh failed open — with no opts, a read-only
  // page's "Continue Application" with nothing entered was captured as replayable navigation
  // (recorder skeptic probe G-f).
  const startsFresh = opts.startsFresh === true;
  return (payload: RecordedPayload): void => {
    const sel = payload.selector;
    // Heal tie-break metadata (attribute names only) — attached to form-control steps.
    const fp = payload.fingerprint ? { fingerprint: payload.fingerprint } : {};
    if (payload.kind === "click") {
      // THE CLICK RIGHT AFTER THE BLOCKED FINAL SUBMIT IS THAT SUBMIT'S OWN CONFIRMATION (#280): the
      // portal's "Yes" / "Confirm" (or its "Cancel") on the dialog the submit opened. It is not a
      // step of any kind: recorded as a click it replayed after the review stop's marker and broke
      // the one valid closing shape; recorded as a second marker it took the first one's place.
      // Decided on the recording's SHAPE (the previous step is the flagged marker), never on the
      // confirmation's wording. The marker itself is untouched; the next form entry ends this.
      if (followsBlockedFinalSubmit(steps)) return;
      const ctx = {
        readOnlyPage: payload.readOnlyPage,
        reviewPage: payload.reviewPage,
        // The recorder opens the portal itself and sees every step from the first page, so an
        // empty recording is KNOWN to have entered nothing (the entry disclaimer's advance is a
        // pass-through). A review page still files: reviewPage outranks this.
        formDataEntered: recordingHasFormData(steps) ? true : startsFresh ? false : undefined,
      };
      // A page that could not run the shared labeler reports an UNKNOWN label: blocked, never
      // a replayable click (an empty label reads as "not submit" to every classifier).
      let cls = payload.safetyUnavailable ? "blocked" : classifyRecordedClick(payload.label, ctx);
      // The words on the control's FACE, when the capture kept them apart from its accessible name
      // (selector.shownText), are asked the same question: the stricter answer wins.
      const face = String((sel as RecipeSelector | undefined)?.shownText ?? "").trim();
      if (face && cls !== "finalSubmit" && !payload.safetyUnavailable) {
        const faceCls = classifyRecordedClick(face, ctx);
        if (faceCls !== "capture") cls = faceCls;
      }
      if (cls === "capture") {
        steps.push({ action: "click", selector: sel, note: payload.label });
        return;
      }
      // A submit/pay-worded control the operator clicked. NEVER replayable: no selector,
      // optional, so replay skips it — but the recipe keeps a visible placeholder instead of
      // a silent hole. Only the filing click itself carries isFinalSubmit (and
      // finalizeRecordedSteps keeps that flag only in the one valid terminal position).
      steps.push({
        action: "click",
        selector: {},
        optional: true,
        ...(cls === "finalSubmit" ? { isFinalSubmit: true } : {}),
        note: `BLOCKED — human clicked a submit/pay-like control ("${payload.label ?? ""}") here; not replayable. Re-record as a nav step if it was mid-flow navigation.`,
      });
    } else if ((payload.kind === "fill" || payload.kind === "select") && capturedFieldIsSecret(payload)) {
      // Credential/secret field — never persist the typed value. The value crosses
      // ONLY this in-memory binding so it can be matched to a project field key
      // (account/meter numbers live in project data); on a match the step binds by
      // NAME and replay substitutes each project's own value. No match → the step
      // is recorded valueless (optional) and skipped at replay.
      // A secret <select> is the same: the chosen option (label or raw value) may bind, and
      // neither ever reaches the step — no value, and no option text in the note.
      const field = bindField(payload.value || "") || (payload.kind === "select" ? bindField(payload.rawValue || "") : undefined);
      // A SENSITIVE STEP KEEPS NO NUMBER-SHAPED TEXT in the parts that are stored. A label[for]
      // that wraps a read-only span showing the STORED account number ("Account Number
      // <span>5550001111</span>") made that number part of the field's accessible name, so it
      // reached selector.name and the note (checker close-mustfix, bypass-label.log
      // for-wraps-span). Digit runs of six or more are removed from the human-text parts (name,
      // label, text, placeholder, note, fingerprint text); attribute keys (css, id, name) stay,
      // because they are the replay's matching key and a customer's value is not an id.
      const strip = (s: unknown): string => String(s ?? "").replace(/\d(?:[\s.\-/]?\d){5,}/g, " ").replace(/\s+/g, " ").trim();
      const kept = { ...(sel as Record<string, unknown>) } as RecipeSelector & Record<string, unknown>;
      for (const k of ["name", "label", "text", "placeholder"]) if (typeof kept[k] === "string") kept[k] = strip(kept[k]);
      const fpKept = payload.fingerprint
        ? { fingerprint: Object.fromEntries(Object.entries(payload.fingerprint).map(([k, v]) => [k, typeof v === "string" && k !== "id" && k !== "name" ? strip(v) : v])) as StepFingerprint }
        : {};
      steps.push({ action: payload.kind === "select" ? "select" : "fill", selector: kept, ...fpKept, field, sensitive: true, optional: true, note: `SENSITIVE — ${field ? `bound to project field "${field}"` : "bind to credential/redacted field"} (no value stored). ${strip(payload.label)}`.trim() });
    } else if (payload.kind === "fill") {
      const field = bindField(payload.value || "");
      steps.push(field ? { action: "fill", selector: sel, ...fp, field, note: payload.label } : { action: "fill", selector: sel, ...fp, value: payload.value, note: payload.label });
    } else if (payload.kind === "select") {
      // payload.value is the selected option's LABEL (replay's selectWithFallback
      // matches label first); rawValue is the option's value attribute, kept in the
      // note for debugging. Try binding on either — project data may hold one or the other.
      const field = bindField(payload.value || "") || bindField(payload.rawValue || "");
      const note = [payload.label, payload.rawValue && payload.rawValue !== payload.value ? `(option value: ${payload.rawValue})` : ""].filter(Boolean).join(" ");
      steps.push(field ? { action: "select", selector: sel, ...fp, field, note } : { action: "select", selector: sel, ...fp, value: payload.value, note });
    } else if (payload.kind === "check") {
      steps.push({ action: "check", selector: sel, ...fp, note: payload.label });
    } else if (payload.kind === "uncheck") {
      steps.push({ action: "uncheck", selector: sel, ...fp, note: payload.label });
    } else if (payload.kind === "upload") {
      // THE SLOT NAMES ITSELF AND THE FILE NAMES ITS DOCUMENT (#280). `slot` is the name the page
      // shows for this file input (its own field: the note and the selector keep their old form).
      // The document type is the job's own document the person chose (file name and size), else what
      // the slot's label or name says with the learner's table; "" is asked about at save.
      const slot = String(payload.slot ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const docType = String(opts.docTypeForFile?.(payload.fileName, payload.fileSize) ?? "").trim()
        || guessUploadDocType(payload.label) || guessUploadDocType(slot);
      steps.push({ action: "upload", selector: sel, docType, ...(slot ? { slot } : {}), ...(payload.viaFileChooser ? { viaFileChooser: true } : {}),
        note: docType ? `upload ${docType}: ${payload.label ?? ""}` : `UPLOAD — set docType (e.g. sld, site_plan) in the dashboard. ${payload.label ?? ""}` });
    }
  };
}

/**
 * Close a recording into the one valid recipe shape (shared validateRecipeShape): replay always
 * stops at a stopForReview marker, and an isFinalSubmit step may exist only as the single LAST
 * step, immediately after that marker. If the operator's last action was the filing click, it is
 * kept there as the (targetless) terminal flagged step; every other flag is dropped — a flagged
 * step mid-recipe is exactly the three-flagged shape the gate must refuse.
 */
export function finalizeRecordedSteps(steps: ReadonlyArray<RecipeStep>): RecipeStep[] {
  const review: RecipeStep = { action: "stopForReview", phase: "review", note: "Stop at review — human submits manually." };
  const last = steps[steps.length - 1];
  const terminal = last && last.isFinalSubmit === true ? last : null;
  const body = (terminal ? steps.slice(0, -1) : steps.slice()).map((s) => {
    if (s.isFinalSubmit !== true) return s;
    const { isFinalSubmit: _drop, ...rest } = s;
    return rest as RecipeStep;
  });
  return terminal ? [...body, review, terminal] : [...body, review];
}

/** One of the recording job's own documents, as GET /api/projects/:id/documents lists it. */
export interface JobDocument {
  docType: string;
  originalFilename: string;
  sizeBytes: number;
}

/** The job's documents (type, file name, size only: no contents). Any failure is an empty list. */
export async function fetchJobDocuments(api: string, projectId: string, headers: Record<string, string>): Promise<JobDocument[]> {
  try {
    const res = await fetch(`${api}/api/projects/${encodeURIComponent(projectId)}/documents`, { headers });
    if (!res.ok) return [];
    const body = await res.json() as { documents?: unknown };
    if (!Array.isArray(body.documents)) return [];
    return body.documents
      .map((d) => d as Partial<JobDocument>)
      .filter((d) => d && typeof d.originalFilename === "string" && typeof d.docType === "string" && Number.isFinite(Number(d.sizeBytes)))
      .map((d) => ({ docType: String(d.docType), originalFilename: String(d.originalFilename), sizeBytes: Number(d.sizeBytes) }));
  } catch {
    return [];
  }
}

/** How long after a click on a non-control a NEW DOCUMENT still counts as that click's doing. The
 *  page itself ends the wait sooner: the person's next key or pointer press settles the click. */
const CLICK_NAVIGATION_WINDOW_MS = 30_000;

export interface RecorderSessionOptions {
  bindField: (typed: string) => string | undefined;
  startsFresh?: boolean;
  /** Where the "captured ..." lines go (the CLI: stdout). */
  log?: (line: string) => void;
  jobDocuments?: ReadonlyArray<JobDocument>;
}

export interface RecorderSession {
  steps: RecipeStep[];
  /** The person typed save: nothing after this is captured or printed. */
  stop(): void;
}

/** Arm one page with the recorder: the step binding, the shared safety predicates and the in-page
 *  capture, on this document and every later one. The CLI and the DOM smoke both go through here. */
export async function armRecorder(page: Page, opts: RecorderSessionOptions): Promise<RecorderSession> {
  const steps: RecipeStep[] = [];
  const log = opts.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const documents = opts.jobDocuments ?? [];
  const sink = createRecorderSink(steps, opts.bindField, {
    startsFresh: opts.startsFresh,
    docTypeForFile: (name, size) => matchJobDocument(documents, name, size),
  });
  // CAPTURE ENDS AT "save" (#280): after stop() nothing is recorded and nothing is printed. Decided
  // here in Node, so it holds for every page and frame whatever the page does.
  let stopped = false;
  const record = (payload: RecordedPayload): void => {
    const before = steps.length;
    const afterBlockedSubmit = payload.kind === "click" && followsBlockedFinalSubmit(steps);
    sink(payload);
    if (steps.length > before) {
      const s = steps[steps.length - 1];
      log(`  · captured ${payload.kind}${s.isFinalSubmit ? " (FINAL SUBMIT — blocked, flagged)" : !s.selector || !Object.keys(s.selector).length ? " (blocked, not replayable)" : ""}${s.field ? ` → field ${s.field}` : ""}`);
    } else if (afterBlockedSubmit) {
      log("  · not recorded: that click answers the final submit blocked just before it");
    }
  };
  // A CLICK ON SOMETHING THAT IS NOT A CONTROL (a card, a list row, a plain block with a handler) is
  // a step only when the page CHANGES because of it (#280). The page reports it at once as a
  // candidate and it waits here, in its place, until one of:
  //   - the page says its view changed (a route change, a new view rendered): recorded;
  //   - its frame, or the main frame, navigates (a new document: the old page cannot report), or a
  //     new tab opens: recorded;
  //   - anything else is captured first, or the page says the person moved on: dropped. A click that
  //     only wrote a field (a toggle, a picker) arrives as that field's own step and drops it, so
  //     replay never does one thing twice.
  let pending: { id: string; payload: RecordedPayload; frame: unknown; at: number } | null = null;
  const confirmPending = (): void => {
    if (!pending || stopped) return;
    const held = pending;
    pending = null;
    if (Date.now() - held.at > CLICK_NAVIGATION_WINDOW_MS) return;
    record({ ...held.payload, kind: "click" });
  };
  await page.exposeBinding("__recordStep", (src: { frame?: unknown } | undefined, payload: RecordedPayload) => {
    if (stopped || !payload || typeof payload !== "object") return;
    if (payload.kind === "clickCandidate") {
      pending = { id: String(payload.candidateId ?? ""), payload, frame: src?.frame, at: Date.now() };
      return;
    }
    if (payload.kind === "clickChanged") {
      if (pending && pending.id === String(payload.candidateId ?? "")) confirmPending();
      return;
    }
    if (payload.kind === "clickSettled") {
      if (pending && pending.id === String(payload.candidateId ?? "")) pending = null;
      return;
    }
    pending = null;
    record(payload);
  });
  page.on("framenavigated", (frame) => {
    if (pending && (frame === pending.frame || frame === page.mainFrame())) confirmPending();
  });
  page.on("popup", () => confirmPending());
  // Inject the shared safety predicates, the learner's upload-slot reader (the one that names a slot
  // by its label, its heading or its requirement row), then the capture listeners, into every
  // page/frame. The safety source carries the __name shim the two serialized functions need.
  await page.addInitScript({ content: PORTAL_SAFETY_IN_PAGE_SOURCE });
  await page.addInitScript({ content: `window.__recorderUploadSlots = ${tagUploadControls.toString()};` });
  await page.addInitScript(captureScript);
  return {
    steps,
    stop: () => {
      stopped = true;
      pending = null;
      // Best effort, so the pages stop reporting at all; the gate above is what guarantees it.
      for (const frame of page.frames()) void frame.evaluate("window.__recordStopped = true").catch(() => null);
      void page.addInitScript({ content: "window.__recordStopped = true;" }).catch(() => null);
    },
  };
}

function argFrom(argv: readonly string[], name: string, fallback = ""): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : fallback;
}

function arg(name: string, fallback = ""): string {
  return argFrom(process.argv, name, fallback);
}

/** How the recorder authenticates to the server (#433). Every field may be empty (sign-in off). */
export interface RecorderServerAuth {
  /** The person's recorder token, minted in the dashboard. Sent as x-recorder-token. */
  token: string;
  /** A Cloudflare Access service token, when the server sits behind Access. */
  cfAccessClientId: string;
  cfAccessClientSecret: string;
}

/** Flags win over the environment; the environment is the recommended place (no shell history). */
export function readRecorderServerAuth(argv: readonly string[], env: Record<string, string | undefined>): RecorderServerAuth {
  return {
    token: argFrom(argv, "token", env.RECORDER_TOKEN || "").trim(),
    cfAccessClientId: argFrom(argv, "cf-access-client-id", env.CF_ACCESS_CLIENT_ID || "").trim(),
    cfAccessClientSecret: argFrom(argv, "cf-access-client-secret", env.CF_ACCESS_CLIENT_SECRET || "").trim(),
  };
}

/**
 * The headers every call to the server carries. Nothing is added for an empty field, so with
 * sign-in off (no token) the requests are exactly what they were before #433. The Access pair is
 * sent only as a pair: half of one is refused by Cloudflare anyway, and sending it would only
 * leak the half that was set.
 */
export function recorderRequestHeaders(auth: RecorderServerAuth, opts: { json?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.json) headers["content-type"] = "application/json";
  if (auth.token) headers["x-recorder-token"] = auth.token;
  if (auth.cfAccessClientId && auth.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = auth.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = auth.cfAccessClientSecret;
  }
  return headers;
}

/** True when a token would cross the network in plain text (http:// to a host that is not this machine). */
export function tokenWouldTravelInPlainText(api: string, auth: RecorderServerAuth): boolean {
  if (!auth.token && !auth.cfAccessClientSecret) return false;
  try {
    const u = new URL(api);
    if (u.protocol !== "http:") return false;
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return !(host === "localhost" || host === "::1" || /^127\./.test(host));
  } catch {
    return false;
  }
}

/** What to tell the person when the server refuses the recorder (401/403), naming the fix. */
export function explainServerRefusal(status: number, auth: RecorderServerAuth): string {
  if (status === 401) {
    return auth.token
      ? "The server refused your recorder token (unknown, revoked or expired, or your login is switched off). Make a new one in the dashboard (Team, Recorder tokens) and set RECORDER_TOKEN to it."
      : "The server has sign-in on. Make a recorder token in the dashboard (Team, Recorder tokens) and set the RECORDER_TOKEN environment variable to it, then run this again.";
  }
  if (status === 403 && !(auth.cfAccessClientId && auth.cfAccessClientSecret)) {
    return "The server refused the request. If it sits behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (ask your admin for the service token).";
  }
  return "";
}

async function main(): Promise<void> {
  const scope = arg("scope", "ahj") === "utility" ? "utility" : "ahj";
  const ahj = arg("ahj");
  const utility = arg("utility");
  const state = arg("state");
  const url = arg("url");
  const platform = arg("platform");
  // Which of the AHJ's permits this recording is for (structural | electrical | combo): the recipe is
  // keyed on it, so that permit's stage replays THIS recording rather than an older learned one.
  const discipline = scope === "ahj" ? arg("discipline") : "";
  const projectId = arg("project");
  const profileDir = arg("profile", "./.portal-profiles/recorder");
  const api = arg("api", process.env.API_BASE || "http://localhost:4173");
  if (scope === "ahj" && !ahj) throw new Error("--ahj is required for an AHJ recipe.");
  if (scope === "utility" && !utility) throw new Error("--utility is required for a utility recipe.");
  // Recorder token + optional Cloudflare Access service token (#433). All empty with sign-in off.
  const auth = readRecorderServerAuth(process.argv, process.env);
  if (tokenWouldTravelInPlainText(api, auth)) {
    console.warn(`WARNING: ${api} is plain http://, so your token crosses the network unencrypted. Use the server's https:// address.`);
  }
  const refused = async (what: string, res: Response): Promise<Error> => {
    const hint = explainServerRefusal(res.status, auth);
    return new Error(`${what}: ${res.status} ${await res.text()}${hint ? `\n${hint}` : ""}`);
  };

  // 1) Start (or reset) the recording row + fetch the recording project's field values
  //    so we can auto-bind typed values to their field key.
  const startRes = await fetch(`${api}/api/portal-recipes/record`, {
    method: "POST",
    headers: recorderRequestHeaders(auth, { json: true }),
    body: JSON.stringify({ scopeType: scope, ahj, utility, state, portalPlatform: platform, portalUrl: url, ...(discipline ? { discipline } : {}) }),
  });
  if (!startRes.ok) throw await refused("Failed to start recording", startRes);
  const recipe = await startRes.json();

  let fieldValues: Record<string, string> = {};
  if (projectId) {
    const fvRes = await fetch(`${api}/api/projects/${projectId}/staging-field-values`, { headers: recorderRequestHeaders(auth) });
    if (fvRes.ok) fieldValues = (await fvRes.json()).fieldValues ?? {};
  }
  // Reverse map: normalized value -> field key (longest values first to avoid collisions).
  const valueToField = new Map<string, string>();
  for (const [field, value] of Object.entries(fieldValues)) {
    const v = String(value || "").trim().toLowerCase();
    if (v.length >= 3 && !valueToField.has(v)) valueToField.set(v, field);
  }
  const bindField = (typed: string): string | undefined => valueToField.get(String(typed || "").trim().toLowerCase());

  // The job's own documents (type, file name, size): an upload of one of them names its own type.
  const jobDocuments = projectId ? await fetchJobDocuments(api, projectId, recorderRequestHeaders(auth)) : [];

  // 2) Open the browser with a persistent profile (login persists across runs).
  const { page } = await openPortal({ userDataDir: profileDir, headless: false });

  // Fresh only when this CLI opens the portal itself; without --url the operator's persistent
  // profile may resume a draft mid-flow.
  const session = await armRecorder(page, { bindField, startsFresh: !!url, jobDocuments });
  const steps = session.steps;
  if (url) await page.goto(url);

  console.log(`\nRecording "${ahj || utility}" (${platform || "portal"}).`);
  console.log("→ Log in and complete the application UP TO the final review/submit screen.");
  console.log("→ Do NOT click the final Submit/Pay. When done, come back here and type: save\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      if (line.trim().toLowerCase() === "save") { session.stop(); resolve(); }
    });
  });
  rl.close();

  // Terminal review marker so replay always stops before submit — in the one valid shape.
  const closed = finalizeRecordedSteps(steps);
  // EVERY UPLOAD NAMES ITS DOCUMENT BEFORE THE RECIPE IS SAVED. A slot whose label named none is asked
  // about here (an interactive terminal); Enter leaves it for the dashboard, and the save says so.
  await askUploadDocTypes(closed);

  // LLM-assisted binding: for fill/select steps without an exact-match field key, ask the
  // model to identify which project/client field each typed value corresponds to.
  // This is a single call at save-time (not per keystroke), so LLM latency is fine.
  let finalSteps = closed;
  if (projectId) {
    const unboundCount = closed.filter((s) => (s.action === "fill" || s.action === "select") && !s.field && s.value).length;
    if (unboundCount > 0) {
      process.stdout.write(`  · ${unboundCount} unbound step(s) — asking the model to suggest field mappings…\n`);
      try {
        const suggestRes = await fetch(`${api}/api/portal-recipes/${recipe.id}/suggest-bindings`, {
          method: "POST",
          headers: recorderRequestHeaders(auth, { json: true }),
          body: JSON.stringify({ steps: closed, projectId }),
        });
        if (suggestRes.ok) {
          const body = await suggestRes.json();
          finalSteps = Array.isArray(body.steps) ? body.steps : closed;
          const applied = body.suggestionsApplied ?? 0;
          if (applied > 0) process.stdout.write(`  · LLM bound ${applied} additional field(s) automatically.\n`);
          if (body.warning) process.stdout.write(`  · ${body.warning}\n`);
        }
      } catch (err) {
        process.stdout.write(`  · LLM field-binding skipped (${err instanceof Error ? err.message : String(err)}); steps saved as-is.\n`);
      }
    }
  }

  const saveRes = await fetch(`${api}/api/portal-recipes/${recipe.id}/steps`, {
    method: "PUT",
    headers: recorderRequestHeaders(auth, { json: true }),
    // recordedOnProjectId: the job this was recorded on, so a choice naming a permit path
    // ("Prescriptive") is stamped with that job's path and replays only on jobs of the same path.
    body: JSON.stringify({ steps: finalSteps, status: "complete", ...(projectId ? { recordedOnProjectId: projectId } : {}) }),
  });
  if (!saveRes.ok) throw await refused("Failed to save recipe", saveRes);
  const boundCount = finalSteps.filter((s: RecipeStep) => s.field).length;
  const untyped = finalSteps.filter((s: RecipeStep) => s.action === "upload" && !s.docType).length;
  console.log(`\nSaved ${finalSteps.length} step(s) to recipe ${recipe.id} (${boundCount} data-bound).`
    + (untyped ? ` ${untyped} upload(s) still have NO document type: set them under Portal recipes, steps, "doc type", or those uploads are skipped and the portal will not go on.` : " Every upload names its document."));
  process.exit(0);
}

/** Ask, in the recorder's terminal, which document each upload with no document type takes. Only on an
 *  interactive terminal; anything typed that is not a known type is refused and asked again once. */
export async function askUploadDocTypes(steps: RecipeStep[], asker?: (question: string) => Promise<string>): Promise<void> {
  const blanks = steps.filter((s) => s.action === "upload" && !s.docType);
  if (!blanks.length || (!asker && !process.stdin.isTTY)) return;
  const rl = asker ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = asker ?? ((q: string) => new Promise<string>((resolve) => rl!.question(q, (a) => resolve(String(a ?? "").trim()))));
  console.log(`\n${blanks.length} upload(s) did not say which document they take. Types: ${UPLOAD_DOC_TYPE_CHOICES.join(", ")}`);
  for (const step of blanks) {
    // The slot's own name, as the page shows it, when the capture read one (#280).
    const where = String(step.slot ?? "").trim().slice(0, 80)
      || String(step.note ?? "").replace(/^UPLOAD — set docType \(e\.g\. sld, site_plan\) in the dashboard\.\s*/, "").slice(0, 80) || "an upload slot";
    for (let tries = 0; tries < 2; tries++) {
      const typed = (await ask(`  Which document goes in "${where}"? (Enter = decide later in the dashboard) `)).toLowerCase();
      if (!typed) break;
      if (UPLOAD_DOC_TYPE_CHOICES.includes(typed)) { step.docType = typed; step.note = `upload ${typed}: ${where}`; break; }
      console.log(`  "${typed}" is not a document type Keelix files. Pick one of the types above.`);
    }
  }
  rl?.close();
}

// Browser-side capture: generates a portable selector for the target element and reports
// each interaction back to the recorder via window.__recordStep.
// Exported so a DOM smoke can drive the REAL recorder page-side code (it had no test at all).
export function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  // Shadow-aware target: the real element through composedPath() (same as humanCapture.ts).
  function target(e: Event): Element | null {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const t = (path && path[0]) || e.target;
    return t instanceof Element ? t : null;
  }
  function describe(el: Element): Record<string, unknown> {
    // Role and label come from the SHARED labeler (window.__portalSafety): the label is what the
    // click classifier is asked about, so it reads a button's value, an image's alt and a title,
    // and never a <select>'s option text. FAIL CLOSED: without the shared predicates the payload
    // says so, and the sink treats the click as blocked (see createRecorderSink).
    const ps = w.__portalSafety;
    const safetyUnavailable = !ps || typeof ps.controlLabelInPage !== "function" || typeof ps.controlRoleInPage !== "function";
    let role = "";
    let name = "";
    if (!safetyUnavailable) {
      try { role = String(ps.controlRoleInPage(el) || ""); name = String(ps.controlLabelInPage(el) || ""); } catch { /* reported below */ }
    }
    const id = el.getAttribute("id");
    const sel: Record<string, unknown> = {};
    // Frame key replay understands (safeAction.frameSelectorFor): the frame element's
    // name, or "src:<pathname>" for unnamed frames (matched on the parent's iframe[src]).
    const frameName = window.name || (window !== window.top ? `src:${window.location.pathname}` : "");
    if (frameName) sel.frame = frameName;
    if (role && name) { sel.role = role; sel.name = name; }
    else if (el.getAttribute("aria-label")) sel.label = el.getAttribute("aria-label");
    else if ((el as HTMLInputElement).placeholder) sel.placeholder = (el as HTMLInputElement).placeholder;
    else if (id) sel.css = `#${CSS.escape(id)}`;
    else if (el.getAttribute("name")) sel.css = `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    else if (name) sel.text = name;
    // Fingerprint: attribute NAMES only for replay-heal tie-breaking — never values.
    const fp: Record<string, string> = {};
    if (id) fp.id = id;
    if (el.getAttribute("name")) fp.name = el.getAttribute("name") as string;
    if ((el as HTMLInputElement).placeholder) fp.placeholder = (el as HTMLInputElement).placeholder;
    if (el.getAttribute("aria-label")) fp.ariaLabel = el.getAttribute("aria-label") as string;
    const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
    if (legend) fp.section = legend;
    return { selector: sel, label: name, ...(Object.keys(fp).length ? { fingerprint: fp } : {}), ...(safetyUnavailable ? { safetyUnavailable: true } : {}) };
  }
  // Every safety decision is made in Node by shared/src/portalSafety.ts (see createRecorderSink):
  // a click is REPORTED with the page's read-only state, and the shared classifier decides
  // whether it is an ordinary click, a blocked submit/pay placeholder, or the filing click. The
  // one decision made here is the card-field refusal, so a card value never crosses the binding.
  // FAIL CLOSED: without the shared predicates, no field event is reported at all.
  function isPaymentCardField(el: Element): boolean {
    const ps = w.__portalSafety;
    if (!ps || typeof ps.isPaymentElementInPage !== "function") return true;
    try { return ps.isPaymentElementInPage(el) === true; } catch { return true; }
  }
  function identityOf(el: Element): Record<string, string> {
    const ps = w.__portalSafety;
    return ps && typeof ps.fieldIdentityInPage === "function" ? ps.fieldIdentityInPage(el) : {};
  }
  function readOnlyPage(): boolean | undefined {
    const ps = w.__portalSafety;
    try { return ps && typeof ps.readOnlyPageInPage === "function" ? ps.readOnlyPageInPage() : undefined; } catch { return undefined; }
  }
  function reviewPage(): boolean | undefined {
    const ps = w.__portalSafety;
    try { return ps && typeof ps.reviewPageInPage === "function" ? ps.reviewPageInPage() : undefined; } catch { return undefined; }
  }
  // ---- A CLICK THAT CHANGES THE PAGE IS A STEP, WHATEVER WAS CLICKED (#280) -----------------------
  // A chooser of TILES (cards that are neither buttons nor links, with a click handler that
  // navigates) left a hole in a hand recording: the click was dropped as "a plain page click", so
  // the recipe went from the entry link straight to the form's "Next" and every replay looked for
  // "Next" on the chooser. The rule has no list of element kinds: a click on anything that is not a
  // control is REPORTED as a candidate, and it becomes a step only when the page is then seen to
  // change — a navigation (seen from Node: this document is gone by then), a route change, or a new
  // view in place of the one the person clicked in. A click that changes nothing is never a step.
  const oneLine = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
  function shown(n: Element): boolean {
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  }
  // The lines a person can read in a node: innerText, which leaves out what the browser does not render.
  function visibleLines(n: Element | null): string[] {
    return String((n as HTMLElement | null)?.innerText ?? "").split(/\n+/).map(oneLine).filter(Boolean);
  }
  function isTop(n: Element | null): boolean {
    return !n || n === document.body || n === document.documentElement;
  }
  // THE THING THE PERSON CLICKED: the nearest ancestor that owns the click (an onclick handler, a
  // tab stop, an interactive role, or where a pointer cursor starts); else the nearest ancestor
  // that is one of several alike (the card among cards, the row among rows: a delegated listener
  // leaves no mark on the card itself); else the clicked element. Never something too big to be
  // one choice.
  function cardOf(el: Element): Element {
    const fits = (n: Element): boolean => oneLine((n as HTMLElement).innerText).length <= 300;
    let n: Element | null = el;
    for (let d = 0; n && !isTop(n) && d < 8; d++, n = n.parentElement) {
      const tab = n.getAttribute("tabindex");
      const role = String(n.getAttribute("role") || "").toLowerCase();
      const parent: Element | null = n.parentElement;
      const pointerStarts = getComputedStyle(n).cursor === "pointer" && !(parent && getComputedStyle(parent).cursor === "pointer");
      if (typeof (n as HTMLElement).onclick === "function" || (tab !== null && tab !== "-1") || pointerStarts
        || /^(tab|menuitem|menuitemcheckbox|menuitemradio|treeitem|switch|checkbox|radio)$/.test(role)) return fits(n) ? n : el;
    }
    n = el;
    for (let d = 0; n && !isTop(n) && d < 6; d++, n = n.parentElement) {
      const parent: Element | null = n.parentElement;
      const tag = n.tagName;
      const cls = n.getAttribute("class") || "";
      const self: Element = n;
      if (parent && Array.from(parent.children).some((s) => s !== self && s.tagName === tag && (s.getAttribute("class") || "") === cls)) return fits(n) ? n : el;
    }
    return el;
  }
  // Name and selector of a clicked non-control. NAME: its accessible name (aria-label) first, else
  // the text a person read on it, one line, capped. SELECTOR: one the replay can resolve — the
  // learner's own shape for a choice tile: the TITLE text, exact (which resolves the title element;
  // a click there reaches the card's handler), with role fallbacks. A role that takes its name from
  // its content is recorded by role and name. The control's label and role are NOT read with the
  // field labeler here: that one glues a card's title to its description and reads text no one sees.
  function describeCard(card: Element): Record<string, unknown> | null {
    const ps = w.__portalSafety;
    const safetyUnavailable = !ps || typeof ps.controlLabelInPage !== "function" || typeof ps.controlRoleInPage !== "function";
    const aria = oneLine(card.getAttribute("aria-label"));
    const lines = visibleLines(card);
    const seen = lines.join(" ");
    const label = (aria || seen).slice(0, 120);
    // Something a person could read: at least two letters or digits.
    if (!/[\p{L}\p{N}][^\p{L}\p{N}]*[\p{L}\p{N}]/u.test(label)) return null;
    const text = (n: Element): string => oneLine(n.textContent);
    const title = lines[0] || "";
    let target = "";
    if (title && title.length <= 200) {
      if ([card, ...Array.from(card.querySelectorAll("*"))].some((n) => text(n) === title && shown(n))) target = title;
      else if (text(card) && text(card).length <= 200) target = text(card);
    }
    const sel: Record<string, unknown> = {};
    const frameName = window.name || (window !== window.top ? `src:${window.location.pathname}` : "");
    if (frameName) sel.frame = frameName;
    const fallbacks: Record<string, unknown>[] = [];
    const role = String(card.getAttribute("role") || "").toLowerCase();
    if (/^(tab|menuitem|treeitem)$/.test(role)) {
      sel.role = role; sel.name = label;
      if (target) fallbacks.push({ text: target, exact: true });
    } else if (target) {
      sel.text = target; sel.exact = true;
      // Which of the page's elements reading exactly this the click was in, when not the first.
      const same = Array.from(document.body.querySelectorAll("*")).filter((n) => !n.closest("script, style, noscript")
        && text(n) === target && !Array.from(n.children).some((c) => text(c) === target));
      const at = same.findIndex((n) => card.contains(n));
      if (at > 0) sel.nth = at;
      fallbacks.push({ role: "link", name: target, exact: true }, { role: "button", name: target, exact: true });
    } else if (aria) sel.label = aria;
    else return null;
    const id = card.getAttribute("id");
    if (id) fallbacks.push({ css: `#${CSS.escape(id)}` });
    if (fallbacks.length) sel.fallbacks = fallbacks;
    // The words on its face, when its accessible name says something else: the click classifier
    // reads both (createRecorderSink), so a pay- or submit-worded face is never a replayable click.
    if (aria && seen && seen !== aria) sel.shownText = seen.slice(0, 120);
    return { selector: sel, label, ...(safetyUnavailable ? { safetyUnavailable: true } : {}) };
  }
  function controlState(c: Element): string {
    const i = c as HTMLInputElement;
    return i.type === "checkbox" || i.type === "radio" ? String(i.checked) : String(i.value ?? "");
  }
  let endWatch: (() => void) | null = null;
  let candidateSeq = 0;
  function reportCandidate(el: Element): void {
    if (endWatch) endWatch();
    const card = cardOf(el);
    const described = describeCard(card);
    if (!described) return;
    const candidateId = `${Date.now().toString(36)}-${++candidateSeq}`;
    const href = location.href;
    const linesBefore = new Set(visibleLines(document.body));
    const controls = Array.from(document.querySelectorAll("input, select, textarea")).slice(0, 400);
    const statesBefore = controls.map(controlState);
    const controlsBefore = new Set(controls);
    w.__recordStep({ kind: "clickCandidate", candidateId, ...described, readOnlyPage: readOnlyPage(), reviewPage: reviewPage() });
    let done = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    // changed: the page changed because of the click. settled: it did not (the person moved on, or
    // the click wrote a field, which is that field's own step). silent: stop looking, say nothing —
    // a slow navigation can still arrive, and Node sees that.
    function finish(outcome: "clickChanged" | "clickSettled" | "silent"): void {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(cap);
      clearTimeout(debounce);
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
      endWatch = null;
      if (outcome !== "silent") { try { w.__recordStep({ kind: outcome, candidateId }); } catch { /* the page is going away */ } }
    }
    function look(): void {
      if (done) return;
      if (location.href !== href) { finish("clickChanged"); return; }
      // The click wrote a field (a toggle, a date picker's day, a custom control): the field's step.
      if (controls.some((c, i) => c.isConnected && controlState(c) !== statesBefore[i])) { finish("clickSettled"); return; }
      // A NEW VIEW: what was clicked is gone, and either much of what the page said went with it
      // or the page now shows a field it did not have.
      if (card.isConnected && shown(card)) return;
      const linesNow = new Set(visibleLines(document.body));
      let lost = 0;
      linesBefore.forEach((l) => { if (!linesNow.has(l)) lost++; });
      const newField = Array.from(document.querySelectorAll("input, select, textarea"))
        .some((c) => !controlsBefore.has(c) && (c as HTMLInputElement).type !== "hidden" && shown(c));
      if (newField || (linesBefore.size > 0 && lost / linesBefore.size >= 0.3)) finish("clickChanged");
    }
    function onGesture(e: Event): void {
      if (e.isTrusted) finish("clickSettled");
    }
    const observer = new MutationObserver(() => { clearTimeout(debounce); debounce = setTimeout(look, 80); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const poll = setInterval(look, 300);
    const cap = setTimeout(() => finish("silent"), 15000);
    // The person's NEXT key or pointer press ends the wait (registered after this click is over).
    setTimeout(() => {
      if (done) return;
      document.addEventListener("pointerdown", onGesture, true);
      document.addEventListener("keydown", onGesture, true);
    }, 0);
    endWatch = () => finish("clickSettled");
  }
  // THE NAME THE PAGE SHOWS FOR A FILE INPUT (#280): the learner's own slot reader (its label, the
  // heading it sits under, or its requirement row), kept only when the browser PAINTS that text. A
  // label that is never rendered is not something a person read, so it is not the slot's name.
  function paintedText(text: string, near: Element): boolean {
    const want = oneLine(text).toLowerCase();
    if (!want) return false;
    const root = near.getRootNode() as Document | ShadowRoot;
    const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const s = oneLine(t.textContent).toLowerCase();
      if (!s || !(s.includes(want) || (want.includes(s) && s.length * 2 >= want.length))) continue;
      const p = (t as Text).parentElement;
      if (!p || p.closest("script, style, noscript, option")) continue;
      const r = p.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // a 1px clip is a screen-reader-only label
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cv = (p as any).checkVisibility;
      const visible = typeof cv === "function" ? cv.call(p, { checkOpacity: true, checkVisibilityCSS: true }) === true : shown(p);
      if (visible) return true;
    }
    return false;
  }
  function uploadSlotName(el: Element): string {
    try {
      if (typeof w.__recorderUploadSlots !== "function") return "";
      const slots = w.__recorderUploadSlots() as Array<{ key: string; heading?: string }>;
      const key = el.getAttribute("data-al-upl");
      const slot = Array.isArray(slots) ? slots.find((s) => s && s.key === key) : undefined;
      const name = oneLine(slot && slot.heading);
      return name && paintedText(name, el) ? name.slice(0, 120) : "";
    } catch { return ""; }
  }
  document.addEventListener("click", (e) => {
    if (w.__recordStopped) return;
    const el = target(e);
    if (!el) return;
    // Custom (non-native) dropdown: a click on an option-like element is recorded as a
    // SELECT step against the owning combobox so replay goes through selectWithFallback
    // (label-first matching) instead of a brittle click on a transient option node.
    const option = el.closest('[role="option"], .select2-results li, .select2-results__option, ul.ui-autocomplete li, .ui-menu-item');
    if (option) {
      const optionText = (option.textContent || "").trim();
      if (optionText) {
        const listbox = option.closest('[role="listbox"], .select2-results, .select2-drop, .select2-dropdown, ul.ui-autocomplete, .ui-menu') || option.parentElement;
        const root = option.getRootNode() as Document | ShadowRoot;
        // The owning control: an expanded combobox, or one wired to the listbox via
        // aria-owns/aria-controls. Fall back to the listbox container itself.
        const listboxId = listbox?.getAttribute("id");
        const combo =
          (listboxId ? root.querySelector(`[aria-owns~="${CSS.escape(listboxId)}"], [aria-controls~="${CSS.escape(listboxId)}"]`) : null) ||
          root.querySelector('[role="combobox"][aria-expanded="true"]') ||
          listbox || option;
        // THE NATIVE CONTROL THE WIDGET FRONTS, when there is one (recorder skeptic F5, probe G-b).
        // A select2/chosen face is labelled by aria-labelledby -> its rendered selection, i.e. the
        // CURRENT VALUE, and carries none of the native control's name/id/label[for]. So a select2
        // over <select name=meterNumber> with <label for>Meter Number</label> recorded
        // {role:combobox, name:'Select...'} sensitive:false with the meter number as the literal
        // (real select2 fires change through jQuery: the native change branch never runs). The
        // identity AND the label come from the native select: select2's "select2-<id>-container|
        // results" ids, the select.select2-hidden-accessible / chosen select just before the
        // container, or chosen's "<id>_chosen" container id.
        const native = ((): Element | null => {
          const ids = [combo.getAttribute("aria-labelledby"), combo.getAttribute("aria-owns"), combo.getAttribute("aria-controls"), listboxId, combo.getAttribute("id")].filter(Boolean).join(" ");
          const m = /select2-(\S+?)-(container|results)\b/.exec(ids);
          const byId = (id: string): Element | null => { try { return (root as Document).getElementById ? (root as Document).getElementById(id) : root.querySelector(`#${CSS.escape(id)}`); } catch { return null; } };
          if (m) { const s = byId(m[1]); if (s && s.tagName === "SELECT") return s; }
          const cont = combo.closest(".select2-container, .chosen-container");
          if (cont) {
            let p = cont.previousElementSibling;
            while (p && p.tagName !== "SELECT" && /select2-container|chosen-container/.test(String(p.getAttribute("class") || ""))) p = p.previousElementSibling;
            if (p && p.tagName === "SELECT") return p;
            const cid = cont.getAttribute("id") || "";
            if (/_chosen$/.test(cid)) { const s = byId(cid.replace(/_chosen$/, "")); if (s && s.tagName === "SELECT") return s; }
          }
          return null;
        })();
        const owner = native || combo;
        w.__recordStep({ kind: "select", value: optionText, identity: identityOf(owner), ...describe(owner) });
        return;
      }
    }
    // Only actionable elements — plain page clicks are noise, not replayable steps.
    const actionable = el.closest('button,a,[role="button"],[role="link"],input[type="button"],input[type="submit"],input[type="image"],summary');
    if (!actionable) {
      // Not a control. A form field or its label is the change handler's (a click there is how a
      // person fills it); anything else is a step only if the page changes because of it.
      if (!el.closest('input, select, textarea, label, option, [contenteditable]:not([contenteditable="false"])')) reportCandidate(el);
      return;
    }
    // A click on a control ends any wait on an earlier click; it is recorded as it always was.
    if (endWatch) endWatch();
    if ((actionable as HTMLInputElement).type === "file") return; // handled by change
    w.__recordStep({ kind: "click", ...describe(actionable), readOnlyPage: readOnlyPage(), reviewPage: reviewPage() });
  }, true);
  document.addEventListener("change", (e) => {
    if (w.__recordStopped) return;
    const el = target(e) as HTMLInputElement | null;
    if (!el || !(el instanceof Element)) return;
    // Payment-card fields are refused before any kind branches: no step, no value, of any kind.
    if (isPaymentCardField(el)) return;
    const d = describe(el);
    if (el.type === "file") {
      // A hidden/offscreen file input belongs to a custom Browse widget — replay must
      // go through the file-chooser dialog (click + setFiles), not setInputFiles.
      const viaFileChooser = !(el as unknown as HTMLElement).offsetParent && getComputedStyle(el).position !== "fixed";
      // The slot's own name, and the chosen file's name and size (never its contents): Node matches
      // them to the job's documents to name the document type, and stores neither.
      const chosen = el.files && el.files.length ? el.files[0] : null;
      w.__recordStep({ kind: "upload", viaFileChooser, ...d, slot: uploadSlotName(el), ...(chosen ? { fileName: chosen.name, fileSize: chosen.size } : {}) });
    }
    else if (el.tagName === "SELECT") {
      // Record the option's LABEL as the value (replay's selectWithFallback matches
      // label first, and labels survive portals whose option values are opaque ids);
      // the raw value rides along for the note/binding.
      const opt = (el as unknown as HTMLSelectElement).selectedOptions[0];
      const optLabel = (opt?.textContent || "").trim();
      w.__recordStep({ kind: "select", value: optLabel || el.value, rawValue: el.value, identity: identityOf(el), ...d });
    }
    else if (el.type === "checkbox" || el.type === "radio") {
      // A radio only ever fires change when it becomes checked; a checkbox the operator
      // UNCHECKS (portals pre-check "same as mailing" etc.) must record an uncheck step,
      // or replay silently leaves the default on every future project.
      if (el.checked) w.__recordStep({ kind: "check", ...d });
      else if (el.type === "checkbox") w.__recordStep({ kind: "uncheck", ...d });
    }
    // The value crosses ONLY the in-page→handler binding. A SECRET field (the shared
    // isSecretField over this identity, decided in Node) is bound to a project field key by
    // NAME and its literal is never persisted.
    else w.__recordStep({ kind: "fill", value: el.value, identity: identityOf(el), ...d });
  }, true);
}

// Run only as the CLI (npm run portal:record). Importing this module — the golden safety test
// does, to drive createRecorderSink and finalizeRecordedSteps — must not open a browser.
const invokedAs = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invokedAs === import.meta.url.toLowerCase()) {
  main().catch((err) => {
    console.error("recordRecipe failed:", err);
    process.exit(1);
  });
}
