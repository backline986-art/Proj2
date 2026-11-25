// ---------------------------------------------------------------------------------------------
// PAGE CAPTURES — A MASKED PICTURE AND A TRIMMED SNAPSHOT OF EVERY PORTAL PAGE A LOCAL RUN VISITS.
//
// Why (owner, 2026-11-24, on Bend's CityView location step: "why can't we see the pages better by
// default?"): the cloud never visits a live portal (and Bend, Meridian, Nampa and Ada County refuse
// cloud reads anyway), so a reviewer only sees a portal page through what a LOCAL run kept. The
// recorder kept steps and labels but no picture; the learner's debug bundle and the replay's page
// shots are raw renders that are not safe to pass around. This keeps, per portal, the latest
// picture and snapshot of every distinct page, MASKED BY CONSTRUCTION, so the question "what does
// that page look like" can be answered from a staff export instead of a live visit.
//
// Where: <PORTAL_PAGE_CAPTURE_DIR, default data/page-captures>/<portal-slug>/
//   pages/<fp>.png   the page, through maskedFullPageScreenshot (the one masking path, rule 2):
//                    the run's known secrets AND whatever the page holds in a password box or a
//                    box the shared safety predicates call secret (account, meter, ESI/SA id), and
//                    every digit-bearing option of a secret list, are painted over. A page the mask
//                    cannot prove (a closed shadow root, a secret it cannot reach) gets NO picture,
//                    and so does a page that TRIPS THE TRIPWIRE: its visible text, after the known
//                    secrets are taken out, still holds a secret-worded value (the model door's own
//                    patterns: "Meter Number: 5550987612" on another application's row) that the mask
//                    was never given. `shot.masked` is true only for a picture that passed both.
//   pages/<fp>.json  the trimmed snapshot: sanitized URL, title, headings, visible text, every
//                    control's label/type/required/visibility (NEVER a value), the visible buttons
//                    and links, and the frame's markup with every value, script and style removed.
//                    All text passes the known-secret scrub, then redactCaptureText (digit runs of
//                    6+ and emails). No secret value is written anywhere, only a count.
//   runs.jsonl       one line per page a run stood on: when, which run kind, which page.
// <fp> is a hash of the page's SHAPE (host, path, headings, control labels), not its contents, so
// one portal step is one file however many jobs pass through it. A page already captured within
// PORTAL_PAGE_CAPTURE_REFRESH_HOURS (default 24) is only logged, never re-pictured, so a replay pays
// one cheap DOM read per page, not a screenshot.
//
// Stays local: the folder is under data/ (gitignored) and nothing here sends a capture anywhere —
// no model call, no network. Sharing is a separate staff step (pageCaptureExport.ts) that copies
// only masked pictures and re-scrubs every snapshot. That export is MODEL-BOUND (it exists to show a
// page to a reviewer in the cloud), so rule 2 holds here in full: a secret list keeps no option in
// the snapshot, and every kept string passes the model door's patterns (scrubCaptureText).
//
// Read-only on the page: nothing is clicked, typed, focused or navigated. The mask's own tags are
// set and cleared by maskedFullPageScreenshot. The recorder asks for `onlyWhenQuiet`, which skips
// the capture while a person has a box focused or a list open, so a picture never closes a
// type-ahead under them. Every method is best-effort and never throws.
//
// Flags: PORTAL_PAGE_CAPTURE=0 turns it off; PORTAL_PAGE_CAPTURE_DIR moves the folder;
// PORTAL_PAGE_CAPTURE_REFRESH_HOURS (24); PORTAL_PAGE_CAPTURE_MAX pages kept per portal (300).
// ---------------------------------------------------------------------------------------------
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { pageCapturesDir as statePageCapturesDir } from "../../backend/src/statePaths";
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE, redactSecretValues } from "../../shared/src/portalSafety";
import { scanText } from "../../backend/src/modelPayloadScan";
import { redactCaptureText } from "./safeAction";
import { maskedFullPageScreenshot } from "./secretMask";

export type PageCaptureKind = "record" | "learn" | "replay";

const flagOff = (name: string): boolean => {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
};
const numEnv = (name: string, dflt: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** The capture store's root: PORTAL_PAGE_CAPTURE_DIR, else <run data>/page-captures. */
export function pageCapturesDir(): string {
  return statePageCapturesDir();
}

/** A portal's folder name: its name lower-cased to letters, digits and dashes (never a value). */
export function portalSlug(name: string | null | undefined, fallbackUrl = ""): string {
  const fromName = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (fromName) return fromName;
  try {
    return new URL(fallbackUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "portal";
  } catch {
    return "portal";
  }
}

/** A page URL safe to keep: origin and path (digit runs redacted), query NAMES with a value kept only
 *  when it is a plain short word (isstep=True), no fragment. A record reference, a session token or an
 *  address in the query is dropped to "…". */
export function sanitizeCaptureUrl(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol}…`;
    const q: string[] = [];
    u.searchParams.forEach((v, k) => {
      const key = k.replace(/[^\w.\-[\]]/g, "").slice(0, 40);
      if (!key) return;
      // A plain word (True, step, edit) reads the same on every job; anything else may be the job's.
      q.push(/^(?:[a-z]{1,12}|[A-Z][a-z]{0,11}|[A-Z]{1,5})$/.test(v) ? `${key}=${v}` : `${key}=…`);
    });
    const p = redactCaptureText(decodeURIComponent(u.pathname).replace(/\s+/g, " "), 300);
    return `${u.origin}${p}${q.length ? `?${q.slice(0, 20).join("&")}` : ""}`;
  } catch {
    return "";
  }
}

/** The page's SHAPE: host, path, its headings and its control labels, digits and case removed. Two
 *  jobs on the same step share it; a different step (same URL in a single-page wizard) does not. */
export function pageFingerprint(shape: { url: string; headings: readonly string[]; labels: readonly string[] }): string {
  let where = "";
  try { const u = new URL(shape.url); where = `${u.host}${u.pathname}`.toLowerCase(); } catch { where = ""; }
  const norm = (t: string): string => String(t ?? "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
  const heads = shape.headings.map(norm).filter(Boolean).slice(0, 4);
  const labels = Array.from(new Set(shape.labels.map(norm).filter(Boolean))).sort().slice(0, 120);
  return createHash("sha256").update(JSON.stringify([where.replace(/\d{4,}/g, "#"), heads, labels])).digest("hex").slice(0, 16);
}

/** The run's known secrets, out of any text: the shared scrub (digits with any separators, mixed
 *  ids), and any other secret of 6+ characters as a case-insensitive literal (a password). */
export function scrubKnownSecrets(text: string, secrets: readonly string[]): string {
  const list = secrets.map((s) => String(s ?? "").trim()).filter((s) => s.length >= 4);
  if (!list.length || !text) return text;
  let out = redactSecretValues(text, list, () => "[secret]");
  for (const s of list) {
    if (/\d/.test(s) || s.length < 6) continue;
    out = out.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[secret]");
  }
  return out;
}

/** Every string inside a JSON-shaped value through `fn` (keys untouched). */
export function deepMapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepMapStrings(v, fn)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepMapStrings(v, fn);
    return out as T;
  }
  return value;
}

/** One control as the snapshot keeps it: what a person reads, never what was typed. */
export interface CapturedControl {
  tag: string;
  type: string;
  label: string;
  name: string;
  id: string;
  required: boolean;
  visible: boolean;
  disabled: boolean;
  secret: boolean;
  options?: string[];
}

export interface CapturedFrame {
  url: string;
  title: string;
  headings: string[];
  text: string;
  controls: CapturedControl[];
  actions: string[];
  html: string;
}

/** The light read of each frame: enough to name the page, decide whether it is quiet, and build the
 *  mask. `secretValues` crosses to Node only to build the mask and the scrub, and is never written. */
interface LightFrameRead {
  url: string;
  headings: string[];
  labels: string[];
  busy: boolean;
  secretValues: string[];
}

/** The full read, taken only for a page that will be written. `tripText` is the frame's whole
 *  visible text, read by the tripwire and never written. */
interface FullFrameRead extends CapturedFrame {
  tripText: string;
}

export interface PageCaptureResult {
  status: "captured" | "seen" | "skipped";
  fp?: string;
  /** The picture, when one was kept. */
  png?: string;
  /** The snapshot written (captured only). */
  json?: string;
  /** Why the picture was not kept, or why nothing was captured. */
  why?: string;
}

/** The light in-page read, run in each frame. Pure DOM: it changes nothing on the live page. A
 *  secret box's value, and every option of a secret list that carries digits (a meter or account
 *  list names the customer's OTHER meters and accounts, which the run does not know), join
 *  secretValues, so the mask paints them and the scrub removes them. */
function lightReadInPage(arg: { g: string }): LightFrameRead {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = (globalThis as any)[arg.g];
  const clean = (t: unknown, n = 160): string => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const shown = (el: Element): boolean => {
    const st = getComputedStyle(el as HTMLElement);
    const r = (el as HTMLElement).getBoundingClientRect();
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0 && r.width >= 2 && r.height >= 2;
  };
  const isSecret = (el: Element): boolean => {
    if ((el as HTMLInputElement).type === "password") return true;
    try { return !!ps && ps.isSecretField(ps.fieldIdentityInPage(el)); } catch { return true; }
  };
  const labelOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean(Array.from(labels).map((l) => l.textContent ?? "").join(" "));
    return clean(el.getAttribute("name") || el.getAttribute("placeholder") || "");
  };
  const secretValues: string[] = [];
  const labels: string[] = [];
  for (const el of Array.from(document.querySelectorAll("input, select, textarea")).slice(0, 400)) {
    if ((el as HTMLInputElement).type === "hidden") continue;
    if (isSecret(el)) {
      const v = String((el as HTMLInputElement).value ?? "").trim();
      if (v.length >= 4) secretValues.push(v);
      if (el.tagName === "SELECT") {
        for (const o of Array.from((el as HTMLSelectElement).options)) {
          for (const t of [o.text, o.value]) {
            const x = String(t ?? "").trim();
            if (x.length >= 4 && (x.match(/\d/g) ?? []).length >= 4) secretValues.push(x);
          }
        }
      }
    }
    if (shown(el)) labels.push(labelOf(el));
  }
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, legend, [aria-current='step'], [role=heading]"))
    .filter(shown).map((h) => clean((h as HTMLElement).innerText, 100)).filter(Boolean).slice(0, 12);
  const ae = document.activeElement as HTMLElement | null;
  const editing = !!ae && ae !== document.body && (
    ae.isContentEditable || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT"
    || (ae.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|image)$/i.test(String((ae as HTMLInputElement).type || ""))));
  const openList = Array.from(document.querySelectorAll("[role=listbox], [role=menu], [aria-expanded='true'], .ui-autocomplete, .pac-container"))
    .some((el) => shown(el) && el.getAttribute("aria-expanded") !== "false");
  return { url: location.href, headings, labels, busy: editing || openList, secretValues };
}

/** The full in-page read, for a page that will be written. Pure DOM: the markup is a clone. */
function fullReadInPage(arg: { g: string; maxHtml: number }): FullFrameRead {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = (globalThis as any)[arg.g];
  const clean = (t: unknown, n = 160): string => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const shown = (el: Element): boolean => {
    const st = getComputedStyle(el as HTMLElement);
    const r = (el as HTMLElement).getBoundingClientRect();
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0 && r.width >= 2 && r.height >= 2;
  };
  const isSecret = (el: Element): boolean => {
    if ((el as HTMLInputElement).type === "password") return true;
    try { return !!ps && ps.isSecretField(ps.fieldIdentityInPage(el)); } catch { return true; }
  };
  const labelOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (clean(t)) return clean(t);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean(Array.from(labels).map((l) => l.textContent ?? "").join(" "));
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || "");
  };
  const secretSelects = new Set<Element>();
  const controls: CapturedControl[] = [];
  for (const el of Array.from(document.querySelectorAll("input, select, textarea")).slice(0, 400)) {
    const type = el.tagName === "INPUT" ? String((el as HTMLInputElement).type || "text").toLowerCase() : el.tagName.toLowerCase();
    if (type === "hidden") continue;
    const secret = isSecret(el);
    if (secret && el.tagName === "SELECT") secretSelects.add(el);
    const c: CapturedControl = {
      tag: el.tagName.toLowerCase(),
      type,
      label: labelOf(el),
      name: clean(el.getAttribute("name"), 80),
      id: clean(el.id, 80),
      required: (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true",
      visible: shown(el),
      disabled: (el as HTMLInputElement).disabled,
      secret,
    };
    if (el.tagName === "SELECT" && !secret) {
      c.options = Array.from((el as HTMLSelectElement).options).map((o) => clean(o.text, 80)).slice(0, 60);
    }
    if (controls.length < 150) controls.push(c);
  }
  const actions: string[] = [];
  for (const el of Array.from(document.querySelectorAll("button, a[href], [role=button], input[type=submit], input[type=button]"))) {
    if (actions.length >= 60) break;
    if (!shown(el)) continue;
    const t = clean((el as HTMLElement).innerText || el.getAttribute("value") || el.getAttribute("aria-label") || "", 60);
    if (t && !actions.includes(t)) actions.push(t);
  }
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, legend, [aria-current='step'], [role=heading]"))
    .filter(shown).map((h) => clean((h as HTMLElement).innerText, 100)).filter(Boolean).slice(0, 12);
  // THE MARKUP, TRIMMED: a clone (the live page is never touched), visibility marked from the live
  // twin walked in the same order, every value and script gone, only the attributes a reader needs.
  // A secret list keeps no option at all; if the twin walk cannot be lined up, no list keeps one.
  const live = Array.from(document.querySelectorAll("body *"));
  const doc = document.documentElement.cloneNode(true) as HTMLElement;
  const cloned = Array.from(doc.querySelectorAll("body *"));
  if (cloned.length === live.length) {
    for (let i = 0; i < live.length; i++) {
      if (!shown(live[i])) cloned[i].setAttribute("data-invisible", "1");
      if (secretSelects.has(live[i])) cloned[i].textContent = "";
    }
  } else {
    for (const sel of Array.from(doc.querySelectorAll("select"))) sel.textContent = "";
  }
  for (const el of Array.from(doc.querySelectorAll("script, noscript, style, link, meta, svg, canvas, template"))) el.remove();
  const KEEP = /^(id|name|type|role|for|class|aria-[a-z]+|required|disabled|readonly|hidden|placeholder|title|alt|href|data-invisible|colspan|rowspan)$/;
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      if (!KEEP.test(a.name)) { el.removeAttribute(a.name); continue; }
      if (a.name === "href") el.setAttribute("href", String(a.value).split(/[?#]/)[0].slice(0, 200));
      if (a.name === "class") el.setAttribute("class", String(a.value).slice(0, 120));
    }
    if (el.tagName === "TEXTAREA") el.textContent = "";
    if (el.tagName === "INPUT") {
      const t = String(el.getAttribute("type") || "").toLowerCase();
      // A button-typed input's value IS its label; every other value is the operator's data.
      const own = (el as HTMLInputElement).getAttribute("value");
      if ((t === "submit" || t === "button" || t === "reset") && own) el.setAttribute("aria-label", own.slice(0, 80));
    }
  }
  const whole = document.body ? document.body.innerText : "";
  // A list's innerText is every option: a secret list's options leave the kept text too.
  let kept = whole;
  secretSelects.forEach((sel) => {
    for (const o of Array.from((sel as HTMLSelectElement).options)) {
      const t = String(o.text ?? "").trim();
      if (t) kept = kept.split(t).join(" ");
    }
  });
  return {
    url: location.href,
    title: clean(document.title, 160),
    headings,
    text: clean(kept, 6000),
    controls,
    actions,
    html: `<!doctype html><html>${doc.innerHTML}</html>`.slice(0, arg.maxHtml),
    tripText: String(whole).slice(0, 300_000),
  };
}

/** THE TRIPWIRE (Helm's review of #296): a secret-worded label (account, meter, ESI/SA id, SSN,
 *  password) followed by a value the run's scrub did not already cover — the shared model-door
 *  patterns (modelPayloadScan.SECRET_SHAPED_PATTERNS) over the page's visible text after the known
 *  secrets are taken out. A value it finds was never given to the mask, so the picture would show it
 *  in clear: the page gets no picture. Returns the kinds found (never the values). */
export function secretTripwire(texts: readonly string[], secrets: readonly string[]): string[] {
  const hits = new Map<string, number>();
  for (const t of texts) scanText(scrubKnownSecrets(String(t ?? ""), secrets), [], NO_EXEMPT, hits as Map<never, number>);
  return Array.from(hits.keys()).sort();
}
const NO_EXEMPT: ReadonlySet<never> = new Set<never>();

/** Every string a snapshot keeps, on its way to disk: the run's known secrets, then the model door's
 *  secret-shaped patterns, then digit runs and emails. */
export function scrubCaptureText(text: string, secrets: readonly string[], max = 400_000): string {
  return redactCaptureText(scanText(scrubKnownSecrets(String(text ?? ""), secrets), [], NO_EXEMPT, new Map()), max);
}

interface IndexedPage { capturedAt: string; }

/**
 * One run's page log. Made by start(); null when PORTAL_PAGE_CAPTURE=0.
 */
export class PageCaptureLog {
  readonly runId: string;
  readonly dir: string;
  private readonly kind: PageCaptureKind;
  private readonly portal: string;
  private readonly secrets: () => readonly string[];
  private readonly seenThisRun = new Set<string>();
  private busy = false;

  private constructor(kind: PageCaptureKind, portal: string, dir: string, secrets: () => readonly string[]) {
    this.kind = kind;
    this.portal = portal;
    this.dir = dir;
    this.secrets = secrets;
    this.runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${kind}-${randomBytes(3).toString("hex")}`;
  }

  /** A log for one run of `kind` on `portal`. `secrets` is read at each capture (a run learns its
   *  account/meter values as it goes). */
  static start(opts: { kind: PageCaptureKind; portal: string; secrets?: () => readonly string[] }): PageCaptureLog | null {
    if (flagOff("PORTAL_PAGE_CAPTURE")) return null;
    try {
      const slug = portalSlug(opts.portal);
      const dir = path.join(pageCapturesDir(), slug);
      return new PageCaptureLog(opts.kind, opts.portal, dir, opts.secrets ?? (() => []));
    } catch {
      return null;
    }
  }

  /** The secrets this capture masks and scrubs: the run's own, and what the page holds in a secret
   *  box. Never written. */
  private allSecrets(fromPage: readonly string[]): string[] {
    let own: readonly string[] = [];
    try { own = this.secrets() ?? []; } catch { own = []; }
    return Array.from(new Set([...own, ...fromPage].map((s) => String(s ?? "").trim()).filter((s) => s.length >= 4)));
  }

  /** Capture the page the run stands on, unless this shape was captured recently. `reason` is a
   *  short label (the step name); it is scrubbed like everything else. Never throws. */
  async capture(page: Page | null | undefined, reason: string, opts: { onlyWhenQuiet?: boolean } = {}): Promise<PageCaptureResult> {
    if (this.busy) return { status: "skipped", why: "a capture is already running" };
    const p = page as (Page & Record<string, unknown>) | null | undefined;
    if (!p || typeof p.evaluate !== "function" || typeof p.screenshot !== "function" || typeof p.frames !== "function") {
      return { status: "skipped", why: "no browser page" };
    }
    this.busy = true;
    try {
      // THE LIGHT READ FIRST (Helm's review of #296): on a page this portal already has (the common
      // replay case) a capture costs this read and nothing else.
      const frames = p.frames().slice(0, 9);
      const lights: Array<{ frame: (typeof frames)[number]; read: LightFrameRead }> = [];
      for (const fr of frames) {
        try {
          await fr.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
          const r = await fr.evaluate(lightReadInPage, { g: PORTAL_SAFETY_GLOBAL }) as LightFrameRead;
          if (r && typeof r.url === "string") lights.push({ frame: fr, read: r });
        } catch { /* a detached or cross-process frame: left out */ }
        if (fr === p.mainFrame() && !lights.length) return { status: "skipped", why: "the page could not be read" };
      }
      const main = lights[0].read;
      if (opts.onlyWhenQuiet && main.busy) return { status: "skipped", why: "a box is focused or a list is open" };
      const fp = pageFingerprint({ url: main.url, headings: main.headings, labels: lights.flatMap((l) => l.read.labels) });
      const pagesDir = path.join(this.dir, "pages");
      const jsonPath = path.join(pagesDir, `${fp}.json`);
      const pngPath = path.join(pagesDir, `${fp}.png`);
      const refreshMs = numEnv("PORTAL_PAGE_CAPTURE_REFRESH_HOURS", 24) * 3_600_000;
      let fresh = this.seenThisRun.has(fp);
      if (!fresh) {
        try {
          const prior = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as IndexedPage;
          fresh = Date.now() - Date.parse(prior.capturedAt) < refreshMs;
        } catch { fresh = false; }
      }
      const secrets = this.allSecrets(lights.flatMap((l) => l.read.secretValues));
      const scrub = (s: string): string => scrubCaptureText(s, secrets);
      const label = scrub(String(reason ?? "")).slice(0, 80);
      if (fresh) {
        this.seenThisRun.add(fp);
        this.logRun({ fp, label, status: "seen" });
        return { status: "seen", fp };
      }
      // The full read, only for a page that will be written.
      const reads: FullFrameRead[] = [];
      for (const { frame } of lights) {
        try {
          const r = await frame.evaluate(fullReadInPage, { g: PORTAL_SAFETY_GLOBAL, maxHtml: 400_000 }) as FullFrameRead;
          if (r && typeof r.url === "string") reads.push(r);
        } catch { /* left out */ }
      }
      if (!reads.length) return { status: "skipped", why: "the page could not be read" };
      fs.mkdirSync(pagesDir, { recursive: true });
      // No picture when the page shows a secret-worded value the mask was never given.
      const tripped = secretTripwire(reads.map((r) => r.tripText), secrets);
      const shot = tripped.length
        ? { ok: false, why: `the page shows ${tripped.join(", ")} value(s) the run did not know, so no picture was taken` }
        : await maskedFullPageScreenshot(p as Page, secrets, pngPath).catch((err: unknown) => ({
          ok: false, why: `the picture could not be taken (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`,
        }));
      if (!shot.ok) fs.rmSync(pngPath, { force: true });
      const frameOut: CapturedFrame[] = reads.map(({ tripText: _t, ...rest }) => ({ ...rest, url: sanitizeCaptureUrl(rest.url) }));
      // What the page said goes through the scrub; the record's own keys (hash, time, run id) do
      // not, since a date or a hash would read as a digit run.
      const seen = deepMapStrings({
        url: sanitizeCaptureUrl(reads[0].url),
        title: reads[0].title,
        headings: reads[0].headings,
        frames: frameOut,
        refused: shot.ok ? "" : shot.why || "the secret mask could not be proven on this page",
      }, scrub);
      const record = {
        fp,
        portal: this.portal,
        kind: this.kind,
        runId: this.runId,
        reason: label,
        capturedAt: new Date().toISOString(),
        url: seen.url,
        title: seen.title,
        headings: seen.headings,
        // masked: true ONLY for a picture taken through the mask on a page that passed the tripwire.
        shot: shot.ok
          ? { file: `${fp}.png`, masked: true, tripwire: "clear", secretsMasked: secrets.length }
          : { file: "", masked: false, tripwire: tripped.length ? "tripped" : "clear", refused: seen.refused },
        frames: seen.frames,
      };
      fs.writeFileSync(jsonPath, JSON.stringify(record, null, 1));
      this.seenThisRun.add(fp);
      this.logRun({ fp, label, status: "captured", ...(shot.ok ? {} : { noPicture: true }) });
      this.prune(pagesDir);
      return shot.ok ? { status: "captured", fp, png: pngPath, json: jsonPath } : { status: "captured", fp, json: jsonPath, why: shot.why };
    } catch (err) {
      return { status: "skipped", why: `capture failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)})` };
    } finally {
      this.busy = false;
    }
  }

  private logRun(line: Record<string, unknown>): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, "runs.jsonl"), JSON.stringify({ t: new Date().toISOString(), run: this.runId, kind: this.kind, ...line }) + "\n");
    } catch { /* never throws */ }
  }

  /** Keep the newest PORTAL_PAGE_CAPTURE_MAX pages (300) of this portal. */
  private prune(pagesDir: string): void {
    try {
      const max = numEnv("PORTAL_PAGE_CAPTURE_MAX", 300);
      const pages = fs.readdirSync(pagesDir).filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, t: fs.statSync(path.join(pagesDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of pages.slice(max)) {
        fs.rmSync(path.join(pagesDir, f), { force: true });
        fs.rmSync(path.join(pagesDir, f.replace(/\.json$/, ".png")), { force: true });
      }
    } catch { /* never throws */ }
  }
}
