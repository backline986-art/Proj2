// A NATIVE <select> WHOSE OPTIONS WORD THE ANSWER DIFFERENTLY IS PICKED AT ONCE, NOT AFTER 10 s
// (replay speed, 2026-11-23). selectWithFallback tried selectOption(value) then selectOption({label}),
// 5 s each, and Playwright WAITS that long for an exact option that a list worded "Enphase Energy
// Inc." will never show for "Enphase". The offline bench measured it: 2 such selects, 20 of a
// PowerClerk-shaped replay's 79 s. Now the list is asked first (nativeExactOptionAppears), polled
// for up to NATIVE_EXACT_WAIT_MS so a cascade that is still replacing the options is waited for.
// Real Chromium, a local page (never a real portal).
//
//   N1 "Enphase" on a list worded "Enphase Energy Inc." lands that option in well under 5 s.
//   N2 a cascade that replaces a STALE list (whose "IQ8 Legacy" would contains-match "IQ8") with
//      one holding the exact "IQ8" 600 ms later lands the exact option, never the stale neighbour.
//   N3 an exact option already listed is selected as before.
//
// KILL TESTS (each must turn this file red):
//   K1 selectWithFallback: drop the nativeExactOptionAppears gate (always run both exact attempts) → N1 fails (slow).
//   K2 NATIVE_EXACT_WAIT_MS = 0                                                                     → N2 fails (stale pick).
//
// Run: npx tsx portal-bot/src/nativeSelectWait.dom.smoke.ts
import "./smokeArtifactDirs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { selectWithFallback } from "./comboboxFill";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx names inner functions with __name; the product's pages get the same shim (see replayFixCapture smoke).
await context.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
const page = await context.newPage();
await page.setContent(`<!doctype html><html><body>
  <label for="make">Manufacturer</label>
  <select id="make"><option value="">Please select...</option><option value="APS">Altenergy Power System</option><option value="ENP">Enphase Energy Inc.</option></select>
  <label for="model">Model</label>
  <select id="model"><option value="">Please select...</option><option value="OLD">IQ8 Legacy</option></select>
  <label for="st">State</label>
  <select id="st"><option value="">--Select--</option><option value="OR">Oregon</option><option value="ID">Idaho</option></select>
  <script>
    window.cascade = function () {
      setTimeout(function () {
        document.getElementById("model").innerHTML = '<option value="">Please select...</option><option value="IQ8">IQ8</option><option value="IQ8P">IQ8 Plus</option>';
      }, 600);
    };
  </script>
</body></html>`);

await check("N1 a differently worded option is picked at once, not after the exact attempts time out", async () => {
  const t0 = Date.now();
  const ok = await selectWithFallback(page, page.locator("#make"), "Enphase");
  const ms = Date.now() - t0;
  assert.equal(ok, true);
  assert.equal(await page.locator("#make").inputValue(), "ENP");
  assert.ok(ms < 4000, `took ${ms} ms`);
});

await check("N2 a cascade still replacing a stale list is waited for: the exact option lands, never the stale contains-match", async () => {
  await page.evaluate(() => (window as unknown as { cascade: () => void }).cascade());
  const ok = await selectWithFallback(page, page.locator("#model"), "IQ8");
  assert.equal(ok, true);
  assert.equal(await page.locator("#model").inputValue(), "IQ8");
});

await check("N3 an option listed exactly is selected as before", async () => {
  const t0 = Date.now();
  assert.equal(await selectWithFallback(page, page.locator("#st"), "OR"), true);
  assert.equal(await page.locator("#st").inputValue(), "OR");
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} native select wait smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll native select wait smoke tests passed.");
process.exit(0);
