// A RESULTS ROW IS PICKED BY THIS JOB'S OWN VALUE; A DATED LABEL IS NOT IDENTITY (#235).
//
// The 2026-11-14 audit of the saved recipes found the learn job's data frozen into selectors, and
// reproduced each on main with these shapes (all values here are synthetic — invented streets,
// parcels, owners, licences and companies; the learn job's values are never this job's):
//
//   E3  — Accela's address-search dialog (a child frame) lists address, parcel and owner rows,
//         each ticked by a radio with an ordinal id (…_gv_CB_0, _CB_1). The recipe recorded each
//         tick with the LEARN job's address / parcel / owner as its label and the ordinal id as its
//         fallback. On another job the label misses: main ticked the NEIGHBOUR's address (row 1,
//         the recorded position) and skipped the parcel and owner (their own labels shared no word
//         with the learn job's, so the re-anchor aborted).
//         MUST: this job's address row, its parcel, its owner — and the neighbour row unticked.
//   E3b — the same, with no parcel number on file for this job: the parcel list's ONLY row is
//         this address's parcel (the no-value rule); an owner list whose only row is NOT this
//         job's owner is refused, named, never ticked.
//   E5  — the certification tick recorded as "Date: <learn day>". Its box's own label is the
//         certification sentence (the audit's assumption; Boise's live markup was not seen — the
//         sentence is the accessible name a human capture recorded for the same id). On a later
//         day main read that label, found no word shared with the date and SKIPPED the
//         certification. MUST: ticked; the recorded final submit after it is NOT clicked.
//   E5b — the same box named by aria-labelledby (no <label for>): main already ticks it, and
//         this change must keep doing so (regression guard).
//   E5c — the E5 box inside a layout table beside another, differently named checkbox (Accela lays
//         pages out in tables): two boxes in one table are not a results grid. MUST: ticked.
//   p2A — a contact search table (per-row Add, Tigard's shape). The recipe's css keys the row by
//         the LEARN company's name and street number; for another client main matched nothing
//         and stalled. MUST: THIS client's row's Add, in seconds.
//   p2B — two records of this client's company at different streets: the client's street number
//         decides. MUST: that row's Add, never the other.
//   p2C — this client is not in the results: nothing is added, named, in seconds (no stall).
//
// Run: npx tsx portal-bot/src/adapters/learnDataRows.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
// main stalls on p2A-p2C (that is the defect): end such a run in a minute, not eight.
process.env.PORTAL_REPLAY_STALL_MINUTES = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---------------------------------------------------------------------------------------------
// The fixture: an Accela-like address-search dialog in a child frame, a review page carrying the
// certification, and a contact-search table. All synthetic.
// ---------------------------------------------------------------------------------------------
const PP = "ctl00_phPopup_ucSearchResult";
const radioRow = (list: string, i: number, cells: string[], labelled: boolean): string => {
  const id = `${PP}_uc${list}List_gv_CB_${i}`;
  const first = labelled ? `<label for="${id}">${cells[0]}</label>` : cells[0];
  return `<tr><td><input type="radio" id="${id}" name="${PP}_uc${list}List_gv_RadioButtonFieldGroupName" value="${i}"></td><td>${first}</td>${cells.slice(1).map((c) => `<td>${c}</td>`).join("")}</tr>`;
};
const grid = (list: string, headers: string[], rows: string[][], labelled: boolean): string =>
  `<h3>${list}</h3><table id="${PP}_uc${list}List_gv"><tr><th></th>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r, i) => radioRow(list, i, r, labelled)).join("")}</table>`;

const popup = (variant: string): string => `<!doctype html><html><body>
<h2>Address Search Result List</h2>
${grid("Address", ["Address", "City", "State", "Zip"], [
    ["4420 W QUILLMERE BLVD", "Fernhollow", "ID", "83999"],
    ["4415 W QUILLMERE BLVD", "Fernhollow", "ID", "83999"],
    ["2208 E LANTERNWOOD ST", "Fernhollow", "ID", "83999"],
  ], false)}
${grid("Parcel", ["Parcel Number", "Lot", "Block", "Subdivision"], [["R5521007731", "4", "2", "LANTERNWOOD ADD"]], true)}
${grid("Owner", ["Name", "Address"], variant === "E3b"
    ? [["HOLLOWAY TRUST", "PO BOX 88 FERNHOLLOW ID"]]
    : [["LANTERNWOOD PRIYA", "2208 E LANTERNWOOD ST FERNHOLLOW ID"]], true)}
<a id="ctl00_phPopup_btnSelect" href="javascript:void(0)">Select</a>
</body></html>`;

const dialogHost = (variant: string): string => `<!doctype html><html><head><title>Enter Work Site Location</title></head><body>
<h1>Step 1: Location</h1><h2>Enter Work Site Location</h2>
<iframe name="ACADialogFrame" id="ACADialogFrame" src="/popup?v=${variant}" style="width:900px;height:600px"></iframe>
</body></html>`;

const today = ((): string => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`; })();
const CERT_ID = "ctl00_PlaceHolderMain_capReviewCertification1_termReviewAccept";
const certLabelled = `<input type="checkbox" id="${CERT_ID}" name="ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept"><label for="${CERT_ID}">By checking this box, I agree to the above certification.</label>`;
const review = (variant: string): string => `<!doctype html><html><head><title>Step 4: Review</title></head><body>
<h1>Step 4: Review</h1>
<div id="certText">Per State Statute: I certify that the information above is true and correct.</div>
${variant === "E5c"
    // Accela lays pages out in tables: the certification shares one with an opt-in box.
    ? `<table class="ACA_Layout"><tr><td><input type="checkbox" id="ctl00_PlaceHolderMain_chkEmailNotice" name="emailNotice"><label for="ctl00_PlaceHolderMain_chkEmailNotice">Email me status updates</label></td></tr>
<tr><td>${certLabelled} <span class="ACA_Date">Date: ${today}</span></td></tr></table>`
    : `<div class="ACA_TabRow">
${variant === "E5"
    ? certLabelled
    : `<span id="certSentence">By checking this box, I agree to the above certification.</span> <input type="checkbox" id="${CERT_ID}" aria-labelledby="certSentence" name="ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept">`}
<span class="ACA_Date">Date: ${today}</span>
</div>`}
<a id="ctl00_PlaceHolderMain_actionBarBottom_btnContinue" href="javascript:void(0)" onclick="window.__finalClicks=(window.__finalClicks||0)+1;return false;">Continue Application &raquo;</a>
</body></html>`;

const contacts = (variant: string): string => {
  const rows: string[][] = variant === "p2C"
    ? [["Mara", "Quist", "61 Fennick Ave", "QUIST ELECTRIC CO"], ["Ana", "Bell", "12 Elmstone Ct", "NORTHGLEN ROOFING"]]
    : variant === "p2B"
      ? [["Dov", "Reyes", "77 Brookside Rd", "HALCYON SOLAR WORKS"], ["Mara", "Quist", "61 Fennick Ave", "QUIST ELECTRIC CO"], ["Dov", "Reyes", "4400 Copperline Way", "HALCYON SOLAR WORKS"]]
      : [["Mara", "Quist", "61 Fennick Ave", "QUIST ELECTRIC CO"], ["Dov", "Reyes", "4400 Copperline Way", "HALCYON SOLAR WORKS"], ["Ana", "Bell", "12 Elmstone Ct", "NORTHGLEN ROOFING"]];
  return `<!doctype html><html><head><title>Add Contact</title></head><body>
<h2>Add Contact As : Contractor</h2>
<div><button type="button">Search</button> <button type="button">Enter Manually</button></div>
<table id="results"><thead><tr><th>First Name</th><th>Last Name</th><th>Address</th><th>Company</th><th></th></tr></thead><tbody>
${rows.map((r, i) => `<tr id="c${i}">${r.map((c) => `<td>${c}</td>`).join("")}<td><button type="button" onclick="window.__added=(window.__added||[]).concat(['c${i}']);">Add</button></td></tr>`).join("")}
</tbody></table></body></html>`;
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const v = u.searchParams.get("v") ?? "";
  const body = u.pathname === "/popup" ? popup(v) : u.pathname === "/dialog" ? dialogHost(v) : u.pathname === "/review" ? review(v) : u.pathname === "/contacts" ? contacts(v)
    : u.pathname === "/lots" ? `<!doctype html><html><body><h2>Search Results</h2>${grid("Lot", ["Number", "Lot"], [["R4410062210", "7"], ["R5521007731", "4"]], true)}</body></html>` : "";
  res.writeHead(body ? 200 : 404, { "Content-Type": "text/html" });
  res.end(body || "not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ---------------------------------------------------------------------------------------------
// The recorded steps, in the shapes the audit found — with the LEARN job's values (synthetic).
// ---------------------------------------------------------------------------------------------
const POPUP = "ACADialogFrame";
const rowTick = (list: string, row: number, learnLabel: string, section: string): RecipeStep => ({
  action: "check", phase: "fill",
  selector: { label: learnLabel, frame: POPUP, fallbacks: [{ css: `#${PP}_uc${list}List_gv_CB_${row}`, frame: POPUP }] },
  note: learnLabel,
  fingerprint: { id: `${PP}_uc${list}List_gv_CB_${row}`, name: `${PP}_uc${list}List_gv_RadioButtonFieldGroupName`, section },
});
const DIALOG_STEPS: RecipeStep[] = [
  rowTick("Address", 1, "4417 W QUILLMERE BLVD, Fernhollow ID 83999", "Address City State Zip"),
  rowTick("Parcel", 0, "R7730012645", "Parcel Number Lot Block Subdivision"),
  rowTick("Owner", 0, "TAVELWICK ORRIN", "Name Address"),
];
const CERT_STEPS: RecipeStep[] = [
  {
    action: "check", phase: "fill",
    selector: { label: "Date: 09/28/2026", fallbacks: [{ css: `#${CERT_ID}` }] },
    note: "Date: 09/28/2026",
    fingerprint: { id: CERT_ID, name: "ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept", section: "Requirements" },
  },
  { action: "click", phase: "review", selector: { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: "#ctl00_PlaceHolderMain_actionBarBottom_btnContinue" }] }, isFinalSubmit: true, note: "final submit: Continue Application » (recorded, NOT clicked)" },
];
const LEARN_ROW = 'tr:has-text("BRIGHTFOLD ENERGY LLC"):has-text("929")';
const CONTACT_STEPS: RecipeStep[] = [{
  action: "click", phase: "fill",
  selector: { css: `${LEARN_ROW} a:has-text("Select"), ${LEARN_ROW} button:has-text("Add"), ${LEARN_ROW} a:has-text("Add"), ${LEARN_ROW} input[type='radio']` },
  note: "lookup(Add Contact As : Contractor): select this client's record (the row at 929 Harrowgate)",
}];

const recipeOf = (path: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "r235", scopeType: "ahj", profileKey: "id|fernhollow|x", state: "ID", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "auto-learned", portalUrl: `${base}${path}`, status: "complete", version: 1, discipline: "electrical",
  steps: [{ action: "goto", phase: "open", value: `${base}${path}`, note: "entry url" }, ...steps],
  createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
} as unknown as PortalRecipe);

// THIS job (synthetic): another property, owner and company than the learn job's.
const THIS_JOB: Record<string, string> = {
  streetNumber: "2208", street: "2208 E Lanternwood St", city: "Fernhollow", zip: "83999",
  homeownerName: "Priya Lanternwood", parcelNumber: "R5521007731",
  installerCompanyName: "Halcyon Solar Works", installerStreetNumber: "4400", installerStreet: "4400 Copperline Way",
};

const browser = await chromium.launch();
type Run = { ok: boolean; message: string; seconds: number; data: Record<string, unknown> };
const replay = async (page: Page, recipe: PortalRecipe, values: Record<string, string>, budgetMs = 110_000): Promise<Run> => {
  const adapter = new RecipeAdapter(recipe, values, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const run = adapter.fillApplication({} as ProjectRecord).catch((e: unknown) => ({ ok: false, message: `threw ${String(e).slice(0, 300)}` }));
  const timeout = new Promise<{ ok: boolean; message: string }>((r) => setTimeout(() => r({ ok: false, message: `TIMED OUT after ${budgetMs / 1000}s (stalled)` }), budgetMs));
  const res = await Promise.race([run, timeout]) as { ok: boolean; message: string; data?: Record<string, unknown> };
  return { ok: !!res.ok, message: String(res.message ?? ""), seconds: (Date.now() - t0) / 1000, data: (res.data ?? {}) as Record<string, unknown> };
};
const freshPage = async (): Promise<Page> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  return ctx.newPage();
};
const notes = (r: Run): string => JSON.stringify({ drift: r.data.driftWarnings, aging: r.data.agingNotes, skipped: r.data.skipped }).slice(0, 900);
const ticked = async (page: Page): Promise<Record<string, boolean>> => {
  const frame = page.frame({ name: POPUP });
  if (!frame) return {};
  return await frame.evaluate(() => {
    const out: Record<string, boolean> = {};
    for (const el of Array.from(document.querySelectorAll("input[type=radio]"))) out[(el as HTMLInputElement).id.replace(/^.*_uc/, "")] = (el as HTMLInputElement).checked;
    return out;
  }).catch(() => ({}));
};

// ---- E3 -------------------------------------------------------------------------------------
{
  const page = await freshPage();
  const r = await replay(page, recipeOf("/dialog?v=E3", DIALOG_STEPS), THIS_JOB);
  const t = await ticked(page);
  console.log(`   E3: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(t)}\n       ${notes(r)}`);
  check("E3: this job's address row is ticked (row 2), chosen by its own address", t.AddressList_gv_CB_2 === true, JSON.stringify(t));
  check("E3: the recorded position (row 1, a NEIGHBOUR) is never ticked", t.AddressList_gv_CB_1 !== true, JSON.stringify(t));
  check("E3: this job's parcel row is ticked (by its parcel number)", t.ParcelList_gv_CB_0 === true, JSON.stringify(t));
  check("E3: this job's owner row is ticked (by the owner's name)", t.OwnerList_gv_CB_0 === true, JSON.stringify(t));
  await page.context().close();
}
// ---- E3b ------------------------------------------------------------------------------------
{
  const page = await freshPage();
  const { parcelNumber: _none, ...noParcel } = THIS_JOB;
  void _none;
  const r = await replay(page, recipeOf("/dialog?v=E3b", DIALOG_STEPS), noParcel);
  const t = await ticked(page);
  const drift = JSON.stringify(r.data.driftWarnings ?? []);
  console.log(`   E3b: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(t)}\n       ${notes(r)}`);
  check("E3b: no parcel on file — the parcel list's ONLY row is ticked (not a position: the only row)", t.ParcelList_gv_CB_0 === true, JSON.stringify(t));
  check("E3b: an owner row that is not this job's owner is NOT ticked", t.OwnerList_gv_CB_0 !== true, JSON.stringify(t));
  check("E3b: ...and the refusal is named for a person", /owner row: none of the 1 result/.test(drift), drift);
  check("E3b: the address row is still this job's", t.AddressList_gv_CB_2 === true && t.AddressList_gv_CB_1 !== true, JSON.stringify(t));
  await page.context().close();
}
// ---- E5 / E5b -------------------------------------------------------------------------------
for (const variant of ["E5", "E5b", "E5c"]) {
  const page = await freshPage();
  const r = await replay(page, recipeOf(`/review?v=${variant}`, CERT_STEPS), THIS_JOB);
  const state = await page.evaluate((id: string) => ({
    checked: (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false,
    finalClicks: (window as unknown as { __finalClicks?: number }).__finalClicks ?? 0,
  }), CERT_ID).catch(() => ({ checked: false, finalClicks: -1 }));
  console.log(`   ${variant}: ok=${r.ok} ${r.seconds.toFixed(1)}s cert=${state.checked} finalClicks=${state.finalClicks} finalSubmitClicked=${String(r.data.finalSubmitClicked)}\n       ${notes(r)}`);
  check(`${variant}: the certification is ticked on a day after the learn (a dated label is not identity)`, state.checked === true, notes(r));
  check(`${variant}: the recorded final submit is NOT clicked (no approval, no PORTAL_ALLOW_FINAL_SUBMIT)`, state.finalClicks === 0 && r.data.finalSubmitClicked !== true, `finalClicks=${state.finalClicks}`);
  await page.context().close();
}
// ---- E3c (must-exclude, red on neither side) --------------------------------------------------
// A grid tick whose control names no role ("ucLotList") is not routed to a picker; its recorded
// label is a number, which is no identity evidence — and a results-grid row is never ticked by the
// position the recording held. main skips it too (its label re-anchor finds no shared word); this
// pins that the volatile-label rule does not turn it into an ordinal tick.
{
  const page = await freshPage();
  const r = await replay(page, recipeOf("/lots", [{
    action: "check", phase: "fill",
    selector: { label: "R7730012645", fallbacks: [{ css: `#${PP}_ucLotList_gv_CB_0` }] },
    note: "R7730012645",
    fingerprint: { id: `${PP}_ucLotList_gv_CB_0`, name: `${PP}_ucLotList_gv_RadioButtonFieldGroupName` },
  }]), THIS_JOB);
  const lots = await page.evaluate(() => Array.from(document.querySelectorAll("input[type=radio]")).map((el) => (el as HTMLInputElement).checked)).catch(() => [true]);
  console.log(`   E3c: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(lots)}\n       ${notes(r)}`);
  check("E3c: an unrouted grid tick with a numeric label ticks NO row (never the recorded position)", lots.every((x) => !x), JSON.stringify(lots));
  await page.context().close();
}
// ---- p2A / p2B / p2C ------------------------------------------------------------------------
for (const [variant, want] of [["p2A", "c1"], ["p2B", "c2"], ["p2C", ""]] as const) {
  const page = await freshPage();
  const r = await replay(page, recipeOf(`/contacts?v=${variant}`, CONTACT_STEPS), THIS_JOB);
  const added = await page.evaluate(() => (window as unknown as { __added?: string[] }).__added ?? []).catch(() => ["(unreadable)"]);
  const drift = JSON.stringify(r.data.driftWarnings ?? []);
  console.log(`   ${variant}: ok=${r.ok} ${r.seconds.toFixed(1)}s added=${JSON.stringify(added)} msg=${r.message.slice(0, 160)}\n       ${notes(r)}`);
  if (want) check(`${variant}: THIS client's row's Add is pressed (${want}), and only it`, added.length === 1 && added[0] === want, JSON.stringify(added));
  else {
    check(`${variant}: this client is not in the results — nothing is added`, added.length === 0, JSON.stringify(added));
    check(`${variant}: ...and it says so, named`, /contact row: none of the 2 result/.test(drift), drift);
  }
  check(`${variant}: no stall — the step is settled in seconds`, r.seconds < 45 && !/TIMED OUT|stalled/i.test(r.message), `${r.seconds.toFixed(1)}s ${r.message.slice(0, 120)}`);
  await page.context().close();
}

await browser.close();
server.close();
if (failures > 0) { console.error(`\nlearnDataRows.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nlearnDataRows.dom.smoke: PASS");
process.exit(0);
