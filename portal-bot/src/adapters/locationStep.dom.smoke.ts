// A LOCATION STEP: A TYPE-AHEAD WHOSE PICK FILLS A REQUIRED READ-ONLY SELECTION (#161) — real Chromium.
// Run: npx tsx portal-bot/src/adapters/locationStep.dom.smoke.ts
//
// The shape (synthetic, from the owner's screenshot of a city's location step, 2026-11-24): a location
// type select above; a type-ahead box whose results appear as the address is typed (a jQuery-UI-style
// list, no search button); picking a result fills the READ-ONLY, REQUIRED "The location you have
// selected" box; a manual-entry button; map and near-me buttons; the step's "Next Step"; and the
// form's FIRST submit, a hidden, wordless default an Enter would post.
//
// The settled rule: the answer is the matching suggestion, clicked — first, always; Enter is never
// pressed where a suggestion matched (a list that came late included); "Next Step" is clicked only
// while the required selection holds THIS job's address (or its tax lot); map / near-me never used.
//
// MUST-PASS  [1] replay: the pick fills the selection, nothing posts but "Next Step", Enter never pressed;
//            [2] a list that arrives after the first wait is still picked — Enter is not pressed
//                (KILL: drop the late-list read in fillTypeaheadInner -> the hidden default posts);
//            [6] a selection that shows the job's tax lot agrees; the learner leaves a good page alone.
// MUST-STOP  [3] replay: the box shows the pick but the selection stayed EMPTY -> "Next Step" refused, named;
//            [4] replay: the selection holds a NEIGHBOUR's address -> refused, named
//                (KILL for [3]/[4]: return early in RecipeAdapter.locationForwardCheck);
//            [5] learner: the same empty selection ends the walk named before the page is left
//                (KILL: return null at the top of AutoLearnAdapter.typeaheadLocationResult).
// NEVER      [7] the map, near-me and manual-entry buttons are never clicked, in any mode.
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { RecipeAdapter } from "./recipeAdapter";
import { AutoLearnAdapter } from "./autoLearnAdapter";
import { fillTypeahead, locationAgrees, locationResultRefusal } from "../typeaheadFill";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const JOB = { street: "4821 W Quillfeather Dr", city: "Marrowvale", state: "UT", zip: "84999" };
const LOT = "17-12-32-CB-01400";
const OURS = "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999";
const NEIGHBOUR = "4823 W QUILLFEATHER DR, MARROWVALE, UT 84999";

type Mode = "good" | "late" | "unheld" | "wrong" | "taxlot";
const posts: Array<{ mode: string; submitter: string }> = [];

const html = (mode: Mode): string => `<!doctype html><html><head><title>Permit Application</title>
<style>.ui-autocomplete{position:absolute;top:150px;left:10px;width:420px;background:#fff;border:1px solid #888;list-style:none;margin:0;padding:0}
.ui-menu-item{padding:4px;cursor:pointer}</style></head><body>
<h1>Location</h1>
<form method="post" action="/Portal/Permit/Application?m=${mode}">
  <input type="submit" name="brepeatlocation" aria-hidden="true" tabindex="-1" value="" style="position:absolute;left:-9999px;width:1px;height:1px">
  <p><label for="ltype">Location type</label> <select id="ltype" name="ltype"><option>Address</option><option>Tax lot</option></select></p>
  <p><label for="q">Search for location:</label> <input type="text" id="q" name="q" class="ui-autocomplete-input" autocomplete="off" style="width:400px"></p>
  <p style="margin-top:120px"><button type="button" id="manual">Can't find address?</button>
     <button type="button" id="map">Select on map</button> <button type="button" id="near">Near me</button></p>
  <p><label for="sel" class="required">The location you have selected *</label> <input type="text" id="sel" name="sel" readonly required style="width:400px"></p>
  <p><button type="submit" name="bnext" value="1">Next Step</button></p>
</form>
<script>
(function () {
  var MODE = ${JSON.stringify(mode)};
  var ROWS = ${JSON.stringify([OURS, NEIGHBOUR])};
  var q = document.getElementById("q"), sel = document.getElementById("sel");
  window.__enter = 0; window.__map = 0; window.__near = 0; window.__manual = 0;
  document.getElementById("map").addEventListener("click", function () { window.__map++; });
  document.getElementById("near").addEventListener("click", function () { window.__near++; });
  document.getElementById("manual").addEventListener("click", function () { window.__manual++; });
  q.addEventListener("keydown", function (e) { if (e.key === "Enter") window.__enter++; });
  var timer = null, ul = null;
  function close() { if (ul) { ul.remove(); ul = null; } }
  q.addEventListener("input", function () {
    clearTimeout(timer); close();
    var num = (q.value.match(/^\\s*(\\d+)/) || [])[1];
    if (!num) return;
    timer = setTimeout(function () {
      var hits = ROWS.filter(function (r) { return r.indexOf(num.slice(0, 3)) === 0; });
      if (!hits.length) return;
      ul = document.createElement("ul");
      ul.className = "ui-menu ui-autocomplete"; ul.setAttribute("role", "listbox");
      hits.forEach(function (h) {
        var li = document.createElement("li");
        li.className = "ui-menu-item"; li.setAttribute("role", "option"); li.textContent = h;
        li.addEventListener("click", function () {
          q.value = h;
          if (MODE === "good" || MODE === "late") sel.value = h;
          else if (MODE === "wrong") sel.value = ${JSON.stringify(NEIGHBOUR)};
          else if (MODE === "taxlot") sel.value = "Tax lot 171232CB01400";
          close();
        });
        ul.appendChild(li);
      });
      document.body.appendChild(ul);
    }, MODE === "late" ? 900 : 150);
  });
})();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const mode = (u.searchParams.get("m") || "good") as Mode;
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const p = new URLSearchParams(body);
      posts.push({ mode, submitter: p.has("bnext") ? "bnext" : p.has("brepeatlocation") ? "brepeatlocation" : "(none)" });
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body><h1>Next step</h1><p>posted</p></body></html>");
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html(mode));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();

const open = async (mode: Mode): Promise<Page> => {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  await page.goto(`${base}/Portal/Permit/Application?m=${mode}`);
  return page;
};
const counters = async (page: Page): Promise<{ enter: number; map: number; near: number; manual: number }> =>
  page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    return { enter: Number(w.__enter ?? -1), map: Number(w.__map ?? -1), near: Number(w.__near ?? -1), manual: Number(w.__manual ?? -1) };
  });
const postsOf = (mode: Mode, submitter: string): number => posts.filter((p) => p.mode === mode && p.submitter === submitter).length;
const sideButtons: Array<{ mode: string; map: number; near: number; manual: number }> = [];

const recipe = {
  id: "location-step-smoke", scopeType: "ahj", profileKey: "ut|synthetic|", state: "UT", ahj: "Synthetic", utility: "",
  portalPlatform: "other", portalUrl: `${base}/Portal/Permit/Application`, status: "complete", version: 1, createdBy: "smoke",
  createdAt: "", updatedAt: "", notes: "", discipline: "building", steps: [],
} as unknown as PortalRecipe;
const STEP: RecipeStep = { action: "fill", phase: "fill", selector: { css: "#q" }, field: "street", note: "Search for location:", fillStrategy: "typeahead" } as RecipeStep;

/** The replay's own doors: the recorded type-ahead step, then the step's "Next Step" through guardedClick. */
const replay = async (mode: Mode): Promise<{ filled: boolean; sel: string; next: "clicked" | string; c: Awaited<ReturnType<typeof counters>> }> => {
  const page = await open(mode);
  const adapter = new RecipeAdapter(recipe, { street: JOB.street, city: JOB.city, state: JOB.state, zip: JOB.zip, parcelNumber: LOT }, {}, {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  a.page = page;
  const filled = await a.fillTypeaheadStep(STEP, page.locator("#q"), JOB.street).catch((e: Error) => { console.log(`     fill threw: ${e.message}`); return false; });
  const sel = await page.inputValue("#sel").catch(() => "");
  const c = await counters(page);
  let next: string = "clicked";
  try {
    const nav = page.waitForNavigation({ timeout: 8000 }).catch(() => null);
    await a.guardedClick(page.getByRole("button", { name: "Next Step" }), "location step forward");
    await nav;
  } catch (e) {
    next = `${(e as Error).name}: ${(e as Error).message}`;
  }
  sideButtons.push({ mode: `replay:${mode}`, map: c.map, near: c.near, manual: c.manual });
  await page.context().close();
  return { filled: !!filled, sel, next, c };
};

// [1] MUST-PASS — the pick fills the selection; only "Next Step" posts; Enter never pressed.
{
  const r = await replay("good");
  console.log(`   [1] filled=${r.filled} sel="${r.sel}" enter=${r.c.enter} next=${r.next.slice(0, 160)} posts=${JSON.stringify(posts.filter((p) => p.mode === "good"))}`);
  check("[1] the suggestion click fills the required selection with the job's address", r.filled && r.sel === OURS, `filled=${r.filled} sel=${r.sel}`);
  check("[1] Enter is never pressed where a suggestion matched (no keydown, the hidden default never posted)", r.c.enter === 0 && postsOf("good", "brepeatlocation") === 0, `enter=${r.c.enter} posts=${JSON.stringify(posts)}`);
  check("[1] \"Next Step\" is clicked once the selection holds the job's address", r.next === "clicked" && postsOf("good", "bnext") === 1, r.next);
}

// [2] MUST-PASS — a list that arrives after the first wait is picked; Enter is not pressed.
{
  const page = await open("late");
  const out = await fillTypeahead(page, page.locator("#q"), { value: JOB.street, mode: "site", site: { ...JOB }, suggestWaitMs: 400 });
  await page.waitForTimeout(600);
  const c = await counters(page).catch(() => ({ enter: -1, map: -1, near: -1, manual: -1 }));
  const sel = await page.inputValue("#sel").catch(() => "(page moved)");
  console.log(`   [2] outcome=${out.outcome} via=${"via" in out ? out.via : ""} sel="${sel}" enter=${c.enter} posts=${JSON.stringify(posts.filter((p) => p.mode === "late"))}`);
  check("[2] a late list is still the answer: the suggestion is picked, Enter is not pressed", out.outcome === "picked" && (out as { via?: string }).via === "list" && c.enter === 0 && postsOf("late", "brepeatlocation") === 0,
    `out=${JSON.stringify(out).slice(0, 300)} enter=${c.enter} posts=${JSON.stringify(posts)}`);
  check("[2] the pick reports the selection it filled", out.outcome === "picked" && !!out.resultBoxes?.some((b) => b.key === "sel" && b.value === OURS), JSON.stringify(out).slice(0, 300));
  sideButtons.push({ mode: "late", map: c.map, near: c.near, manual: c.manual });
  await page.context().close();
}

// [3] MUST-STOP — the box shows the pick, the selection stayed empty: "Next Step" refused, named.
{
  const r = await replay("unheld");
  console.log(`   [3] filled=${r.filled} sel="${r.sel}" next=${r.next.slice(0, 220)}`);
  check("[3] an EMPTY required selection refuses \"Next Step\" (named, a stop for a person)",
    r.next.startsWith("TypeaheadStop") && /is empty/.test(r.next) && /The location you have selected/.test(r.next) && postsOf("unheld", "bnext") === 0,
    `next=${r.next} posts=${JSON.stringify(posts.filter((p) => p.mode === "unheld"))}`);
}

// [4] MUST-STOP — the selection holds a neighbour's address.
{
  const r = await replay("wrong");
  console.log(`   [4] filled=${r.filled} sel="${r.sel}" next=${r.next.slice(0, 220)}`);
  check("[4] a selection holding ANOTHER address refuses \"Next Step\" (named)",
    r.next.startsWith("TypeaheadStop") && /not the job's address/.test(r.next) && postsOf("wrong", "bnext") === 0,
    `next=${r.next} posts=${JSON.stringify(posts.filter((p) => p.mode === "wrong"))}`);
}

// [5] / [6] the learner's door: applyTypeaheadFill, then the page's d4b'' question.
const learn = async (mode: Mode): Promise<{ step: RecipeStep | null; stop: { stopReason?: string; message?: string } | null }> => {
  const page = await open(mode);
  const adapter = new AutoLearnAdapter("Location Step Smoke", null as never, { maxPages: 1 } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  a.page = page;
  a.typeaheadSite = { ...JOB };
  a.typeaheadParcels = [LOT];
  const field = { label: "Search for location:", selector: { css: "#q" }, fieldType: "text", required: false };
  const step = await a.applyTypeaheadFill(field, { value: JOB.street, field: "street" }, JOB.street, false);
  const stop = await a.typeaheadLocationResult([], 1, [], [], []);
  const c = await counters(page);
  sideButtons.push({ mode: `learn:${mode}`, map: c.map, near: c.near, manual: c.manual });
  await page.context().close();
  return { step, stop };
};
{
  const bad = await learn("unheld");
  console.log(`   [5] step=${bad.step?.action ?? "none"} stop=${bad.stop?.stopReason ?? "none"} ${String(bad.stop?.message ?? "").slice(0, 200)}`);
  check("[5] learner: an empty required selection ends the walk named before the page is left",
    bad.stop?.stopReason === "typeahead_location_unselected" && /is empty/.test(String(bad.stop?.message ?? "")), JSON.stringify(bad.stop).slice(0, 300));
  const good = await learn("good");
  check("[6] learner: a selection holding the job's address is left alone (the pick is recorded, no stop)", good.step?.action === "fill" && good.stop === null, JSON.stringify(good).slice(0, 300));
  const lot = await learn("taxlot");
  check("[6] learner: a selection showing the job's tax lot agrees", lot.stop === null, JSON.stringify(lot.stop).slice(0, 300));
}

// [6] the predicate itself.
{
  const site = { ...JOB };
  check("[6] locationAgrees: the job's address, the job's tax lot — yes; a neighbour, another lot, nothing — no",
    locationAgrees(OURS, site) && locationAgrees("Tax lot 171232CB01400", site, [LOT]) && !locationAgrees(NEIGHBOUR, site, [LOT])
      && !locationAgrees("Tax lot 171232CB09999", site, [LOT]) && !locationAgrees("", site, [LOT]));
  check("[6] a box that is no longer on the page is not judged; an empty one is",
    locationResultRefusal([{ key: "sel", how: "id", label: "The location you have selected", value: "", found: false }], site) === ""
      && /is empty/.test(locationResultRefusal([{ key: "sel", how: "id", label: "The location you have selected", value: "", found: true }], site)));
}

// [7] NEVER — map, near-me and manual entry untouched in every mode.
check("[7] the map, near-me and manual-entry buttons were never clicked", sideButtons.length >= 7 && sideButtons.every((s) => s.map === 0 && s.near === 0 && s.manual === 0), JSON.stringify(sideButtons));

await browser.close();
server.close();
if (failures > 0) { console.error(`\nlocationStep.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nlocationStep.dom.smoke: PASS");
process.exit(0);
