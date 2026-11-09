// AN EMPTY SHADOW BESIDE THE REAL CONTROL DOES NOT UNDO THE RESCUE, AND NOTHING ELSE DOES (#408).
//
// sectionDisambiguation pins PGE's spec block: the recorded #pcInputBase34 is an opacity:0
// "Model" select holding only "Select...", the section rescue picks the visible inverter Model,
// and MF5's fingerprint re-anchor (replayWrongElement) used to send the write back into the
// shadow. shadowKeepsRescue now lets the rescue stand, but only for that shape. Each MUST
// EXCLUDE below breaks exactly one of its conditions, so loosening any of them turns a case
// red: the neighbour must stay untouched and the Model step must be reported, never verified.
// sectionRedirectKept carries the rest (select2/bootstrap/Kendo cascades, code-valued twins,
// the hook and "Existing Model" neighbours).
//   npx tsx portal-bot/src/adapters/shadowKeepsRescue.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const IQ8 = "IQ8PLUS-72-2-US {240V}";
const shell = (body: string, script = ""): string => `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .panel { border: 1px solid #bbb; padding: 12px; margin: 12px 0; }
  .concealed { opacity: 0; position: absolute; }
  .select2-hidden-accessible { border: 0; clip: rect(0 0 0 0); height: 1px; width: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; }
  .select2-selection { display: inline-block; min-width: 220px; border: 1px solid #aaa; padding: 3px 6px; cursor: pointer; }
  .select2-results { position: absolute; background: #fff; border: 1px solid #aaa; z-index: 9; list-style: none; margin: 0; padding: 0; }
  .select2-results li { padding: 3px 6px; cursor: pointer; }
</style></head><body>${body}
<script>
  // A minimal select2 (sectionRedirectKept's): the face opens the native select's options.
  document.querySelectorAll(".select2-container").forEach(function (box) {
    var sel = document.getElementById(box.getAttribute("data-for"));
    var face = box.querySelector(".select2-selection");
    var sync = function () { var o = sel.options[sel.selectedIndex]; face.textContent = o ? o.text : ""; };
    sel.addEventListener("change", sync); sync();
    face.addEventListener("click", function () {
      var open = document.querySelector(".select2-results"); if (open) { open.remove(); return; }
      var show = function (items) {
        var ul = document.createElement("ul"); ul.className = "select2-results"; ul.setAttribute("role", "listbox");
        items.forEach(function (t) {
          var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = t;
          li.addEventListener("click", function () {
            var hit = Array.from(sel.options).find(function (o) { return o.text === t; });
            if (!hit) { hit = new Option(t, t); sel.add(hit); }
            sel.value = hit.value; sel.dispatchEvent(new Event("change", { bubbles: true })); ul.remove();
          });
          ul.appendChild(li);
        });
        box.appendChild(ul);
      };
      // An AJAX select2: its native select holds only the placeholder until it is opened.
      var ajax = box.getAttribute("data-ajax");
      if (ajax) setTimeout(function () { show(ajax.split("|")); }, 300);
      else show(Array.from(sel.options).map(function (o) { return o.text; }).filter(function (t) { return !/^Select/.test(t); }));
    });
  });
  ${script}
</script></body></html>`;

const REAL = `<label for="inv-model-real">Model</label>
    <select id="inv-model-real"><option>Select...</option><option>${IQ8}</option></select>`;
const ARRAY = `<div class="panel"><h3 class="panel-title">PV ArrayDelete Array</h3>
    <label for="mod-model">Model</label>
    <select id="mod-model"><option>Select...</option><option>Q.PEAK DUO BLK ML-G10 400</option></select></div>`;
const MAKE = `<label for="inv-make">Manufacturer</label>
    <select id="inv-make"><option>Select...</option><option>Enphase Energy, Inc.</option></select>`;

const PAGES: Record<string, string> = {
  // MUST LAND: PGE's shadow, display:none instead of opacity:0, in a fieldset with a legend.
  fieldsetHidden: shell(`<fieldset><legend>Inverter Clone System</legend>${MAKE}
    <label for="pcInputBase34">Model</label><select id="pcInputBase34" style="display:none"><option value="">Select...</option></select>
    ${REAL}</fieldset>${ARRAY}`),
  // MUST EXCLUDE (condition 3, the block): two "Inverter Clone System" panels. The recorded
  // shadow sits in clone 1 with only the Manufacturer; the visible Model the rescue takes is in
  // clone 2. Same label, same section, a different block: not the shadow's twin.
  cloneBlock: shell(`<div class="panel"><h3 class="panel-title">Inverter Clone System</h3>${MAKE}
    <label for="pcInputBase34">Model</label><select id="pcInputBase34" class="concealed"><option>Select...</option></select></div>
    <div class="panel"><h3 class="panel-title">Inverter Clone System</h3>
    <label for="inv-make2">Manufacturer</label><select id="inv-make2"><option>Select...</option></select>
    ${REAL}</div>${ARRAY}`),
  // MUST EXCLUDE (condition 2, a widget of its own): the recorded control is an AJAX select2's
  // native <select>, empty until its face is opened, beside a visible "Model" twin in the same
  // panel. Empty is not stale when a face says a widget owns it.
  select2Twin: shell(`<div class="panel"><h3 class="panel-title">Inverter Clone System</h3>${MAKE}
    <label for="pcInputBase34">Model</label><select id="pcInputBase34" class="select2-hidden-accessible" tabindex="-1"><option value="">Select...</option></select><span class="select2 select2-container" data-for="pcInputBase34" data-ajax="${IQ8}|IQ8M-72-2-US {240V}"><span class="select2-selection" role="combobox" aria-haspopup="listbox"></span></span>
    ${REAL}</div>${ARRAY}`),
  // MUST EXCLUDE (condition 4, the section): the recorded section is "Inverter" and the hook
  // rescue takes a bare "Model" under "Existing Inverter" (the headings overlap, so the hook is
  // allowed). The shadow is alone in its fieldset, so its block reaches the neighbour; only the
  // section says the neighbour is another question. (No PV array panel: a second "Model" in the
  // block would already be a contest.)
  hookedOverlap: shell(`<fieldset><legend>Inverter</legend>
    <label for="pcInputBase34">Model</label><select id="pcInputBase34" class="concealed"><option>Select...</option></select></fieldset>
    <fieldset><legend>Existing Inverter</legend><label for="inv-model-real">Model</label>
    <select id="inv-model-real" data-test-role="existing-inverter-model-select"><option>Select...</option><option>${IQ8}</option></select></fieldset>`),
  // MUST EXCLUDE (condition 1, empty): the recorded concealed select still CARRIES the model,
  // beside a visible exact "Model" twin. It can take the answer, so MF5 writes it there.
  carriesList: shell(`<div class="panel"><h3 class="panel-title">Inverter Clone System</h3>${MAKE}
    <label for="pcInputBase34">Model</label><select id="pcInputBase34" class="concealed"><option>Select...</option><option>${IQ8}</option></select>
    ${REAL}</div>${ARRAY}`),
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<html></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const MODEL: RecipeStep = {
  action: "select", phase: "fill", field: "inverterModel", note: "Model",
  selector: { css: "#pcInputBase34", fallbacks: [{ label: "Model", nth: 0 }] },
  fingerprint: { id: "pcInputBase34", ariaLabel: "Model", section: "Inverter Clone System" },
} as unknown as RecipeStep;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

type Data = { driftWarnings?: string[]; agingNotes?: string[]; skipped?: string[]; fieldsVerified?: string[] };
const run = async (key: string, steps: RecipeStep[]): Promise<{ read: (id: string) => Promise<string>; data: Data }> => {
  const page = await context.newPage();
  const url = `http://127.0.0.1:${port}/${key}`;
  await page.goto(url);
  const recipe = {
    id: `sk-${key}`, scopeType: "utility", profileKey: "or|unknown|portland general electric", state: "OR", ahj: "",
    utility: "Portland General Electric", portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
    steps, createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { inverterMake: "Enphase Energy, Inc.", inverterModel: IQ8 }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const res = await adapter.fillApplication({} as never);
  const data = ((res as unknown as { data?: Data }).data ?? {});
  console.log(`   [${key}] skipped=${JSON.stringify(data.skipped ?? [])} verified=${JSON.stringify(data.fieldsVerified ?? [])} drift=${JSON.stringify((data.driftWarnings ?? []).slice(0, 1))}`);
  const read = async (id: string): Promise<string> => page.locator(`#${id}`).evaluate((el: Element) => {
    const s = el as HTMLSelectElement; return s.options[s.selectedIndex]?.text ?? "";
  }).catch(() => "(unreadable)") as Promise<string>;
  return { read, data };
};
const reportedModel = (d: Data): boolean =>
  !(d.fieldsVerified ?? []).includes("Model") && /Model/.test([...(d.skipped ?? []), ...(d.driftWarnings ?? [])].join(" | "));

{
  const r = await run("fieldsetHidden", [MODEL]);
  const real = await r.read("inv-model-real"), arr = await r.read("mod-model");
  check("MUST LAND fieldsetHidden: a display:none empty shadow in a legend'd fieldset keeps the rescue; the real Model lands", () => {
    assert.equal(real, IQ8, `the inverter Model reads ${JSON.stringify(real)}`);
    assert.equal(arr, "Select...", `the PV array's Model holds ${JSON.stringify(arr)}`);
    assert.ok(!(r.data.skipped ?? []).includes("Model"), `skipped=${JSON.stringify(r.data.skipped)}`);
    assert.ok((r.data.agingNotes ?? []).some((n) => /empty concealed shadow/.test(n)), `aging=${JSON.stringify(r.data.agingNotes)}`);
  });
}
for (const [key, steps, why] of [
  ["cloneBlock", [MODEL], "the visible Model is in ANOTHER clone block"],
  ["select2Twin", [MODEL], "the empty recorded select is an AJAX select2's native"],
  ["hookedOverlap", [{ ...MODEL, fingerprint: { id: "pcInputBase34", ariaLabel: "Model", section: "Inverter" } } as RecipeStep], "the hooked Model the rescue took sits under \"Existing Inverter\", not the recorded \"Inverter\""],
  ["carriesList", [MODEL], "the concealed recorded select carries the model, so it is no empty shadow"],
] as Array<[string, RecipeStep[], string]>) {
  const r = await run(key, steps);
  const other = await r.read("inv-model-real"), recorded = await r.read("pcInputBase34");
  const arr = key === "hookedOverlap" ? "Select..." : await r.read("mod-model");
  check(`MUST EXCLUDE ${key}: ${why}; the visible twin stays "Select..." and the step is not undone silently`, () => {
    assert.equal(other, "Select...", `the twin holds ${JSON.stringify(other)} — written into the wrong control`);
    assert.equal(arr, "Select...", `the PV array's Model holds ${JSON.stringify(arr)}`);
    if (recorded !== IQ8) assert.ok(reportedModel(r.data), `the recorded Model reads ${JSON.stringify(recorded)} and is reported verified, or not reported`);
  });
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} shadow-keep check(s) FAILED.`); process.exit(1); }
console.log("\nAll shadow-keep checks passed (real Chromium).");
process.exit(0);
