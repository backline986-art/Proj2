// A LABEL RE-ANCHOR TAKES THE BOX WHOSE LABEL IS THE WHOLE RECORDED LABEL, NOT ONE THAT SHARES A WORD.
//
// reanchorIfWrongControl compares labels by their STRONG words (stopwords dropped: "name",
// "number", "type"), so a recorded "Business Name" is {business}. On a page that also holds
// "Business Phone", both candidates scored one word; the visible one — or simply the first in
// the document — won, and the step was re-anchored onto the phone box. Live City of Tigard
// (Tyler EnerGov SelfService) contact lookup, replay v8 of 2026-11-15: the recorded fallback
// `input[id*='Name' i]` resolved onto First Name, the mismatch was caught, and the re-anchor then
// chose #BusinessPhone — "step "Business Name" resolved onto "First Name" — re-anchored by label
// to #BusinessPhone" — where the company name's fill timed out.
//
// The rule: every word of the recorded label (stopwords included, requirement markers dropped)
// counts, the whole phrase ranks first, and a strong word of the candidate's own that the
// recorded label never had ("phone") counts against it. The strong-word gate is unchanged.
//
// Synthetic page and names. Run: npx tsx portal-bot/src/adapters/reanchorWholeLabel.dom.smoke.ts
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

// First Name comes first (so a `[id*='Name']` fallback lands on it), the phone box BEFORE the
// name box (so a tie on {business} falls to the phone, as it did live). The name box's label is
// not the recorded words verbatim, so the label level misses it and the fallback runs.
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Add Contact As : Contractor</h2>
  <label for="FirstName">First Name</label><input id="FirstName" type="text">
  <label for="LastName">Last Name</label><input id="LastName" type="text">
  <label for="BusinessPhone">Business Phone</label><input id="BusinessPhone" type="text">
  <label for="BusinessName">Business/Company Name</label><input id="BusinessName" type="text">
  <button id="search" type="button">Search</button>
</body></html>`;

// The live dialog's shape (EnerGov "Add Contact", v9 step-015 HTML): a Search tab whose one box
// ALREADY HOLDS the company name (the recorded steps typed and searched it), results with an Add
// button, and an inactive "Enter Manually" tab whose boxes are present but not shown — First Name,
// Last Name, a "Company Name" known only by aria-label, Business Phone.
const LOOKUP_PAGE = `<!doctype html><html><body>
  <h3>Add Contact</h3><h4 aria-label="Add Contact As Contractor">Add Contact As <b>Contractor</b></h4>
  <div id="tab-search">
    <label>Search <input id="input-ContactSearchBar" name="contactSearchText" placeholder="Name, E-mail, or Company" value="Quillfeather Solar LLC"></label>
    <button id="button-ContactSearchBar" aria-label="Search" type="button">Go</button>
    <table><tr><th>First Name</th><th>Last Name</th><th>Address</th><th>Company</th><th></th></tr>
      <tr><td></td><td></td><td>808 SW Example Way</td><td>QUILLFEATHER SOLAR LLC</td><td><button type="button" aria-label="Add Contact">Add</button></td></tr></table>
  </div>
  <div id="tab-manual" style="display:none">
    <input aria-label="First Name" id="FirstName" type="text">
    <input aria-label="Last Name" id="LastName" type="text">
    <input aria-label="Company Name" id="GlobalEntityName" type="text">
    <label for="BusinessPhone">Business Phone</label><input aria-label="Business Phone" id="BusinessPhone" type="text">
  </div>
  <button id="next" type="button">Next</button>
</body></html>`;

// The live results grid (v10 step-018 HTML): every row BEGINS with a favourite star whose aria-label is
// "Add Favorite", then the contact's cells, then its own "Add" (aria-label "Add Contact"). Pressing the
// star changes nothing; pressing Add takes the page back to the application.
const ROWS_PAGE = `<!doctype html><html><head><title>Apply for Permit</title>
  <style>.fav{display:inline-block;width:22px;height:22px;background:#eee;border:1px solid #999}</style></head><body>
  <h3>Add Contact</h3><h4 aria-label="Add Contact As Contractor">Add Contact As <b>Contractor</b></h4>
  <table id="res"><thead><tr><th>Favorite</th><th>First Name</th><th>Last Name</th><th>Address</th><th>Company</th><th>Email</th><th>Action</th></tr></thead><tbody>
    <tr><td><button type="button" class="fav" aria-label="Add Favorite" title="Add Favorite"></button></td><td></td><td></td><td>305 SW Example Way Suite 111 Maplecrest ZZ 99999</td><td>QUILLFEATHER SOLAR LLC</td><td></td><td><button type="button" class="add" aria-label="Add Contact">Add</button></td></tr>
    <tr><td><button type="button" class="fav" aria-label="Add Favorite" title="Add Favorite"></button></td><td></td><td></td><td>808 SW Example Way Ste 3-337 Maplecrest ZZ 99999</td><td>QUILLFEATHER SOLAR LLC</td><td>[email]</td><td><button type="button" class="add" aria-label="Add Contact">Add</button></td></tr>
  </tbody></table>
  <script>
    var S = JSON.parse(sessionStorage.getItem("R") || '{"favs":0,"adds":[]}');
    function save(){ sessionStorage.setItem("R", JSON.stringify(S)); }
    document.querySelectorAll("tr").forEach(function (tr) {
      var f = tr.querySelector(".fav"), a = tr.querySelector(".add");
      if (f) f.onclick = function(){ S.favs++; save(); };
      if (a) a.onclick = function(){ S.adds.push(tr.cells[3].textContent.trim().slice(0, 3)); save(); location.href = "/review"; };
    });
  </script>
</body></html>`;
const REVIEW_PAGE = `<!doctype html><html><head><title>Apply for Permit</title></head><body><h2>Contacts</h2><p id="card">Contractor added.</p><button id="button-Next" type="button">Next</button></body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  const u = String(q.url);
  r.end(/lookup/.test(u) ? LOOKUP_PAGE : /rows/.test(u) ? ROWS_PAGE : /review/.test(u) ? REVIEW_PAGE : PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;
const lookupUrl = `${url}lookup`;
const rowsUrl = `${url}rows`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "rwl1", scopeType: "ahj", profileKey: "zz||maplecrest", state: "ZZ", ahj: "City of Maplecrest", utility: "",
  portalPlatform: "energov", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const LOOKUP_FALLBACK = "input[id*='Business' i], input[id*='Company' i], input[id*='Name' i]";

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE A — the live shape: recorded "Business Name", fallback lands on First Name.
const pA = await context.newPage();
await pA.goto(url);
const aA = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "installerCompanyName", note: "lookup(Add Contact As : Contractor): business name",
    selector: { label: "Business Name", fallbacks: [{ css: LOOKUP_FALLBACK }] },
  } as RecipeStep,
]), { installerCompanyName: "Quillfeather Solar LLC" }, {}, { autoSubmit: false });
(aA as unknown as { page: unknown }).page = pA;
await aA.fillApplication({} as never);
const nameA = await pA.locator("#BusinessName").inputValue();
const phoneA = await pA.locator("#BusinessPhone").inputValue();
const firstA = await pA.locator("#FirstName").inputValue();
// The re-anchor's note is a drift warning on the adapter (the fill result carries them under its
// own shape; the adapter's list is the one the live replay json printed).
const notesA = ((aA as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");

check("MUST-PASS: the company name lands in the box whose label is the whole recorded label", () => {
  assert.equal(nameA, "Quillfeather Solar LLC", `#BusinessName holds ${JSON.stringify(nameA)}`);
});
check("MUST-PASS: the box that merely shares a word (\"Business Phone\") is left empty", () => {
  assert.equal(phoneA, "", `#BusinessPhone received ${JSON.stringify(phoneA)} — the live v8 failure`);
});
check("MUST-PASS: the box the fallback resolved onto (First Name) is left empty", () => {
  assert.equal(firstA, "", `#FirstName received ${JSON.stringify(firstA)}`);
});
check("the re-anchor is named, to the name box", () => {
  assert.match(notesA, /resolved onto "First Name" — re-anchored by label to #BusinessName/, notesA.slice(0, 400));
});

// CASE B — MUST-KEEP, the mirror: recorded "Business Phone" re-anchors to the phone box, never the
// name box (two strong words, and the name box has only one of them).
const pB = await context.newPage();
await pB.goto(url);
const aB = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "installerPhone", note: "lookup(Add Contact As : Contractor): business phone",
    selector: { label: "Business Telephone", fallbacks: [{ css: "input[id*='Name' i], input[id*='Business' i]" }] },
  } as RecipeStep,
]), { installerPhone: "503-555-0100" }, {}, { autoSubmit: false });
(aB as unknown as { page: unknown }).page = pB;
await aB.fillApplication({} as never);
const phoneB = await pB.locator("#BusinessPhone").inputValue();
const nameB = await pB.locator("#BusinessName").inputValue();

check("MUST-KEEP: the name box never receives the phone number", () => {
  assert.equal(nameB, "", `#BusinessName received ${JSON.stringify(nameB)} — a phone number in the company name`);
});
check("MUST-KEEP: a recorded phone label heals to the phone box or is skipped, named — never written elsewhere", () => {
  // "Business Telephone" vs the page's "Business Phone": strong words {business, telephone}; the gate
  // wants two of them, and "phone" is a subsequence of "telephone" only in the agree() escape, not in
  // the candidate scan — so today this heals to the phone box or skips; this pins that it never
  // lands anywhere else.
  assert.ok(phoneB === "503-555-0100" || phoneB === "", `#BusinessPhone holds ${JSON.stringify(phoneB)}`);
});

// CASE C — A LOOKUP TEMPLATE'S FILL IS DONE WHEN ITS VALUE ALREADY STANDS ON THE PAGE (live v9, step 16
// of 40): the learner's synthesised "business name" step re-types what the recorded search box already
// holds (the recorded steps typed and searched it). Its loose fallback reached the inactive tab's First
// Name (not shown), the re-anchor then "Business Phone", the fill timed out there and the run stopped.
// Read live, by value: the lookup is fed — skipped, named; nothing typed into the inactive tab.
const pC = await context.newPage();
await pC.goto(lookupUrl);
const aC = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "installerCompanyName", note: "lookup(Add Contact As : Contractor): business name",
    selector: { label: "Business Name", fallbacks: [{ css: LOOKUP_FALLBACK }] },
  } as RecipeStep,
]), { installerCompanyName: "Quillfeather Solar LLC" }, {}, { autoSubmit: false });
(aC as unknown as { page: unknown }).page = pC;
await aC.fillApplication({} as never);
const firstC = await pC.locator("#FirstName").inputValue();
const phoneC = await pC.locator("#BusinessPhone").inputValue();
const companyC = await pC.locator("#GlobalEntityName").inputValue();
const searchC = await pC.locator("#input-ContactSearchBar").inputValue();
const agingC = ((aC as unknown as { agingNotes?: string[] }).agingNotes ?? []).join(" | ");
const driftC = ((aC as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");

check("MUST-PASS (lookup): nothing is typed into the inactive tab's boxes", () => {
  assert.equal(firstC, "", `#FirstName received ${JSON.stringify(firstC)}`);
  assert.equal(phoneC, "", `#BusinessPhone received ${JSON.stringify(phoneC)} — the live v8/v9 failure`);
  assert.equal(companyC, "", `#GlobalEntityName received ${JSON.stringify(companyC)}`);
});
check("MUST-PASS (lookup): the search box keeps the value it already held", () => {
  assert.equal(searchC, "Quillfeather Solar LLC", `#input-ContactSearchBar holds ${JSON.stringify(searchC)}`);
});
check("MUST-PASS (lookup): the step is skipped, named — its value already stands on the page", () => {
  assert.match(agingC, /already stands/, `aging: ${agingC.slice(0, 300)} | drift: ${driftC.slice(0, 300)}`);
});
check("MUST-PASS (lookup): no fill timeout and no re-anchor onto the phone box", () => {
  assert.doesNotMatch(driftC, /Timeout|re-anchored by label to #BusinessPhone/, driftC.slice(0, 400));
});

// CASE D — THE ROW'S OWN ACTION, NOT THE FIRST CONTROL CARRYING THE WORD (live v10, step 18 of 40): the
// replay chose this job's row by its company record and then pressed the row's FIRST control whose text
// carried "add" — the favourite star ("Add Favorite"). The page did not move and the walk stopped at the
// next "Next". The learner's reading (ROW_PICK_WORDS, shared/src/rowPick.ts) is now the replay's too.
const pD = await context.newPage();
await pD.goto(rowsUrl);
const ROW = `tr:has-text("QUILLFEATHER SOLAR LLC"):has-text("808")`;
const aD = new RecipeAdapter(mkRecipe([
  {
    action: "click", phase: "fill", note: "lookup(Add Contact As : Contractor): select this client's record (the row showing the company)",
    selector: { css: `${ROW} a:has-text("Select"), ${ROW} button:has-text("Add"), ${ROW} a:has-text("Add"), ${ROW} input[type='radio']` },
  } as RecipeStep,
]), { installerCompanyName: "Quillfeather Solar LLC", installerStreet: "808 SW Example Way Ste 3-337" }, {}, { autoSubmit: false });
(aD as unknown as { page: unknown }).page = pD;
await aD.fillApplication({} as never);
const stateD = await pD.evaluate(() => JSON.parse(sessionStorage.getItem("R") || "{}")).catch(() => ({})) as { favs?: number; adds?: string[] };
const urlD = pD.url();
const notesD = ((aD as unknown as { agingNotes?: string[] }).agingNotes ?? []).join(" | ");
const driftD = ((aD as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");

check("MUST-PASS (rows): the row's own Add is pressed — the 808 row, once — and the page moves on", () => {
  assert.deepEqual(stateD.adds ?? [], ["808"], `adds=${JSON.stringify(stateD.adds)} url=${urlD} notes=${notesD.slice(0, 200)} drift=${driftD.slice(0, 200)}`);
  assert.match(urlD, /\/review$/, `url=${urlD}`);
});
check("MUST-PASS (rows): the favourite star (\"Add Favorite\") is never pressed", () => {
  assert.equal(stateD.favs ?? 0, 0, `favs=${String(stateD.favs)} — the live v10 failure (the star took the click)`);
});
check("the pick is named by the job's own company record", () => {
  assert.match(notesD, /contact row chosen by this job's own company record/, notesD.slice(0, 300) || driftD.slice(0, 300));
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} reanchor-whole-label smoke check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll reanchor-whole-label smoke checks passed (real Chromium).");
process.exit(0);
