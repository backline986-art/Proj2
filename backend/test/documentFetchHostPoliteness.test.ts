// ONE WINDOW PER WALLED HOST, TEN SECONDS BETWEEN REQUESTS, AN HOUR OFF AFTER A REFUSAL (#130).
//
// Fee research opened 17 headed browser windows against one Cloudflare-walled host in 80 s.
// browserGate serialised them — it remembers nothing, so every walled URL earned its own window
// and every window was refused the same way. The owner's rule (memory: go gently on Cloudflare
// sites): one try per protected page, >= 10 s between requests to a host, back off and mark the
// fee unconfirmed. This drives fetchPublicDocument against a LOCAL server whose paths all 403
// like Cloudflare, with an INJECTED launcher that counts launches and an injected clock/sleep so
// the gap is asserted, not waited for. No public network, no Chromium.
//
// THE SCOPE OF A REFUSAL (fix round 1): a bare 403 on ONE object is byte-for-byte an S3
// AccessDenied on a stale link or an Apache 403 on a directory, not a host wall, and the body says
// nothing a regex can trust (the WAF's stock page and Apache's both read "Forbidden"). So one
// refused document costs the host its WINDOW for the hour (one window per walled host) and
// nothing more: its siblings are still read, 10 s apart. A SECOND document refused on the host
// within the hour is the host refusing us — backed off, nothing sent — as is a challenge, a
// stated no-robots notice or HTTP 429 on the first strike. The host STAMPED is the one that
// answered: a city page that 302s to a vendor object that 403s stamps the vendor, not the city.
//
// Browser-free. Run: tsx backend/test/documentFetchHostPoliteness.test.ts
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DocumentBrowserLauncher, DocumentBrowserSession } from "../src/documentFetch";

delete process.env.DOCUMENT_FETCH_BROWSER;
process.env.AUTOPILOT_LOG_FILE = "";
process.env.AUTOPILOT_DB_PATH = path.join(os.tmpdir(), "document-fetch-politeness-never-opened.sqlite");

const df = await import("../src/documentFetch");
const { fetchPublicDocument } = df;
// Reached through optional access ON PURPOSE: with the fix stashed these seams do not exist, and
// the run must then fail on the launch COUNT below, not on a TypeError up here.
const reset = (df as { _resetHostPoliteness?: () => void })._resetHostPoliteness ?? (() => {});
const setPoliteness = (df as { _setDocumentFetchPoliteness?: (s: Record<string, unknown>) => void })._setDocumentFetchPoliteness ?? (() => {});
const hostOf = (df as { politeHostOf?: (u: string) => string }).politeHostOf ?? (() => undefined as unknown as string);
type Verdict = { hostBackedOff?: true; siteRefused?: true; refusedHost?: string };
const verdict = (r: unknown): Verdict => r as Verdict;

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   - ${label}`); })
    .catch((err: unknown) => {
      failures++;
      console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
    });

// ---------------------------------------------------------------------------
// The jurisdiction, locally: ten distinct documents, every one of them walled the way Cloudflare
// walls a script (403, server: cloudflare, a body that explains nothing), one real PDF, one 404,
// one challenge page, one rate limit, and a link that 302s onto a vendor's object that 403s with
// Apache's stock directory page.
// ---------------------------------------------------------------------------
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);
const WALL = "<html><head><title>Access denied</title></head><body>Access denied. Error code 1020. Ray ID: 8f3b21c0de9a0001</body></html>";
const APACHE_403 = "<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1><p>You don't have permission to access this resource.</p></body></html>";
const seenPaths: string[] = [];
let redirectTarget = "";
function makeServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    seenPaths.push(url);
    if (url === "/ok.pdf") { res.writeHead(200, { "content-type": "application/pdf", server: "nginx" }); res.end(Buffer.from(PDF_BYTES)); return; }
    if (/^\/doc-\d+\.pdf$/.test(url)) { res.writeHead(403, { "content-type": "text/html", server: "cloudflare" }); res.end(WALL); return; }
    if (url === "/captcha.pdf") { res.writeHead(403, { "content-type": "text/html", server: "cloudflare" }); res.end('<html><body><h1>Verify you are human</h1><div class="cf-turnstile"></div></body></html>'); return; }
    if (url === "/limited.pdf") { res.writeHead(429, { "content-type": "text/plain", "retry-after": "60" }); res.end("Too Many Requests"); return; }
    if (/^\/fees-link/.test(url)) { res.writeHead(302, { location: redirectTarget }); res.end(); return; }
    if (/^\/vendor\/denied\d*\.pdf$/.test(url)) { res.writeHead(403, { "content-type": "text/html", server: "Apache" }); res.end(APACHE_403); return; }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("Not Found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    resolve({ base, close: () => new Promise<void>((r) => server.close(() => r())) });
  }));
}
const site = await makeServer();
const other = await makeServer();
const base = site.base;
redirectTarget = `${other.base}/vendor/denied.pdf`;
process.env.DOCUMENT_FETCH_ALLOW_ORIGINS = `${base},${other.base}`;
const walled = (n: number, origin = base): string => `${origin}/doc-${n}.pdf`;

// The injected window: counts launches; its in-page fetch is refused too, which is what a
// Cloudflare-walled host does to a window it has fingerprinted. `inPage` lets a check script the
// window's answer (a landing URL after a redirect, a throw).
interface FakeState { launches: number; closes: number }
type InPage = (url: string) => Promise<{ status: number; contentType: string; bytes: Uint8Array; url?: string }>;
function makeLauncher(inPage?: InPage): { launcher: DocumentBrowserLauncher; state: FakeState } {
  const state: FakeState = { launches: 0, closes: 0 };
  const launcher: DocumentBrowserLauncher = async (): Promise<DocumentBrowserSession> => {
    state.launches++;
    return {
      async visit(url: string) { return { status: 200, html: "<html><body>warm</body></html>", url }; },
      fetchInPage: inPage ?? (async () => ({ status: 403, contentType: "text/html", bytes: new TextEncoder().encode(WALL) })),
      async close() { state.closes++; },
    };
  };
  return { launcher, state };
}

// The clock and the sleep are seams: the gap is read off what the module ASKED to wait, so the
// test proves ten seconds without spending them. The clock stands still unless a check moves it.
const sleeps: number[] = [];
let clock = 1_700_000_000_000;
setPoliteness({ sleep: async (ms: number) => { sleeps.push(ms); }, now: () => clock });

// ---------------------------------------------------------------------------
await check("the host key folds case and a leading www., keeps the port, and does NOT fold other subdomains", () => {
  assert.equal(hostOf("https://WWW.Example.gov/fees.pdf"), "example.gov");
  assert.equal(hostOf("https://example.gov/"), "example.gov");
  assert.equal(hostOf("https://permits.example.gov/"), "permits.example.gov", "a vendor's tenant subdomain is its own host");
  assert.equal(hostOf("http://127.0.0.1:8080/x"), "127.0.0.1:8080", "two stubs on one loopback address are two hosts");
  assert.equal(hostOf("not a url"), "");
});

await check(">= 10 s is waited between two requests to one host (read off the sleep seam, not the wall clock)", async () => {
  reset(); sleeps.length = 0;
  const { launcher } = makeLauncher();
  const first = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(first.ok, true, first.reason);
  assert.deepEqual(sleeps, [], "the first request to a host waits for nothing");
  await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.ok(sleeps.length >= 1 && sleeps[0] >= 10_000, `the second request must wait >= 10 s; waits asked: ${JSON.stringify(sleeps)}`);
});

await check("THE BITE: ten walled paths on one host open exactly ONE window; the second plain try proves the host, the other eight send nothing and say why", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher();
  const results = [];
  for (let n = 1; n <= 10; n++) results.push(await fetchPublicDocument(walled(n), { launcher }));
  assert.equal(state.launches, 1, `exactly one launcher call for one walled host, got ${state.launches}`);
  assert.equal(state.closes, 1, "the one window was closed");
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /refused too/i, "the first result reports the window that was refused");
  assert.equal(verdict(results[0]).siteRefused, true, "the ladder's own verdict: the site refused this document");
  assert.equal(verdict(results[0]).refusedHost, undefined, "one refused object is not yet the host refusing");
  // The second document: the plain rung is tried (no window — the host had its one), refused, and
  // that second refusal is what backs the host off.
  assert.equal(results[1].ok, false);
  assert.equal(results[1].status, 403, "the second URL was sent, plainly");
  assert.equal(verdict(results[1]).siteRefused, true);
  assert.match(results[1].reason, /already tried once/i, `the second result names the window that was already refused: ${results[1].reason}`);
  assert.equal(verdict(results[1]).refusedHost, hostOf(base), `two documents refused = the host refusing: ${results[1].reason}`);
  for (const [i, r] of results.slice(2).entries()) {
    assert.equal(r.ok, false);
    assert.equal(r.status, 0, `result ${i + 3}: nothing was sent, so there is no status`);
    assert.equal(verdict(r).hostBackedOff, true, `result ${i + 3} must carry the stable back-off marker`);
    assert.equal(verdict(r).siteRefused, true, `result ${i + 3} is still a refusal to the caller`);
    assert.equal(verdict(r).refusedHost, hostOf(base), `result ${i + 3} names the refusing host`);
    assert.match(r.reason, /backed off/i, `result ${i + 3}: ${r.reason}`);
    assert.match(r.reason, /cloudflare/i, `result ${i + 3} names the earlier refusal: ${r.reason}`);
    assert.ok(r.reason.includes(hostOf(base)), `result ${i + 3} names the host: ${r.reason}`);
  }
  assert.deepEqual(seenPaths.filter((p) => p.startsWith("/doc-")), ["/doc-1.pdf", "/doc-2.pdf"], "the server saw TWO walled requests (the window's document and the one that proved the host), not ten");
});

await check("ten callers arriving TOGETHER still open one window (the chain and the gate both re-read the refusal)", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher();
  const results = await Promise.all(Array.from({ length: 10 }, (_v, i) => fetchPublicDocument(walled(i + 1), { launcher })));
  assert.equal(state.launches, 1, `got ${state.launches} launches`);
  assert.equal(results.filter((r) => verdict(r).hostBackedOff).length, 8);
  assert.deepEqual(seenPaths.filter((p) => p.startsWith("/doc-")), ["/doc-1.pdf", "/doc-2.pdf"]);
});

await check("ONE object refused in the window does not silence the host: its sibling is read, and no second window opens", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher();
  const denied = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 1);
  assert.equal(verdict(denied).siteRefused, true);
  assert.equal(verdict(denied).refusedHost, undefined, denied.reason);
  const sibling = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(sibling.ok, true, `the sibling must be read: ${sibling.reason}`);
  assert.ok(seenPaths.includes("/ok.pdf"), "the server saw the sibling");
  // The SAME object asked again is not a second document: refused plainly, no window, host still open.
  const same = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 1, "the host had its one window");
  assert.equal(verdict(same).siteRefused, true);
  assert.match(same.reason, /already tried once/i, same.reason);
  assert.equal(verdict(same).refusedHost, undefined, `the same URL twice is one refused document: ${same.reason}`);
  const siblingAgain = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(siblingAgain.ok, true, siblingAgain.reason);
});

await check("…a SECOND document refused on that host is the host refusing: backed off, nothing more sent", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher();
  await fetchPublicDocument(walled(1), { launcher });
  const second = await fetchPublicDocument(walled(2), { launcher });
  assert.equal(state.launches, 1, "no second window");
  assert.equal(verdict(second).refusedHost, hostOf(base), second.reason);
  assert.equal(verdict(second).hostBackedOff, undefined, "the second was sent (plainly) — it is the refusal, not the back-off");
  const sibling = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(verdict(sibling).hostBackedOff, true, sibling.reason);
  assert.ok(!seenPaths.includes("/ok.pdf"), "nothing was sent to the backed-off host");
});

await check("a window that TIMED OUT or threw is ours, not the site's: no refusal verdict, the next URL on the host is still fetched, and the window is tried again", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher(async () => { throw new Error("page.evaluate: Timeout 30000ms exceeded."); });
  const broke = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 1);
  assert.equal(broke.ok, false);
  assert.match(broke.reason, /in-page retrieval failed/i, broke.reason);
  assert.equal(verdict(broke).siteRefused, undefined, `a timeout is not the site refusing: ${broke.reason}`);
  assert.equal(verdict(broke).refusedHost, undefined);
  assert.equal(verdict(broke).hostBackedOff, undefined);
  const sibling = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(sibling.ok, true, sibling.reason);
  const next = await fetchPublicDocument(walled(2), { launcher });
  assert.equal(state.launches, 2, "the host was never refused, so the next wall earns its window");
  assert.match(next.reason, /in-page retrieval failed/i);
});

await check("the host STAMPED is the one that ANSWERED: a city link that 302s to a vendor object that 403s stamps the vendor, and the city keeps serving", async () => {
  reset(); seenPaths.length = 0;
  const vendorHost = hostOf(other.base);
  const cityHost = hostOf(base);
  // The window follows the redirect itself and reports where the bytes came from, as the real
  // launcher's fetchInPage does (res.url).
  const { launcher, state } = makeLauncher(async () => ({ status: 403, contentType: "text/html", bytes: new TextEncoder().encode(APACHE_403), url: redirectTarget }));
  const viaCity = await fetchPublicDocument(`${base}/fees-link`, { launcher });
  assert.equal(state.launches, 1);
  assert.equal(verdict(viaCity).siteRefused, true, viaCity.reason);
  assert.equal(verdict(viaCity).refusedHost, undefined, "one object");
  // The city's own document is read: it was not the city that refused.
  const cityDoc = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(cityDoc.ok, true, `the city must not be backed off: ${cityDoc.reason}`);
  // The vendor had its one window: the same object asked directly is refused plainly, no window.
  const direct = await fetchPublicDocument(`${other.base}/vendor/denied.pdf`, { launcher });
  assert.equal(state.launches, 1, "the vendor host already had its window — stamped under the landing host, not the city");
  assert.match(direct.reason, /already tried once/i, direct.reason);
  assert.equal(verdict(direct).refusedHost, undefined, `the object the window was refused on, reached directly, is the same document: ${direct.reason}`);
  // A second vendor object refused: the vendor is backed off — and a city link onto it sends nothing to the vendor.
  const second = await fetchPublicDocument(`${other.base}/vendor/denied2.pdf`, { launcher });
  assert.equal(verdict(second).refusedHost, vendorHost, second.reason);
  seenPaths.length = 0;
  const viaCityAgain = await fetchPublicDocument(`${base}/fees-link2`, { launcher });
  assert.equal(verdict(viaCityAgain).hostBackedOff, true, viaCityAgain.reason);
  assert.equal(verdict(viaCityAgain).refusedHost, vendorHost, `the back-off names the vendor, not the city: ${viaCityAgain.reason}`);
  assert.ok(seenPaths.includes("/fees-link2"), "the city was asked (it is not backed off)…");
  assert.ok(!seenPaths.some((p) => p.startsWith("/vendor/")), "…and the redirect hop onto the backed-off vendor was NOT followed");
  const cityStill = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(cityStill.ok, true, `the city is still served: ${cityStill.reason}`);
  assert.notEqual(cityHost, vendorHost);
});

await check("…and when the window does NOT say where it landed, the host the plain rung landed on is stamped, still never the city", async () => {
  reset(); seenPaths.length = 0;
  const vendorHost = hostOf(other.base);
  // The default fake window: a 403 with no landing URL reported.
  const { launcher, state } = makeLauncher();
  const viaCity = await fetchPublicDocument(`${base}/fees-link`, { launcher });
  assert.equal(state.launches, 1);
  assert.equal(verdict(viaCity).siteRefused, true, viaCity.reason);
  const cityDoc = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(cityDoc.ok, true, `the city must not carry the vendor's refusal: ${cityDoc.reason}`);
  const cityWall = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 2, "the city never had its window refused, so its own wall earns one");
  assert.equal(verdict(cityWall).refusedHost, undefined, cityWall.reason);
  const second = await fetchPublicDocument(`${other.base}/vendor/denied2.pdf`, { launcher });
  assert.equal(state.launches, 2, "the vendor had its window (through the city's link)");
  assert.equal(verdict(second).refusedHost, vendorHost, second.reason);
});

await check("a 404 on the host is a missing page, not a refusal: the next wall still earns its window", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  const missing = await fetchPublicDocument(`${base}/missing.pdf`, { launcher });
  assert.equal(missing.status, 404);
  assert.equal(verdict(missing).hostBackedOff, undefined);
  assert.equal(verdict(missing).siteRefused, undefined);
  const next = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 1, "the 404 must not have backed the host off");
  assert.match(next.reason, /refused too/i);
});

await check("a refusal on one host does not reach another host", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  await fetchPublicDocument(walled(1), { launcher });
  await fetchPublicDocument(walled(2), { launcher });
  const elsewhere = await fetchPublicDocument(walled(1, other.base), { launcher });
  assert.equal(state.launches, 2, "the other host gets its own one try");
  assert.equal(verdict(elsewhere).hostBackedOff, undefined, elsewhere.reason);
});

await check("a CAPTCHA still never earns a window — and it backs the host off on the first strike", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  const puzzle = await fetchPublicDocument(`${base}/captcha.pdf`, { launcher });
  assert.equal(puzzle.ok, false);
  assert.match(puzzle.reason, /never solves CAPTCHAs/i);
  assert.equal(state.launches, 0, "escalating INTO a CAPTCHA is the first step toward solving one");
  assert.equal(verdict(puzzle).siteRefused, true);
  assert.equal(verdict(puzzle).refusedHost, hostOf(base), "a challenge is the host's answer, not one object's");
  const next = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 0, "the host that showed a puzzle is not asked again");
  assert.equal(verdict(next).hostBackedOff, true, next.reason);
});

await check("HTTP 429 is the host saying stop: no window, backed off on the first strike", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher();
  const limited = await fetchPublicDocument(`${base}/limited.pdf`, { launcher });
  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429);
  assert.equal(state.launches, 0, "a window right after 'too many requests' is the opposite of polite");
  assert.equal(verdict(limited).siteRefused, true);
  assert.equal(verdict(limited).refusedHost, hostOf(base), limited.reason);
  const next = await fetchPublicDocument(`${base}/ok.pdf`, { launcher });
  assert.equal(verdict(next).hostBackedOff, true, next.reason);
  assert.ok(!seenPaths.includes("/ok.pdf"));
});

await check("a wall the CALLER would not climb does not back the host off: the lookup's no-browser 403 must not cost fee research its one window", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  const polite = await fetchPublicDocument(walled(1), { launcher, allowBrowser: false });
  assert.match(polite.reason, /switched off/i);
  assert.equal(verdict(polite).siteRefused, true, "it is still a refusal of THIS caller's best permitted try");
  assert.equal(verdict(polite).refusedHost, undefined);
  const polite2 = await fetchPublicDocument(walled(2), { launcher, allowBrowser: false });
  assert.equal(verdict(polite2).refusedHost, undefined, "two no-browser 403s do not count: the window was never this caller's to try");
  const next = await fetchPublicDocument(walled(3), { launcher });
  assert.equal(state.launches, 1, "the first caller that MAY open a window gets its one try");
  assert.match(next.reason, /refused too/i);
});

await check("with DOCUMENT_FETCH_BROWSER=0 the plain 403 IS the process's best permitted try: it counts, and the second backs the host off", async () => {
  reset(); seenPaths.length = 0;
  process.env.DOCUMENT_FETCH_BROWSER = "0";
  try {
    const { launcher, state } = makeLauncher();
    const first = await fetchPublicDocument(walled(1), { launcher });
    assert.equal(state.launches, 0);
    assert.equal(verdict(first).siteRefused, true);
    assert.equal(verdict(first).refusedHost, undefined, first.reason);
    const second = await fetchPublicDocument(walled(2), { launcher });
    assert.equal(verdict(second).refusedHost, hostOf(base), second.reason);
    const third = await fetchPublicDocument(walled(3), { launcher });
    assert.equal(verdict(third).hostBackedOff, true, third.reason);
    assert.deepEqual(seenPaths.filter((p) => p.startsWith("/doc-")), ["/doc-1.pdf", "/doc-2.pdf"]);
  } finally {
    delete process.env.DOCUMENT_FETCH_BROWSER;
  }
});

await check("the back-off expires: after an hour the host may be asked again — one window, then the count starts over", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  await fetchPublicDocument(walled(1), { launcher });
  await fetchPublicDocument(walled(2), { launcher });
  assert.equal(state.launches, 1);
  assert.equal(verdict(await fetchPublicDocument(walled(3), { launcher })).hostBackedOff, true);
  clock += 61 * 60 * 1000;
  const later = await fetchPublicDocument(walled(4), { launcher });
  assert.equal(state.launches, 2, "one more window after the hour");
  assert.match(later.reason, /refused too/i);
  assert.equal(verdict(later).refusedHost, undefined, "the hour-old refusals are forgotten: this is one document again");
  const again = await fetchPublicDocument(walled(5), { launcher });
  assert.equal(state.launches, 2, "…and only one window");
  assert.equal(verdict(again).refusedHost, hostOf(base));
  assert.equal(verdict(await fetchPublicDocument(walled(6), { launcher })).hostBackedOff, true);
});

await check("the reset seam clears the record (what documentFetch.test relies on between its one-origin checks)", async () => {
  const { launcher, state } = makeLauncher();
  reset();
  await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 1);
});

await site.close();
await other.close();

if (failures) { console.error(`\n${failures} document-fetch politeness check(s) FAILED.`); process.exit(1); }
console.log("\nAll document-fetch politeness checks passed.");
process.exit(0);
