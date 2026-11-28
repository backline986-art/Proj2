// A REPLAY THAT LANDS ON A RATE-LIMIT / BAN PAGE STOPS AT ONCE AND PAUSES THE HOST (hostThrottle.ts).
// Live 2026-11-27: Oregon ePermitting (Accela behind Cloudflare) served Error 1015 "You are being
// rate limited … has banned you temporarily" to the operator's computer. A run that kept going on
// that page would fail on a missing control many steps later, blamed on the recipe, and every request
// it made would count against the ban. Real Chromium, a local page shaped like a portal (never a real
// one).
//
//   R1 the page after a click turns into Cloudflare's 1015 page: the run stops before the next step,
//      says THE PORTAL RATE-LIMITED THIS RUN with the until-time, fills nothing on that page, submits
//      nothing; and the host is paused for every automated read (hostPause).
//   R2 a step that fails ON the 1015 page names the rate limit as the cause.
//   C1 an ordinary page that carries Cloudflare's injected bot-detection script and a sign-in CAPTCHA
//      widget is NOT a rate limit: every fill runs, the host is not paused.
//
// KILL TESTS (each must turn this file red):
//   K1 recipeAdapter: drop the pre-step rateLimitPage check                        → R1 fails.
//   K2 rateLimitSignals: match "/cdn-cgi/challenge-platform/" or "cf-chl-" again   → C1 fails.
//
// Run: npx tsx portal-bot/src/adapters/portalRateLimitStop.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { _resetHostThrottle, hostPause } from "../../../backend/src/hostThrottle";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const BAN_BODY = `<div id="cf-wrapper"><h1><span>Error</span><span>1015</span></h1><span>Ray ID: a613d90e0f7d5303</span><h2>You are being rate limited</h2><h2>What happened?</h2><p>The owner of this website (permits.example.gov) has banned you temporarily from accessing this website.</p></div>`;
const PAGES: Record<string, string> = {
  "/limited": `<!doctype html><html><body><main id="app"><h2>Applicant</h2>
    <label for="a">First name</label><input id="a">
    <button id="next" type="button">Next</button></main>
    <script>
      document.getElementById("next").addEventListener("click", function () {
        document.title = "Access denied | permits.example.gov used Cloudflare to restrict access";
        document.body.innerHTML = ${JSON.stringify(BAN_BODY)};
      });
    </script></body></html>`,
  "/banned": `<!doctype html><html><head><title>Access denied | permits.example.gov used Cloudflare to restrict access</title></head><body>${BAN_BODY}</body></html>`,
  "/ordinary": `<!doctype html><html><body><h2>Sign in, then Contact</h2>
    <div class="cf-turnstile" id="cf-chl-widget-ab12"></div><p>Verify you are human</p>
    <label for="f1">First</label><input id="f1"><label for="f2">Last</label><input id="f2">
    <script>window.__CF$cv$params={r:'8f'};var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script>
    </body></html>`,
};
const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGES[String(q.url).split("?")[0]] ?? "<h1>nothing</h1>"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const host = new URL(base).host;

const recipeFor = (url: string, steps: unknown[]): PortalRecipe => ({
  id: "rl1", scopeType: "ahj", profileKey: "or|bench|bench", state: "OR",
  ahj: "Bench City", utility: "", portalPlatform: "custom", portalUrl: url,
  status: "complete", version: 1, steps: steps as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

type Out = { ok: boolean; ms: number; error: string; values: string[]; bodyHasInput: boolean };
const runOne = async (url: string, steps: unknown[], fieldValues: Record<string, string>, read: string[]): Promise<Out> => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(url);
  const adapter = new RecipeAdapter(recipeFor(url, steps), fieldValues, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never) as unknown as { ok?: boolean; message?: string };
  const ms = Date.now() - t0;
  const values: string[] = [];
  for (const sel of read) values.push(await page.locator(sel).inputValue({ timeout: 1000 }).catch(() => ""));
  const bodyHasInput = (await page.locator("input").count().catch(() => 0)) > 0;
  await browser.close();
  return { ok: !!res.ok, ms, error: String(res.message ?? ""), values, bodyHasInput };
};
const VALUES = { installerFirstName: "Pat", installerLastName: "Lee", installerCity: "Bend" };

// ---------------------------------------------------------------------------
_resetHostThrottle();
const r1 = await runOne(`${base}/limited`, [
  { action: "fill", phase: "fill", field: "installerFirstName", note: "First name", selector: { css: "#a" } },
  { action: "click", phase: "fill", field: "", note: "advance: Next", selector: { css: "#next" } },
  { action: "fill", phase: "fill", field: "installerLastName", note: "Last", selector: { css: "#b" } },
  { action: "fill", phase: "fill", field: "installerCity", note: "City", selector: { css: "#c" } },
], VALUES, []);
console.log(`   R1 ${r1.ms} ms: ${r1.error.slice(0, 260)}`);
check("R1 a page that turned into Cloudflare's 1015 page stops the replay before the next step, named as a rate limit",
  !r1.ok && /THE PORTAL RATE-LIMITED THIS RUN before step 3: .*temporarily banned Keelix.*paused until \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(r1.error) && /nothing was submitted/.test(r1.error),
  r1.error.slice(0, 400));
check("R1 ...in seconds, and nothing is filled on that page", r1.ms < 25_000 && !r1.bodyHasInput, `${r1.ms} ms`);
check("R1 ...and the host is paused for every automated read", hostPause(base)?.kind === "banned", JSON.stringify(hostPause(base)));

_resetHostThrottle();
const r2 = await runOne(`${base}/banned`, [
  { action: "fill", phase: "fill", field: "installerFirstName", note: "First name", selector: { css: "#a" } },
], VALUES, []);
console.log(`   R2 ${r2.ms} ms: ${r2.error.slice(0, 260)}`);
check("R2 a first step that fails on the ban page names the rate limit as the cause",
  !r2.ok && /^THE PORTAL RATE-LIMITED THIS RUN: .*The step failure below is the symptom/.test(r2.error) && hostPause(host) != null,
  r2.error.slice(0, 400));

_resetHostThrottle();
const c1 = await runOne(`${base}/ordinary`, [
  { action: "fill", phase: "fill", field: "installerFirstName", note: "First", selector: { css: "#f1" } },
  { action: "fill", phase: "fill", field: "installerLastName", note: "Last", selector: { css: "#f2" } },
], VALUES, ["#f1", "#f2"]);
console.log(`   C1 ${c1.ms} ms, values ${JSON.stringify(c1.values)}${c1.error ? `, error ${c1.error.slice(0, 200)}` : ""}`);
check("C1 a sign-in CAPTCHA widget and Cloudflare's injected script are not a rate limit: every fill runs, no pause",
  c1.values.join(",") === "Pat,Lee" && !/RATE-LIMITED/.test(c1.error) && hostPause(host) == null,
  `${c1.error.slice(0, 200)} pause=${JSON.stringify(hostPause(host))}`);

server.close();
if (failures > 0) {
  console.error(`\n${failures} portal rate-limit smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll portal rate-limit smoke tests passed.");
process.exit(0);
