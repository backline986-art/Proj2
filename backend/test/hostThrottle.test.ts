// A PORTAL THAT SAYS STOP IS LEFT ALONE, BY EVERY FEATURE, ACROSS A RESTART (hostThrottle.ts).
//
// Live 2026-11-27 (operator's PC): the KB link check probed 40 stored portal links back to back, then
// the 15-minute status sweep read 28 filings back to back; Oregon ePermitting (Accela behind
// Cloudflare) answered a record search HTTP 429, the sweep logged "status unreadable this sweep" and
// read the same host again, and seconds later Cloudflare banned the server's IP (Error 1015) — the
// operator's own browser too. This suite drives the shared throttle with an injected clock, sleep and
// fetch (no network, no Chromium), then the REAL sweep (runDuePermitChecks / runPermitChecksNow) with
// only the browser doors stubbed and the plain HTTP door going through the real politeFetch.
//
//   MUST-PASS    the classifier: 429 (+Retry-After), Cloudflare 1015 as HTML and as rendered text,
//                a challenge (cf-mitigated, the interstitial's own wording), 1020, 503+Retry-After
//   MUST-EXCLUDE a portal's own sign-in CAPTCHA (Turnstile, "verify you are human"), Cloudflare's
//                ordinary injected script, a long page that mentions "too many requests", a plain
//                403 or 503 with no Retry-After, a 200
//   MUST-PASS    >= 10 s between requests to one host, from any feature; a data row widens the gap,
//                never narrows it; another host is not held up; loopback is not paced
//   MUST-PASS    an hourly budget per host (data row or default): over it, nothing is sent, until when
//   MUST-PASS    a 429 pauses the host for every feature: nothing more is sent until it ends; the
//                site's Retry-After wins when longer; strikes double the pause; a quiet day resets
//   MUST-PASS    the pause survives a restart (portal_host_pauses, read back at attach)
//   MUST-PASS    THE SWEEP: a 429 on one filing's read pauses its host; the next filing on that host
//                is not read at all (no request), and both cards say "paused until"; the next check
//                is moved past the pause; after a "restart" a click still sends nothing there
//   MUST-PASS    a block page read as a status (a 1015 page rendered in the window) is not a status
//   MUST-PASS    next checks are spread: two filings read in the same second are not due together
//
// Run: npx tsx backend/test/hostThrottle.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";
import { rateLimitFromAnswer, rateLimitFromText, parseRetryAfter } from "../../shared/src/rateLimitSignals";

const fx = await setupStageFixture("host-throttle");
const { db, repo } = fx;
process.env.PORTAL_AUTOSEED = "1"; // the live install's mode: an empty read is "unreadable", not a mock
process.env.PORTAL_FEE_READ = "off";
const ht = await import("../src/hostThrottle");
const { HostPausedError } = ht;

// ── A clock that moves only when told; sleeps advance it and are recorded ──────────────────────────────
let clock = Date.parse("2026-11-27T20:00:00.000Z");
const sleeps: number[] = [];
// The owner's 10 s gap restored explicitly: _isolate zeroes it for the offline suites.
const useFakeClock = () => ht._setHostThrottleSeams({ now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, minGapMs: ht.HOST_MIN_GAP_MS });
const fresh = () => { ht._resetHostThrottle(); sleeps.length = 0; useFakeClock(); };

const H = (h: Record<string, string> = {}) => (n: string) => h[n.toLowerCase()] ?? null;
const CF_1015_HTML = `<!DOCTYPE html><html><head><title>Access denied | aca-test.accela.com used Cloudflare to restrict access</title>
<link rel="stylesheet" href="/cdn-cgi/styles/cf.errors.css"></head><body><div id="cf-wrapper"><div id="cf-error-details">
<h1><span data-translate="error">Error</span><span>1015</span></h1><span>Ray ID: a613d90e0f7d5303</span>
<h2 data-translate="error_desc">You are being rate limited</h2><section><h2>What happened?</h2>
<p>The owner of this website (aca-test.accela.com) has banned you temporarily from accessing this website.</p></section></div></div></body></html>`;
const CF_1015_RENDERED = "Error 1015 Ray ID: a613d90e0f7d5303 • 2026-11-27 20:22:56 UTC You are being rate limited What happened? The owner of this website (aca-oregon.accela.com) has banned you temporarily from accessing this website.";
const CHALLENGE_HTML = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><noscript>Enable JavaScript and cookies to continue</noscript><script>(function(){window._cf_chl_opt={cvId: '3',cZone: 'portal.example.gov'};}());</script></body></html>`;
const LOGIN_WITH_TURNSTILE = `<html><body><h1>Sign in</h1><form><input name="user"><input name="pass" type="password"><div class="cf-turnstile" id="cf-chl-widget-ab12"></div><p>Verify you are human</p><button>Log in</button></form><script>window.__CF$cv$params={r:'8f'};var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script></body></html>`;

await check("(k1) MUST-PASS the classifier names a rate limit, a ban, a challenge, a block and a come-back-later", () => {
  const now = Date.parse("2026-11-27T20:00:00Z");
  const r429 = rateLimitFromAnswer(429, H({ "retry-after": "120" }), "Too Many Requests", now);
  assert.equal(r429?.kind, "rate_limited");
  assert.equal(r429?.retryAfterMs, 120_000);
  assert.equal(rateLimitFromAnswer(429, H(), CF_1015_HTML, now)?.kind, "banned", "the 1015 HTML split across tags still reads as a ban");
  assert.equal(rateLimitFromText(CF_1015_RENDERED)?.kind, "banned", "the rendered 1015 page (the operator's screenshot)");
  assert.equal(rateLimitFromAnswer(403, H({ "cf-mitigated": "challenge" }), "", now)?.kind, "challenge");
  assert.equal(rateLimitFromAnswer(403, H(), CHALLENGE_HTML, now)?.kind, "challenge");
  assert.equal(rateLimitFromText("Just a moment... portal.example.gov needs to review the security of your connection before proceeding.")?.kind, "challenge");
  assert.equal(rateLimitFromAnswer(403, H({ server: "cloudflare" }), "<html><body>Access denied. Error code 1020. Ray ID: 8f3b</body></html>", now)?.kind, "blocked");
  const r503 = rateLimitFromAnswer(503, H({ "retry-after": new Date(now + 300_000).toUTCString() }), "Service Unavailable", now);
  assert.equal(r503?.kind, "unavailable");
  assert.ok(r503!.retryAfterMs! > 290_000 && r503!.retryAfterMs! <= 300_000, `HTTP-date Retry-After read as ${r503?.retryAfterMs}`);
  assert.equal(parseRetryAfter("not a date", now), undefined);
});

await check("(k2) MUST-EXCLUDE a sign-in CAPTCHA, Cloudflare's ordinary script, a long help page, a bare 403/503, a 200", () => {
  const now = Date.now();
  assert.equal(rateLimitFromText(LOGIN_WITH_TURNSTILE), null, "a Turnstile on a sign-in form is a person's job, never a pause");
  assert.equal(rateLimitFromAnswer(200, H(), LOGIN_WITH_TURNSTILE, now), null);
  const longHelp = `<html><body><main>${"Record Status: In Review. Inspections. Fees. ".repeat(200)} If you see "too many requests", wait a minute.</main></body></html>`;
  assert.equal(rateLimitFromText(longHelp), null, "a long portal page that mentions the words is not a block page");
  assert.equal(rateLimitFromAnswer(403, H({ server: "Apache" }), "<h1>Forbidden</h1>", now), null);
  assert.equal(rateLimitFromAnswer(503, H(), "Service Unavailable", now), null, "a 503 with no Retry-After is an outage, not a request to slow down");
  assert.equal(rateLimitFromAnswer(200, H(), CF_1015_RENDERED, now), null, "a 2xx page is judged by its reader (noteHostBlockText), not as an answer");
});

// A stub fetch that records each request and answers from a table.
type Answer = { status: number; headers?: Record<string, string>; body?: string };
const sent: Array<{ url: string; at: number }> = [];
const stubFetch = (answer: (url: string) => Answer) => (async (input: string | URL) => {
  const url = String(input);
  sent.push({ url, at: clock });
  const a = answer(url);
  return new Response(a.body ?? "ok", { status: a.status, headers: a.headers ?? {} });
}) as unknown as typeof fetch;
const ok200 = stubFetch(() => ({ status: 200, body: "<html><body>Record Status: Issued</body></html>" }));

await check("(k3) MUST-PASS >= 10 s between requests to one host from any feature; another host is not held up", async () => {
  fresh();
  sent.length = 0;
  await ht.politeFetch("https://portal-a.example.gov/x", {}, { feature: "status-read", fetchImpl: ok200 });
  await ht.politeFetch("https://portal-b.example.gov/x", {}, { feature: "kb-links", fetchImpl: ok200 });
  assert.deepEqual(sleeps, [], "a different host waits for nothing");
  await ht.politeFetch("https://www.portal-a.example.gov/y", {}, { feature: "kb-links", fetchImpl: ok200 });
  assert.equal(sleeps.length, 1, "the second request to portal-a (www folded) waited");
  assert.equal(sleeps[0], 10_000);
  // documentFetch's own requests move the same clock.
  ht.markHostRequest("https://portal-b.example.gov/doc.pdf");
  await ht.politeFetch("https://portal-b.example.gov/z", {}, { feature: "status-read", fetchImpl: ok200 });
  assert.equal(sleeps[1], 10_000, "a document fetch on the host counts for the next read's gap");
  // Loopback is a stub or a dev mock: never paced.
  sleeps.length = 0;
  await ht.politeFetch("http://127.0.0.1:9/x", {}, { feature: "status-read", fetchImpl: ok200 });
  await ht.politeFetch("http://127.0.0.1:9/y", {}, { feature: "status-read", fetchImpl: ok200 });
  assert.deepEqual(sleeps, []);
});

await check("(k4) MUST-PASS a host's data row widens the gap (never narrows it) and sets its hourly budget", async () => {
  fresh();
  ht.attachHostThrottleStore(db);
  db.run("INSERT OR REPLACE INTO portal_host_pacing (host, min_gap_ms, max_per_hour, note, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ["slow.example.gov", 30_000, 3, "test", "test", new Date().toISOString()]);
  db.run("INSERT OR REPLACE INTO portal_host_pacing (host, min_gap_ms, max_per_hour) VALUES (?, ?, ?)", ["fast.example.gov", 1_000, null]);
  for (let i = 0; i < 3; i += 1) await ht.politeFetch("https://slow.example.gov/r", {}, { feature: "status-read", fetchImpl: ok200 });
  assert.deepEqual(sleeps, [30_000, 30_000], "the row's 30 s gap");
  sent.length = 0;
  await assert.rejects(ht.politeFetch("https://slow.example.gov/r", {}, { feature: "status-read", fetchImpl: ok200 }), (err: unknown) => {
    assert.ok(err instanceof HostPausedError);
    assert.equal((err as InstanceType<typeof HostPausedError>).pause.kind, "budget");
    assert.match((err as Error).message, /already sent slow\.example\.gov its 3 automatic requests for this hour.*waits until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    return true;
  });
  assert.equal(sent.length, 0, "over budget: nothing was sent");
  sleeps.length = 0;
  await ht.politeFetch("https://fast.example.gov/r", {}, { feature: "status-read", fetchImpl: ok200 });
  await ht.politeFetch("https://fast.example.gov/r", {}, { feature: "status-read", fetchImpl: ok200 });
  assert.deepEqual(sleeps, [10_000], "a row below the floor does not narrow the owner's 10 s");
  db.run("DELETE FROM portal_host_pacing");
});

await check("(k5) MUST-PASS a 429 pauses the host for every feature; Retry-After wins when longer; strikes double; a quiet day resets", async () => {
  fresh();
  sent.length = 0;
  const limited = stubFetch(() => ({ status: 429, headers: { "retry-after": "120" }, body: "Too Many Requests" }));
  const res = await ht.politeFetch("https://aca-test.accela.com/TEST/Cap/CapHome.aspx", {}, { feature: "record-search", fetchImpl: limited });
  assert.equal(res.status, 429, "the caller still sees the answer");
  assert.equal(await res.text(), "Too Many Requests", "and can still read its body");
  const p = ht.hostPause("https://aca-test.accela.com/other/path")!;
  assert.ok(p, "the whole host is paused");
  assert.equal(p.kind, "rate_limited");
  assert.equal(Date.parse(p.until) - clock, 15 * 60_000, "max(15 min first strike, the site's 120 s)");
  assert.equal(ht.hostPauseLine(p), `aca-test.accela.com rate-limited Keelix (HTTP 429 Too Many Requests); automatic reads of it are paused until ${ht.pauseTimeLabel(new Date(clock + 15 * 60_000).toISOString())}.`);
  // Every feature: nothing is sent while it lasts.
  for (const feature of ["status-read", "kb-links"]) {
    await assert.rejects(ht.politeFetch("https://aca-test.accela.com/TEST/Cap/CapDetail.aspx", {}, { feature, fetchImpl: ok200 }), HostPausedError);
  }
  assert.equal(sent.length, 1, "only the request that was answered 429 was ever sent");
  // Over: asked again; a second 429 within the day doubles it.
  clock = Date.parse(p.until) + 1;
  await ht.politeFetch("https://aca-test.accela.com/TEST/x", {}, { feature: "status-read", fetchImpl: limited });
  const p2 = ht.hostPause("aca-test.accela.com")!;
  assert.equal(p2.strikes, 2);
  assert.equal(Date.parse(p2.until) - clock, 30 * 60_000, "second strike: 30 min");
  // The site's own longer Retry-After wins.
  clock = Date.parse(p2.until) + 1;
  await ht.politeFetch("https://aca-test.accela.com/TEST/x", {}, { feature: "status-read", fetchImpl: stubFetch(() => ({ status: 429, headers: { "retry-after": String(3 * 3600) } })) });
  assert.equal(Date.parse(ht.hostPause("aca-test.accela.com")!.until) - clock, 3 * 3600_000, "Retry-After of 3 h beats the 60 min third strike");
  // A strike more than a day after the last starts again at the first step.
  clock = Date.parse(ht.hostPause("aca-test.accela.com")!.until) + 25 * 3600_000;
  await ht.politeFetch("https://aca-test.accela.com/TEST/x", {}, { feature: "status-read", fetchImpl: limited });
  assert.equal(ht.hostPause("aca-test.accela.com")!.strikes, 1);
});

await check("(k6) MUST-PASS a Cloudflare 1015 ban is an hour at least; the pause survives a restart", async () => {
  fresh();
  ht.attachHostThrottleStore(db);
  const banned = stubFetch(() => ({ status: 429, headers: { "content-type": "text/html" }, body: CF_1015_HTML }));
  await ht.politeFetch("https://ban.example.gov/a", {}, { feature: "status-read", fetchImpl: banned });
  const p = ht.hostPause("ban.example.gov")!;
  assert.equal(p.kind, "banned");
  assert.equal(Date.parse(p.until) - clock, 60 * 60_000);
  assert.match(ht.hostPauseLine(p), /temporarily banned Keelix/);
  const row = db.get<{ until_at: string; kind: string }>("SELECT until_at, kind FROM portal_host_pauses WHERE host = ?", ["ban.example.gov"]);
  assert.equal(row?.kind, "banned");
  // "Restart": memory gone; the next attach reads it back and nothing is sent.
  ht._resetHostThrottle();
  useFakeClock();
  assert.equal(ht.hostPause("ban.example.gov"), null, "(memory really was cleared)");
  ht.attachHostThrottleStore(db);
  assert.equal(ht.hostPause("ban.example.gov")?.kind, "banned", "read back after the restart");
  sent.length = 0;
  await assert.rejects(ht.politeFetch("https://ban.example.gov/b", {}, { feature: "kb-links", fetchImpl: ok200 }), HostPausedError);
  assert.equal(sent.length, 0);
  // And an expired row is not a pause.
  clock = Date.parse(p.until) + 1;
  assert.equal(ht.hostPause("ban.example.gov"), null);
});

// ── THE SWEEP ───────────────────────────────────────────────────────────────────────────────────────
// Real clock from here (the sweep stamps ISO times off Date.now); a recorded sleep so a gap costs nothing.
ht._resetHostThrottle();
db.run("DELETE FROM portal_host_pauses");
ht._setHostThrottleSeams({ sleep: async (ms) => { sleeps.push(ms); }, minGapMs: ht.HOST_MIN_GAP_MS });
repo.setStatusCheckSeamsForTests({
  checkStatus: (async () => null) as never,
  recordSearch: (async () => ({ found: false, module: "Building", reason: "stub" })) as never,
  signedInLink: (async () => ({ text: null, reason: "stub", signedIn: false, loginRefused: false })) as never,
  // publicCheck NOT stubbed: the real publicPermitStatusCheck → fetchHtml → politeFetch → this fetch.
});
const httpLog: string[] = [];
let answerFor: (url: string) => Answer = () => ({ status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return realFetch(input, init);
  httpLog.push(url);
  const a = answerFor(url);
  return new Response(a.body ?? "", { status: a.status, headers: a.headers ?? {} });
}) as typeof fetch;

const target = (portalUrl: string, number: string, ahj: string): string => {
  const projectId = fx.newProject({ ahj });
  repo.createPermitCheckTarget(db, projectId, { targetType: "permit", permitType: "building", portalUrl, applicationNumber: number, jurisdiction: ahj, portalName: "Test portal" });
  const id = db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId])!.id;
  // Already read once ("keeping the known status" is the live log line), due now.
  db.run("UPDATE permit_check_targets SET latest_outcome = 'under_review', latest_status_label = 'In review', last_checked_at = ?, next_check_at = ? WHERE id = ?", [new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), id]);
  return id;
};
const only = (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const id of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), id]);
  httpLog.length = 0;
};
const rowOf = (id: string) => db.get<{ read_gap: string; next_check_at: string; latest_outcome: string }>("SELECT read_gap, next_check_at, latest_outcome FROM permit_check_targets WHERE id = ?", [id])!;

const T1 = target("https://permits.limited.example/record/1", "BLD-1", "Limited City");
const T2 = target("https://permits.limited.example/record/2", "BLD-2", "Limited City");
const T3 = target("https://permits.other.example/record/3", "BLD-3", "Other City");

await check("(s1) MUST-PASS THE SWEEP: a 429 pauses the host; the next filing there is not read at all; cards say until when", async () => {
  only(T1, T2, T3);
  answerFor = (url) => url.includes("limited.example")
    ? { status: 429, headers: { "retry-after": "600" }, body: "Too Many Requests" }
    : { status: 200, headers: { "content-type": "text/html" }, body: "<html><body><main>Record BLD-3 Record Status: Permit Issued. Inspections may now be scheduled for this record online.</main></body></html>" };
  const before = Date.now();
  const res = await repo.runDuePermitChecks(db, "permit");
  const limitedHits = httpLog.filter((u) => u.includes("limited.example"));
  assert.equal(limitedHits.length, 1, `the paused host got exactly the one request that was answered 429: ${JSON.stringify(httpLog)}`);
  assert.ok(httpLog.some((u) => u.includes("other.example")), "the other host was still read");
  assert.equal(rowOf(T3).latest_outcome, "issued");
  const pause = ht.hostPause("permits.limited.example")!;
  assert.ok(pause, "the host is paused");
  for (const id of [T1, T2]) {
    const row = rowOf(id);
    assert.match(row.read_gap, /permits\.limited\.example rate-limited Keelix .* paused until \d{4}-\d\d-\d\d \d\d:\d\d UTC/, `card line for ${id}: ${row.read_gap}`);
    assert.ok(Date.parse(row.next_check_at) >= Date.parse(pause.until), `next check ${row.next_check_at} is not after the pause ${pause.until}`);
    assert.equal(row.latest_outcome, "under_review", "the known status is kept, nothing fabricated");
    const r = (res.results ?? []).find((x: { targetId: string }) => x.targetId === id) as { reason?: string } | undefined;
    assert.match(String(r?.reason), /paused until/);
  }
  assert.ok(Date.parse(pause.until) - before >= 15 * 60_000 - 5_000, "at least the first strike's 15 minutes");
});

await check("(s2) MUST-PASS after a restart, a person's 'check now' still sends nothing to the paused host", async () => {
  ht._resetHostThrottle(); // the restart: memory gone, the row stays
  ht._setHostThrottleSeams({ sleep: async (ms) => { sleeps.push(ms); }, minGapMs: ht.HOST_MIN_GAP_MS });
  only(T1, T2);
  const res = await repo.runPermitChecksNow(db, "permit", null, { sleep: async () => {} });
  assert.deepEqual(httpLog, [], "nothing was sent to the paused host");
  assert.equal(res.unreadable, 2);
  assert.ok(res.results.every((r) => /paused until/.test(String(r.reason))), JSON.stringify(res.results.map((r) => r.reason)));
});

await check("(s3) MUST-PASS a 1015 page read as a status is not a status: it pauses its host", async () => {
  db.run("DELETE FROM portal_host_pauses");
  ht._resetHostThrottle();
  ht._setHostThrottleSeams({ sleep: async (ms) => { sleeps.push(ms); }, minGapMs: ht.HOST_MIN_GAP_MS });
  const T4 = target("https://permits.banned.example/record/4", "BLD-4", "Banned City");
  only(T4);
  // The site serves its ban page with a 200 (as a browser window renders it): only the text says so.
  answerFor = () => ({ status: 200, headers: { "content-type": "text/html" }, body: `<html><body><main>${CF_1015_RENDERED}</main></body></html>` });
  await repo.runDuePermitChecks(db, "permit");
  const row = rowOf(T4);
  assert.equal(row.latest_outcome, "under_review", "the ban page was not classified as the filing's status");
  assert.match(row.read_gap, /permits\.banned\.example temporarily banned Keelix/);
  assert.equal(ht.hostPause("permits.banned.example")?.kind, "banned");
});

await check("(s4) MUST-PASS next checks are spread: two filings read in the same second are not due at the same minute", async () => {
  db.run("DELETE FROM portal_host_pauses");
  ht._resetHostThrottle();
  ht._setHostThrottleSeams({ sleep: async (ms) => { sleeps.push(ms); }, minGapMs: ht.HOST_MIN_GAP_MS });
  const T5 = target("https://permits.spread-a.example/record/5", "BLD-5", "Spread A");
  const T6 = target("https://permits.spread-b.example/record/6", "BLD-6", "Spread B");
  only(T5, T6);
  answerFor = (url) => ({ status: 200, headers: { "content-type": "text/html" }, body: `<html><body><main>Record ${url.includes("/5") ? "BLD-5" : "BLD-6"} Record Status: Permit Issued. Inspections may now be scheduled online.</main></body></html>` });
  await repo.runDuePermitChecks(db, "permit");
  const a = Date.parse(rowOf(T5).next_check_at);
  const b = Date.parse(rowOf(T6).next_check_at);
  assert.notEqual(Math.floor(a / 60_000), Math.floor(b / 60_000), `both due at the same minute: ${rowOf(T5).next_check_at} ${rowOf(T6).next_check_at}`);
  const { checkSpreadMs, CHECK_SPREAD_MS } = await import("../src/permitMonitor");
  for (const id of [T5, T6]) assert.ok(checkSpreadMs(id) >= 0 && checkSpreadMs(id) < CHECK_SPREAD_MS);
});

globalThis.fetch = realFetch;
finish("hostThrottle");
