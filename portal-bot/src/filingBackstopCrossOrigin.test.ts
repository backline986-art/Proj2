// #402: A CROSS-ORIGIN 307 OF A FORM POST, THROUGH THE BACKSTOP, IN THE REAL BROWSER.
//
// A portal's "Next" form POST answered 307 to ANOTHER origin (an SSO hop, a hand-off to a sister
// host) must arrive there, without the first origin's cookie. On Chromium 149 (build 1228, the one
// Playwright 1.61 pinned) it never did: with ANY DevTools Fetch interception on the page — and the
// backstop's own context.route is one — Chromium failed the redirected leg itself
// (net::ERR_INVALID_ARGUMENT, responseErrorReason "Failed", nothing sent) and the page ended on
// chrome-error://chromewebdata/. Not the redirect guard: a bare `context.route(() => fallback())`
// with none of our code failed the same way, and so did a raw page-target Fetch.enable at either
// stage; a same-origin 307 and a fetch's cross-origin 307 were fine. Chromium 153 (build 1243,
// Playwright 1.63) follows it. So every learn / replay run on 149 died silently on such a hop.
//
// This runs in the unit suite (CI installs Chromium for it) so a browser pin that brings the bug
// back is red in CI, not only in the DOM smoke (filingBackstopRedirect xoriginOk, which CI does not
// run). The refusal half pins rule 1 on the same path: a cross-origin 307 to a filing URL is still
// refused, named, and never reaches the other origin.
//
// The second origin is `localhost` on the same loopback server set: a different host (so the
// 127.0.0.1 cookie may not travel) without needing 127.0.0.2, which macOS does not configure.
import http from "node:http";
import { chromium } from "playwright";
import { installFilingBackstop } from "./filingBackstop";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.error(`FAIL - ${label}${detail ? ` (${detail})` : ""}`); }
};

type Hit = { origin: "first" | "other"; method: string; path: string; body: string; cookie: string };
const hits: Hit[] = [];
let otherBase = "";
const REDIRECTS: Record<string, () => string> = {
  "/step/handoff": () => `${otherBase}/landing`,
  "/step/handoffFile": () => `${otherBase}/SubmitApplication`,
};
const handle = (origin: Hit["origin"]) => (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "GET") hits.push({ origin, method: String(req.method), path: url.pathname, body: Buffer.concat(chunks).toString("utf8"), cookie: String(req.headers.cookie || "") });
    const to = REDIRECTS[url.pathname];
    if (to && req.method === "POST") { res.writeHead(307, { location: to() }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    if (url.pathname === "/form") {
      const action = url.searchParams.get("to") || "/step/handoff";
      res.end(`<!doctype html><html><body><h1>Step 3: Contacts</h1>
        <form id="hf" method="post" action="${action}"><input name="a" value="synthetic-402"></form>
        <a id="next" href="#" onclick="document.getElementById('hf').submit();return false;">Next</a></body></html>`);
      return;
    }
    res.end("<!doctype html><html><body><h1>Step 4: Additional Information</h1></body></html>");
  });
};
const first = http.createServer(handle("first"));
await new Promise<void>((r) => first.listen(0, "127.0.0.1", () => r()));
const firstBase = `http://127.0.0.1:${(first.address() as { port: number }).port}`;
const other = http.createServer(handle("other"));
await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
otherBase = `http://localhost:${(other.address() as { port: number }).port}`;

const browser = await chromium.launch();
try {
  console.log(`(chromium ${browser.version()})`);
  const run = async (to: string) => {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addCookies([{ name: "sess", value: "first-origin-synthetic", url: firstBase, httpOnly: true }]);
    const page = await ctx.newPage();
    const failed: string[] = [];
    page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`));
    const bs = await installFilingBackstop(page, "cross-origin unit");
    await page.goto(`${firstBase}/form?to=${encodeURIComponent(to)}`);
    hits.length = 0;
    await Promise.all([page.waitForLoadState("load").catch(() => null), page.click("#next")]);
    await page.waitForTimeout(700);
    const out = { hits: hits.slice(), url: page.url(), failed, aborts: bs ? bs.aborts.slice() : [], stopping: bs ? bs.stoppingAborts().slice() : [], judged: !!bs?.redirectsJudged };
    await bs?.dispose();
    await ctx.close().catch(() => null);
    return out;
  };

  const ok = await run("/step/handoff");
  const land = ok.hits.find((h) => h.origin === "other" && h.path === "/landing");
  const detail = `hits=[${ok.hits.map((h) => `${h.method} ${h.origin}${h.path}`).join(",")}] url=${ok.url} failed=[${ok.failed.join(" | ")}] aborts=${ok.aborts.length}`;
  check("the backstop was installed and judges this page's redirects", ok.judged, detail);
  check("a form POST answered 307 to another origin ARRIVES there (POST, body kept) — never chrome-error",
    !!land && land.method === "POST" && /a=synthetic-402/.test(land.body) && ok.url === `${otherBase}/landing`, detail);
  check("…without the first origin's cookie", !!land && !/first-origin-synthetic/.test(land.cookie), `cookie=${land?.cookie}`);
  check("…and nothing was held or failed on the way", ok.aborts.length === 0 && ok.failed.length === 0, detail);

  const bad = await run("/step/handoffFile");
  const badDetail = `hits=[${bad.hits.map((h) => `${h.method} ${h.origin}${h.path}`).join(",")}] url=${bad.url} stopping=[${bad.stopping.map((a) => `${a.where} ${a.why}`).join(" | ")}]`;
  check("rule 1: a cross-origin 307 to a filing URL never reaches the other origin",
    bad.hits.filter((h) => h.path === "/SubmitApplication").length === 0 && bad.hits.some((h) => h.origin === "first" && h.path === "/step/handoffFile"), badDetail);
  check("…and the refusal is named and stops the run (a redirect, from the first leg)",
    bad.stopping.some((a) => a.where.endsWith("/SubmitApplication") && !!a.redirect && a.redirect.status === 307 && /\/step\/handoffFile$/.test(a.redirect.from)), badDetail);
} finally {
  await browser.close().catch(() => null);
  first.close();
  other.close();
}

if (failures) { console.error(`filingBackstopCrossOrigin: ${failures} FAILED`); process.exit(1); }
console.log("filingBackstopCrossOrigin: all checks passed");
