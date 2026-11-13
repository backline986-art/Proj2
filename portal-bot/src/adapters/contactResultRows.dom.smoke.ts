// #221 — A CONTACT LOOKUP WHOSE RESULTS TABLE HAS A PER-ROW "ADD" (live City of Tigard, Tyler EnerGov
// "Add Contact As: Contractor", 2026-11-13), against a SYNTHETIC replica (invented company, streets).
//
// The live shape: tab buttons "Search" (already the ACTIVE tab) / "Enter Manually" (its form, with its
// own "Company Name" box, hidden) / "My Favorites"; a search box labelled "Search" whose placeholder
// lists "Name, E-mail, or Company"; a wordless magnifier button beside it; a results table whose rows
// each carry their own "Add". The client is listed TWICE (two addresses).
//
//   MUST-PASS  street:   the client record's business street picks the ONE row at that street; its
//                        "Add" is pressed; the other row's never is.
//   MUST-STOP  nostreet: no street on the client → a NAMED stop ("listed this client more than once"),
//                        no row added.
//   Both:      the active "Search" tab is never what searched (the magnifier is), nothing typed into the
//              hidden "Enter Manually" form, no filing request, Submit never clicked.
//
// Run: npx tsx portal-bot/src/adapters/contactResultRows.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { ProjectRecord } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const CO = "Quillmark Solar Co";
const contactPage = `<!doctype html><html><head><title>Apply for Permit</title></head><body>
<a href="#">Back to Application</a>
<h2>Add Contact</h2>
<div class="contact-page">
<div class="contact-section">
  <h3>Add Contact As : Contractor</h3>
  <div class="tabs">
    <button type="button" class="btn active" aria-selected="true" id="tabSearch">Search</button>
    <button type="button" class="btn" id="tabManual">Enter Manually</button>
    <button type="button" class="btn" id="tabFav">My Favorites</button>
  </div>
  <div id="manual" style="display:none"><label for="mCompany">Company Name</label><input id="mCompany" type="text"></div>
  <div style="display:none"><input id="contractorRequired" type="text" required aria-required="true"></div>
</div>
  <!-- As live: the search row and the results table are SIBLINGS of the section block, not inside it. -->
  <div class="search-row">
    <span>Search</span>
    <input id="input-ContactSearchBar" type="text" aria-label="Search" placeholder="Name, E-mail, or Company" required>
    <button id="button-ContactSearchBar" type="button" class="btn fa fa-search" aria-label="Search"></button>
  </div>
  <table id="res"><thead><tr><th>Company</th><th>Address</th><th>Action</th></tr></thead><tbody></tbody></table>
</div>
<script>
var S = JSON.parse(sessionStorage.getItem("S") || '{"tab":0,"mag":0,"adds":[],"manualTyped":0}');
function save(){ sessionStorage.setItem("S", JSON.stringify(S)); }
document.getElementById("tabSearch").onclick = function(){ S.tab++; save(); };
document.getElementById("mCompany").oninput = function(){ S.manualTyped++; save(); };
document.getElementById("button-ContactSearchBar").onclick = function(){
  S.mag++; save();
  var q = document.getElementById("input-ContactSearchBar").value.toLowerCase();
  var tb = document.querySelector("#res tbody"); tb.innerHTML = "";
  if (q.indexOf("quillmark") < 0) return;
  [["808 SE EXAMPLE DR STE 3-337 VANCOUVER WA 98683"], ["305 SE EXAMPLE DR SUITE 111 VANCOUVER WA 98683"]].forEach(function(r){
    var tr = document.createElement("tr");
    tr.innerHTML = "<td>QUILLMARK SOLAR CO</td><td>" + r[0] + "</td><td><button type='button' class='add'>Add</button></td>";
    tr.querySelector(".add").onclick = function(){ S.adds.push(r[0]); save(); location.href = "/review"; };
    tb.appendChild(tr);
  });
};
</script></body></html>`;
const reviewPage = `<!doctype html><html><head><title>Apply for Permit</title></head><body>
<h2>Review and Submit</h2><p>Please review your application before submitting.</p>
<div id="card"></div><button type="button" id="submit">Submit</button>
<script>
var S = JSON.parse(sessionStorage.getItem("S") || "{}");
document.getElementById("card").textContent = "Contractor: QUILLMARK SOLAR CO " + ((S.adds || [])[0] || "");
document.getElementById("submit").onclick = function(){ fetch("/api/submit", { method: "POST", body: "x" }); };
</script></body></html>`;

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { posts.push(url.pathname); res.writeHead(200); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(url.pathname.startsWith("/review") ? reviewPage : contactPage);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// The planner stands in for the LLM: nothing to fill by itself on the contact page (the lookup pass
// does the search), the review page is review with its Submit named (recorded, never clicked).
const planner: LearnPlanner = async (req) => {
  const submit = req.fields.findIndex((f) => f.fieldType === "button" && /^submit$/i.test(String(f.label ?? "").trim()));
  if (/Review and Submit/.test(req.bodyText)) return { fills: [], atReview: true, ...(submit >= 0 ? { finalSubmitSelectorIndex: submit } : {}) };
  // As live: the planner types the company into the contact search box (then nothing to advance by).
  const box = req.fields.findIndex((f) => f.fieldType === "text" && /search/i.test(String(f.label ?? "")));
  return { fills: box >= 0 ? [{ selectorIndex: box, value: CO, field: "installerCompanyName" }] : [], atReview: false };
};
const project = { projectAddress: "4821 W Quillfeather Dr, Marrowvale, UT 84999", city: "Marrowvale", state: "UT", zip: "84999", homeownerName: "Test Owner", permitType: "structural", parserSnapshot: {} } as unknown as ProjectRecord;

const browser = await chromium.launch();
try {
  for (const variant of ["street", "nostreet"] as const) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page: Page = await ctx.newPage();
    await page.goto(`${base}/contact`);
    posts.length = 0;
    const company = { companyName: CO, firstName: "Permit", lastName: "Tech", ...(variant === "street" ? { street: "808 SE Example Dr Ste 3-337", city: "Vancouver", state: "WA", zip: "98683" } : {}) };
    const adapter = new AutoLearnAdapter("Contact Rows Smoke", planner, { maxPages: 4, contactIdentity: company, siteContactIdentity: { lastName: "Owner" } });
    (adapter as unknown as { page: unknown }).page = page;
    const events: Array<Record<string, unknown>> = [];
    const noop = async (): Promise<void> => undefined;
    (adapter as unknown as { debug: unknown }).debug = {
      event: (e: Record<string, unknown>) => { events.push(e); },
      writeJson: () => undefined, capturePageHtml: noop, screenshot: noop, startTrace: noop, stopTrace: noop, finalize: noop,
      setScrubber: () => undefined, dir: "",
    };
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try { r = await adapter.learn({ portalUrl: `${base}/contact` } as never, project); } catch (e) { threw = String(e).slice(0, 300); }
    const st = await page.evaluate(() => JSON.parse(sessionStorage.getItem("S") || "{}")).catch(() => ({})) as { tab?: number; mag?: number; adds?: string[]; manualTyped?: number };
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw).replace(/\s+/g, " ").slice(0, 500);
    const detail = `state=${JSON.stringify(st)} posts=${JSON.stringify(posts)} ok=${String(r?.ok)} stop=${String(r?.stopReason)} msg=${msg}`;
    console.log(`# ${variant}: ${detail}`);
    console.log(`#   events: ${JSON.stringify(events.filter((e) => !/^page$|trace|shot/.test(String(e.type))).map((e) => ({ ...e, t: undefined, ms: undefined }))).slice(0, 1500)}`);
    check(`${variant}: no filing request, nothing typed into the hidden "Enter Manually" form`, !posts.includes("/api/submit") && !st.manualTyped, detail);
    check(`${variant}: the box's own magnifier searched (pressed at least once)`, (st.mag ?? 0) >= 1, detail);
    if (variant === "street") {
      check("MUST-PASS street: the row at the client's business street (808) is added, once; the 305 row never", JSON.stringify(st.adds ?? []) === JSON.stringify(["808 SE EXAMPLE DR STE 3-337 VANCOUVER WA 98683"]), detail);
    } else {
      check("MUST-STOP nostreet: no row added, and a NAMED stop saying the client was listed more than once", !(st.adds ?? []).length && /listed this client more than once/.test(msg), detail);
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures === 0 ? "contactResultRows.dom.smoke: PASS" : `contactResultRows.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
