// RAPID SHUTDOWN FROM THE MAKER'S OWN SPEC SHEET (#220; owner card 2026-11-13, "Keelix attaches the
// maker's spec sheet").
//
// city.elec.rapid-shutdown-edition-evidence fired on 22 of 26 real jobs: the plan sets mention rapid
// shutdown but never say the equipment is LISTED for 690.12(B)(2), while the microinverter maker's
// own datasheet says exactly that ("UL Listed as PV Rapid Shutdown Equipment"). The sheet simply was
// not in the package. So Keelix finds it once per make + model, keeps it, and gives a job a copy as
// its own inverter_spec document. The reviewer rule is NOT changed and is NOT told anything: it
// clears because the package now carries the maker's own words, the same as if the installer had
// attached the sheet. A city reviewer wants that sheet in the package anyway.
//
// WHAT COUNTS:
//   * The URL is one the web search actually RETURNED (resultUrls), never one the model wrote from
//     memory, and its host is the MAKER'S OWN domain (makerHostFits: the registrable domain is the
//     make's name), never a distributor's copy.
//   * The bytes are a real PDF fetched through fetchPublicDocument (public addresses only, no
//     credential, DOCUMENT_FETCH=off honoured), read with the same extractor project documents use.
//   * The sheet NAMES the job's model, and its own words answer rsdListedEquipmentAffirmed — the one
//     predicate the reviewer rule reads. A sheet that does not say it is kept as no_listing and is
//     never attached: attaching it would answer nothing.
//   * A maker's site is NOT an official source (rule 3): nothing here writes a KB fact, a verified
//     mark or a "Verified from" label. The document is evidence in the package, named as the maker's.
//
// WHAT IT NEVER DOES: no filing door, no portal, no send. Only make + model go to the lookup (no
// address, no homeowner, no account number). First slice: microinverters (pvMicroMake/pvMicroModel);
// optimizer sheets come later. No place is named here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import type { LLMProvider, ParserPayload, WebLookupResult } from "../../shared/src/types";
import { backendDataDir } from "./statePaths";
import { fetchPublicDocument } from "./documentFetch";
import { extractPdfText } from "./batchImport";
import { microEvidenceSupersededIn } from "./normalize";
import { rsdListedEquipmentAffirmed } from "./codeReviewRules";
import { packageTextSources } from "./designCriteria";
import { designDocumentTexts, getProjectDetail } from "./repository";
import { saveProjectDocument } from "./projectDocuments";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { nowIso } from "./time";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** The document source a project's copy carries (project_documents.source). */
export const MAKER_SPEC_SHEET_SOURCE = "maker_spec_sheet";
/** A sheet that was not found, or does not say it, is asked again after this long. */
const RETRY_AFTER_MS = 30 * 24 * 3600_000;
/** Bigger than any datasheet; a portal upload slot caps near 5 MB. */
const MAX_SHEET_BYTES = 5 * 1024 * 1024;
const MAX_CANDIDATES = 3;

export interface RsdEquipment { make: string; model: string; makeKey: string; modelKey: string }

// Corporate words that are not the brand ("Enphase Energy", "Hoymiles Power Electronics Inc").
const CORPORATE = /\b(?:inc|llc|ltd|corp(?:oration)?|co|company|gmbh|energy|power|electronics|technolog(?:y|ies)|solar|systems?|international|usa|us|america)\b\.?/gi;

/** The make as a key: lowercase letters and digits, corporate words dropped ("Enphase Energy" → "enphase"). */
export function makerKey(make: string): string {
  const words = s(make).toLowerCase().replace(/&/g, " ");
  const brand = words.replace(CORPORATE, " ").replace(/[^a-z0-9]+/g, "");
  return brand || words.replace(/[^a-z0-9]+/g, "");
}

/** The model as a key: uppercase, whitespace removed, braces/notes dropped ("IQ8M-72-2-US {240V}" → "IQ8M-72-2-US"). */
export function modelKey(model: string): string {
  return s(model).toUpperCase().replace(/[{(\[].*$/, "").replace(/\s+/g, "").replace(/[^A-Z0-9.\-+]/g, "");
}

/** The microinverter on the job, or null. A person's "that is not the micro" (#270) outranks the field. */
export function rsdEquipmentForJob(snapshot: ParserPayload | Record<string, unknown> | null | undefined): RsdEquipment | null {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  if (microEvidenceSupersededIn(snap as ParserPayload)) return null;
  const model = s(snap.pvMicroModel);
  const make = s(snap.pvMicroMake);
  if (!model || !make) return null;
  const mk = makerKey(make);
  const md = modelKey(model);
  if (mk.length < 3 || md.length < 3) return null;
  return { make, model, makeKey: mk, modelKey: md };
}

/** The registrable label of a host: "enphase" for www.enphase.com / enphase.com.au / usa.enphase.com. */
export function registrableLabel(host: string): string {
  const labels = s(host).toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return labels[0] ?? "";
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  // co.uk / com.au / com.cn: the label before the public suffix.
  if (tld.length === 2 && /^(?:co|com|net|org|gov|ac|edu)$/.test(second) && labels.length >= 3) return labels[labels.length - 3];
  return second;
}

/** Is this URL on the maker's OWN domain? The registrable label is the brand ("enphase" for Enphase
 *  Energy), or the brand with the label's own separators dropped ("ap-systems" for APsystems).
 *  A distributor that puts the brand in a SUBDOMAIN (enphase.someshop.com) is not the maker. */
export function makerHostFits(make: string, url: string): boolean {
  let host = "";
  try { host = new URL(url).hostname; } catch { return false; }
  const brand = makerKey(make);
  if (brand.length < 3) return false;
  const label = registrableLabel(host).replace(/[^a-z0-9]+/g, "");
  return label === brand;
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the sheet name the job's model? The whole model first; else its leading family token
 *  (IQ8M of IQ8M-72-M-US) at a token boundary, so IQ8 never matches IQ8M and IQ8M never IQ8MC. */
export function modelOnSheet(model: string, text: string): boolean {
  const key = modelKey(model);
  const body = s(text).toUpperCase().replace(/\s+/g, " ");
  if (!key || !body) return false;
  const bounded = (token: string) => new RegExp(`(?<![A-Z0-9])${escapeRe(token)}(?![A-Z0-9])`).test(body);
  if (bounded(key)) return true;
  const family = key.split(/[-+]/)[0];
  return family.length >= 3 && family !== key && /\d/.test(family) && bounded(family);
}

export interface MakerSpecSheetRow {
  makeKey: string;
  modelKey: string;
  make: string;
  model: string;
  status: "found" | "no_listing" | "not_found";
  sourceUrl: string;
  host: string;
  sha256: string;
  storedPath: string;
  rsdQuote: string;
  detail: string;
  fetchedAt: string;
}

function mapRow(r: Row): MakerSpecSheetRow {
  return {
    makeKey: s(r.make_key), modelKey: s(r.model_key), make: s(r.make), model: s(r.model),
    status: s(r.status) as MakerSpecSheetRow["status"], sourceUrl: s(r.source_url), host: s(r.host),
    sha256: s(r.sha256), storedPath: s(r.stored_path), rsdQuote: s(r.rsd_quote), detail: s(r.detail), fetchedAt: s(r.fetched_at),
  };
}

export function makerSpecSheetFor(db: AppDb, eq: Pick<RsdEquipment, "makeKey" | "modelKey">): MakerSpecSheetRow | null {
  const r = db.get<Row>("SELECT * FROM maker_spec_sheets WHERE make_key = ? AND model_key = ?", [eq.makeKey, eq.modelKey]);
  return r ? mapRow(r) : null;
}

function saveRow(db: AppDb, row: MakerSpecSheetRow): void {
  db.run(
    `INSERT INTO maker_spec_sheets (make_key, model_key, make, model, status, source_url, host, sha256, stored_path, rsd_quote, detail, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(make_key, model_key) DO UPDATE SET make = excluded.make, model = excluded.model, status = excluded.status,
       source_url = excluded.source_url, host = excluded.host, sha256 = excluded.sha256, stored_path = excluded.stored_path,
       rsd_quote = excluded.rsd_quote, detail = excluded.detail, fetched_at = excluded.fetched_at`,
    [row.makeKey, row.modelKey, row.make, row.model, row.status, row.sourceUrl, row.host, row.sha256, row.storedPath, row.rsdQuote, row.detail.slice(0, 600), row.fetchedAt],
  );
}

function sheetsDir(): string {
  return path.join(backendDataDir(), "maker-spec-sheets");
}

/** The sheet's own words that make it listed rapid-shutdown equipment, or "" — the reviewer's predicate. */
export function sheetRsdQuote(text: string): string {
  return rsdListedEquipmentAffirmed([{ label: "Maker spec sheet", text }])?.excerpt ?? "";
}

/** Does the job's package already say its rapid-shutdown equipment is listed? Then nothing is attached. */
export function packageSaysRsdListed(db: AppDb, projectId: string): boolean {
  const project = getProjectDetail(db, projectId).project;
  return !!rsdListedEquipmentAffirmed(packageTextSources(project, designDocumentTexts(db, projectId)));
}

const LOOKUP_SYSTEM = [
  "You find a solar equipment manufacturer's own product datasheet (spec sheet) PDF.",
  "Search the web. Answer with JSON only: {\"urls\": [\"...\"]} — at most 3 URLs, best first.",
  "Each URL must be one that appeared in your search results, on the MANUFACTURER'S OWN website,",
  "and should be the datasheet PDF for the exact product named. Never a distributor or reseller copy.",
  "If you find none, answer {\"urls\": []}. No other text.",
].join(" ");

function urlsFromAnswer(text: string): string[] {
  const m = s(text).match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]) as { urls?: unknown };
    return Array.isArray(parsed.urls) ? parsed.urls.map((u) => s(u)).filter((u) => /^https:\/\//i.test(u)) : [];
  } catch { return []; }
}

const sameUrl = (a: string, b: string) => a.replace(/[#].*$/, "").replace(/\/$/, "") === b.replace(/[#].*$/, "").replace(/\/$/, "");

/** The candidates to try, in order: the model's picks that the search actually returned, then any
 *  other returned PDF link; each on the maker's own domain. */
export function candidateUrls(make: string, web: Pick<WebLookupResult, "text" | "resultUrls" | "fetchedUrls">): string[] {
  const returned = [...(web.resultUrls ?? []), ...(web.fetchedUrls ?? [])].map(s).filter(Boolean);
  const grounded = (u: string) => returned.some((r) => sameUrl(r, u));
  const picks = urlsFromAnswer(web.text).filter(grounded);
  const pdfs = returned.filter((u) => /\.pdf(?:$|[?#])/i.test(u));
  const out: string[] = [];
  for (const u of [...picks, ...pdfs]) {
    if (!/^https:\/\//i.test(u) || !makerHostFits(make, u) || out.some((o) => sameUrl(o, u))) continue;
    out.push(u);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Room for a search turn and the JSON after it (the other web lookups use 4000 to 6000). */
const LOOKUP_MAX_TOKENS = 2000;

/** WHY no candidate was left, so the stored row says which refusal it was: the answer was cut off,
 *  it named nothing the search returned, or what was found is not on the maker's own site. */
function noCandidateReason(make: string, web: Pick<WebLookupResult, "text" | "resultUrls" | "fetchedUrls">, cutOff: boolean): string {
  if (cutOff) return "the answer was cut off at the token limit both times it was asked, before it named a link";
  const returned = [...(web.resultUrls ?? []), ...(web.fetchedUrls ?? [])].map(s).filter(Boolean);
  const picks = urlsFromAnswer(web.text);
  const grounded = picks.filter((u) => returned.some((r) => sameUrl(r, u)));
  const found = [...grounded, ...returned.filter((u) => /\.pdf(?:$|[?#])/i.test(u))];
  if (found.length) return `${found.length} link(s) were found, none on ${make}'s own site`;
  if (picks.length) return `the ${picks.length} link(s) the answer named were not among the search results`;
  return "the answer named no link and the search returned no PDF";
}

export interface LookupDeps {
  fetchDocument?: typeof fetchPublicDocument;
  readPdf?: (filePath: string) => Promise<string>;
}

/** ONE lookup for one make + model: find the maker's sheet, read it, keep it. Writes the shared row. */
export async function runMakerSpecSheetLookup(
  db: AppDb,
  llm: Pick<LLMProvider, "webLookup">,
  eq: RsdEquipment,
  deps: LookupDeps = {},
): Promise<MakerSpecSheetRow> {
  const fetchDocument = deps.fetchDocument ?? fetchPublicDocument;
  const readPdf = deps.readPdf ?? ((p: string) => extractPdfText(p, 20));
  const base = { makeKey: eq.makeKey, modelKey: eq.modelKey, make: eq.make, model: eq.model, sourceUrl: "", host: "", sha256: "", storedPath: "", rsdQuote: "", fetchedAt: nowIso() };
  const notFound = (detail: string): MakerSpecSheetRow => {
    const row: MakerSpecSheetRow = { ...base, status: "not_found", detail };
    saveRow(db, row);
    return row;
  };
  if (!llm.webLookup) return notFound("no web lookup available on this installation");
  const ask = () => llm.webLookup!({
    label: "makerSpecSheet",
    system: LOOKUP_SYSTEM,
    user: `Manufacturer: ${eq.make}\nModel: ${eq.model}\nFind this product's datasheet PDF on the manufacturer's own website.`,
    maxTokens: LOOKUP_MAX_TOKENS,
    maxSearches: 2,
  });
  let web = await ask();
  // AN ANSWER CUT OFF BEFORE ITS JSON IS NOT "NO LINK" (audit 2026-11-28). The search turn's own
  // output shares the token budget; at 400 the turn stopped at the cap with no JSON written and the
  // lookup stored "no datasheet link" for 30 days. Asked once more, and the row says so.
  const cutOff = (w: WebLookupResult) => (w.stopReason === "max_tokens" || w.stopReason === "pause_turn") && !urlsFromAnswer(w.text).length;
  const firstCutOff = cutOff(web);
  if (firstCutOff) web = await ask();
  if (!web.groundedSearches) return notFound(`the search returned nothing${web.error ? ` (${web.error.slice(0, 160)})` : ""}`);
  const candidates = candidateUrls(eq.make, web);
  if (!candidates.length) return notFound(`no datasheet link on ${eq.make}'s own site among ${web.resultUrls.length} search result(s): ${noCandidateReason(eq.make, web, cutOff(web))}`);
  const tried: string[] = [];
  let noListing: MakerSpecSheetRow | null = null;
  for (const url of candidates) {
    const got = await fetchDocument(url, { maxBytes: MAX_SHEET_BYTES });
    const bytes = got.bytes;
    const finalUrl = got.finalUrl || url;
    if (!got.ok || !bytes || !Buffer.from(bytes.subarray(0, 5)).toString("latin1").startsWith("%PDF")) {
      tried.push(`${url}: ${got.ok ? "not a PDF" : got.reason.slice(0, 120)}`);
      continue;
    }
    // A redirect must land on the maker's own site too.
    if (!makerHostFits(eq.make, finalUrl)) { tried.push(`${url}: redirected off the maker's site (${new URL(finalUrl).hostname})`); continue; }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(sheetsDir(), { recursive: true });
    const storedPath = path.join(sheetsDir(), `${sha256}.pdf`);
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, bytes);
    let text = "";
    try { text = await readPdf(storedPath); } catch { text = ""; }
    if (!text.trim()) { tried.push(`${url}: no text layer`); continue; }
    if (!modelOnSheet(eq.model, text)) { tried.push(`${url}: the sheet does not name ${eq.model}`); continue; }
    const host = new URL(finalUrl).hostname;
    const rsdQuote = sheetRsdQuote(text);
    const row: MakerSpecSheetRow = { ...base, status: rsdQuote ? "found" : "no_listing", sourceUrl: finalUrl, host, sha256, storedPath, rsdQuote, detail: rsdQuote ? "" : "the maker's sheet names the model but does not say it is listed rapid-shutdown equipment" };
    if (rsdQuote) { saveRow(db, row); return row; }
    noListing ??= row;
  }
  if (noListing) { saveRow(db, noListing); return noListing; }
  return notFound(`no candidate could be used: ${tried.join("; ")}`);
}

/** The filename a project's copy carries: it says whose sheet it is. */
function copyFilename(row: MakerSpecSheetRow): string {
  return `${row.make} ${row.model} spec sheet (from ${row.host}).pdf`;
}

/** Give one project a copy of a found sheet, as its own inverter_spec document. Never twice, and
 *  never when the package already says it (a person's own upload wins). */
export async function attachMakerSpecSheet(db: AppDb, projectId: string, row: MakerSpecSheetRow, deps: LookupDeps = {}): Promise<{ attached: boolean; reason: string }> {
  if (row.status !== "found" || !row.rsdQuote) return { attached: false, reason: "the maker's sheet does not say it is listed rapid-shutdown equipment" };
  const filename = copyFilename(row);
  const already = db.get<Row>("SELECT id FROM project_documents WHERE project_id = ? AND source = ? AND original_filename = ?", [projectId, MAKER_SPEC_SHEET_SOURCE, filename]);
  if (already) return { attached: false, reason: "already attached" };
  if (packageSaysRsdListed(db, projectId)) return { attached: false, reason: "the package already says its rapid-shutdown equipment is listed" };
  if (!row.storedPath || !fs.existsSync(row.storedPath)) return { attached: false, reason: "the kept sheet is missing on disk" };
  const buffer = fs.readFileSync(row.storedPath);
  if (crypto.createHash("sha256").update(buffer).digest("hex") !== row.sha256) return { attached: false, reason: "the kept sheet no longer matches what was read" };
  const doc = saveProjectDocument(db, projectId, { docType: "inverter_spec", filename, contentType: "application/pdf", buffer, source: MAKER_SPEC_SHEET_SOURCE, uploadedBy: "Keelix" });
  // The text the reviewer reads, now rather than after the background extraction (same extractor).
  try {
    const text = await (deps.readPdf ?? ((p: string) => extractPdfText(p, 40)))(row.storedPath);
    if (text.trim()) db.run("UPDATE project_documents SET extracted_text = ? WHERE id = ?", [text, doc.id]);
  } catch { /* the background extraction still runs */ }
  try {
    addAuditLog(db, projectId, "system", "Keelix", "documents.maker_spec_sheet_attached", {
      make: row.make, model: row.model, sourceUrl: row.sourceUrl, fetchedAt: row.fetchedAt, quote: row.rsdQuote.slice(0, 160),
    });
  } catch { /* audit is best-effort */ }
  return { attached: true, reason: `attached ${filename}` };
}

/** What QC's background trigger asks: attach a kept sheet now, or queue one lookup for it. */
export async function ensureMakerSpecSheetForProject(db: AppDb, projectId: string): Promise<"attached" | "queued" | "skipped"> {
  if (process.env.MAKER_SPEC_SHEETS === "off") return "skipped";
  try {
    const project = getProjectDetail(db, projectId).project;
    const eq = rsdEquipmentForJob(project.parserSnapshot);
    if (!eq) return "skipped";
    const kept = makerSpecSheetFor(db, eq);
    if (kept?.status === "found") return (await attachMakerSpecSheet(db, projectId, kept)).attached ? "attached" : "skipped";
    if (kept && Date.now() - Date.parse(kept.fetchedAt) < RETRY_AFTER_MS) return "skipped";
    if (packageSaysRsdListed(db, projectId)) return "skipped";
    const jobQueue = await import("./jobQueue");
    if (!jobQueue.jobWorkerRunning()) return "skipped";
    const key = `${eq.makeKey}|${eq.modelKey}`;
    const recent = db.get<Row>(
      `SELECT id FROM job_queue WHERE job_type = 'maker_spec_sheet' AND payload LIKE ? AND (status IN ('pending','running') OR created_at > ?) LIMIT 1`,
      [`%"key":${JSON.stringify(key)}%`, new Date(Date.now() - 24 * 3600_000).toISOString()],
    );
    if (recent) return "skipped";
    jobQueue.enqueueJob(db, "maker_spec_sheet", { key, make: eq.make, model: eq.model }, { priority: 4, maxRetries: 2, projectId });
    return "queued";
  } catch (err) {
    logger.warn("spec-sheet", "maker spec sheet trigger failed", { projectId, err: err instanceof Error ? err.message : String(err) });
    return "skipped";
  }
}

/** The maker_spec_sheet job: look up (unless a fresh row is kept), then attach to the job's project. */
export async function runMakerSpecSheetJob(db: AppDb, payload: Record<string, unknown>, projectId: string | null, llm: Pick<LLMProvider, "webLookup">, deps: LookupDeps = {}): Promise<Record<string, unknown>> {
  const make = s(payload.make);
  const model = s(payload.model);
  const mk = makerKey(make);
  const md = modelKey(model);
  if (!make || !model || mk.length < 3 || md.length < 3) return { status: "skipped", reason: "no make/model" };
  const eq: RsdEquipment = { make, model, makeKey: mk, modelKey: md };
  let row = makerSpecSheetFor(db, eq);
  if (!row || (row.status !== "found" && Date.now() - Date.parse(row.fetchedAt) >= RETRY_AFTER_MS)) row = await runMakerSpecSheetLookup(db, llm, eq, deps);
  const attach = projectId && row.status === "found" ? await attachMakerSpecSheet(db, projectId, row, deps) : null;
  return { status: row.status, sourceUrl: row.sourceUrl, detail: row.detail.slice(0, 300), attached: attach?.attached ?? false, attachReason: attach?.reason ?? "" };
}
