// IS THIS SITE TELLING US TO STOP? (pure; no state, no I/O)
//
// Live 2026-11-27: the status sweep read a filing on Oregon ePermitting (Accela behind Cloudflare),
// got HTTP 429 on a record search, logged "status unreadable this sweep" and moved straight on to
// the next filing on the same host. Seconds later the whole site answered Cloudflare's Error 1015
// ("You are being rate limited … has banned you temporarily") to the operator's own browser too:
// one IP, one ban. Nothing in the app could tell a rate limit from an ordinary failure.
//
// ONE answer to "is this response, or this page's text, the site asking automation to stop?",
// asked by every door that reads a portal: the plain HTTP fetches (backend/src/hostThrottle.ts
// politeFetch, documentFetch), the browser status reads and the recipe runner. A verdict says WHAT
// kind of stop it is (which sets how long to stay away) and carries the site's own Retry-After.
//
// NARROW ON PURPOSE. A CAPTCHA on a portal's own sign-in page (Star's) is a person's job, not a
// rate limit, and must never pause the host; "verify you are human" alone is NOT a signal here.
// Only a rate-limit status, a stated rate limit or ban, or a CDN interstitial that is plainly the
// CDN's own page counts.

export type RateLimitKind =
  /** HTTP 429, or a page that says the client is rate limited. */
  | "rate_limited"
  /** The site banned this client for a while (Cloudflare 1015 "banned you temporarily"). */
  | "banned"
  /** A CDN's browser check / managed challenge page instead of the content. */
  | "challenge"
  /** A CDN firewall block aimed at this client (Cloudflare 1020 "Access denied"). */
  | "blocked"
  /** HTTP 503 with a Retry-After: the site asked us to come back later. */
  | "unavailable";

export interface RateLimitVerdict {
  kind: RateLimitKind;
  /** Short human evidence: "HTTP 429", "Cloudflare Error 1015 (rate limited)", … */
  evidence: string;
  /** The site's own Retry-After, in ms from now, when it sent one we could read. */
  retryAfterMs?: number;
}

/** Retry-After is either delta-seconds or an HTTP-date. ms from `nowMs`, or undefined. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const s = Number(raw);
    return Number.isFinite(s) ? s * 1000 : undefined;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - nowMs);
}

// The CDN pages, by their own words. Cloudflare's 1015 page reads "Error 1015 … You are being rate
// limited … The owner of this website (<host>) has banned you temporarily"; its plain-text variant
// is "error code: 1015". 1020 is a firewall rule ("Access denied … Error code 1020").
const CF_1015 = /error(?:\s+code)?:?\s*1015\b|\bbanned you temporarily\b/i;
const RATE_LIMITED_WORDS = /\byou are being rate[\s-]?limited\b|\btoo many requests\b|\brate limit(?:ed)? exceeded\b/i;
const CF_1020 = /error(?:\s+code)?:?\s*1020\b/i;
// A managed challenge / browser check, by the interstitial's own wording (rendered text) or markup.
const CHALLENGE_TEXT = /\bneeds to review the security of your connection before proceeding\b|\bchecking (?:if the site connection is secure|your browser before accessing)\b|\bverifying you are human\. this may take a few seconds\b/i;
// Only the interstitial's own config object. NOT "/cdn-cgi/challenge-platform/" (Cloudflare injects
// its bot-detection script into ordinary pages under that path) and NOT "cf-chl-" (a Turnstile CAPTCHA
// on a portal's own sign-in form carries it, and that is a person's job, never a rate limit).
const CHALLENGE_MARKUP = /\b_cf_chl_opt\b/;

/** A page's TEXT (rendered innerText, or a body we hold) that is the site asking us to stop.
 *  Long pages are not block pages: a real portal page that happens to mention "too many requests"
 *  in a help paragraph is not one. */
export function rateLimitFromText(text: string | null | undefined): RateLimitVerdict | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const raw = t.slice(0, 20000);
  if (CHALLENGE_MARKUP.test(raw)) return { kind: "challenge", evidence: "a Cloudflare browser-check page" };
  // Markup or rendered text alike: Cloudflare's own HTML splits "Error</span><span>1015", so the
  // words are read with tags, scripts and styles taken out.
  const plain = /<[a-z!/]/i.test(raw)
    ? raw.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    : raw.replace(/\s+/g, " ").trim();
  const head = plain.slice(0, 6000);
  if (CF_1015.test(head)) return { kind: "banned", evidence: "Cloudflare Error 1015 (rate limited, temporarily banned)" };
  // A CDN interstitial is short. 4,000 characters of page text is far past any of them.
  const short = plain.length <= 4000 && t.length <= 60000;
  if (short && CHALLENGE_TEXT.test(head)) return { kind: "challenge", evidence: "a browser-check page (\"checking your connection\")" };
  if (short && CF_1020.test(head) && /access denied|cloudflare/i.test(head)) return { kind: "blocked", evidence: "Cloudflare Error 1020 (access denied)" };
  if (short && RATE_LIMITED_WORDS.test(head)) return { kind: "rate_limited", evidence: "the page says the client is rate limited" };
  return null;
}

/** An HTTP answer that is the site asking us to stop: the status, the headers, and (for a
 *  non-2xx answer, or a 2xx the CDN flags) a peek at the body. */
export function rateLimitFromAnswer(
  status: number,
  header: (name: string) => string | null | undefined,
  body: string | null | undefined,
  nowMs: number,
): RateLimitVerdict | null {
  const retryAfterMs = parseRetryAfter(header("retry-after"), nowMs);
  const withRetry = (v: RateLimitVerdict): RateLimitVerdict => (retryAfterMs != null ? { ...v, retryAfterMs } : v);
  const fromBody = rateLimitFromText(body);
  // Cloudflare marks its own challenge responses: cf-mitigated: challenge (any status).
  if (/challenge/i.test(String(header("cf-mitigated") ?? ""))) return withRetry({ kind: "challenge", evidence: `a Cloudflare challenge (HTTP ${status})` });
  if (status === 429) {
    if (fromBody?.kind === "banned") return withRetry({ ...fromBody, evidence: `HTTP 429, ${fromBody.evidence}` });
    return withRetry({ kind: "rate_limited", evidence: "HTTP 429 Too Many Requests" });
  }
  if (status >= 200 && status < 400) return null; // a page that loaded is content, judged by its reader
  if (fromBody) return withRetry({ ...fromBody, evidence: `HTTP ${status}, ${fromBody.evidence}` });
  if (status === 503 && retryAfterMs != null) return { kind: "unavailable", evidence: "HTTP 503 with Retry-After", retryAfterMs };
  return null;
}
