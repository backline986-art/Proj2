// A CLICK ONTO A PAGE WITH NOTHING TO TYPE INTO DOES NOT WAIT 12 s FOR AN INPUT (replay speed,
// 2026-11-23). After every recorded click, replay waited up to 12 s for an interactive control
// to mount — right for a Vue section about to be filled, but a page of buttons (a lookup page, a
// read-only page) never mounts one, so every click onto such a page burned the whole budget. The
// offline bench measured two per Self-Service-shaped replay: 24 of its 47 s. The full wait is now
// kept only when the next step types into the page (or is the review stop / final submit).
// Real Chromium, a local page (never a real portal).
//
//   C1 Next onto a page of buttons, then that page's own Next: the two clicks take well under 12 s.
//   C2 Next onto a section whose input mounts 4 s late, then a fill: the replay still waits for the
//      input (controls-wait over 3.5 s) and the value lands.
//
// KILL TESTS (each must turn this file red):
//   K1 executeClick: waitForInteractiveControls(this.page) (full budget always)      → C1 fails.
//   K2 nextStepNeedsControls: return false                                            → C2 fails.
//
// Run: npx tsx portal-bot/src/adapters/clickControlsWait.dom.smoke.ts
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

// One SPA path. #n1 swaps in a page of buttons only; its #n2 swaps in the last section, whose
// input mounts after `?late` ms (0 = at once).
const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}</style></head><body>
  <main id="app"><h2>Start</h2><button id="n1" type="button">Next</button></main>
  <script>
    var late = Number(new URLSearchParams(location.search).get("late") || 0);
    var app = document.getElementById("app");
    function last() {
      app.innerHTML = '<h2>Project details</h2><p>Loading section...</p>';
      setTimeout(function () { app.innerHTML = '<h2>Project details</h2><label for="desc">Description</label><input id="desc">'; }, late);
    }
    document.getElementById("n1").addEventListener("click", function () {
      if (late) { last(); return; }
      app.innerHTML = '<h2>Find your contractor</h2><button type="button">Search the state list</button><button id="n2" type="button">Next</button>';
      document.getElementById("n2").addEventListener("click", last);
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const recipeFor = (url: string, steps: unknown[]): PortalRecipe => ({
  id: "ccw1", scopeType: "ahj", profileKey: "or|bench|bench", state: "OR",
  ahj: "Bench", utility: "", portalPlatform: "custom", portalUrl: url,
  status: "complete", version: 1, steps: steps as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

type Out = { ok: boolean; ms: number; slow: Array<{ note?: string; phases?: Record<string, number> }>; value: string; drift: string[]; error: string };
const runOne = async (url: string, steps: unknown[], fieldValues: Record<string, string> = {}): Promise<Out> => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(url);
  const adapter = new RecipeAdapter(recipeFor(url, steps), fieldValues, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never) as unknown as { success?: boolean; error?: string; data?: { slowSteps?: Out["slow"]; driftWarnings?: string[] } };
  const ms = Date.now() - t0;
  const value = await page.locator("#desc").inputValue({ timeout: 1000 }).catch(() => "");
  await browser.close();
  return { ok: !!res.success, ms, slow: res.data?.slowSteps ?? [], value, drift: res.data?.driftWarnings ?? [], error: String(res.error ?? "") };
};

// ---------------------------------------------------------------------------
const c1 = await runOne(`http://127.0.0.1:${port}/`, [
  { action: "click", phase: "fill", field: "", note: "advance: Next", selector: { css: "#n1" } },
  { action: "click", phase: "fill", field: "", note: "advance: Next", selector: { css: "#n2" } },
  { action: "fill", phase: "fill", field: "projectDescription", note: "Description", selector: { css: "#desc" } },
], { projectDescription: "Roof-mounted PV" });
console.log(`   C1 ${c1.ms} ms, slow=${JSON.stringify(c1.slow)}${c1.error ? `, error=${c1.error.slice(0, 160)}` : ""}`);
check("C1 two clicks onto pages with nothing to type into take well under the old 12 s each",
  c1.ms < 10_000 && c1.value === "Roof-mounted PV", `took ${c1.ms} ms, value=${JSON.stringify(c1.value)}`);

const c2 = await runOne(`http://127.0.0.1:${port}/?late=4000`, [
  { action: "click", phase: "fill", field: "", note: "advance: Next", selector: { css: "#n1" } },
  { action: "fill", phase: "fill", field: "projectDescription", note: "Description", selector: { css: "#desc" } },
], { projectDescription: "Roof-mounted PV" });
const waited = c2.slow.find((s) => /advance: Next/.test(String(s.note ?? "")))?.phases?.["controls-wait"] ?? 0;
console.log(`   C2 ${c2.ms} ms, controls-wait=${waited} ms${c2.error ? `, error=${c2.error.slice(0, 160)}` : ""}`);
check("C2 a click before a fill still waits for the late section's input, and the value lands",
  waited >= 3500 && c2.value === "Roof-mounted PV", `controls-wait=${waited} ms, value=${JSON.stringify(c2.value)}`);

server.close();
if (failures > 0) {
  console.error(`\n${failures} click controls-wait smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll click controls-wait smoke tests passed.");
process.exit(0);
