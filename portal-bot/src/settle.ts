// WAIT FOR THE PAGE TO SETTLE — BY WHAT THE PAGE IS DOING, NOT BY A LOAD EVENT.
//
// An ASP.NET UpdatePanel postback (Accela, most county portals) never fires a load event: it is
// an XHR that Sys.WebForms.PageRequestManager brackets with beginRequest / endRequest and then
// replaces a region of the DOM. waitForLoadState() returns immediately through it, and
// "networkidle" — used ~100 times in this bot, and discouraged by Playwright itself — is a
// guess about quiet that a long-poll never gives and a 0ms setTimeout slips through.
//
// So this module answers "is the page still working?" from inside the page:
//   - PageRequestManager begin/endRequest (hooked lazily — Sys arrives after our init script,
//     and there is no instance at all when partial rendering is off; every touch is guarded)
//     plus get_isInAsyncPostBack() at each read;
//   - a "postback began" flag set by __doPostBack and form submission, so a postback whose
//     PRM hook is not installed yet (or a full-page postback) still reads as busy;
//   - an in-flight fetch / XHR counter (requests older than maxRequestAgeMs — long-polls,
//     heartbeats — stop counting, or they would never let a page settle);
//   - a DOM-mutation quiet window (a caller may leave it out: `dom: false`, see settleAfterRoute);
//   - a change of the page's own URL (a hash route, pushState/replaceState, back/forward): an
//     app that rewrites its route has not finished arriving (#245).
// The quiet window is measured from the START of the wait as well as from the last activity:
// an autopostback control commonly defers its postback with setTimeout(…, 0), so right after a
// commit NOTHING is in flight yet. Requiring quietMs of stillness after the commit is what
// catches that gap.
//
// OVERLAPPING POSTBACKS ARE LAST-WINS: PageRequestManager aborts the in-flight request when a
// new one starts, and the first control's cascade is lost. Fill autopostback fields ONE AT A
// TIME and settle between them — commitField() does exactly that for one field.
//
// locator.fill() fires `input` only — no `change`, no blur — so a portal that saves or cascades
// on change never hears the value. commitField() blurs (Tab as the fallback), which fires the
// change, and then waits for whatever that started.
import type { Locator, Page } from "playwright";

/** Everything the page-side probe does. A plain string (not a serialized function) so it needs
 *  no __name shim and survives any bundler. Idempotent: a second install is a no-op. */
export const SETTLE_PROBE_SOURCE = String.raw`(function () {
  var g = globalThis;
  if (g.__settleProbe) return;
  var now = function () { return (g.performance && performance.now) ? performance.now() : Date.now(); };
  var st = {
    doc: String(Math.random()).slice(2), prmInFlight: 0, postbackAt: -1, lastActivity: now(), net: new Map(), seq: 0,
    // The same clock with DOM mutations left out, for a caller that settles on requests and route only.
    lastNonDom: now(), href: String(location.href),
    saw: { prm: 0, postback: 0, net: 0, mutation: 0, url: 0 },
    hooked: { prm: false, doPostBack: false }
  };
  var touch = function (kind) { var t = now(); st.lastActivity = t; if (kind !== "mutation") st.lastNonDom = t; if (kind) st.saw[kind]++; };

  // --- PageRequestManager (guarded: Sys may never exist; getInstance may throw or be null) ---
  var hookPrm = function () {
    try {
      if (typeof Sys === "undefined" || !Sys.WebForms || !Sys.WebForms.PageRequestManager) return;
      var prm = Sys.WebForms.PageRequestManager.getInstance();
      if (!prm || prm.__settleHooked) { if (prm) st.hooked.prm = true; return; }
      prm.__settleHooked = true;
      st.hooked.prm = true;
      prm.add_beginRequest(function () { st.prmInFlight++; st.postbackAt = -1; touch("prm"); });
      prm.add_endRequest(function () { st.prmInFlight = Math.max(0, st.prmInFlight - 1); touch("prm"); });
    } catch (e) { /* a portal's own Sys object that is not ASP.NET AJAX */ }
  };
  var prmBusy = function () {
    try {
      if (typeof Sys === "undefined" || !Sys.WebForms || !Sys.WebForms.PageRequestManager) return st.prmInFlight > 0;
      var prm = Sys.WebForms.PageRequestManager.getInstance();
      return st.prmInFlight > 0 || !!(prm && typeof prm.get_isInAsyncPostBack === "function" && prm.get_isInAsyncPostBack());
    } catch (e) { return st.prmInFlight > 0; }
  };

  // --- "postback began": __doPostBack and form submission ---
  var markPostback = function () { st.postbackAt = now(); touch("postback"); };
  var wrapDoPostBack = function () {
    try {
      var f = g.__doPostBack;
      if (typeof f !== "function" || f.__settleWrapped) return;
      var wrapped = function () { markPostback(); return f.apply(this, arguments); };
      wrapped.__settleWrapped = true;
      g.__doPostBack = wrapped;
      st.hooked.doPostBack = true;
    } catch (e) { /* non-writable on this page */ }
  };
  try {
    var origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () { markPostback(); return origSubmit.apply(this, arguments); };
  } catch (e) { /* locked prototype */ }
  try { document.addEventListener("submit", function () { markPostback(); }, true); } catch (e) {}

  // --- in-flight fetch / XHR ---
  var netStart = function () { var id = ++st.seq; st.net.set(id, now()); touch("net"); return id; };
  var netEnd = function (id) { if (st.net.delete(id)) touch("net"); };
  try {
    var origFetch = g.fetch;
    if (typeof origFetch === "function") {
      g.fetch = function () {
        var id = netStart();
        try {
          var p = origFetch.apply(this, arguments);
          return p.then(function (r) { netEnd(id); return r; }, function (e) { netEnd(id); throw e; });
        } catch (e) { netEnd(id); throw e; }
      };
    }
  } catch (e) {}
  try {
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      var id = netStart();
      try { this.addEventListener("loadend", function () { netEnd(id); }); } catch (e) {}
      try { return origSend.apply(this, arguments); } catch (e) { netEnd(id); throw e; }
    };
  } catch (e) {}

  // --- DOM mutations (structure, text, and the attributes that gate a control) ---
  var observe = function () {
    try {
      new MutationObserver(function () { touch("mutation"); }).observe(document, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["disabled", "hidden", "readonly", "aria-busy", "aria-disabled"]
      });
    } catch (e) {}
  };
  observe();

  // --- the page's own URL (#245): a hash route, pushState / replaceState, back / forward ---
  // An app that rewrites its route has not finished arriving: Tigard's (Tyler EnerGov) application
  // assistant rewrote #/applicationAssistant?sectionName=All to ?showTemplates=false when its own
  // initialisation ended, and wiped the search a replay had clicked in the meantime. A change is
  // activity; the href is also compared at every poll and snapshot, so nothing that moves the URL
  // without an event (a router that captured history methods before this ran) is missed.
  var checkUrl = function () {
    try { var h = String(location.href); if (h !== st.href) { st.href = h; touch("url"); } } catch (e) {}
  };
  try { g.addEventListener("hashchange", checkUrl, true); g.addEventListener("popstate", checkUrl, true); } catch (e) {}
  try {
    ["pushState", "replaceState"].forEach(function (m) {
      var f = history[m];
      if (typeof f !== "function" || f.__settleWrapped) return;
      var wrapped = function () { var r = f.apply(this, arguments); checkUrl(); return r; };
      wrapped.__settleWrapped = true;
      history[m] = wrapped;
    });
  } catch (e) { /* locked history */ }

  // Sys and __doPostBack arrive with the page's own scripts, after this runs — and a
  // PageRequestManager re-assigns __doPostBack when it initialises. Re-check cheaply.
  var poll = function () { hookPrm(); wrapDoPostBack(); checkUrl(); };
  poll();
  try { document.addEventListener("DOMContentLoaded", poll); g.addEventListener("load", poll); } catch (e) {}
  setInterval(poll, 150);

  g.__settleProbe = {
    /** Start a wait: reset the "seen" tallies and return the page clock. */
    begin: function () { st.saw = { prm: 0, postback: 0, net: 0, mutation: 0, url: 0 }; poll(); return now(); },
    /** dom === false: DOM mutations do not count as activity (requests, postbacks and route do). */
    snapshot: function (maxRequestAgeMs, postbackGraceMs, dom) {
      poll();
      var t = now();
      var net = 0;
      st.net.forEach(function (started) { if (t - started < maxRequestAgeMs) net++; });
      var pending = st.postbackAt >= 0 && t - st.postbackAt < postbackGraceMs;
      var busy = [];
      if (prmBusy()) busy.push("async postback in flight");
      if (pending) busy.push("postback began");
      if (net > 0) busy.push(net + " request(s) in flight");
      return { doc: st.doc, now: t, busy: busy, lastActivity: dom === false ? st.lastNonDom : st.lastActivity, saw: st.saw, hooked: st.hooked };
    }
  };
})();`;

const installed = new WeakSet<object>();

/** Install the probe on this page: for every future document (init script, once per page) and
 *  for the one already loaded. Never throws. */
export async function installSettleProbe(page: Page): Promise<void> {
  if (!page) return;
  if (!installed.has(page)) {
    installed.add(page);
    await page.addInitScript({ content: SETTLE_PROBE_SOURCE }).catch(() => null);
  }
  await page.evaluate(SETTLE_PROBE_SOURCE).catch(() => null);
}

export interface SettleOptions {
  /** Give up after this long. Default 10000. */
  timeoutMs?: number;
  /** Required stillness — no postback, no request, no mutation — measured from the later of
   *  the wait's start and the last activity. Default 300 (> a setTimeout-0 deferral). */
  quietMs?: number;
  /** Poll interval. Default 50. */
  pollMs?: number;
  /** A request older than this stops counting (long-poll, heartbeat). Default 5000. */
  maxRequestAgeMs?: number;
  /** How long a "postback began" mark keeps the page busy without a PRM beginRequest (a full
   *  page postback navigates within this). Default 2000. */
  postbackGraceMs?: number;
  /** Whether a DOM mutation is activity. Default true. false settles on requests, postbacks and the
   *  page's URL alone (settleAfterRoute): a view with one ticking node never goes DOM-quiet. */
  dom?: boolean;
}

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
  /** Why it returned: what was seen, or what was still busy at the timeout. */
  reason: string;
}

interface Snapshot {
  /** Per-document token: performance.now() restarts with every document, so a new token
   *  restarts the quiet clock. */
  doc: string;
  now: number;
  busy: string[];
  lastActivity: number;
  saw: { prm: number; postback: number; net: number; mutation: number; url: number };
  hooked: { prm: boolean; doPostBack: boolean };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the page has been still for quietMs: no async postback in flight (PageRequestManager),
 * no postback just begun, no young fetch/XHR, no change of its URL, no DOM mutation (unless
 * `dom: false`). Returns {settled:false} on timeout rather than throwing — the caller decides
 * whether an unsettled page is fatal.
 */
export async function waitForSettled(page: Page, opts: SettleOptions = {}): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const quietMs = opts.quietMs ?? 300;
  const pollMs = opts.pollMs ?? 50;
  const maxRequestAgeMs = opts.maxRequestAgeMs ?? 5_000;
  const postbackGraceMs = opts.postbackGraceMs ?? 2_000;
  const dom = opts.dom !== false;
  const started = Date.now();
  let pageStart: number | null = null;
  let last: Snapshot | null = null;
  let navigations = 0;
  let doc = "";

  while (Date.now() - started < timeoutMs) {
    let snap: Snapshot | null = null;
    try {
      snap = await page.evaluate(
        ([age, grace, fresh, withDom]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = (globalThis as any).__settleProbe;
          if (!p) return null;
          const s = p.snapshot(age, grace, withDom);
          if (fresh) s.pageStart = p.begin();
          return s;
        },
        [maxRequestAgeMs, postbackGraceMs, pageStart === null, dom] as const,
      ) as (Snapshot & { pageStart?: number }) | null;
      if (snap === null) {
        // A document without the probe (navigated, or never installed): install and restart the clock.
        await page.evaluate(SETTLE_PROBE_SOURCE).catch(() => null);
        pageStart = null;
      } else if (pageStart === null || snap.doc !== doc) {
        // First read, or a NEW document (a full postback navigated): its clock starts over.
        if (pageStart !== null) navigations++;
        pageStart = (snap as Snapshot & { pageStart?: number }).pageStart ?? snap.now;
        doc = snap.doc;
      }
    } catch {
      // Evaluate throws while a navigation swaps the document: that is activity, not quiet.
      navigations++;
      pageStart = null;
    }
    if (snap && pageStart !== null) {
      last = snap;
      const quietSince = Math.max(pageStart, snap.lastActivity);
      if (snap.busy.length === 0 && snap.now - quietSince >= quietMs) {
        const seen = Object.entries(snap.saw).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`);
        return {
          settled: true,
          waitedMs: Date.now() - started,
          reason: `quiet ${quietMs}ms${seen.length ? ` after ${seen.join(", ")}` : " (nothing happened)"}` +
            `${navigations ? `, ${navigations} navigation read(s)` : ""}` +
            `${snap.hooked.prm ? "" : " [no PageRequestManager on this page]"}`,
        };
      }
    }
    await sleep(pollMs);
  }
  return {
    settled: false,
    waitedMs: Date.now() - started,
    reason: `timeout after ${timeoutMs}ms: ${last ? (last.busy.length ? last.busy.join("; ") : dom ? "DOM still changing" : "requests or the URL still changing") : "page never readable"}`,
  };
}

/**
 * THE BOUND ON A ROUTE SETTLE (#245). It must outlast the rewrite that does the damage, not the whole
 * request chain behind it. Tigard's (Tyler EnerGov, AngularJS) application assistant, opened from the
 * menu, runs a chain with 4-15 ms between its stages (view template, settings, api/user/my ~500 ms,
 * a 4-request batch, then a POST to ApplicationAssistant/trending of 1.3-2.5 s); from its first
 * request to the end of trending that is 1.9-3.7 s in six learn traces. The route rewrite that wiped
 * the live replay's search results lands at the end of the batch, before trending: 1.12 s after the
 * click live (11:01:11.018 → 11:01:12.142), 1.1-1.9 s in the traces. So the settle normally waits
 * the whole chain (2.7-4.0 s on Tigard) and returns settled; on the slowest trace it reaches this bound
 * with trending still in flight, unsettled, having waited ~2 s past the rewrite. A larger bound buys
 * nothing against the rewrite and is spent in full by a page whose requests or URL never go quiet for
 * the window (a short-interval poll; a long-poll younger than the probe's 5 s request age). A settle
 * that reaches the bound says so in the step's phase record (recipeAdapter routeSettle).
 */
export const ROUTE_SETTLE_MS = 4_000;

export interface RouteSettle {
  /** The URL the click left the page on, read as the click returned. */
  clickedUrl: string;
  /** The URL once the page settled, or when the bound ran out. */
  settledUrl: string;
  result: SettleResult;
}

/**
 * A CLICK THAT CHANGED THE PAGE'S URL IS NOT DONE UNTIL THE PAGE HAS SETTLED (#245): no request in
 * flight and no further change of its URL for the quiet window (the probe's 300 ms default, longer
 * than a setTimeout-0 deferral and than the 15 ms between Tigard's last init response and its
 * rewrite), bounded by ROUTE_SETTLE_MS. A single-page app's view goes on initialising after the
 * route change that opened it, and may end by rewriting its own route; the live replay clicked
 * Tigard's "Search" 0.8 s after "Apply" while the assistant was still initialising, and the
 * assistant's rewrite then wiped the results the next step needed (the learn, with ~15 s between
 * those steps, never raced). DOM mutations are left out (`dom: false`): the question is whether the
 * view has finished arriving, which its requests and its route answer; a ticking node would make
 * every navigation click pay the whole bound.
 *
 * A click whose URL did not change returns null at once: one page.url() read, nothing waited on.
 * The probe must have been installed BEFORE the click (installSettleProbe; the recipe adapter does it
 * for every click) or the requests the click started are invisible. A full page load is a new
 * document, which restarts the quiet clock (waitForSettled) and carries the probe from its init
 * script. Never throws.
 */
export async function settleAfterRoute(page: Page, beforeUrl: string, opts: { timeoutMs?: number } = {}): Promise<RouteSettle | null> {
  if (!page || typeof page.url !== "function" || typeof page.evaluate !== "function" || typeof page.addInitScript !== "function") return null;
  const urlNow = (): string => { try { return String(page.url() ?? ""); } catch { return ""; } };
  const clickedUrl = urlNow();
  if (!beforeUrl || !clickedUrl || clickedUrl === beforeUrl) return null;
  // A closed page cannot settle; waiting would only spend the bound reading nothing.
  if (typeof page.isClosed === "function" && page.isClosed()) return null;
  const result = await waitForSettled(page, { timeoutMs: opts.timeoutMs ?? ROUTE_SETTLE_MS, dom: false })
    .catch((e: unknown): SettleResult => ({ settled: false, waitedMs: 0, reason: `could not read the page: ${String((e as Error)?.message ?? e).slice(0, 120)}` }));
  return { clickedUrl, settledUrl: urlNow(), result };
}

/** A URL as an operator reads a route in a message: path, query and hash, without the origin. */
export function routeText(url: string): string {
  try { const u = new URL(url); return `${u.pathname}${u.search}${u.hash}`; } catch { return String(url ?? ""); }
}

/** A URL as a route and its parameters: the route is origin + path + the hash's path; the parameters
 *  are the query's (`?k`) and the hash query's (`#k`), so a hash router's `#/view?k=v` reads like a
 *  path router's `/view?k=v`. An empty parameter (`?q=`) is left out, so it reads like an absent one:
 *  a router that drops it is normalising, not taking anything back. null when it does not parse. */
function routeParts(url: string): { route: string; params: Map<string, string> } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const params = new Map<string, string>();
  const put = (k: string, v: string): void => { if (v !== "") params.set(k, v); };
  for (const k of new Set(u.searchParams.keys())) put(`?${k}`, u.searchParams.getAll(k).join(","));
  const hash = u.hash.startsWith("#") ? u.hash.slice(1) : u.hash;
  const q = hash.indexOf("?");
  if (q >= 0) {
    const hp = new URLSearchParams(hash.slice(q + 1));
    for (const k of new Set(hp.keys())) put(`#${k}`, hp.getAll(k).join(","));
  }
  return { route: `${u.origin}${u.pathname}#${q >= 0 ? hash.slice(0, q) : hash}`, params };
}

/**
 * DID THE PAGE TAKE BACK WHAT A CLICK DID TO ITS URL? (#245) `before` is the URL before the click,
 * `clicked` the URL the click left, `settled` the URL now. A URL that merely differs from `before` is
 * not proof of an advance: Tigard's "Search" went from #/applicationAssistant to
 * ?sectionName=All&showTemplates=false, and the assistant's own rewrite left ?showTemplates=false —
 * not `before`, yet the search was gone. Undone means exactly one of:
 *   - the click left the route, and the page is back on it with the same parameters it had there:
 *     back where it was (#/a → #/b → #/a; /apply → /apply/search?t=all → /apply);
 *   - the click changed only parameters, the page is still on that route, and a parameter the click
 *     SET (to a value) no longer holds it (Tigard: sectionName=All gone).
 * ONLY WHAT THE CLICK DID COUNTS, never what the page added or restored around it, because a router
 * normalising its own URL looks exactly like that and the click's effect held (review of #245):
 *   - a page back on the route it left but in a NEW state is moving on, not going back: a wizard
 *     #/w?step=1 → #/loading → #/w?step=2 (the round-1 rule called this undone, and its retry clicked
 *     Continue a second time and skipped a page). A parameter the old state lacked is a new state too
 *     (#/w → #/loading → #/w?step=2): the URL cannot tell that from a page that went back and added a
 *     parameter of its own, so it keeps today's reading, moved;
 *   - a parameter the click REMOVED that the page put back is a default re-added, not the click
 *     taken back: a search #/s?q=a&page=2 → ?q=b → ?q=b&page=1 kept q=b (the round-1 rule called it
 *     undone; a search page keeps its identity, so "advance: Search" false-stopped). A URL that went
 *     all the way back to `before` this way still reads as not moved: the caller compares it with
 *     `before` first.
 * A page that went on to another route ("#/loading" → "#/dashboard"), or that kept everything the
 * click set and added to it (Tigard's "Apply": #/applicationAssistant → ?showTemplates=false), is not
 * undone. Unparseable URLs, or a click that did not change the URL, are never undone (the caller keeps
 * today's reading).
 */
export function routeEffectUndone(before: string, clicked: string, settled: string): boolean {
  if (!before || !clicked || !settled || clicked === before || settled === clicked) return false;
  const a = routeParts(before);
  const b = routeParts(clicked);
  const c = routeParts(settled);
  if (!a || !b || !c) return false;
  if (b.route !== a.route) return c.route === a.route && c.params.size === a.params.size && [...a.params].every(([k, v]) => c.params.get(k) === v);
  if (c.route !== a.route) return false;
  for (const [k, v] of b.params) if (a.params.get(k) !== v && c.params.get(k) !== v) return true;
  return false;
}

/**
 * Commit a filled field the way a person does — leave it — and wait for what that started.
 * Blur fires `change` (Playwright's fill() fires only `input`); Tab is the fallback for a control
 * that refuses a programmatic blur. Then waitForSettled. Never throws.
 */
export async function commitField(locator: Locator, opts: SettleOptions = {}): Promise<SettleResult> {
  const page = locator.page();
  await installSettleProbe(page);
  let committed = await locator.blur({ timeout: 2_000 }).then(() => true).catch(() => false);
  if (!committed) committed = await page.keyboard.press("Tab").then(() => true).catch(() => false);
  const res = await waitForSettled(page, opts);
  return committed ? res : { ...res, reason: `could not blur the field; ${res.reason}` };
}
