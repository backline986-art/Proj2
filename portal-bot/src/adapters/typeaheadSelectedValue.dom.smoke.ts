// A TYPE-AHEAD PICK IS JUDGED BY WHAT THE WIDGET OWNS, AND "ALREADY SEARCHED" BELONGS TO ONE BOX
// (#244 fix round).
//
// The review of 5eb51ad3 reproduced three engine-wide regressions against main. None of the 22 saved
// recipes carries these shapes today, but any portal can:
//   S1  an unrelated EMPTY hidden input beside the box (Accela renders a ClientState there) was read
//       as the widget's selected value, so a correct pick was cleared and FAILED;
//   S2  a widget that writes its selected id on blur (jQuery UI's change event) and not in the click
//       was judged before the blur commit, so a correct pick was cleared and FAILED;
//   S3  "already searched out" was keyed by the step's words (note + binding + value), so a SECOND
//       box with the same words, on the next page or beside the first, was never searched, and the
//       run stopped short of the review page that main reached; and it remembered transient misses
//       (a pick the box did not keep) for the whole run.
// MUST KEEP (main reached /review, so this must too): S1; S2a (id empty at rest, written on blur);
// S2b (a reopened draft: the id is emptied by the typing and written again on blur; the only shape
// that tells "read after the blur" from "read before it"); S3 across two documents; S3 with two
// boxes in one document; T (the first pick lost to a re-render, the required sweep picks again).
// MUST CATCH: N, the same reopened draft whose id the click never writes again: FAILED, named,
// cleared. And a DIFFERENT step that lands on a box which already answered is named, not searched.
// The widgets are generic ARIA comboboxes (role=combobox, aria-autocomplete=list, aria-controls ->
// a listbox on <body>). Synthetic data only: invented streets, numbers, cities and ids.
//
//   npx tsx portal-bot/src/adapters/typeaheadSelectedValue.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---- synthetic data ----------------------------------------------------------------------------
const JOB = { street: "4821 W Quillfeather Dr", city: "Marrowvale", state: "ID", zip: "83999" };
const ROW = (n: string): { id: string; label: string } => ({ id: `a-${n}`, label: `${n} W QUILLFEATHER DR, MARROWVALE` });
const WITH_JOB = [ROW("4812"), ROW("4821"), ROW("4830")];
const WITHOUT_JOB = [ROW("4812"), ROW("4830")];

// ---- the replica ---------------------------------------------------------------------------------
// One widget: the box, the hidden inputs the shape puts beside it, and its list on <body>.
//   idWrite  "click" the click writes the id; "blur" the click stages it and the blur writes it;
//            "never" the click writes only the box's words.
//   need     what Next requires of this widget: "box" (words in the box), "id" (its hidden id), "none".
type Widget = {
  id: string; rows: Array<{ id: string; label: string }>; idWrite: "click" | "blur" | "never"; need: "box" | "id" | "none";
  clientState?: boolean; idInput?: boolean; draft?: { label: string; id: string };
  /** The widget re-renders on its first pick and loses it (the box comes back empty); later picks hold. */
  flaky?: boolean; required?: boolean;
};
const widgetHtml = (w: Widget): string => `
  <label for="${w.id}">Address</label>
  <div class="ta-widget" data-rows='${JSON.stringify(w.rows)}' data-idwrite="${w.idWrite}" data-need="${w.need}" data-flaky="${w.flaky ? "1" : ""}">
    <input id="${w.id}" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${w.id}_list" autocomplete="off" value="${w.draft ? w.draft.label : ""}"${w.required ? " required" : ""}>
    ${w.clientState ? `<input type="hidden" name="${w.id}_ClientState" value="">` : ""}
    ${w.idInput ? `<input type="hidden" name="${w.id}_id" value="${w.draft ? w.draft.id : ""}">` : ""}
  </div>`;

const page = (title: string, widgets: Widget[], nextTo: string): string => `<!doctype html><html><head><title>${title}</title>
<style>body{font:14px sans-serif;margin:0;padding:16px} input[type=text]{width:360px;padding:4px}
  ul[role=listbox]{position:absolute;background:#fff;border:1px solid #ccc;list-style:none;margin:0;padding:0;width:380px}
  ul[role=listbox] li{padding:4px 8px;cursor:pointer}</style></head><body>
<h1>${title}</h1>
${widgets.map(widgetHtml).join("\n<br><br>\n")}
${widgets.map((w) => `<ul id="${w.id}_list" role="listbox" style="display:none"></ul>`).join("\n")}
<p><button type="button" id="next">Next</button></p>
<script>
  window.__searches = [];
  function words(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean); }
  document.querySelectorAll(".ta-widget").forEach(function (w) {
    var box = w.querySelector("input[role=combobox]");
    var hid = w.querySelector("input[name$=_id]");
    var list = document.getElementById(box.getAttribute("aria-controls"));
    var rows = JSON.parse(w.getAttribute("data-rows"));
    var idWrite = w.getAttribute("data-idwrite");
    var flaky = w.getAttribute("data-flaky") === "1";
    var pending = null, timer = null;
    function close() { list.style.display = "none"; list.innerHTML = ""; box.setAttribute("aria-expanded", "false"); }
    box.addEventListener("input", function () {
      if (hid) hid.value = "";
      pending = null; clearTimeout(timer);
      var q = box.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () {
        window.__searches.push(box.id + ":" + q);
        var qw = words(q);
        var alpha = qw.filter(function (t) { return /^[a-z]{4,}$/.test(t); });
        var nums = qw.filter(function (t) { return /^[0-9]+$/.test(t); });
        var hits = rows.filter(function (r) {
          var toks = words(r.label);
          var has = function (w) { return toks.some(function (t) { return t.indexOf(w) === 0; }); };
          return alpha.length ? alpha.every(has) : nums.some(has);
        });
        list.innerHTML = "";
        hits.forEach(function (r) {
          var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = r.label;
          li.addEventListener("mousedown", function (e) { e.preventDefault(); });
          li.addEventListener("click", function () {
            if (flaky) { flaky = false; box.value = ""; close(); return; }
            box.value = r.label;
            if (hid && idWrite === "click") hid.value = r.id;
            if (idWrite === "blur") pending = r.id;
            close();
          });
          list.appendChild(li);
        });
        var b = box.getBoundingClientRect();
        list.style.left = b.left + "px"; list.style.top = (b.bottom + window.scrollY) + "px";
        list.style.display = hits.length ? "block" : "none";
        box.setAttribute("aria-expanded", hits.length ? "true" : "false");
      }, 250);
    });
    box.addEventListener("blur", function () { if (hid && pending) { hid.value = pending; pending = null; } });
  });
  document.getElementById("next").addEventListener("click", function () {
    var ok = true, sel = [];
    document.querySelectorAll(".ta-widget").forEach(function (w) {
      var box = w.querySelector("input[role=combobox]");
      var hid = w.querySelector("input[name$=_id]");
      var need = w.getAttribute("data-need");
      if (need === "box" && !box.value.trim()) ok = false;
      if (need === "id" && !(hid && hid.value)) ok = false;
      sel.push(box.id + "=" + (hid ? hid.value : box.value));
    });
    if (!ok) { document.getElementById("next").insertAdjacentHTML("afterend", '<p class="err">Select an address from the list.</p>'); return; }
    location.href = ${JSON.stringify(nextTo)} + "?sel=" + encodeURIComponent(sel.join(";"));
  });
</script></body></html>`;

const REVIEW = (q: URLSearchParams): string => `<!doctype html><html><head><title>Review Application</title></head><body>
<h1>Review</h1><p>Review your application before you submit it.</p><p id="sel">${String(q.get("sel") ?? "").replace(/[<>&]/g, "")}</p></body></html>`;

const draft = { label: "4812 W QUILLFEATHER DR, MARROWVALE", id: "a-4812" };
const PAGES: Record<string, string> = {
  "/s1": page("S1 Location", [{ id: "addr", rows: WITH_JOB, idWrite: "click", need: "box", clientState: true }], "/review"),
  "/s2a": page("S2a Location", [{ id: "addr", rows: WITH_JOB, idWrite: "blur", need: "id", idInput: true }], "/review"),
  "/s2b": page("S2b Location", [{ id: "addr", rows: WITH_JOB, idWrite: "blur", need: "id", idInput: true, draft }], "/review"),
  "/n": page("N Location", [{ id: "addr", rows: WITH_JOB, idWrite: "never", need: "id", idInput: true, draft }], "/review"),
  "/s3a": page("S3a Owner Address", [{ id: "addr", rows: WITHOUT_JOB, idWrite: "click", need: "none" }], "/s3b"),
  "/s3b": page("S3b Site Address", [{ id: "addr", rows: WITH_JOB, idWrite: "click", need: "box" }], "/review"),
  "/s3c": page("S3c Addresses", [
    { id: "a1", rows: WITHOUT_JOB, idWrite: "click", need: "none" },
    { id: "a2", rows: WITH_JOB, idWrite: "click", need: "box" },
  ], "/review"),
  "/d": page("D Address", [{ id: "a1", rows: WITHOUT_JOB, idWrite: "click", need: "none" }], "/review"),
  "/t": page("T Location", [{ id: "addr", rows: WITH_JOB, idWrite: "click", need: "box", flaky: true, required: true }], "/review"),
};

const served: string[] = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (u.pathname === "/favicon.ico") { res.writeHead(404); return res.end(); }
  served.push(u.pathname);
  res.writeHead(200, { "Content-Type": "text/html" });
  if (u.pathname === "/review") return res.end(REVIEW(u.searchParams));
  res.end(PAGES[u.pathname] ?? "<!doctype html><title>none</title>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const ta = (css: string, note = "Address"): RecipeStep => ({ action: "fill", phase: "fill", fillStrategy: "typeahead", field: "street", selector: { css }, note } as RecipeStep);
const NEXT: RecipeStep = { action: "click", phase: "fill", selector: { css: "#next" }, note: "advance: Next" } as RecipeStep;

type Run = { ms: number; url: string; data: Record<string, unknown>; verified: string[]; unverified: string[]; failed: string[]; searches: string[]; served: string[]; page: Page };
async function replay(path: string, steps: RecipeStep[]): Promise<Run> {
  const p = await ctx.newPage();
  const url = `${base}${path}`;
  const recipe = {
    id: `r-tsv-${path.slice(1)}`, scopeType: "ahj", profileKey: "id|synthetic city|x", state: "ID", ahj: "Synthetic City", utility: "",
    portalPlatform: "other", portalUrl: url, status: "complete", version: 1,
    steps: [{ action: "goto", phase: "open", value: url, note: "entry url" }, ...steps],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
  } as unknown as PortalRecipe;
  const values = { street: JOB.street, city: JOB.city, state: JOB.state, zip: JOB.zip, projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}` };
  const adapter = new RecipeAdapter(recipe, values, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = p;
  const from = served.length;
  const t0 = Date.now();
  const r = await adapter.fillApplication({} as never);
  const ms = Date.now() - t0;
  const data = (r.data ?? {}) as Record<string, unknown>;
  const list = (k: string): string[] => (Array.isArray(data[k]) ? (data[k] as unknown[]).map(String) : []);
  const searches = await p.evaluate(() => (window as unknown as { __searches?: string[] }).__searches ?? []).catch(() => [] as string[]);
  return {
    ms, url: p.url(), data, verified: list("fieldsVerified"), unverified: list("fieldsUnverified"),
    failed: list("driftWarnings").filter((w) => /^FAILED /.test(w)), searches, served: served.slice(from), page: p,
  };
}
const box = async (p: Page, css: string): Promise<string> => p.locator(css).inputValue({ timeout: 2000 }).catch(() => "(gone)");
const say = (name: string, r: Run, extra = ""): void => {
  console.log(`   [${name}] ${r.ms} ms url=${r.url.replace(base, "")} served=${JSON.stringify(r.served)}\n     verified=${JSON.stringify(r.verified)} unverified=${JSON.stringify(r.unverified)}\n     failed=${JSON.stringify(r.failed)}${extra ? `\n     ${extra}` : ""}`);
};

// ---- S1: an unrelated EMPTY hidden input beside the box is not the widget's selection ---------------
{
  const r = await replay("/s1", [ta("#addr"), NEXT]);
  say("S1 unrelated empty ClientState beside the box", r);
  check("MUST KEEP S1: an empty ClientState beside the box does not fail a correct pick (picked, verified, on to the review)",
    /\/review/.test(r.url) && r.verified.includes("Address") && !r.failed.length,
    `url=${r.url} verified=${JSON.stringify(r.verified)} failed=${JSON.stringify(r.failed)}`);
  await r.page.close();
}

// ---- S2a: the id is written on blur, and was empty at rest -----------------------------------------
{
  const r = await replay("/s2a", [ta("#addr"), NEXT]);
  say("S2a id written on blur, empty at rest", r);
  check("MUST KEEP S2a: a widget that writes its id on blur keeps a correct pick (the id the review shows is the job's)",
    /\/review/.test(r.url) && /addr=a-4821/.test(decodeURIComponent(r.url)) && r.verified.includes("Address") && !r.failed.length,
    `url=${r.url} verified=${JSON.stringify(r.verified)} failed=${JSON.stringify(r.failed)}`);
  await r.page.close();
}

// ---- S2b: a reopened draft — the typing empties the id, the blur writes the new one -----------------
{
  const r = await replay("/s2b", [ta("#addr"), NEXT]);
  say("S2b reopened draft, id emptied by the typing, written again on blur", r);
  check("MUST KEEP S2b: the widget's own id (emptied by the typing) is judged AFTER the blur commit, which writes it",
    /\/review/.test(r.url) && /addr=a-4821/.test(decodeURIComponent(r.url)) && r.verified.includes("Address") && !r.failed.length,
    `url=${r.url} verified=${JSON.stringify(r.verified)} failed=${JSON.stringify(r.failed)}`);
  await r.page.close();
}

// ---- N: the same draft, and the pick never writes the id again → named, never verified, cleared ----
{
  const r = await replay("/n", [ta("#addr")]);
  const shown = { box: await box(r.page, "#addr"), id: await box(r.page, "input[name=addr_id]") };
  say("N reopened draft, the pick never writes the id", r, `shown=${JSON.stringify(shown)}`);
  check("MUST CATCH N: a pick that never writes again the id the typing emptied is a FAILED step naming that id",
    r.failed.some((w) => /^FAILED "Address"/.test(w) && /selected value/.test(w) && /addr_id/.test(w) && /not written again/.test(w)),
    JSON.stringify(r.failed));
  check("...never verified, and the box cleared (no unpicked words left for the portal to take)",
    !r.verified.includes("Address") && r.unverified.includes("Address") && shown.box === "" && shown.id === "",
    `verified=${JSON.stringify(r.verified)} shown=${JSON.stringify(shown)}`);
  await r.page.close();
}

// ---- S3 (two documents): a box on the NEXT page with the same words is its own search ---------------
{
  const r = await replay("/s3a", [ta("#addr"), NEXT, ta("#addr"), NEXT]);
  say("S3 two documents, same note + binding + value, page 1 has no match", r);
  check("MUST KEEP S3 (two documents): page 1's no-match is named, page 2's box is searched and picked, the run reaches the review",
    /\/review/.test(r.url) && r.served.includes("/s3b") && r.verified.includes("Address")
      && r.failed.length === 1 && /^FAILED "Address"/.test(r.failed[0]) && /none|no suggestion|not/i.test(r.failed[0]),
    `url=${r.url} served=${JSON.stringify(r.served)} verified=${JSON.stringify(r.verified)} failed=${JSON.stringify(r.failed)}`);
  await r.page.close();
}

// ---- S3 (one document): two boxes with the same words beside each other are two searches ------------
{
  const r = await replay("/s3c", [ta("#a1"), ta("#a2"), NEXT]);
  say("S3 one document, two boxes, same note + binding + value", r);
  // The review URL carries what each box held when Next was clicked: a2's pick is its own search.
  check("MUST KEEP S3 (one document): the second box is searched and picked although the first, worded alike, found nothing",
    /\/review/.test(r.url) && /a2=4821 W QUILLFEATHER DR/.test(decodeURIComponent(r.url)) && r.verified.includes("Address")
      && r.failed.length === 1 && /^FAILED "Address"/.test(r.failed[0]),
    `url=${r.url} failed=${JSON.stringify(r.failed)}`);
  await r.page.close();
}

// ---- D: a DIFFERENT step landing on a box that already answered is named, and not searched again ----
{
  const r = await replay("/d", [ta("#a1", "Address"), ta("#a1", "Site Address")]);
  say("D two steps, one box", r, `searches=${JSON.stringify(r.searches)}`);
  const firstSearches = r.searches.length;
  check("the second step on the answered box is named by its own words, not left silent",
    r.failed.some((w) => /^FAILED "Address"/.test(w)) && r.failed.some((w) => /^FAILED "Site Address": not searched again/.test(w))
      && r.unverified.includes("Site Address"),
    `failed=${JSON.stringify(r.failed)} unverified=${JSON.stringify(r.unverified)}`);
  check("...and the box's search is not typed again for it",
    firstSearches > 0 && r.searches.every((s) => s.startsWith("a1:")) && new Set(r.searches).size === r.searches.length,
    `searches=${JSON.stringify(r.searches)}`);
  await r.page.close();
}

// ---- T: a pick the box did not keep is NOT remembered as "searched out" — the re-assert tries again --
// The first pick is lost to a re-render (the box comes back empty); the required sweep before Next
// re-runs the step, which picks again and holds. Remembering that miss for the run left it empty.
{
  const r = await replay("/t", [ta("#addr"), NEXT]);
  say("T first pick lost to a re-render, the re-assert picks again", r);
  check("MUST KEEP T: a pick the box did not keep is tried again by the required sweep, and the run reaches the review with it",
    /\/review/.test(r.url) && /addr=4821 W QUILLFEATHER DR/.test(decodeURIComponent(r.url)),
    `url=${r.url} failed=${JSON.stringify(r.failed)}`);
  await r.page.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? "typeaheadSelectedValue.dom.smoke: PASS" : `typeaheadSelectedValue.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
