// A POPUP WITH NO FILTER BOX MUST NOT COST THIRTY SECONDS (#584).
//
// fillCustomCombobox's "filtered-list miss recovery" (3a') reads the popup's search box to see
// whether a typed filter emptied the list. A Telerik-style list (and most plain dropdowns) has no
// box at all, so its `input:visible` matches nothing — and an uncapped inputValue() on a locator
// that matches nothing WAITS for one: Playwright's default 30s, with no default set anywhere in
// this engine. Every pick that reached 3a' — any answer without an exact option, which is exactly
// when the trailing-token and visible-text passes run — paid that 30s, twice per replay step
// (the select path calls the combobox fill twice). widgetFaceReadback's 48 cases then ran past
// the runner's 600s budget and were reported as a hang, not as a result.
//
// MUST PASS — one fill on a Telerik list with no search box, for an answer with no exact option
//             ("Schedule 7"), returns within 12s (it took 30s+ before the cap).
// MUST PASS — it still reaches the trailing-token pass (the option it clicks is the same one
//             widgetFaceReadback's schedule7 case refuses at read-back; this smoke pins timing,
//             not the verdict).
// MUST PASS — a popup that HAS a search box still gets the typed filter and the exact pick.
// MUST PASS — a cascading list (aria-controls) that opens EMPTY and fills ~600ms later: the fill
//             waits on that list, not on another popup still on screen, and picks the model in
//             seconds. Before, the empty list sent the wait to the other popup and only the 30s
//             stall above gave the cascade time to land (powerClerkSpecsCombobox).
//
// Hermetic: a throwaway 127.0.0.1 server. Discovered from disk by scripts/run-dom-smokes.ts.
//   npx tsx portal-bot/src/comboboxNoSearchBox.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { fillCustomCombobox, type ComboboxPick } from "./comboboxFill";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; padding: 16px; }
  .face { display: inline-block; min-width: 180px; border: 1px solid #999; padding: 3px 6px; cursor: pointer; }
  .wired-popup { position: absolute; background: #fff; border: 1px solid #999; z-index: 99; }
  ul { list-style: none; padding: 0; margin: 0; }
</style></head><body>
  <div class="t-widget t-dropdown" id="noBox" tabindex="0">
    <div class="face t-dropdown-wrap"><span class="t-input" id="noBoxFace">Please select...</span></div>
    <input id="k" style="display:none" value="">
  </div>
  <div class="t-widget t-dropdown" id="withBox" tabindex="0" style="margin-top:220px">
    <div class="face t-dropdown-wrap"><span class="t-input" id="withBoxFace">Please select...</span></div>
    <input id="k2" style="display:none" value="">
  </div>
  <div class="cascade" style="margin-top:220px">
    <input id="model" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="model-list" aria-label="Model" readonly tabindex="0" value="">
    <ul id="model-list" role="listbox" hidden></ul>
  </div>
<script>
  // A CASCADING list (PowerClerk's Model after a Manufacturer change): it opens empty and its
  // options arrive ~600ms later, rendered into the list that is already open.
  (function () {
    var inp = document.getElementById("model"), ul = document.getElementById("model-list"), loaded = false;
    var render = function () {
      ul.innerHTML = "";
      if (!loaded) return;
      ["0.8 kW (Model DS3-L {240V} [SI1])", "0.96 kW (Model QT2 {240V})"].forEach(function (t) {
        var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = t;
        li.addEventListener("mousedown", function (e) { e.preventDefault(); inp.value = t; ul.hidden = true; inp.setAttribute("aria-expanded", "false"); });
        ul.appendChild(li);
      });
    };
    inp.addEventListener("click", function () {
      inp.setAttribute("aria-expanded", "true"); ul.hidden = false; render();
      if (!loaded) setTimeout(function () { loaded = true; if (inp.getAttribute("aria-expanded") === "true") render(); }, 600);
    });
  })();
  function wire(w, input, face, opts, withSearch) {
    w.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".wired-popup")) return;
      var open = document.querySelector(".wired-popup"); if (open) { open.remove(); return; }
      // No box: a Telerik list. With a box: a listbox popup holding its own filter input (the
      // shape optionScope scopes the search to).
      var box = document.createElement("div");
      if (withSearch) { box.setAttribute("role", "listbox"); box.className = "wired-popup"; } else box.className = "t-animation-container wired-popup";
      var ul = document.createElement("ul"); if (!withSearch) ul.className = "t-list";
      var render = function (filter) {
        ul.innerHTML = "";
        opts.filter(function (o) { return !filter || o[1].toLowerCase().indexOf(filter.toLowerCase()) >= 0; }).forEach(function (o) {
          var li = document.createElement("li"); li.className = "t-item"; li.textContent = o[1];
          li.addEventListener("click", function () { input.value = o[0]; face.textContent = o[1]; box.remove(); });
          ul.appendChild(li);
        });
      };
      if (withSearch) {
        var s = document.createElement("input"); s.type = "search"; s.className = "t-search"; s.setAttribute("aria-label", "Search");
        s.addEventListener("input", function () { window.__typed = s.value; render(s.value); });
        box.appendChild(s);
      }
      render(""); box.appendChild(ul); document.body.appendChild(box);
    });
  }
  wire(document.getElementById("noBox"), document.getElementById("k"), document.getElementById("noBoxFace"),
    [["21", "Rule 21 - 7 kW or less"], ["10", "Schedule 10"]], false);
  wire(document.getElementById("withBox"), document.getElementById("k2"), document.getElementById("withBoxFace"),
    [["1", "Enphase Energy Inc"], ["2", "SolarEdge Technologies"], ["3", "Enphase Storage"]], true);
</script></body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);

  {
    const pick: ComboboxPick = { text: "" };
    const t0 = Date.now();
    const ok = await fillCustomCombobox(page, page.locator("#k"), "Schedule 7", pick);
    const ms = Date.now() - t0;
    console.log(`   [noBox] ok=${ok} picked=${JSON.stringify(pick.text)} key=${JSON.stringify(await page.locator("#k").inputValue())} ${ms}ms`);
    check("a list with no search box, an answer with no exact option: the fill returns within 12s (30s+ before the cap)", ms < 12_000, `${ms}ms`);
    check("…and it still reaches the trailing-token pass (clicked 'Rule 21 - 7 kW or less'; the read-back verdict is widgetFaceReadback's)",
      ok && /Rule 21/.test(pick.text), `ok=${ok} picked=${JSON.stringify(pick.text)}`);
  }
  {
    const pick: ComboboxPick = { text: "" };
    const t0 = Date.now();
    const ok = await fillCustomCombobox(page, page.locator("#k2"), "SolarEdge Technologies", pick);
    const ms = Date.now() - t0;
    const typed = await page.evaluate(() => (window as unknown as { __typed?: string }).__typed ?? "");
    console.log(`   [withBox] ok=${ok} picked=${JSON.stringify(pick.text)} typed=${JSON.stringify(typed)} key=${JSON.stringify(await page.locator("#k2").inputValue())} ${ms}ms`);
    check("a popup WITH a search box still gets the typed filter", typed === "SolarEdge Technologies", `typed=${JSON.stringify(typed)}`);
    check("…and the exact option is picked", ok && pick.text === "SolarEdge Technologies" && (await page.locator("#k2").inputValue()) === "2", `ok=${ok} picked=${JSON.stringify(pick.text)}`);
  }
  {
    // A list a sibling has left on screen is what the empty cascade's wait used to read instead.
    await page.evaluate(() => {
      const ul = document.createElement("ul"); ul.className = "t-list"; ul.id = "stale";
      ul.innerHTML = "<li>Some other widget's row</li>"; document.body.appendChild(ul);
    });
    const pick: ComboboxPick = { text: "" };
    const t0 = Date.now();
    const ok = await fillCustomCombobox(page, page.locator("#model"), "DS3-L", pick);
    const ms = Date.now() - t0;
    console.log(`   [cascade] ok=${ok} picked=${JSON.stringify(pick.text)} value=${JSON.stringify(await page.locator("#model").inputValue())} ${ms}ms`);
    check("a cascading list that opens EMPTY: the fill waits on ITS OWN list and picks the model once it loads",
      ok && /DS3-L/.test(await page.locator("#model").inputValue()), `ok=${ok} picked=${JSON.stringify(pick.text)}`);
    check("…in seconds, not by riding out a 30s stall", ms < 8000, `${ms}ms`);
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\ncomboboxNoSearchBox.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\ncomboboxNoSearchBox.dom.smoke: PASS");
process.exit(0);
