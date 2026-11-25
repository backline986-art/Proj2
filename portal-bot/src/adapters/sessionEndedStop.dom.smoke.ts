// A REPLAY THAT LANDS ON "SESSION ENDED" STOPS AT ONCE; A BLANK SAVE INDICATOR COSTS NOTHING
// (replay-doctor output, live PGE replay 2026-11-23, #281). Real Chromium, a local page shaped like
// a hosted interconnection portal (never a real one).
//
//   S1 the page after a click turns into the platform's "Session Ended" page (another sign-in with
//      the same login ended this session): the replay stops before the next step, says so in the
//      run-abort words the backend keeps the recipe on, and never fills a thing on that page. It
//      stalled for 8 minutes before.
//   A1 a page carrying the platform's save indicator with NOTHING in it: three fills take well under
//      the old 8 s each (the replay waited for the word "saved"; the live PGE fills took 8.2-8.7 s).
//   A2 the indicator says "Saving…" after each change and "All changes saved" 3 s later: each fill
//      still waits for it, and every value holds.
//
// KILL TESTS (each must turn this file red):
//   K1 recipeAdapter: drop the pre-step sessionEndedBanner check                          → S1 fails.
//   K2 waitForAutosaveCommitted: wait for /saved/ in the text again (the old loop)         → A1 fails.
//   K3 waitForAutosaveCommitted: return at once whatever the indicator says                 → A2 fails.
//
// Run: npx tsx portal-bot/src/adapters/sessionEndedStop.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGES: Record<string, string> = {
  "/ended": `<!doctype html><html><body><main id="app"><h2>Applicant</h2>
    <label for="a">First name</label><input id="a">
    <button id="next" type="button">Next</button></main>
    <script>
      document.getElementById("next").addEventListener("click", function () {
        document.body.innerHTML = '<h1>Session Ended</h1><p>Your session has ended. Accounts are designed for exactly one user.</p><a href="/login">Log in again</a>';
      });
    </script></body></html>`,
  "/blank": `<!doctype html><html><body><span data-test-role="project-save-state"></span><h2>Contact</h2>
    <label for="f1">First</label><input id="f1"><label for="f2">Last</label><input id="f2"><label for="f3">City</label><input id="f3">
    </body></html>`,
  "/saving": `<!doctype html><html><body><span data-test-role="project-save-state"></span><h2>Contact</h2>
    <label for="f1">First</label><input id="f1"><label for="f2">Last</label><input id="f2">
    <script>
      var st = document.querySelector("[data-test-role='project-save-state']"); var timer = null;
      document.addEventListener("input", function () {
        st.textContent = "Saving\\u2026"; clearTimeout(timer);
        timer = setTimeout(function () { st.textContent = "All changes saved"; }, 3000);
      });
    </script></body></html>`,
};
const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGES[String(q.url).split("?")[0]] ?? "<h1>nothing</h1>"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeFor = (url: string, steps: unknown[]): PortalRecipe => ({
  id: "ses1", scopeType: "utility", profileKey: "or|bench|bench", state: "OR",
  ahj: "", utility: "Bench Power", portalPlatform: "custom", portalUrl: url,
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
  const res = await adapter.fillApplication({} as never) as unknown as { ok?: boolean; message?: string; data?: Record<string, unknown> };
  const ms = Date.now() - t0;
  const values: string[] = [];
  for (const sel of read) values.push(await page.locator(sel).inputValue({ timeout: 1000 }).catch(() => ""));
  const bodyHasInput = (await page.locator("input").count().catch(() => 0)) > 0;
  await browser.close();
  return { ok: !!res.ok, ms, error: String(res.message ?? ""), values, bodyHasInput };
};

// ---------------------------------------------------------------------------
const s1 = await runOne(`${base}/ended`, [
  { action: "fill", phase: "fill", field: "installerFirstName", note: "First name", selector: { css: "#a" } },
  { action: "click", phase: "fill", field: "", note: "advance: Next", selector: { css: "#next" } },
  { action: "fill", phase: "fill", field: "installerLastName", note: "Last", selector: { css: "#b" } },
  { action: "fill", phase: "fill", field: "installerCity", note: "City", selector: { css: "#c" } },
], { installerFirstName: "Pat", installerLastName: "Lee", installerCity: "Bend" }, []);
console.log(`   S1 ${s1.ms} ms: ${s1.error.slice(0, 220)}`);
check("S1 a page that turned into \"Session Ended\" stops the replay before the next step, named as the session's end",
  !s1.ok && /THE PORTAL ENDED THIS SESSION mid-run \("Session Ended"\) before step 3/.test(s1.error) && /nothing was submitted/.test(s1.error),
  s1.error.slice(0, 300));
check("S1 ...in seconds, not minutes, and nothing is filled on that page", s1.ms < 25_000 && !s1.bodyHasInput, `${s1.ms} ms`);

const FIELDS = ["installerFirstName", "installerLastName", "installerCity"];
const LABELS = ["First", "Last", "City"];
const fills = (ids: string[]) => ids.map((id, i) => ({ action: "fill", phase: "fill", field: FIELDS[i], note: LABELS[i], selector: { css: `#${id}` } }));
const VALUES = { installerFirstName: "Pat", installerLastName: "Lee", installerCity: "Bend" };
const a1 = await runOne(`${base}/blank`, fills(["f1", "f2", "f3"]), VALUES, ["#f1", "#f2", "#f3"]);
console.log(`   A1 ${a1.ms} ms, values ${JSON.stringify(a1.values)}${a1.error ? `, error ${a1.error.slice(0, 160)}` : ""}`);
check("A1 a blank save indicator does not hold each fill for 8 s", a1.ms < 12_000 && a1.values.join(",") === "Pat,Lee,Bend", `${a1.ms} ms`);

const a2 = await runOne(`${base}/saving`, fills(["f1", "f2"]), VALUES, ["#f1", "#f2"]);
console.log(`   A2 ${a2.ms} ms, values ${JSON.stringify(a2.values)}${a2.error ? `, error ${a2.error.slice(0, 160)}` : ""}`);
check("A2 \"Saving…\" is still waited for after each fill, and both values hold", a2.ms >= 5_500 && a2.values.join(",") === "Pat,Lee", `${a2.ms} ms`);

server.close();
if (failures > 0) {
  console.error(`\n${failures} session-ended / save-indicator smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll session-ended / save-indicator smoke tests passed.");
process.exit(0);
