// ---------------------------------------------------------------------------
// RETRIEVE A PUBLIC DOCUMENT THE WAY A PERSON WOULD.
//
// The fee researcher reported found:false for the City of Coos Bay and gave an honest
// refusal — it could not retrieve the fee schedule. The operator then found it in their
// browser in seconds. The researcher was right that the document was hard to REACH and
// wrong about why: coosbayor.gov sits behind Akamai (Server: AkamaiGHost) and returns 403
// to EVERY programmatic client — WebFetch, curl with a real browser User-Agent, and even
// headless Playwright. A HEADED Chromium with --disable-blink-features=AutomationControlled
// gets 200, and fetching the PDF THROUGH that page context (same cookies, same TLS
// fingerprint) returns the 1.2 MB application/pdf that curl was refused.
//
// So this module is a ladder, cheapest rung first, because a browser launch costs 1-2s and
// the overwhelming majority of jurisdictions need none of it:
//
//   1. plain fetch with a real browser User-Agent;
//   2. on 401/403/429 — or a 200 that is really a bot wall — a HEADED Chromium: warm the
//      session on the document's ORIGIN first (that is when the WAF sets its cookie), then
//      retrieve the document from inside the page;
//   3. give up with a REASON that names what blocked it — status and Server header — never
//      a silent "".
//
// WHAT THIS IS NOT:
//
// * PUBLIC DOCUMENTS ONLY. No credential is ever attached: there is no options field for a
//   cookie, a header, a token or a password, and a URL carrying user:pass@ is refused
//   outright. Nothing here logs in, and it must never be pointed at a portal we hold an
//   account on — that is what portal-bot is for, with its stored credentials, its profile
//   locks and its human gates. A fee schedule is a public PDF; keep it that way.
//
// * NOT A CAPTCHA SOLVER. CLAUDE.md rule 1 is that automation never solves CAPTCHA/MFA, and
//   nothing we could learn from a fee schedule is worth approaching that line. A response
//   that is an interactive human-verification puzzle ends the ladder with ok:false and the
//   challenge named — we do not escalate INTO it and we do not retry it.
//
// * A ROBOTS-STYLE REFUSAL IS HONOURED. A 403 whose body is plainly a "no automated access"
//   notice is the site telling us its terms, not a WAF guessing at our browser. Those are
//   reported refused and the ladder STOPS — a headed window would be a way around a decision
//   rather than around a misdetection. The distinction is the whole reason the two are
//   classified separately below.
//
// * NOT A WAY INTO THE LAN (issue #391). The form-fill tool hands this module URLs an API-key
//   holder typed, so the URL and EVERY redirect hop must resolve to a public address
//   (publicUrlGuard.ts, the same predicate the AHJ form-template fetch asks). Redirects are
//   followed by hand so the question is asked before each request, not once at the top; a
//   refused hop ends the ladder with `privateTarget` set and nothing sent there. The connection
//   itself dials only the addresses that were judged (#407, publicDispatcher), and the headed
//   window asks the same question of every request and redirect it makes (guardBrowserHops).
//
// * BOUNDED: every rung has a timeout, one browser runs at a time, and the session is closed
//   in a finally whatever happens.
//
// The WAF vocabulary is NOT redefined here. looksBotBlocked lives in runAbort.ts because the
// same concept once lived in three places and the copies drifted; this is the fourth caller,
// not a fourth definition.
// ---------------------------------------------------------------------------
import pLimit from "p-limit";
import { logger } from "./logger";
import { connectTimeRefusal, judgedFetchInit, publicUrlRefusal } from "./publicUrlGuard";
import { looksBotBlocked } from "./runAbort";

export type FetchVia = "http" | "browser";

export interface FetchedDocument {
  ok: boolean;
  /** HTTP status of the attempt we are reporting on. 0 when nothing was ever sent. */
  status: number;
  contentType: string;
  bytes?: Uint8Array;
  /** Decoded body, set only when the content is text-ish (html, xml, json, plain). */
  text?: string;
  via: FetchVia;
  /** ALWAYS populated, success or failure. On a refusal it names what blocked us. */
  reason: string;
  /** The URL the bytes actually came from, after redirects — resolve links against this. */
  finalUrl: string;
  /** Set when the URL, or a redirect hop, pointed at a private/loopback/link-local address and
   *  was refused before any request went there. The refused URL. A caller at a route edge
   *  answers this with a 400: the caller asked for something the server will not fetch. */
  privateTarget?: string;
  /** Set when NOTHING was sent because this host refused automated clients within the last hour
   *  (#130): the reason names that earlier refusal. A caller can tell this from a 404 or a dead
   *  host — it is "do not ask this site again", not "this page is missing". */
  hostBackedOff?: true;
  /** THE LADDER'S OWN VERDICT (#130): the site refused automated clients THIS document at the
   *  best try the caller was permitted — a challenge, a stated notice, a window refused, a plain
   *  403 with no window to climb to (forbidden, or already tried and refused on this host), or a
   *  host backed off before anything was sent. NOT set for a 404, a network failure, a launch
   *  failure, an in-page throw or timeout, an over-cap body or a refusal that is ours (private
   *  address, the caller's door): those are not the site's answer. A caller reads this, never
   *  status + reason, so "did the site refuse us" has one answer. */
  siteRefused?: true;
  /** Set beside siteRefused when the refusal read as the HOST's, not this one document's: a
   *  challenge, a stated notice, HTTP 429, or a second document refused on the host within the
   *  hour. Names the host that answered (the redirect landing host when the ladder followed one),
   *  which is now backed off, process-wide, for an hour. A caller stops asking that host; absent,
   *  the host's other documents may still answer. */
  refusedHost?: string;
}

export interface DocumentLink {
  text: string;
  href: string;
}

/**
 * The narrow slice of a browser this module needs. Kept to three methods so a test can
 * supply a fake and never launch Chromium — and so every decision about WHEN to escalate,
 * what counts as a wall, and what the reason says stays here rather than in the launcher.
 */
export interface DocumentBrowserSession {
  /** Navigate a real page. Used to warm the session on the origin, and to read rendered HTML. */
  visit(url: string, timeoutMs?: number): Promise<{ status: number | null; html: string; url?: string }>;
  /** Retrieve a URL from INSIDE the page context — same cookies, same TLS fingerprint. */
  fetchInPage(url: string, timeoutMs?: number): Promise<{ status: number; contentType: string; bytes: Uint8Array; url?: string }>;
  close(): Promise<void>;
}

/** What kind of request a browser hop is: a 3xx Location the window is about to follow, a
 *  document the window is about to load (a navigation the page itself started, a meta refresh),
 *  or anything else the page asks for. */
export type BrowserHopKind = "redirect" | "navigation" | "subresource";
/** The question a launcher asks before its browser sends a request or follows a redirect: the
 *  refusal (do NOT send / follow it) or null (go ahead). Asked by the launcher, answered here, so
 *  the rule stays publicUrlGuard's and a launcher only has to wire it in (#407). */
export type BrowserHopJudge = (url: string, kind: BrowserHopKind) => Promise<string | null>;

export type DocumentBrowserLauncher = (opts: { timeoutMs: number; judgeHop: BrowserHopJudge }) => Promise<DocumentBrowserSession>;

export interface FetchPublicDocumentOptions {
  /** Budget for the plain-HTTP rung. Default 20s. */
  timeoutMs?: number;
  /** Budget for the whole browser rung — launch, warm and retrieve. Default 45s. */
  browserTimeoutMs?: number;
  /** Set false to forbid the browser rung entirely (also DOCUMENT_FETCH_BROWSER=0). */
  allowBrowser?: boolean;
  /** Take the page's RENDERED DOM instead of the raw bytes. What link discovery wants. */
  render?: boolean;
  /** Refuse anything larger. Default 32 MB — a fee schedule is ~1 MB. */
  maxBytes?: number;
  /** Injected for tests. Production uses the headed-Chromium launcher below. */
  launcher?: DocumentBrowserLauncher;
  userAgent?: string;
  /** THE CALLER'S OWN DOOR, asked of the URL and of EVERY redirect hop before it is requested:
   *  a refusal (do not go there) or null. The permit monitor's issued-document fetch passes rule
   *  5's track predicate and "the record's own portal" here (portalIssuedDocuments.ts), so a hop
   *  onto the other track's portal is refused before anything is sent to it, exactly as a private
   *  address is. Setting it also forbids the browser rung: a window follows its own redirects,
   *  and only publicUrlGuard is wired into it. */
  allowUrl?: (url: string) => string | null;
}

// A current desktop Chrome. The point of the first rung is to look like what a person uses;
// Node's default "undici" User-Agent is refused by a good number of government CDNs on its
// own, before any fingerprinting is involved.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** Redirect hops followed by hand (fetch's own default is 20; a document needs a few). */
const MAX_REDIRECTS = 10;
/** Past this, a body is a document, not a block page — never classify it as a wall. */
const WALL_BODY_MAX = 100_000;

// ONE BROWSER AT A TIME. A research sweep over forty jurisdictions that escalated on ten of
// them would otherwise open ten headed windows at once on somebody's laptop.
const browserGate = pLimit(1);

// ---------------------------------------------------------------------------
// PER-HOST POLITENESS, PROCESS-WIDE (#130; memory: go gently on Cloudflare sites — same IP as the
// production bot). Fee research opened 17 headed windows against one Cloudflare-walled host in 80 s:
// browserGate serialises windows, it remembers nothing, so every walled URL earned its own window
// and every window was refused the same way. ONE record per host, shared by every caller of this
// module (fee research, the harvest, form acquisition, the lookup's page reader):
//   - >= HOST_MIN_GAP_MS between the end of one ladder on a host and the start of the next, chained
//     per host (two callers on one host queue; other hosts are not held up) — the same gap and the
//     same shape as agencyPageReader, which used to be the only polite path;
//   - a host that REFUSED us is backed off for HOST_BACK_OFF_MS: a later call sends nothing and
//     says so (hostBackedOff), so the caller can tell it from a 404.
// TWO SCOPES OF REFUSAL, because a bare 403 on ONE object is byte-for-byte an S3 AccessDenied on a
// stale link or an Apache 403 on a directory, not a host wall — and the body cannot split them (the
// WAF's stock page and Apache's both read "Forbidden"; S3's reads "Access Denied"). So:
//   - ONE document refused at our best permitted try costs the host its WINDOW for the hour (one
//     window per walled host) and nothing more: its siblings are still read, plainly, 10 s apart;
//   - a SECOND document refused on the host within the hour is the host refusing us: backed off;
//   - a challenge, a stated no-robots notice or HTTP 429 is the host's answer on the first strike.
// "Our best permitted try" is: the window (refused: wall, challenge, notice), or the plain rung when
// the PROCESS forbids the window (DOCUMENT_FETCH_BROWSER=0 — nobody here will ever try harder). It is
// NOT a plain 403 with the window forbidden by the CALLER (allowBrowser:false, allowUrl): the lookup's
// page reader runs on every AHJ host just BEFORE fee research and forbids the window; had its 403
// counted, the one window the fee pass is allowed would never open and Coos Bay — the reason this
// module exists — would be lost. Nor a launch failure, an in-page throw or timeout, or a private
// redirect: those are ours, not the site's. The host STAMPED is the one that ANSWERED: a city page
// that 302s to a vendor object that 403s stamps the vendor, never the city.
// ---------------------------------------------------------------------------
/** The owner's rule, in one constant: >= 10 s between requests to one host. agencyPageReader's
 *  PAGE_READ_MIN_GAP_MS is this value re-exported. */
export const HOST_MIN_GAP_MS = 10_000;
/** A refusal backs a host off for an hour (the server is long-running: one transient 429 must not
 *  silence a host for the life of the process), then it may be asked again — once. */
export const HOST_BACK_OFF_MS = 60 * 60 * 1000;
interface HostRecord {
  lastRequestAt?: number;
  /** HOST-level: nothing is sent to this host before refusedAt + HOST_BACK_OFF_MS. */
  refusedAt?: number;
  refusedReason?: string;
  /** ONE document refused at our best permitted try (the URL it was answered from): no second
   *  window on this host before documentRefusedAt + HOST_BACK_OFF_MS; a DIFFERENT document refused
   *  within that hour escalates to the host-level refusal above. */
  documentRefusedAt?: number;
  documentRefusedUrl?: string;
  documentRefusedReason?: string;
}
/** A refusal's scope: one document's, or the host's. */
export type RefusalScope = "document" | "host";
const hostRecords = new Map<string, HostRecord>();
const hostChain = new Map<string, Promise<unknown>>();
interface PolitenessSeams { sleep: (ms: number) => Promise<void>; now: () => number; minGapMs: number }
const REAL_POLITENESS: PolitenessSeams = { sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), now: () => Date.now(), minGapMs: HOST_MIN_GAP_MS };
let politeness: PolitenessSeams = { ...REAL_POLITENESS };
/** Tests only: forget every host (documentFetch.test plays several jurisdictions on one origin). */
export function _resetHostPoliteness(): void { hostRecords.clear(); hostChain.clear(); }
/** Tests only: a clock and a sleep that record instead of waiting, or a zero gap for a suite whose
 *  loopback stub stands in for twenty public hosts. Not an operator knob — the gap is the rule. */
export function _setDocumentFetchPoliteness(seams: Partial<PolitenessSeams>): void { politeness = { ...REAL_POLITENESS, ...seams }; }

/** THE HOST A REQUEST IS COUNTED AGAINST: case folded, a leading "www." folded (the observed
 *  failure hit bendoregon.gov AND www.bendoregon.gov — two records would halve the rule), the
 *  port kept. Nothing else is folded: permits.example.gov is not example.gov, and a tenant
 *  subdomain of a shared vendor host is its own host. "" for a non-URL. */
export function politeHostOf(url: string | URL): string {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return u.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
const recordOf = (host: string): HostRecord => {
  let r = hostRecords.get(host);
  if (!r) { r = {}; hostRecords.set(host, r); }
  return r;
};
/** The live refusal on a host, or null — an expired one is forgotten here. */
function hostRefusal(host: string): Required<Pick<HostRecord, "refusedAt" | "refusedReason">> | null {
  const r = hostRecords.get(host);
  if (!r?.refusedAt) return null;
  if (politeness.now() - r.refusedAt > HOST_BACK_OFF_MS) { delete r.refusedAt; delete r.refusedReason; return null; }
  return { refusedAt: r.refusedAt, refusedReason: r.refusedReason ?? "" };
}
/** The live one-document refusal on a host (the window it had this hour was refused), or null. */
function hostDocumentRefusal(host: string): { url: string; reason: string; at: number } | null {
  const r = hostRecords.get(host);
  if (!r?.documentRefusedAt) return null;
  if (politeness.now() - r.documentRefusedAt > HOST_BACK_OFF_MS) { delete r.documentRefusedAt; delete r.documentRefusedUrl; delete r.documentRefusedReason; return null; }
  return { url: r.documentRefusedUrl ?? "", reason: r.documentRefusedReason ?? "", at: r.documentRefusedAt };
}
function noteRequest(host: string): void { if (host) recordOf(host).lastRequestAt = politeness.now(); }
/** The site refused our best permitted try on `url`, answered from `answering` (the redirect
 *  landing host when the ladder followed one — the host that actually said no, which is the one
 *  the next request must not go to; the original host is stamped only when it answered itself).
 *  A "document" refusal becomes the host's when it is the SECOND document within the hour. Returns
 *  the scope that was recorded. */
function noteRefused(answering: string, url: string, reason: string, scope: RefusalScope): RefusalScope {
  if (!answering) return scope;
  const r = recordOf(answering);
  const now = politeness.now();
  if (scope === "document") {
    const earlier = hostDocumentRefusal(answering);
    if (!earlier || earlier.url === url) {
      r.documentRefusedAt = earlier?.at ?? now;
      r.documentRefusedUrl = url;
      r.documentRefusedReason = reason.slice(0, 200);
      logger.info("document-fetch", "a document refused automated clients — no second window on this host for an hour; its other documents are still read", { host: answering, url });
      return "document";
    }
    reason = `two documents refused within the hour — ${earlier.url} and ${url}; ${reason}`;
    logger.info("document-fetch", "a SECOND document refused automated clients — the host refuses us", { host: answering, first: earlier.url, second: url });
  }
  r.refusedAt = now;
  r.refusedReason = reason.slice(0, 300);
  logger.info("document-fetch", "host refused automated clients — backed off, not asked again for an hour", { host: answering, url });
  return "host";
}
function backedOffResult(host: string, refusal: { refusedAt: number; refusedReason: string }, url: string): FetchedDocument {
  const agoMin = Math.max(0, Math.round((politeness.now() - refusal.refusedAt) / 60_000));
  const until = new Date(refusal.refusedAt + HOST_BACK_OFF_MS).toISOString();
  return {
    ok: false, status: 0, contentType: "", via: "http", finalUrl: url, hostBackedOff: true, siteRefused: true, refusedHost: host,
    reason: `${host} refused automated clients ${agoMin} min ago (${refusal.refusedReason}) — backed off: nothing was sent, and the host is not asked again before ${until}.`,
  };
}
/** The verdict fields a refused result carries, by the scope noteRefused recorded. */
const refusedFields = (scope: RefusalScope, answering: string): Pick<FetchedDocument, "siteRefused" | "refusedHost"> =>
  scope === "host" ? { siteRefused: true, refusedHost: answering } : { siteRefused: true };

const REFUSED_REASON = /refus|challenge|captcha|no automated|robots|wall|HTTP 40[13]\b|HTTP 429\b/i;
/** A REFUSAL backs a host off; a MISSING PAGE does not (close F7: an Apache 404 on a county's site was
 *  classed "refused an ordinary HTTP client" and silenced the host for an hour — its permit-packets
 *  page was then never read). 401 / 403 / 429 always refuse; a challenge / wall / "no automated
 *  access" notice refuses unless the server said the page is not there (404 / 410). ONE predicate for
 *  "was this not-ok result the site refusing us?" — agencyPageReader, ahjFormAuto and the fee
 *  researcher all ask it here. */
export function isRefusal(status: number, reason: string): boolean {
  if ([401, 403, 429].includes(status)) return true;
  if (status === 404 || status === 410) return false;
  return REFUSED_REASON.test(String(reason ?? ""));
}

// An INTERACTIVE human-verification puzzle. Not a thing we get past, by policy and by taste.
const CAPTCHA =
  /recaptcha|hcaptcha|cf-turnstile|turnstile|captcha|press (and|&) hold|verify (that )?you are (a )?human|i'?m not a robot|are you a human|complete the (security )?challenge/i;

// The site stating its TERMS rather than guessing at our browser. A headed window would be a
// way around a decision, so this rung of the ladder stops here.
const ROBOTS_REFUSAL =
  /automated (access|requests?|queries|traffic|tools?)[^.]{0,40}(is|are)? ?(not (permitted|allowed)|prohibited|disallowed|forbidden|blocked)|no bots?\b|bots? (are|is) not (permitted|allowed|welcome)|(scraping|crawling|data mining)[^.]{0,30}(prohibited|not permitted|not allowed)|(disallowed by|violates?|see) (our )?robots\.txt|robots\.txt (disallows?|forbids)|terms of (use|service)[^.]{0,40}(prohibit|forbid)/i;

type Refusal = "captcha" | "robots" | "wall" | "none";

/**
 * What KIND of refusal is this, if any? Order matters and is the policy:
 * a puzzle is never escalated into, a stated refusal is never worked around, and only a
 * generic wall — the Akamai/Cloudflare "Access Denied" aimed at whatever client we are —
 * earns a real window.
 */
function classifyRefusal(status: number, contentType: string, body: string | undefined, bodyBytes?: number): Refusal {
  const textish = isTextish(contentType);
  // THE SIZE GUARD HAS TO SEE THE TRUE SIZE, NOT THE PEEK.
  //
  // WALL_BODY_MAX says "past this, a body is a document, not a block page". But peekText hands
  // this function at most WALL_BODY_MAX characters, so testing the SNIPPET's length asks "is
  // the peek no longer than the peek is allowed to be?" — true for every oversized page there
  // is. The guard was inert on the one path that needed it, and the bigger the page the more
  // certainly it was classified.
  //
  // What that cost, measured on two jurisdictions in one harvest: coosbayor.gov's real
  // 125,692-byte home page and cityofpsl.com's 159,684-byte "Permit Applications, Fees and
  // Checklists" page both answered HTTP 200 with the whole page in hand, and both were thrown
  // away as "a human-verification challenge — a person must retrieve this one". Neither site
  // challenged anything. Both carry Akamai's own mPulse telemetry beacon
  // (...clientnsv4-s.AKAMAIHD.net), and "akamai" is a wall word in the shared predicate, so
  // the CDN's signature on a page it served successfully read as the CDN refusing us.
  //
  // That is this module's own failure mode inverted: it exists because a refused document must
  // never look like a document that does not exist, and here a document we HELD was reported
  // as a wall. A false wall is worse than a missed one — it is a reason an operator believes.
  const size = bodyBytes ?? (body ? body.length : 0);
  const snippet = textish && body && size <= WALL_BODY_MAX ? body : "";
  // A FILTER LIST FAILS BOTH WAYS, so these two regexes only get to speak about a page that
  // is ALREADY refusing us. /home/showpublisheddocument is CivicPlus — the platform Coos Bay
  // itself runs — and those sites load reCAPTCHA for their own contact and search widgets and
  // carry a "use of automated tools is prohibited" line in the footer. Run unguarded, the
  // classifier reads that furniture as a wall and refuses the very document search this
  // module exists to read, with a reason ("a human-verification challenge") the researcher
  // would then pass on as fact. A genuine 200 interstitial still classifies, because
  // "checking your browser" / "verify you are human" / perimeterx trip looksBotBlocked on
  // their own — a block page says it is one.
  const refusing = status === 401 || status === 403 || status === 429 || (snippet !== "" && looksBotBlocked(snippet));
  if (snippet && refusing) {
    if (CAPTCHA.test(snippet)) return "captcha";
    if (ROBOTS_REFUSAL.test(snippet)) return "robots";
  }
  // A refusal aimed at the CLIENT. Status alone is enough: an Akamai 403 can come with an
  // empty body, and "403 with no explanation" is exactly the Coos Bay case.
  if (status === 401 || status === 403 || status === 429) return "wall";
  // A 200 (or a 503) that is really a block page. Only the body can say so, and only
  // looksBotBlocked gets to decide — see the header.
  if (snippet && looksBotBlocked(snippet)) return "wall";
  return "none";
}

function isTextish(contentType: string): boolean {
  return /text\/|json|xml|html|javascript|^$/i.test(contentType.split(";")[0].trim());
}

/** A public http(s) URL with nothing that could carry a credential. */
function validateUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Not a URL: ${String(raw).slice(0, 120)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `Refused: ${url.protocol} is not a public web URL — this fetcher only speaks http(s).` };
  }
  if (url.username || url.password) {
    // The one hard line this module draws about itself, drawn in code rather than in prose.
    return { error: "Refused: the URL carries credentials. This fetcher retrieves PUBLIC documents and never authenticates." };
  }
  return { url };
}

function describeStatus(status: number, server: string): string {
  const who = server ? ` (server: ${server})` : "";
  return `HTTP ${status}${who}`;
}

function decodeText(bytes: Uint8Array, contentType: string): string | undefined {
  if (!isTextish(contentType)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A peek at the body for classification, even when the body is not the document's real type. */
function peekText(bytes: Uint8Array, contentType: string): string | undefined {
  if (!isTextish(contentType)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, WALL_BODY_MAX));
  } catch {
    return undefined;
  }
}

interface HttpAttempt {
  status: number;
  contentType: string;
  server: string;
  bytes: Uint8Array;
  finalUrl: string;
  networkError?: string;
  /** The URL the guard refused (the first one, or a redirect hop). Nothing was sent to it. */
  refusedUrl?: string;
  refusal?: string;
  /** The refusal was the caller's allowUrl, not a private address. */
  callerRefused?: boolean;
  /** A redirect hop pointed at a host that is backed off (#130): nothing was sent to it. */
  backedOffHost?: { host: string; refusedAt: number; refusedReason: string };
}

async function httpAttempt(
  url: string,
  opts: { timeoutMs: number; userAgent: string; maxBytes: number; allowUrl?: (url: string) => string | null },
): Promise<HttpAttempt> {
  const blank: HttpAttempt = { status: 0, contentType: "", server: "", bytes: new Uint8Array(0), finalUrl: url };
  // ONE deadline for the whole chain, as fetch's own redirect:"follow" had.
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      // ASK BEFORE EVERY REQUEST. redirect:"follow" asked nothing past the first URL, so a public
      // host answering 302 Location: http://169.254.169.254/ took the server there (#391).
      const refusal = await publicUrlRefusal(current);
      if (refusal) return { ...blank, finalUrl: current, refusedUrl: current, refusal };
      // A hop onto a host that refused us within the hour is not followed (#130): the first URL's
      // host was asked at the door; a redirect names a host nobody asked about yet.
      if (hop > 0) {
        const hopHost = politeHostOf(current);
        const backedOff = hostRefusal(hopHost);
        if (backedOff) return { ...blank, finalUrl: current, backedOffHost: { host: hopHost, ...backedOff } };
      }
      // The caller's own door, asked of the same URL at the same moment (allowUrl).
      const callerRefusal = opts.allowUrl ? opts.allowUrl(current) : null;
      if (callerRefusal) return { ...blank, finalUrl: current, refusedUrl: current, refusal: callerRefusal, callerRefused: true };
      // ...AND AGAIN AT CONNECT TIME (#407): the check above and the connection are two lookups,
      // so the connection goes through a dispatcher that judges the addresses it dials.
      const res = await fetch(current, {
        ...(judgedFetchInit(current) as RequestInit),
        redirect: "manual",
        signal,
        // NO cookies, NO authorization, NO credentials of any kind. A plain public GET.
        headers: {
          "user-agent": opts.userAgent,
          accept: "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) return { ...blank, status: res.status, finalUrl: current, networkError: `more than ${MAX_REDIRECTS} redirects` };
        const next = new URL(location, current);
        // The URL check at the door, re-asked of the hop: a redirect is a URL too, and one carrying
        // user:pass@ is as much a credential as the first.
        if (next.username || next.password) {
          return { ...blank, status: res.status, finalUrl: current, networkError: "a redirect pointed at a URL that carries credentials" };
        }
        current = next.toString();
        continue;
      }
      const contentType = res.headers.get("content-type") || "";
      const server = res.headers.get("server") || "";
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared && declared > opts.maxBytes) {
        await res.body?.cancel().catch(() => {});
        return { ...blank, status: res.status, contentType, server, finalUrl: current, networkError: `document is ${declared} bytes, over the ${opts.maxBytes}-byte cap` };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > opts.maxBytes) {
        return { ...blank, status: res.status, contentType, server, finalUrl: current, networkError: `document is ${bytes.length} bytes, over the ${opts.maxBytes}-byte cap` };
      }
      return { status: res.status, contentType, server, bytes, finalUrl: current };
    }
  } catch (err) {
    // A name that answered public to the check and private to the connection: the same refusal
    // as the check's, and nothing was sent (the socket never opened).
    const refusal = connectTimeRefusal(err);
    if (refusal) return { ...blank, finalUrl: current, refusedUrl: current, refusal };
    return { ...blank, finalUrl: current, networkError: err instanceof Error ? err.message : String(err) };
  }
}

/** DOCUMENT_FETCH=off: this installation never downloads a public document. ONE predicate,
 *  read per call: fetchPublicDocument below and ahjForms.fetchFormTemplate (which keeps its
 *  own SSRF-guarded fetch, so it cannot route through here) both ask THIS function — two
 *  copies of the regex is how one of them stopped honouring the switch. */
export function documentFetchDisabled(): boolean {
  return /^(off|0|false)$/i.test(String(process.env.DOCUMENT_FETCH ?? "").trim());
}

/**
 * Retrieve a PUBLIC document, escalating from a plain fetch to a real window only when the
 * far end refuses the plain one. Never throws: every outcome is a FetchedDocument whose
 * `reason` says what happened.
 */
export async function fetchPublicDocument(url: string, opts: FetchPublicDocumentOptions = {}): Promise<FetchedDocument> {
  const checked = validateUrl(url);
  if ("error" in checked) {
    return { ok: false, status: 0, contentType: "", via: "http", reason: checked.error, finalUrl: url };
  }
  // DOCUMENT_FETCH=off: an offline install (the demo kit) never downloads. Every public-
  // document fetch — blank AHJ forms, fee schedules, the headed-browser fallback below —
  // passes through here, so this one line is what makes "nothing outbound" true rather than
  // true-while-every-template-happens-to-be-on-disk. Same shape as any refusal: status 0,
  // nothing was ever sent, and every caller already handles a not-ok result.
  if (documentFetchDisabled()) {
    return { ok: false, status: 0, contentType: "", via: "http", reason: "Document downloads are off on this installation (DOCUMENT_FETCH=off).", finalUrl: url };
  }
  const host = politeHostOf(checked.url);
  // A host that refused us within the hour is not asked: nothing is sent, and the reason says so.
  const refused = hostRefusal(host);
  if (refused) return backedOffResult(host, refused, url);
  // ONE HOST AT A TIME, >= the gap apart — chained per host, process-wide, the ladder held inside
  // the chain so a window's own requests count too. The refusal is re-read after the wait: ten
  // callers that arrived together must not all climb because none had stamped the host yet.
  const prev = hostChain.get(host) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async (): Promise<FetchedDocument> => {
    const wait = (hostRecords.get(host)?.lastRequestAt ?? 0) + politeness.minGapMs - politeness.now();
    if (wait > 0 && politeness.minGapMs > 0) await politeness.sleep(wait);
    const again = hostRefusal(host);
    if (again) return backedOffResult(host, again, url);
    return runLadder(checked.url, host, opts);
  });
  hostChain.set(host, run);
  try {
    return await run;
  } finally {
    if (hostChain.get(host) === run) hostChain.delete(host);
  }
}

/** The ladder proper, for one URL whose host's turn it is. */
async function runLadder(url: URL, host: string, opts: FetchPublicDocumentOptions): Promise<FetchedDocument> {
  const checked = { url };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = opts.userAgent || BROWSER_UA;

  const attempt = await httpAttempt(checked.url.toString(), { timeoutMs, userAgent, maxBytes, allowUrl: opts.allowUrl });
  // The gap clock starts when something was actually sent: a URL the guard refused at hop 0 was
  // never a request. A redirect onto another host starts THAT host's clock too.
  if (attempt.refusedUrl !== checked.url.toString()) noteRequest(host);
  const landing = attempt.refusedUrl || attempt.backedOffHost ? "" : politeHostOf(attempt.finalUrl);
  if (landing && landing !== host) noteRequest(landing);
  // The host that ANSWERED, which is the one a refusal is counted against.
  const answering = landing || host;

  if (attempt.backedOffHost) {
    // A redirect onto a host that refused us this hour: the hop was not followed. The reason names
    // that host, not this URL's, so the caller stops asking the right one.
    const b = attempt.backedOffHost;
    return { ...backedOffResult(b.host, b, attempt.finalUrl), reason: `${checked.url.host} redirected to ${attempt.finalUrl}; ${backedOffResult(b.host, b, attempt.finalUrl).reason}` };
  }

  if (attempt.refusedUrl && attempt.callerRefused) {
    // Not a private address: a place the caller's own door does not open onto. Nothing was sent.
    return {
      ok: false,
      status: 0,
      contentType: "",
      via: "http",
      reason: attempt.refusedUrl === checked.url.toString()
        ? `Refused: ${attempt.refusal}`
        : `Refused: ${checked.url.host} redirected to ${attempt.refusedUrl}. ${attempt.refusal}`,
      finalUrl: attempt.refusedUrl,
    };
  }

  if (attempt.refusedUrl) {
    // Not a network failure and not a wall: the server will not go there. No browser either —
    // a window pointed at the same address would be the same request with more machinery.
    return {
      ok: false,
      status: 0,
      contentType: "",
      via: "http",
      reason: attempt.refusedUrl === checked.url.toString()
        ? `Refused: ${attempt.refusal}`
        : `Refused: ${checked.url.host} redirected to ${attempt.refusedUrl}. ${attempt.refusal}`,
      finalUrl: attempt.refusedUrl,
      privateTarget: attempt.refusedUrl,
    };
  }

  if (attempt.networkError) {
    // A dead host, a DNS failure or a timeout says nothing about robots, and a headed
    // browser cannot fix any of them — the same discipline runAbort.ts applies to portals.
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      via: "http",
      reason: `No usable response from ${checked.url.host}: ${attempt.networkError}`,
      finalUrl: attempt.finalUrl,
    };
  }

  const peek = peekText(attempt.bytes, attempt.contentType);
  const refusal = classifyRefusal(attempt.status, attempt.contentType, peek, attempt.bytes.length);
  /** The host a refusal's reason names: the one whose bytes these are (the redirect landing), with
   *  the URL's own host beside it when the link went elsewhere — a reason must not blame the city
   *  for its vendor's 403. */
  const answeredBy = (() => {
    let landed = "";
    try { landed = new URL(attempt.finalUrl).host; } catch { /* not a URL: the asked host stands */ }
    return landed && landed !== checked.url.host ? `${landed} (redirected from ${checked.url.host})` : checked.url.host;
  })();

  if (attempt.status >= 200 && attempt.status < 300 && refusal === "none") {
    return {
      ok: true,
      status: attempt.status,
      contentType: attempt.contentType,
      bytes: attempt.bytes,
      text: decodeText(attempt.bytes, attempt.contentType),
      via: "http",
      reason: `${describeStatus(attempt.status, attempt.server)} — ${attempt.bytes.length} bytes of ${attempt.contentType || "unknown type"}`,
      finalUrl: attempt.finalUrl,
    };
  }

  if (refusal === "captcha") {
    // Policy ends the ladder here, so this IS the site's answer to our best permitted try — and a
    // challenge is the HOST's answer, not one object's.
    const reason = `${answeredBy} answered with a human-verification challenge (${describeStatus(attempt.status, attempt.server)}). `
      + "Automation never solves CAPTCHAs — a person must retrieve this one.";
    const scope = noteRefused(answering, attempt.finalUrl, reason, "host");
    return { ok: false, status: attempt.status, contentType: attempt.contentType, text: peek, via: "http", reason, finalUrl: attempt.finalUrl, ...refusedFields(scope, answering) };
  }

  if (refusal === "robots") {
    const reason = `${answeredBy} refuses automated clients by its own notice (${describeStatus(attempt.status, attempt.server)}). `
      + "Not escalated: that is a stated policy, not a misdetected browser.";
    const scope = noteRefused(answering, attempt.finalUrl, reason, "host");
    return { ok: false, status: attempt.status, contentType: attempt.contentType, text: peek, via: "http", reason, finalUrl: attempt.finalUrl, ...refusedFields(scope, answering) };
  }

  if (attempt.status === 429) {
    // "Too many requests" is the host asking us to stop; a window right behind it is the
    // opposite of polite, and no window makes a rate limit go away.
    const reason = `${describeStatus(attempt.status, attempt.server)} from ${answeredBy} — the host is rate-limiting automated clients. Not escalated: backed off instead.`;
    const scope = noteRefused(answering, attempt.finalUrl, reason, "host");
    return { ok: false, status: attempt.status, contentType: attempt.contentType, text: peek, via: "http", reason, finalUrl: attempt.finalUrl, ...refusedFields(scope, answering) };
  }

  if (refusal !== "wall") {
    // An ordinary HTTP failure: 404, 500, a redirect loop. Nothing a window changes.
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      text: peek,
      via: "http",
      reason: `${describeStatus(attempt.status, attempt.server)} from ${checked.url.host}`,
      finalUrl: attempt.finalUrl,
    };
  }

  const blocked = `${describeStatus(attempt.status, attempt.server)} from ${answeredBy} — the site refused an ordinary HTTP client`;
  const processForbidsWindow = process.env.DOCUMENT_FETCH_BROWSER === "0";
  const browserAllowed = opts.allowBrowser !== false && !opts.allowUrl && !processForbidsWindow;
  if (!browserAllowed) {
    // This caller's best permitted try was refused: the verdict says so. It COUNTS against the
    // host only when the PROCESS forbids the window — nobody here will try harder — never when the
    // caller alone would not climb (see the header: the lookup's reader must not cost the fee
    // pass its one window).
    const reason = `${blocked}, and the browser fallback is switched off (DOCUMENT_FETCH_BROWSER=0 / allowBrowser:false).`;
    const scope = processForbidsWindow ? noteRefused(answering, attempt.finalUrl, reason, "document") : "document";
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      text: peek,
      via: "http",
      reason,
      finalUrl: attempt.finalUrl,
      ...refusedFields(scope, answering),
    };
  }

  /** ONE WINDOW PER WALLED HOST: the host that answered already had its window this hour and
   *  refused it, so this wall gets no second one. The plain refusal stands as this document's
   *  answer — and if it is a different document from the one the window was refused on, the host
   *  has now refused two and is backed off. */
  const windowWithheld = (): FetchedDocument | null => {
    const had = hostDocumentRefusal(answering);
    if (!had) return null;
    const until = new Date(had.at + HOST_BACK_OFF_MS).toISOString();
    const reason = `${blocked}; a real window on ${answering} was already tried once this hour and refused (${had.reason}) — not opened again before ${until}.`;
    const scope = noteRefused(answering, attempt.finalUrl, reason, "document");
    return { ok: false, status: attempt.status, contentType: attempt.contentType, text: peek, via: "http", reason, finalUrl: attempt.finalUrl, ...refusedFields(scope, answering) };
  };
  const withheld = windowWithheld();
  if (withheld) return withheld;

  return browserGate(async () => {
    // Re-read at the gate: another host's window may have run for a minute while this call
    // queued, and in that time this host may have refused somebody else's window.
    const meanwhile = hostRefusal(host) ?? hostRefusal(answering);
    if (meanwhile) return backedOffResult(hostRefusal(host) ? host : answering, meanwhile, checked.url.toString());
    const withheldMeanwhile = windowWithheld();
    if (withheldMeanwhile) return withheldMeanwhile;
    logger.info("document-fetch", "plain fetch was refused — retrying with a real window", {
      host: checked.url.host,
      status: attempt.status,
      server: attempt.server || undefined,
    });
    try {
      return await browserAttempt(checked.url, {
        launcher: opts.launcher || headedChromiumLauncher,
        timeoutMs: opts.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
        maxBytes,
        render: opts.render === true,
        blocked,
        httpStatus: attempt.status,
        // The window was the one try this host gets. Refused on one object: no second window this
        // hour. Refused with a challenge, a notice or a 429, or on a second object: backed off. The
        // host counted is the one the window's bytes came from — and when the window did not say
        // where it landed, the host the plain rung landed on, never the URL's own host by default.
        onSiteRefusal: (reason, finalUrl, scope) => {
          const at = finalUrl || attempt.finalUrl;
          const from = politeHostOf(at) || answering;
          return { scope: noteRefused(from, at, reason, scope), host: from, at };
        },
      });
    } finally {
      // The window's own requests (the warm-up on the origin, the document wherever it redirected)
      // move the gap clock too — on both hosts when the plain rung landed elsewhere.
      noteRequest(host);
      if (answering !== host) noteRequest(answering);
    }
  });
}

async function browserAttempt(
  url: URL,
  cfg: {
    launcher: DocumentBrowserLauncher; timeoutMs: number; maxBytes: number; render: boolean; blocked: string; httpStatus: number;
    /** Called when the SITE refused the window (wall, challenge, notice) — not when the window
     *  could not start, threw, or was sent somewhere private. `scope` is what the refusal read as
     *  (a bare wall on one object: "document"; a challenge, a notice, a 429: "host"); the answer is
     *  the scope the host record ended up at, the host it was counted against, and the URL it was
     *  counted at (the result's finalUrl, so a caller names the host that answered). */
    onSiteRefusal?: (reason: string, finalUrl: string | undefined, scope: RefusalScope) => { scope: RefusalScope; host: string; at: string };
  },
): Promise<FetchedDocument> {
  const deadline = Date.now() + cfg.timeoutMs;
  const remaining = (): number => Math.max(1_000, deadline - Date.now());
  const fail = (reason: string, status = cfg.httpStatus): FetchedDocument =>
    ({ ok: false, status, contentType: "", via: "browser", reason, finalUrl: url.toString() });
  /** The site's refusal of the window: reported like any failure, the host told, and the result
   *  carrying the verdict (siteRefused, and refusedHost when it read as the host's). */
  const refusedBySite = (kind: Exclude<Refusal, "none">, reason: string, status: number, finalUrl?: string): FetchedDocument => {
    const from = finalUrl || url.toString();
    const scope: RefusalScope = kind === "wall" && status !== 429 ? "document" : "host";
    // The landing URL as the WINDOW reported it (undefined when it did not): the ladder falls back
    // to where its plain rung landed, which is the host that answered.
    const noted = cfg.onSiteRefusal?.(reason, finalUrl || undefined, scope) ?? { scope, host: politeHostOf(from), at: from };
    return { ...fail(reason, status), finalUrl: noted.at, ...refusedFields(noted.scope, noted.host) };
  };

  // THE WINDOW ASKS THE SAME QUESTION (#407). Chromium follows a page's redirects itself, so the
  // URL the plain rung judged is only the first of the window's requests. Every request it sends
  // and every redirect it is about to follow comes here first; a private one is failed before
  // Chromium acts on it. A refused redirect or document load ends the attempt, named, with
  // privateTarget set; a refused subresource (an <img> or a script's fetch into the LAN) is only
  // blocked, since the page around it is still the public page we asked for.
  const verdicts = new Map<string, Promise<string | null>>();
  const refusedHops: Array<{ url: string; kind: BrowserHopKind; refusal: string }> = [];
  const judgeHop: BrowserHopJudge = async (hopUrl, kind) => {
    let origin: string;
    try { origin = new URL(hopUrl).origin; } catch { origin = hopUrl; }
    // One verdict per origin per window: a page of forty images on one host is one lookup.
    let verdict = verdicts.get(origin);
    if (!verdict) { verdict = publicUrlRefusal(hopUrl).catch((e: unknown) => `could not be judged: ${e instanceof Error ? e.message : String(e)}`); verdicts.set(origin, verdict); }
    const refusal = await verdict;
    if (refusal) {
      refusedHops.push({ url: hopUrl, kind, refusal });
      logger.info("document-fetch", "a real window was refused a private address", { host: url.host, kind, target: hopUrl });
    }
    return refusal;
  };
  /** The attempt's outcome when the window was sent somewhere private, or null. */
  const privateOutcome = (): FetchedDocument | null => {
    const hop = refusedHops.find((h) => h.kind !== "subresource");
    if (!hop) return null;
    return {
      ok: false, status: 0, contentType: "", via: "browser",
      reason: `${cfg.blocked}. Refused: a real window on ${url.host} was ${hop.kind === "redirect" ? "redirected" : "sent"} to ${hop.url}. ${hop.refusal}`,
      finalUrl: hop.url,
      privateTarget: hop.url,
    };
  };

  let session: DocumentBrowserSession | null = null;
  try {
    try {
      session = await cfg.launcher({ timeoutMs: cfg.timeoutMs, judgeHop });
    } catch (err) {
      // A headed launch on a machine with no display is a real and common outcome. Say so
      // plainly rather than reporting it as the site blocking us.
      return fail(`${cfg.blocked}. The headed-browser fallback could not start (no display, or Chromium is not installed): `
        + `${err instanceof Error ? err.message : String(err)}`);
    }

    // RENDERED MODE: the page itself is the answer (this is what link discovery wants), so
    // navigating IS the retrieval and the DOM after scripts have run is the honest body.
    if (cfg.render) {
      let visited: Awaited<ReturnType<DocumentBrowserSession["visit"]>>;
      try {
        visited = await session.visit(url.toString(), remaining());
      } catch (err) {
        return privateOutcome() ?? fail(`${cfg.blocked}. A real window could not load the page: ${err instanceof Error ? err.message : String(err)}`);
      }
      const refusedPage = privateOutcome();
      if (refusedPage) return refusedPage;
      const status = visited.status ?? 200;
      const html = visited.html || "";
      const refusal = classifyRefusal(status, "text/html", html);
      if (refusal === "captcha") return refusedBySite("captcha", `${cfg.blocked}. A real window reached a human-verification challenge; automation stops there.`, status, visited.url);
      if (refusal === "robots") return refusedBySite("robots", `${cfg.blocked}. A real window reached the site's own "no automated access" notice.`, status, visited.url);
      if (refusal === "wall") return refusedBySite("wall", `${cfg.blocked}, and a real window was refused too (${describeStatus(status, "")}).`, status, visited.url);
      if (status >= 400) {
        // A 404 / 500 in the window is a missing page, not the site refusing us.
        return fail(`${cfg.blocked}, and a real window was refused too (${describeStatus(status, "")}).`, status);
      }
      const bytes = new TextEncoder().encode(html);
      return {
        ok: true, status, contentType: "text/html", bytes, text: html, via: "browser",
        reason: `${cfg.blocked}; a headed browser rendered it (HTTP ${status}, ${bytes.length} bytes).`,
        finalUrl: visited.url || url.toString(),
      };
    }

    // WARM THE SESSION ON THE ORIGIN FIRST. This is the step that made Coos Bay work: the
    // WAF hands its cookie to a page load, and the document request then carries it (and the
    // browser's TLS fingerprint) instead of arriving cold.
    try {
      await session.visit(url.origin, remaining());
    } catch (err) {
      logger.debug("document-fetch", "origin warm-up failed; trying the document anyway", {
        host: url.host, error: err instanceof Error ? err.message : String(err),
      });
    }
    // An origin that sends a window into the LAN is not one to ask for the document next.
    const refusedWarmUp = privateOutcome();
    if (refusedWarmUp) return refusedWarmUp;

    let got: { status: number; contentType: string; bytes: Uint8Array; url?: string };
    try {
      got = await session.fetchInPage(url.toString(), remaining());
    } catch (err) {
      return privateOutcome() ?? fail(`${cfg.blocked}. The in-page retrieval failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const refusedDocument = privateOutcome();
    if (refusedDocument) return refusedDocument;

    if (got.bytes.length > cfg.maxBytes) {
      return fail(`${cfg.blocked}. A real window got the document, but it is ${got.bytes.length} bytes, over the ${cfg.maxBytes}-byte cap.`, got.status);
    }

    const peek = peekText(got.bytes, got.contentType);
    const refusal = classifyRefusal(got.status, got.contentType, peek, got.bytes.length);
    if (refusal === "captcha") {
      return refusedBySite("captcha", `${cfg.blocked}. A real window was answered with a human-verification challenge; automation never solves those — a person must retrieve this one.`, got.status, got.url);
    }
    if (refusal === "robots") {
      return refusedBySite("robots", `${cfg.blocked}. A real window reached the site's own "no automated access" notice.`, got.status, got.url);
    }
    if (refusal === "wall") {
      // ONE escalation, not a loop: the ladder has no rung above a real window.
      return refusedBySite("wall", `${cfg.blocked}, and a real window was refused too (${describeStatus(got.status, "")}).`, got.status, got.url);
    }
    if (got.status < 200 || got.status >= 300) {
      return fail(`${cfg.blocked}, and a real window was refused too (${describeStatus(got.status, "")}).`, got.status);
    }

    return {
      ok: true,
      status: got.status,
      contentType: got.contentType,
      bytes: got.bytes,
      text: decodeText(got.bytes, got.contentType),
      via: "browser",
      reason: `${cfg.blocked}; a headed browser retrieved it (HTTP ${got.status}, ${got.bytes.length} bytes of ${got.contentType || "unknown type"}).`,
      finalUrl: got.url || url.toString(),
    };
  } finally {
    if (session) {
      try { await session.close(); } catch { /* a browser we could not close is not a result */ }
    }
  }
}

/**
 * Load a page the same escalating way and return its links, filtered.
 *
 * This is what turns "the jurisdiction's document search" into "the fee schedule PDF": the
 * Coos Bay search page lists "Fee Schedule - Resolution 26-30" as an ordinary anchor
 * pointing at /home/showpublisheddocument/570/..., and the whole trick is being able to READ
 * that page at all. Hrefs come back absolute, resolved against the FINAL url after redirects.
 */
export async function findDocumentLinks(
  url: string,
  opts: FetchPublicDocumentOptions = {},
  match: (link: DocumentLink) => boolean = () => true,
): Promise<DocumentLink[]> {
  const page = await fetchPublicDocument(url, { ...opts, render: true });
  if (!page.ok || !page.text) return [];
  const { load } = await import("cheerio");
  const $ = load(page.text);
  const base = page.finalUrl || url;
  const seen = new Set<string>();
  const out: DocumentLink[] = [];
  $("a[href]").each((_i, el) => {
    const raw = String($(el).attr("href") || "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) return;
    let href: string;
    try {
      href = new URL(raw, base).toString();
    } catch {
      return;
    }
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const link: DocumentLink = { text, href };
    if (!match(link)) return;
    const key = `${href}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(link);
  });
  return out;
}

// ---------------------------------------------------------------------------
// The production launcher: a REAL window.
//
// Headless is detected and refused — measured, not assumed: on coosbayor.gov headless
// Playwright got the same 403 as curl, and a headed Chromium got 200. Playwright is imported
// lazily so that nothing on the plain-fetch path (which is nearly every fetch) pays for it,
// and so the unit test stays browser-free.
// ---------------------------------------------------------------------------

// Same shim as portal-bot/src/browser.ts NAME_SHIM, and for the same reason: under tsx,
// esbuild's keepNames wraps named functions in a `__name(fn, "...")` call, which is undefined
// inside the page. A serialized function that hits it throws a ReferenceError that a catch
// turns into a silent "the site blocked us". Duplicated rather than imported so this module
// does not drag the portal machinery in behind it.
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (fn) { return fn; };";

const CHROMIUM_ARGS = [
  // The flag that does the work. Chromium advertises navigator.webdriver and a handful of
  // other automation tells; a WAF that scores them is exactly what refused us on rung one.
  "--disable-blink-features=AutomationControlled",
  "--window-size=1440,900",
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-extensions",
  "--disable-features=TranslateUI,AutofillAddressProfileSavePrompt,AutofillServerCommunication",
  "--disable-save-password-bubble",
];

/** The Chromium launcher, headed (production: headless is refused by the WAFs this rung exists
 *  for) or headless (the real-browser smoke, which has no display to open a window on). */
export function chromiumDocumentLauncher(headless: boolean): DocumentBrowserLauncher {
  return async ({ timeoutMs, judgeHop }) => {
    const { chromium } = await import("playwright");
    // Chromium does not inherit HTTPS_PROXY from the environment — it must be wired
    // explicitly, exactly as portal-bot/src/browser.ts does it.
    const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const proxy = httpsProxy
      ? { server: httpsProxy, bypass: ["127.0.0.1", "localhost", "[::1]", process.env.PORTAL_PROXY_BYPASS || ""].filter(Boolean).join(",") }
      : undefined;

    const browser = await chromium.launch({ headless, args: CHROMIUM_ARGS, proxy });
    try {
      // The hop guard goes on BEFORE the context and page exist, so every loader the window ever
      // has is created under it. Fail closed: a window whose redirects cannot be judged is not
      // opened at all (the attempt reports the launch failure).
      await guardBrowserHops(browser, judgeHop);
      // No storage state, no stored cookies, no credentials: a fresh anonymous window every
      // time, which is all a public document needs.
      const context = await browser.newContext({ viewport: null, proxy });
      await context.addInitScript({ content: NAME_SHIM });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      return buildSession(browser, context, page, timeoutMs);
    } catch (err) {
      // Setup failed after a successful launch: the caller never receives a session and so can
      // never close it. Tear the browser down here or the process leaks a window.
      await browser.close().catch(() => {});
      throw err;
    }
  };
}

export const headedChromiumLauncher: DocumentBrowserLauncher = chromiumDocumentLauncher(false);

/** One request as Fetch.requestPaused reports it: at the request stage (no response fields) or
 *  at the response stage (responseStatusCode set). */
interface PausedRequest {
  requestId: string;
  request?: { url?: string };
  resourceType?: string;
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

/**
 * JUDGE EVERY HOP AT THE BROWSER (#407): the same response-stage pattern the portal backstop uses
 * (portal-bot/src/filingBackstop.ts, joinRedirectGuard), cut down to one question. One
 * browser-level DevTools session pauses every request twice:
 *   - at the REQUEST stage, before it is sent: the URL is judged (a document load the page itself
 *     started, a meta refresh, a script's fetch, an <img>);
 *   - at the RESPONSE stage, before Chromium acts on it: a 3xx's Location is judged before the
 *     redirect is followed. Chromium never pauses a redirect's second leg at the request stage
 *     (that is why the backstop works at this stage), so this is where a redirect is caught.
 * A refused request or hop is failed (BlockedByClient) and never sent; anything else continues
 * untouched, so cookies, TLS and the redirect itself stay Chromium's own. A judge that throws
 * fails the request: unjudged is refused.
 *
 * What it cannot reach: Chromium's OWN resolver. The window resolves the name again when it
 * connects, so a rebinding resolver can still split the judged name from the dialled address
 * inside the window. The plain rung (which pins the address) is the door a URL from outside comes
 * through; this rung runs only on an operator's own fetch after a wall (#406).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function guardBrowserHops(browser: any, judge: BrowserHopJudge): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  session.on("Fetch.requestPaused", (e: PausedRequest) => {
    void (async () => {
      const atResponse = e.responseStatusCode !== undefined && e.responseStatusCode !== null;
      let target = "";
      let kind: BrowserHopKind = "subresource";
      const requestUrl = String(e.request?.url || "");
      if (atResponse) {
        const status = Number(e.responseStatusCode);
        const location = (e.responseHeaders || []).find((h) => /^location$/i.test(String(h?.name || "")))?.value;
        if (status >= 300 && status < 400 && location) {
          try { target = new URL(location, requestUrl).toString(); } catch { target = ""; }
          kind = "redirect";
        }
      } else {
        target = requestUrl;
        kind = e.resourceType === "Document" ? "navigation" : "subresource";
      }
      let refused = false;
      if (/^https?:/i.test(target)) {
        try { refused = (await judge(target, kind)) !== null; } catch { refused = true; }
      }
      if (refused) await session.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" }).catch(() => null);
      else if (atResponse) await session.send("Fetch.continueResponse", { requestId: e.requestId }).catch(() => null);
      else await session.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => null);
    })();
  });
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }],
  });
}

type PwBrowser = Awaited<ReturnType<Awaited<typeof import("playwright")>["chromium"]["launch"]>>;
type PwContext = Awaited<ReturnType<PwBrowser["newContext"]>>;
type PwPage = Awaited<ReturnType<PwContext["newPage"]>>;

function buildSession(browser: PwBrowser, context: PwContext, page: PwPage, timeoutMs: number): DocumentBrowserSession {
  return {
    async visit(url: string, ms?: number) {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: ms ?? timeoutMs });
      // A WAF challenge sets its cookie and redirects a beat after DOMContentLoaded. Waiting
      // for the network to settle is what makes the warm-up worth doing; failing to settle is
      // not itself an error.
      await page.waitForLoadState("networkidle", { timeout: Math.min(8_000, ms ?? timeoutMs) }).catch(() => {});
      return { status: res ? res.status() : null, html: await page.content(), url: page.url() };
    },
    async fetchInPage(url: string, ms?: number) {
      // Bytes do not survive the evaluate boundary, so they come back base64 in chunks small
      // enough for String.fromCharCode.apply. NOTHING in here may be a named inner function
      // (see NAME_SHIM), and the abort signal is created IN THE PAGE because page.evaluate
      // has no timeout of its own — a hung fetch would otherwise hang forever.
      const got = await page.evaluate(
        async (arg: { url: string; timeoutMs: number }) => {
          const res = await fetch(arg.url, {
            credentials: "include",
            redirect: "follow",
            signal: AbortSignal.timeout(arg.timeoutMs),
          });
          const view = new Uint8Array(await res.arrayBuffer());
          let binary = "";
          for (let i = 0; i < view.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + 0x8000)));
          }
          return {
            status: res.status,
            contentType: res.headers.get("content-type") || "",
            url: res.url,
            base64: btoa(binary),
          };
        },
        { url, timeoutMs: ms ?? timeoutMs },
      );
      return {
        status: got.status,
        contentType: got.contentType,
        bytes: new Uint8Array(Buffer.from(got.base64, "base64")),
        url: got.url,
      };
    },
    async close() {
      try { await context.close(); } catch { /* best effort */ }
      try { await browser.close(); } catch { /* best effort */ }
    },
  };
}
