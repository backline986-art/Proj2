// ONE PER-HOST BUDGET FOR EVERY AUTOMATED PORTAL READ, AND A PAUSE THAT SURVIVES A RESTART.
//
// THE LIVE CASE (2026-11-27, operator's PC, main 9bda24b2). The KB link check probed 40 stored
// portal links back to back (20:16:48 → 20:21:49; Oregon's AHJs share aca-oregon.accela.com), then
// the 15-minute status sweep read 28 filings back to back, several on that same host, each read up
// to four GETs plus a search postback. At 20:22:32 the Mechanical record search answered HTTP 429;
// the sweep logged "status unreadable this sweep" and carried on. At 20:22:56 Cloudflare served
// Error 1015, "has banned you temporarily", to the operator's own browser: one IP, one ban.
// The sweep's back-to-back order had no gap, no budget and no memory of being told to stop.
//
// WHAT THIS MODULE IS. Process-wide, per host (case folded, "www." folded, port kept — the same key
// documentFetch's politeHostOf uses, which now delegates here):
//   - A GAP: >= HOST_MIN_GAP_MS (the owner's rule: 10 s between requests to one host) from the end
//     of one request to the start of the next, chained per host, so two features on one host queue
//     behind each other and other hosts are not held up. A host's data row may WIDEN the gap,
//     never narrow it.
//   - A BUDGET: at most N requests per rolling hour per host (DEFAULT_MAX_PER_HOUR, or the host's
//     data row). Spent = the read is not sent; the caller is told until when. Not a strike.
//   - A PAUSE: a 429, a 503 with Retry-After, a Cloudflare 1015 ban / 1020 block / challenge page
//     (shared/src/rateLimitSignals.ts, the ONE classifier) pauses the host for every feature:
//     max(the site's Retry-After, base x 2^(strikes-1)), capped. Strikes restart after a quiet day.
//     The pause is PERSISTED (portal_host_pauses, migration v94) once a database is attached, so a
//     restart inside a ban does not knock again; it is read back at attach.
//   - Staff wording: hostPauseLine says "<host> rate-limited Keelix (<evidence>): automatic reads
//     paused until <time>". The permit card shows it as the filing's read gap.
//
// PER-HOST SETTINGS ARE DATA (portal_host_pacing: host, min_gap_ms, max_per_hour). Never a place
// name in code (placeNameGuard): a host that needs gentler pacing gets a row, not a branch.
//
// LOOPBACK (127.0.0.1, localhost, ::1) is a local stub or dev mock, never a third party's portal:
// it gets no gap and no budget. A pause still applies to it, so a test can drive one.
//
// This only ever ADDS stops and waits. It never sends anything, never retries on its own, and
// never stands in for any gate: a read it lets through is judged by its caller exactly as before.

import type { AppDb } from "./db";
import { logger } from "./logger";
import { rateLimitFromAnswer, rateLimitFromText, type RateLimitKind, type RateLimitVerdict } from "../../shared/src/rateLimitSignals";

/** The owner's rule, in one constant: >= 10 s between requests to one host. documentFetch's
 *  HOST_MIN_GAP_MS and agencyPageReader's PAGE_READ_MIN_GAP_MS are this value. */
export const HOST_MIN_GAP_MS = 10_000;
/** Requests per rolling hour per host unless the host's data row says otherwise. 120 = one every
 *  30 s on average: the status sweep and the link check together on a shared portal host fit
 *  inside it; a burst does not. */
export const DEFAULT_MAX_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;
/** First pause by kind (doubled per strike). A ban or a challenge is the CDN already angry: an hour. */
const BASE_PAUSE_MS: Record<RateLimitKind, number> = {
  rate_limited: 15 * 60 * 1000,
  banned: HOUR_MS,
  challenge: HOUR_MS,
  blocked: 6 * HOUR_MS,
  unavailable: 5 * 60 * 1000,
};
/** No computed pause is longer than a day; a site's own Retry-After is honoured up to a week. */
const MAX_PAUSE_MS = 24 * HOUR_MS;
const MAX_RETRY_AFTER_MS = 7 * 24 * HOUR_MS;
/** A strike more than a day after the last one starts the count again. */
const STRIKE_MEMORY_MS = 24 * HOUR_MS;

export type HostPauseKind = RateLimitKind;
export interface HostPause {
  host: string;
  kind: HostPauseKind;
  /** The evidence that set it: "HTTP 429 Too Many Requests", "Cloudflare Error 1015 …". */
  reason: string;
  /** ISO time the pause began / ends. */
  since: string;
  until: string;
  strikes: number;
  /** Which feature was answered: "status-read", "record-search", "kb-links", "document-fetch", "recipe-run". */
  feature: string;
}
/** Keelix's own hourly budget for a host is spent: nothing was sent. Not the site's doing. */
export interface HostBudgetSpent { host: string; kind: "budget"; until: string; limit: number }

export class HostPausedError extends Error {
  constructor(public readonly pause: HostPause | HostBudgetSpent) {
    super(hostPauseLine(pause));
    this.name = "HostPausedError";
  }
}

interface HostState {
  /** When the last request to this host ended (ms). */
  lastAt?: number;
  /** Start times of requests in the last hour (ms), oldest first. */
  recent: number[];
  pause?: HostPause;
  /** ms of the last strike, for STRIKE_MEMORY_MS (kept after a pause ends). */
  lastStrikeAt?: number;
  strikes: number;
}
const states = new Map<string, HostState>();
const chains = new Map<string, Promise<unknown>>();
let store: AppDb | null = null;

interface Seams { now: () => number; sleep: (ms: number) => Promise<void>; minGapMs: number }
/** The unit-test harness (backend/test/_isolate.ts) takes the process OFFLINE — every non-loopback
 *  request is refused before it leaves — and sets this global flag, so a refused request costs no
 *  10 s wait. A global symbol, not an env var or a setting: nothing an operator configures reaches it. */
const OFFLINE_TEST_GAP = Symbol.for("keelix.hostThrottle.offlineTestNoGap");
const offlineTests = (): boolean => (globalThis as Record<symbol, unknown>)[OFFLINE_TEST_GAP] === true;
const REAL: Seams = { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), minGapMs: offlineTests() ? 0 : HOST_MIN_GAP_MS };
let seams: Seams = { ...REAL };
/** Tests only: a clock and a sleep that record instead of waiting, or a zero gap. Not an operator
 *  knob — the gap is the owner's rule; a host's data row can only widen it. */
export function _setHostThrottleSeams(s: Partial<Seams> | null): void { seams = { ...REAL, ...(s ?? {}) }; }
/** Tests only: forget every host in memory and detach the database (its rows are left as they
 *  are), which is what a restart does: the next attach reads the live pauses back. */
export function _resetHostThrottle(): void { states.clear(); chains.clear(); store = null; }

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);

/** THE HOST A REQUEST IS COUNTED AGAINST: case folded, a leading "www." folded (bendoregon.gov and
 *  www.bendoregon.gov are one site), the port kept. Nothing else is folded: permits.example.gov is
 *  not example.gov. "" for a non-URL. A bare host (no scheme) is accepted as itself. */
export function throttleHostOf(urlOrHost: string | URL): string {
  try {
    const u = typeof urlOrHost === "string" ? new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`) : urlOrHost;
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
const isLoopback = (host: string): boolean => LOOPBACK.has(host.replace(/:\d+$/, "")) || host.startsWith("[::1]");

function stateOf(host: string): HostState {
  let s = states.get(host);
  if (!s) { s = { recent: [], strikes: 0 }; states.set(host, s); }
  return s;
}

// ── PERSISTENCE ────────────────────────────────────────────────────────────────────────────────────
/** Attach the database: live pauses are read back (a restart inside a ban does not knock again) and
 *  every later pause is written through. Idempotent; the sweep and the link check call it too, so a
 *  process that never booted the server still keeps its pauses. */
export function attachHostThrottleStore(db: AppDb): void {
  if (store === db) return;
  store = db;
  try {
    const now = seams.now();
    const rows = db.query<{ host: string; kind: string; reason: string; since_at: string; until_at: string; strikes: number; last_strike_at: string; feature: string }>(
      "SELECT host, kind, reason, since_at, until_at, strikes, last_strike_at, feature FROM portal_host_pauses",
    );
    for (const r of rows) {
      const s = stateOf(r.host);
      const lastStrike = Date.parse(r.last_strike_at);
      if (Number.isFinite(lastStrike) && (s.lastStrikeAt ?? 0) < lastStrike) { s.lastStrikeAt = lastStrike; s.strikes = Number(r.strikes) || 1; }
      if (Date.parse(r.until_at) > now) {
        s.pause = { host: r.host, kind: r.kind as HostPauseKind, reason: r.reason, since: r.since_at, until: r.until_at, strikes: Number(r.strikes) || 1, feature: r.feature };
      }
    }
  } catch (err) {
    // A database without the table (an older build's file opened read-only by a script): memory only.
    logger.warn("host-throttle", `host pauses not read back: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function persist(p: HostPause, lastStrikeAt: number): void {
  if (!store) return;
  try {
    store.run(
      `INSERT INTO portal_host_pauses (host, kind, reason, since_at, until_at, strikes, last_strike_at, feature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET kind = excluded.kind, reason = excluded.reason, since_at = excluded.since_at,
         until_at = excluded.until_at, strikes = excluded.strikes, last_strike_at = excluded.last_strike_at, feature = excluded.feature`,
      [p.host, p.kind, p.reason, p.since, p.until, p.strikes, new Date(lastStrikeAt).toISOString(), p.feature],
    );
  } catch (err) {
    logger.warn("host-throttle", `host pause not saved (kept in memory): ${err instanceof Error ? err.message : String(err)}`, { host: p.host });
  }
}

/** The host's pacing row (portal_host_pacing), when a database is attached and has one. */
function pacingFor(host: string): { minGapMs: number; maxPerHour: number } {
  let rowGap = 0;
  let rowMax = 0;
  if (store) {
    try {
      const row = store.get<{ min_gap_ms: number | null; max_per_hour: number | null }>(
        "SELECT min_gap_ms, max_per_hour FROM portal_host_pacing WHERE host = ?",
        [host],
      );
      rowGap = Number(row?.min_gap_ms) || 0;
      rowMax = Number(row?.max_per_hour) || 0;
    } catch { /* no table: defaults */ }
  }
  // The gap only widens past the floor; the hourly budget is the row's when it has one.
  const minGapMs = Math.max(seams.minGapMs, rowGap > seams.minGapMs ? rowGap : 0);
  const maxPerHour = rowMax > 0 ? Math.floor(rowMax) : DEFAULT_MAX_PER_HOUR;
  return { minGapMs, maxPerHour };
}

// ── READING THE STATE ───────────────────────────────────────────────────────────────────────────────
/** The live pause on this URL's host, or null (an expired one is forgotten here). */
export function hostPause(urlOrHost: string): HostPause | null {
  const host = throttleHostOf(urlOrHost);
  if (!host) return null;
  const s = states.get(host);
  if (!s?.pause) return null;
  if (Date.parse(s.pause.until) <= seams.now()) { delete s.pause; return null; }
  return s.pause;
}

/** Every live pause, soonest-ending first (for a staff view or a log line). */
export function listHostPauses(): HostPause[] {
  const out: HostPause[] = [];
  for (const host of states.keys()) {
    const p = hostPause(host);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.until.localeCompare(b.until));
}

/** "2026-11-27 21:22 UTC" — one stable format for the card, the log and the click's reply. */
export function pauseTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const KIND_WORDS: Record<HostPauseKind, string> = {
  rate_limited: "rate-limited Keelix",
  banned: "temporarily banned Keelix for too many requests",
  challenge: "answered with a browser check instead of the page",
  blocked: "blocked Keelix's automated reads",
  unavailable: "asked Keelix to come back later",
};

/** The one line staff see: what the site did, and until when nothing automatic goes there. */
export function hostPauseLine(p: HostPause | HostBudgetSpent): string {
  if (p.kind === "budget") {
    return `Keelix has already sent ${p.host} its ${p.limit} automatic requests for this hour, so this read waits until ${pauseTimeLabel(p.until)} rather than risk a rate limit.`;
  }
  return `${p.host} ${KIND_WORDS[p.kind]} (${p.reason}); automatic reads of it are paused until ${pauseTimeLabel(p.until)}.`;
}

// ── RECORDING WHAT A SITE SAID ──────────────────────────────────────────────────────────────────────
/** Record a stop verdict against a host: a pause for every feature. Returns the pause (the longer
 *  of an existing live one and the new one, so a weaker verdict never shortens a ban). */
export function noteHostVerdict(urlOrHost: string, verdict: RateLimitVerdict, feature: string): HostPause | null {
  const host = throttleHostOf(urlOrHost);
  if (!host) return null;
  const s = stateOf(host);
  const now = seams.now();
  const live = hostPause(host);
  // One strike per pause: a second request that was already in flight when the first 429 landed is
  // the same event, not a new one.
  const sameEvent = Boolean(live);
  if (!sameEvent) {
    s.strikes = s.lastStrikeAt != null && now - s.lastStrikeAt <= STRIKE_MEMORY_MS ? s.strikes + 1 : 1;
    s.lastStrikeAt = now;
  }
  const strikes = Math.max(1, s.strikes);
  const computed = Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS[verdict.kind] * 2 ** Math.min(strikes - 1, 10));
  const siteSaid = verdict.retryAfterMs != null ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, verdict.retryAfterMs)) : 0;
  const untilMs = Math.max(now + Math.max(computed, siteSaid), live ? Date.parse(live.until) : 0);
  const pause: HostPause = {
    host,
    kind: live && Date.parse(live.until) >= untilMs ? live.kind : verdict.kind,
    reason: (live && Date.parse(live.until) >= untilMs ? live.reason : verdict.evidence).slice(0, 200),
    since: live?.since ?? new Date(now).toISOString(),
    until: new Date(untilMs).toISOString(),
    strikes,
    feature: live?.feature ?? feature,
  };
  s.pause = pause;
  persist(pause, s.lastStrikeAt ?? now);
  if (!sameEvent) {
    logger.warn("host-throttle", hostPauseLine(pause), { host, feature, strikes, kind: verdict.kind });
  }
  return pause;
}

/** An HTTP answer: a pause when it is the site asking us to stop, else null. `body` is a peek at
 *  the response text when the caller has one (a non-2xx body is where Cloudflare says 1015). */
export function noteHostAnswer(
  url: string,
  answer: { status: number; header: (name: string) => string | null | undefined; body?: string | null },
  feature: string,
): HostPause | null {
  const verdict = rateLimitFromAnswer(answer.status, answer.header, answer.body ?? null, seams.now());
  return verdict ? noteHostVerdict(url, verdict, feature) : null;
}

/** A page's TEXT (a browser read, a body already in hand) that is a block page: a pause, else null. */
export function noteHostBlockText(url: string, text: string | null | undefined, feature: string): HostPause | null {
  const verdict = rateLimitFromText(text);
  return verdict ? noteHostVerdict(url, verdict, feature) : null;
}

// ── TAKING A TURN ───────────────────────────────────────────────────────────────────────────────────
/** Run `fn` as this host's next request: after any earlier request on the host has ended and the
 *  gap has passed, inside the hourly budget, and never while the host is paused (then nothing runs
 *  and HostPausedError says why). The host's clock moves when `fn` ends, however it ends. */
export async function withHostTurn<T>(url: string, feature: string, fn: () => Promise<T>): Promise<T> {
  const host = throttleHostOf(url);
  if (!host) return fn();
  const paused = hostPause(host);
  if (paused) throw new HostPausedError(paused);
  const prev = chains.get(host) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async (): Promise<T> => {
    const s = stateOf(host);
    const local = isLoopback(host);
    const { minGapMs, maxPerHour } = pacingFor(host);
    if (!local) {
      const wait = (s.lastAt ?? -Infinity) + minGapMs - seams.now();
      if (wait > 0 && minGapMs > 0) await seams.sleep(wait);
    }
    // Re-read after the wait: the request ahead of this one may have been told to stop.
    const again = hostPause(host);
    if (again) throw new HostPausedError(again);
    const now = seams.now();
    if (!local) {
      while (s.recent.length && now - s.recent[0]! >= HOUR_MS) s.recent.shift();
      if (s.recent.length >= maxPerHour) {
        const spent: HostBudgetSpent = { host, kind: "budget", until: new Date(s.recent[0]! + HOUR_MS).toISOString(), limit: maxPerHour };
        logger.info("host-throttle", hostPauseLine(spent), { host, feature });
        throw new HostPausedError(spent);
      }
      s.recent.push(now);
    }
    try {
      return await fn();
    } finally {
      s.lastAt = seams.now();
    }
  });
  chains.set(host, run);
  try {
    return await run;
  } finally {
    if (chains.get(host) === run) chains.delete(host);
  }
}

/** Mark a request another module sent on its own (documentFetch's ladder): the gap clock and the
 *  hourly count move, so the next read of that host from any feature waits its turn. */
export function markHostRequest(urlOrHost: string): void {
  const host = throttleHostOf(urlOrHost);
  if (!host || isLoopback(host)) return;
  const s = stateOf(host);
  const now = seams.now();
  s.lastAt = now;
  while (s.recent.length && now - s.recent[0]! >= HOUR_MS) s.recent.shift();
  s.recent.push(now);
}

/** A PLAIN HTTP REQUEST TO A PORTAL, POLITELY: one turn per request (withHostTurn), and the answer
 *  judged (noteHostAnswer) before the caller sees it — a 429 / 1015 / challenge pauses the host for
 *  every feature. A non-2xx body is peeked from a clone, so the caller still reads it whole. Throws
 *  HostPausedError (nothing sent) while the host is paused or over budget; network errors propagate
 *  as before. */
export async function politeFetch(
  url: string,
  init: RequestInit,
  opts: { feature: string; fetchImpl?: typeof fetch },
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  return withHostTurn(url, opts.feature, async () => {
    const res = await doFetch(url, init);
    const header = (n: string) => res.headers.get(n);
    const flagged = (res.status >= 400) || Boolean(res.headers.get("cf-mitigated"));
    let body: string | null = null;
    if (flagged) {
      try { body = (await res.clone().text()).slice(0, 20000); } catch { body = null; }
    }
    noteHostAnswer(url, { status: res.status, header, body }, opts.feature);
    return res;
  });
}
