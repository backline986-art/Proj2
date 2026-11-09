// A SELECT STEP ON A CONCEALED BACKING INPUT DOES NOT WAIT FOR IT TO TURN VISIBLE (#584).
//
// A Telerik/Kendo-style dropdown keeps its key in an <input style="display:none"> and is driven
// through its face. The replay's select step waited (waitForElement, 10s) for that input to become
// visible, which it never does — so every such step spent 10s doing nothing, on every run, and
// widgetFaceReadback's 48 one-step cases ran past the runner's 600s budget as a "hang".
//
// MUST PASS    — isConcealedBackingInput: a display:none <input> and a type=hidden <input> are
//                concealed backing inputs.
// MUST EXCLUDE — a visible input; an input hidden only by a hidden SECTION around it (it may be
//                revealed: the wait stays); a <select> with display:none (select2's native select,
//                driven its own way); a selector that matches nothing yet (not rendered: the wait
//                stays). Each answers false, and fast.
// MUST PASS    — a RecipeAdapter select step on a Telerik widget lands, is verified, and takes well
//                under the old 10s wait.
//
// Hermetic: a throwaway 127.0.0.1 server. Discovered from disk by scripts/run-dom-smokes.ts.
//   npx tsx portal-bot/src/adapters/concealedBackingInput.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter, isConcealedBackingInput } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; padding: 16px; }
  .face { display: inline-block; min-width: 180px; border: 1px solid #999; padding: 3px 6px; cursor: pointer; }
  .t-animation-container { position: absolute; background: #fff; border: 1px solid #999; z-index: 99; }
  ul { list-style: none; padding: 0; margin: 0; }
</style></head><body>
  <label>Work Type</label>
  <div class="t-widget t-dropdown t-header" tabindex="0" data-for="k">
    <div class="face t-dropdown-wrap t-state-default"><span class="t-input" id="face">Please select...</span><span class="t-select"><span class="t-icon t-arrow-down">select</span></span></div>
    <input id="k" name="k" style="display:none" type="text" value="">
  </div>
  <input id="typeHidden" type="hidden" value="x">
  <input id="shown" type="text" value="">
  <div style="display:none"><input id="inHiddenSection" type="text" value=""></div>
  <select id="nativeHidden" style="display:none"><option>a</option></select>
<script>
  var w = document.querySelector(".t-widget"), input = document.getElementById("k"), face = document.getElementById("face");
  var opts = [["1", "ADDITION AND REMODELING"], ["5", "STAND-ALONE"]];
  w.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest(".t-animation-container")) return;
    var open = document.querySelector(".t-animation-container"); if (open) { open.remove(); return; }
    var box = document.createElement("div"); box.className = "t-animation-container";
    var ul = document.createElement("ul"); ul.className = "t-list t-reset";
    opts.forEach(function (o) {
      var li = document.createElement("li"); li.className = "t-item"; li.textContent = o[1];
      li.addEventListener("click", function () { input.value = o[0]; face.textContent = o[1]; box.remove(); });
      ul.appendChild(li);
    });
    box.appendChild(ul); document.body.appendChild(box);
  });
</script></body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(url);

  const ask = async (css: string): Promise<{ v: boolean; ms: number }> => {
    const t0 = Date.now();
    const v = await isConcealedBackingInput(page.locator(css));
    return { v, ms: Date.now() - t0 };
  };
  for (const css of ["#k", "#typeHidden"]) {
    const r = await ask(css);
    check(`MUST PASS: ${css} is a concealed backing input`, r.v === true, JSON.stringify(r));
  }
  for (const [css, why] of [["#shown", "a visible input"], ["#inHiddenSection", "an input hidden only by its section"], ["#nativeHidden", "a display:none <select>"], ["#notRenderedYet", "a selector that matches nothing yet"]] as const) {
    const r = await ask(css);
    check(`MUST EXCLUDE: ${why} (${css}) is not — the visibility wait stays — answered in under 2s`, r.v === false && r.ms < 2000, JSON.stringify(r));
  }
  check("a browser-free fake (no count/first) answers false", (await isConcealedBackingInput({})) === false);

  // End to end: one replay select step on the Telerik widget.
  const steps = [{ action: "select", phase: "fill", field: "pick", note: "Work Type", selector: { css: "#k" } }] as unknown as RecipeStep[];
  const recipe = {
    id: "concealed-backing", scopeType: "ahj", profileKey: "fl|example|x", state: "FL", ahj: "Example", utility: "",
    portalPlatform: "ibuild", portalUrl: url, status: "complete", version: 1, steps,
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { pick: "STAND-ALONE" }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never);
  const ms = Date.now() - t0;
  const data = (res.data ?? {}) as { skipped?: string[]; fieldsVerified?: string[] };
  const key = await page.locator("#k").inputValue();
  console.log(`   [replay] key=${JSON.stringify(key)} verified=${JSON.stringify(data.fieldsVerified ?? [])} skipped=${JSON.stringify(data.skipped ?? [])} ${ms}ms`);
  check("a replay select step on a Telerik widget lands and is verified", key === "5" && (data.fieldsVerified ?? []).includes("Work Type") && !(data.skipped ?? []).includes("Work Type"),
    `key=${key} verified=${JSON.stringify(data.fieldsVerified)} skipped=${JSON.stringify(data.skipped)}`);
  check("…without waiting 10s for its hidden key input to turn visible (the step takes under 8s)", ms < 8000, `${ms}ms`);
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\nconcealedBackingInput.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nconcealedBackingInput.dom.smoke: PASS");
process.exit(0);
