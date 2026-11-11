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
// one challenge page.
// ---------------------------------------------------------------------------
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);
const WALL = "<html><head><title>Access denied</title></head><body>Access denied. Error code 1020. Ray ID: 8f3b21c0de9a0001</body></html>";
const seenPaths: string[] = [];
function makeServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    seenPaths.push(url);
    if (url === "/ok.pdf") { res.writeHead(200, { "content-type": "application/pdf", server: "nginx" }); res.end(Buffer.from(PDF_BYTES)); return; }
    if (/^\/doc-\d+\.pdf$/.test(url)) { res.writeHead(403, { "content-type": "text/html", server: "cloudflare" }); res.end(WALL); return; }
    if (url === "/captcha.pdf") { res.writeHead(403, { "content-type": "text/html", server: "cloudflare" }); res.end('<html><body><h1>Verify you are human</h1><div class="cf-turnstile"></div></body></html>'); return; }
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
process.env.DOCUMENT_FETCH_ALLOW_ORIGINS = `${base},${other.base}`;
const walled = (n: number, origin = base): string => `${origin}/doc-${n}.pdf`;

// The injected window: counts launches; its in-page fetch is refused too, which is what a
// Cloudflare-walled host does to a window it has fingerprinted.
interface FakeState { launches: number; closes: number }
function makeLauncher(): { launcher: DocumentBrowserLauncher; state: FakeState } {
  const state: FakeState = { launches: 0, closes: 0 };
  const launcher: DocumentBrowserLauncher = async (): Promise<DocumentBrowserSession> => {
    state.launches++;
    return {
      async visit(url: string) { return { status: 200, html: "<html><body>warm</body></html>", url }; },
      async fetchInPage() { return { status: 403, contentType: "text/html", bytes: new TextEncoder().encode(WALL) }; },
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

await check("THE BITE: ten walled paths on one host open exactly ONE window; the other nine send nothing and say why", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher();
  const results = [];
  for (let n = 1; n <= 10; n++) results.push(await fetchPublicDocument(walled(n), { launcher }));
  assert.equal(state.launches, 1, `exactly one launcher call for one walled host, got ${state.launches}`);
  assert.equal(state.closes, 1, "the one window was closed");
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /refused too/i, "the first result reports the window that was refused");
  for (const [i, r] of results.slice(1).entries()) {
    assert.equal(r.ok, false);
    assert.equal(r.status, 0, `result ${i + 2}: nothing was sent, so there is no status`);
    assert.equal((r as { hostBackedOff?: boolean }).hostBackedOff, true, `result ${i + 2} must carry the stable back-off marker`);
    assert.match(r.reason, /backed off/i, `result ${i + 2}: ${r.reason}`);
    assert.match(r.reason, /cloudflare/i, `result ${i + 2} names the earlier refusal: ${r.reason}`);
    assert.ok(r.reason.includes(hostOf(base)), `result ${i + 2} names the host: ${r.reason}`);
  }
  assert.deepEqual(seenPaths.filter((p) => p.startsWith("/doc-")), ["/doc-1.pdf"], "the server saw ONE walled request, not ten");
});

await check("ten callers arriving TOGETHER still open one window (the chain and the gate both re-read the refusal)", async () => {
  reset(); seenPaths.length = 0;
  const { launcher, state } = makeLauncher();
  const results = await Promise.all(Array.from({ length: 10 }, (_v, i) => fetchPublicDocument(walled(i + 1), { launcher })));
  assert.equal(state.launches, 1, `got ${state.launches} launches`);
  assert.equal(results.filter((r) => (r as { hostBackedOff?: boolean }).hostBackedOff).length, 9);
  assert.deepEqual(seenPaths.filter((p) => p.startsWith("/doc-")), ["/doc-1.pdf"]);
});

await check("a 404 on the host is a missing page, not a refusal: the next wall still earns its window", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  const missing = await fetchPublicDocument(`${base}/missing.pdf`, { launcher });
  assert.equal(missing.status, 404);
  assert.equal((missing as { hostBackedOff?: boolean }).hostBackedOff, undefined);
  const next = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 1, "the 404 must not have backed the host off");
  assert.match(next.reason, /refused too/i);
});

await check("a refusal on one host does not reach another host", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  await fetchPublicDocument(walled(1), { launcher });
  const elsewhere = await fetchPublicDocument(walled(1, other.base), { launcher });
  assert.equal(state.launches, 2, "the other host gets its own one try");
  assert.equal((elsewhere as { hostBackedOff?: boolean }).hostBackedOff, undefined, elsewhere.reason);
});

await check("a CAPTCHA still never earns a window — and it backs the host off like any refusal", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  const puzzle = await fetchPublicDocument(`${base}/captcha.pdf`, { launcher });
  assert.equal(puzzle.ok, false);
  assert.match(puzzle.reason, /never solves CAPTCHAs/i);
  assert.equal(state.launches, 0, "escalating INTO a CAPTCHA is the first step toward solving one");
  const next = await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 0, "the host that showed a puzzle is not asked again");
  assert.equal((next as { hostBackedOff?: boolean }).hostBackedOff, true, next.reason);
});

await check("a wall the CALLER would not climb does not back the host off: the lookup's no-browser 403 must not cost fee research its one window", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  const polite = await fetchPublicDocument(walled(1), { launcher, allowBrowser: false });
  assert.match(polite.reason, /switched off/i);
  const next = await fetchPublicDocument(walled(2), { launcher });
  assert.equal(state.launches, 1, "the first caller that MAY open a window gets its one try");
  assert.match(next.reason, /refused too/i);
});

await check("the back-off expires: after an hour the host may be asked again, once", async () => {
  reset();
  const { launcher, state } = makeLauncher();
  await fetchPublicDocument(walled(1), { launcher });
  assert.equal(state.launches, 1);
  clock += 61 * 60 * 1000;
  const later = await fetchPublicDocument(walled(2), { launcher });
  assert.equal(state.launches, 2, "one more try after the hour");
  assert.match(later.reason, /refused too/i);
  const again = await fetchPublicDocument(walled(3), { launcher });
  assert.equal(state.launches, 2, "…and only one");
  assert.equal((again as { hostBackedOff?: boolean }).hostBackedOff, true);
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
