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
//   E5  — the certification tick recorded as "Date: <learn day>" (the corpus's shape: Corvallis
//         333de771 #63 and two Boise ticks, recorded by an EARLIER learner — today's learner reads a
//         <label for> sentence instead). Its box's own label here is the certification sentence: the
//         AUDIT'S ASSUMPTION, the live markup was never seen (the sentence is the accessible name a
//         human capture recorded for the same id). On a later day main read that label, found no
//         word shared with the date and SKIPPED the certification. MUST: ticked; the recorded final
//         submit after it is NOT clicked.
//   E5b — the same box named by aria-labelledby (no <label for>): main already ticks it, and this
//         change must keep doing so (regression guard; NOT the auditor's E5b, which failed on main).
//   E5c — the E5 box inside a layout table beside another, differently named checkbox (Accela lays
//         pages out in tables): two boxes in one table are not a results grid. MUST: ticked.
//   E5d / E5e — the shapes today's learner records "Date:" for (a title, no label at all): ticked
//         on main and here (regression guards).
//   E3c / E3d — must-exclude: a grid tick recorded by another row's number (E3c) or by the date
//         printed beside the rows (E3d) is never ticked by its recorded position.
//   E3e / E3f — the grid a row step reads is told by the recorded control: by a same-shaped sibling
//         id when the recorded row is not on this job's page (E3e: the one address row, not the
//         owner's mailing address beside it) — but such an id is no authority for "the only row"
//         (E3f: another list whose ids differ by a digit is never taken for the recorded one).
//   C4 / C5 / C5b — the label re-anchor keeps main's answers (#235 review): a numeric control name
//         as the label still refuses a box labelled as another question (C4); a label that agrees
//         with the box's own (C5) or a box with no label (C5b) is kept, even among ordinal siblings.
//   A1 / A1b — the generic results-row pass's address step (no id) beside a small table whose header
//         says "address" and carries a button (a search form; a mailing-address box): the job's row
//         is read from every row, as main does (#235 review).
//   L1-L3 — Accela's licence results (15d6d558 #24 shape): the row with THIS job's licence number,
//         the permit's trade breaking a tie between two of the company's licences; no licence on
//         file or no trade to decide is refused, named; a number that is itself the link is clicked.
//         main ticks the recorded position (another company's licence) every time.
//   p2A — a contact search table (per-row Add, Tigard's shape). The recipe's css keys the row by
//         the LEARN company's name and street number; for another client main matched nothing
//         and stalled. MUST: THIS client's row's Add, in seconds.
//   p2B — two records of this client's company at different streets: the client's street number
//         decides. MUST: that row's Add, never the other.
//   p2C — this client is not in the results: nothing is added, named, in seconds (no stall).
//   p2F — a namesake: "HALCYON SOLAR WORKS SUPPLY INC" and "HALCYON SOLAR WORKS LLC", neither at the
//         client's street. MUST: the LLC row (its own cell is the company; the learner's companyKey),
//         never the supplier; main refused both as ambiguous.
//   p2D / p2E — the recipe replayed for the company it was learned for, its action worded "Add" with
//         an icon's text, or "Select Contact": main adds it, and so must this (#235 review).
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
// THE LIVE PREFIX: Boise's parcel and owner lists nest inside a panel named for the ADDRESS search
// (ctl00_phPopup_ucAddressSearchResult_ucParcelList_gv_CB_0), so only "the last role word wins"
// reads them as the parcel and owner lists (#235 review: a fixture without "Address" in the prefix
// left that rule unpinned).
const PP = "ctl00_phPopup_ucAddressSearchResult";
const radioRow = (list: string, i: number, cells: string[], labelled: boolean, prefix = PP): string => {
  const id = `${prefix}_uc${list}List_gv_CB_${i}`;
  const first = labelled ? `<label for="${id}">${cells[0]}</label>` : cells[0];
  return `<tr><td><input type="radio" id="${id}" name="${prefix}_uc${list}List_gv_RadioButtonFieldGroupName" value="${i}"></td><td>${first}</td>${cells.slice(1).map((c) => `<td>${c}</td>`).join("")}</tr>`;
};
const grid = (list: string, headers: string[], rows: string[][], labelled: boolean, prefix = PP): string =>
  `<h3>${list}</h3><table id="${prefix}_uc${list}List_gv"><tr><th></th>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r, i) => radioRow(list, i, r, labelled, prefix)).join("")}</table>`;
// E3c's lot list names no role anywhere in its id (a role-free panel), so it is never routed.
const LOT_PP = "ctl00_phPopup_ucSearchResult";

const popup = (variant: string): string => `<!doctype html><html><body>
<h2>Address Search Result List</h2>
${grid("Address", ["Address", "City", "State", "Zip"], variant === "E3e"
    // E3e: this job's search returned ONE address row — the recorded row (_CB_1) is not on the page.
    ? [["2208 E LANTERNWOOD ST", "Fernhollow", "ID", "83999"]]
    : [
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
    : variant === "E5d"
      ? `<input type="checkbox" id="${CERT_ID}" title="By checking this box, I agree to the above certification." name="ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept">`
      : variant === "E5e"
        ? `<input type="checkbox" id="${CERT_ID}" name="ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept">`
        : `<span id="certSentence">By checking this box, I agree to the above certification.</span> <input type="checkbox" id="${CERT_ID}" aria-labelledby="certSentence" name="ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept">`}
<span class="ACA_Date">Date: ${today}</span>
</div>`}
<a id="ctl00_PlaceHolderMain_actionBarBottom_btnContinue" href="javascript:void(0)" onclick="window.__finalClicks=(window.__finalClicks||0)+1;return false;">Continue Application &raquo;</a>
</body></html>`;

const contacts = (variant: string): string => {
  const rows: string[][] = variant === "p2F"
    // A NAMESAKE: both rows carry this client's words, neither at its street. The row whose own cell
    // IS the company (rowPick.ts companyKey: "LLC" is a suffix, "Supply" is not) is the one.
    ? [["Dov", "Reyes", "15 Mill St", "HALCYON SOLAR WORKS SUPPLY INC"], ["Ana", "Bell", "12 Elmstone Ct", "NORTHGLEN ROOFING"], ["Dov", "Reyes", "88 Pine Rd", "HALCYON SOLAR WORKS LLC"]]
    : variant === "p2C"
    ? [["Mara", "Quist", "61 Fennick Ave", "QUIST ELECTRIC CO"], ["Ana", "Bell", "12 Elmstone Ct", "NORTHGLEN ROOFING"]]
    : variant === "p2B"
      ? [["Dov", "Reyes", "77 Brookside Rd", "HALCYON SOLAR WORKS"], ["Mara", "Quist", "61 Fennick Ave", "QUIST ELECTRIC CO"], ["Dov", "Reyes", "4400 Copperline Way", "HALCYON SOLAR WORKS"]]
      : variant === "p2D" || variant === "p2E"
        // The LEARN company's own record (the recipe replayed for the company it was learned for).
        ? [["Mara", "Quist", "61 Fennick Ave", "QUIST ELECTRIC CO"], ["Lena", "Oduya", "929 Harrowgate Rd", "BRIGHTFOLD ENERGY LLC"], ["Ana", "Bell", "12 Elmstone Ct", "NORTHGLEN ROOFING"]]
        : [["Mara", "Quist", "61 Fennick Ave", "QUIST ELECTRIC CO"], ["Dov", "Reyes", "4400 Copperline Way", "HALCYON SOLAR WORKS"], ["Ana", "Bell", "12 Elmstone Ct", "NORTHGLEN ROOFING"]];
  // Every press is logged to the console too, so "what was added" is read in node and never depends on
  // the page still answering after a stalled run.
  const press = (i: number): string => `window.__added=(window.__added||[]).concat(['c${i}']);console.log('ADDED c${i}');return false;`;
  const action = (i: number): string => variant === "p2D"
    // An Add button carrying its icon's ligature text: the control's whole text is not "Add".
    ? `<button type="button" onclick="${press(i)}"><span class="material-icons" aria-hidden="true">person_add</span> Add</button>`
    : variant === "p2E"
      ? `<a href="javascript:void(0)" onclick="${press(i)}">Select Contact</a>`
      : `<button type="button" onclick="${press(i)}">Add</button>`;
  return `<!doctype html><html><head><title>Add Contact</title></head><body>
<h2>Add Contact As : Contractor</h2>
<div><button type="button">Search</button> <button type="button">Enter Manually</button></div>
<table id="results"><thead><tr><th>First Name</th><th>Last Name</th><th>Address</th><th>Company</th><th></th></tr></thead><tbody>
${rows.map((r, i) => `<tr id="c${i}">${r.map((c) => `<td>${c}</td>`).join("")}<td>${action(i)}</td></tr>`).join("")}
</tbody></table></body></html>`;
};

// A1 / A1b — the generic results-row pass's address step on a page that ALSO holds a small table whose
// header says "address" and that carries a button: a search form (A1, beside a grid whose rows bind
// their click in script and carry no control — Miami's shape) or a mailing-address box (A1b, beside a
// Select-link grid headed "Street No / Street Name"). The row is read from every row, as main does.
const pickScript = `<script>function pick(id){window.__picked=id;document.getElementById('out').textContent='Selected '+id;console.log('PICKED '+id);}</script>`;
const addressDecoy = (variant: string): string => variant === "A1"
  ? `<!doctype html><html><head><title>Property Search</title>${pickScript}</head><body><h1>Property Search</h1>
<table class="searchForm"><tr><th colspan="2">Property Search by Address</th></tr>
<tr><td>Street Number</td><td><input name="sn" value="6120"></td></tr>
<tr><td>Street Name</td><td><input name="st" value="Marrowbend"></td></tr>
<tr><td colspan="2"><button type="button">Search</button></td></tr></table>
<table id="results"><thead><tr><th>Site Address</th><th>Folio</th><th>Municipality</th></tr></thead><tbody>
<tr id="r-other" onclick="pick('r-other')" style="cursor:pointer"><td>6100 MARROWBEND DR</td><td>0199887766551</td><td>CITY OF FERNHOLLOW</td></tr>
<tr id="r-this" onclick="pick('r-this')" style="cursor:pointer"><td>6120 MARROWBEND DR</td><td>0199887766554</td><td>CITY OF FERNHOLLOW</td></tr>
<tr id="r-third" onclick="pick('r-third')" style="cursor:pointer"><td>6120 KESTREL WAY</td><td>0199887766559</td><td>CITY OF FERNHOLLOW</td></tr>
</tbody></table><div id="out"></div></body></html>`
  : `<!doctype html><html><head><title>Select Location</title>${pickScript}</head><body><h1>Select Location</h1>
<table class="mailing"><caption>Mailing Address</caption><tr><td>PO BOX 4471, FERNHOLLOW ID 83999</td><td><button type="button">Edit</button></td></tr></table>
<table id="results"><tr><th>Street No</th><th>Street Name</th><th>City</th><th></th></tr>
<tr id="r-other"><td>6100</td><td>MARROWBEND DR</td><td>FERNHOLLOW</td><td><a href="javascript:void(0)" onclick="pick('r-other')">Select</a></td></tr>
<tr id="r-this"><td>6120</td><td>MARROWBEND DR</td><td>FERNHOLLOW</td><td><a href="javascript:void(0)" onclick="pick('r-this')">Select</a></td></tr>
</table><div id="out"></div></body></html>`;

// L* — Accela's licence results in its dialog frame (the audit's 15d6d558 #24 shape): a checkbox per
// row named per row (…$gdvLicenseList$ctl02$CB_0), and a pager row with no control. Invented numbers.
const LP = "ctl00_phPopup_refLicenseList_gdvLicenseList";
const licRow = (ctl: string, cells: string[]): string =>
  `<tr class="ACA_TabRow_Odd"><td><div class="ACA_CheckBox"><input type="checkbox" id="${LP}_${ctl}_CB_0" name="ctl00$phPopup$refLicenseList$gdvLicenseList$${ctl}$CB_0"></div></td>${cells.map((c) => `<td><div><span>${c}</span></div></td>`).join("")}</tr>`;
// L3: the licence NUMBER is the row's link (no tick, no action word) — clicking it is the choice.
const licLinkRow = (ctl: string, cells: string[]): string =>
  `<tr class="ACA_TabRow_Odd"><td>${cells[0]}</td><td><a id="${LP}_${ctl}_lnkLicense" href="javascript:void(0)" onclick="console.log('LICENCE ${ctl}');return false;">${cells[1]}</a></td>${cells.slice(2).map((c) => `<td>${c}</td>`).join("")}</tr>`;
const licences = (variant: string): string => {
  const rows = variant === "L2"
    // The construction licence sits at the recorded position, the electrical one below it.
    ? [["Construction Contractor", "0072954", "HALCYON SOLAR WORKS", "4400 Copperline Way"], ["Electrical Contractor", "063318", "HALCYON SOLAR WORKS", "4400 Copperline Way"]]
    : [["Electrical Contractor", "041207", "QUIST ELECTRIC CO", "61 Fennick Ave"], ["Electrical Contractor", "063318", "HALCYON SOLAR WORKS", "4400 Copperline Way"]];
  return `<!doctype html><html><body><h2>Select from License</h2>
<table id="${LP}"><tr class="ACA_TabRow_Header">${variant === "L3" ? "" : "<th></th>"}<th>License Type</th><th>License Number</th><th>Business Name</th><th>Address</th></tr>
${rows.map((r, i) => (variant === "L3" ? licLinkRow : licRow)(`ctl0${i + 2}`, r)).join("")}
<tr class="ACA_Table_Pages"><td colspan="5"><span>Showing 1-2 of 2</span></td></tr></table>
<a id="ctl00_phPopup_btnContinue" href="javascript:void(0)">Continue</a></body></html>`;
};

// C4 / C5 / C5b / E3d — the label re-anchor's own cases (pages without results rows to route).
const anchorPage = (variant: string): string => {
  const body = variant === "C4"
    // A numeric control NAME recorded as the label, resolved by its id onto a box the page now labels
    // as another question: main refuses to write the valuation into "Owner Phone".
    ? `<label for="fld20456">Owner Phone</label> <input id="fld20456" name="fld20456">`
    : variant === "C5"
      // A stable numeric code list: the recorded label IS the box's own label.
      ? `<table id="workClass">${["10045", "10046", "10047"].map((c, i) => `<tr><td><input type="checkbox" id="workClass_ctl0${i + 2}_chk" name="workClass$ctl0${i + 2}$chk"><label for="workClass_ctl0${i + 2}_chk">${c}</label></td></tr>`).join("")}</table>`
      : variant === "C5b"
        // An unlabelled box (its numeric name the only recorded text) in a layout table beside another.
        ? `<table class="layout"><tr><td>Solar PV</td><td><input type="checkbox" id="field267070" name="field267070"></td></tr><tr><td>Battery</td><td><input type="checkbox" id="field267071" name="field267071"></td></tr></table>`
        : variant === "E3f"
          // E3f: the recorded parcel list (gvList2) returned nothing; ANOTHER list whose ids differ only
          // by a digit (gvList1, the address results) holds one row.
          ? `<h3>Address</h3><table id="ctl00_phPopup_gvList1"><tr><th></th><th>Address</th></tr><tr><td><input type="radio" id="ctl00_phPopup_gvList1_CB_0" name="ctl00$phPopup$gvList1$rb"></td><td>4420 W QUILLMERE BLVD</td></tr></table><h3>Parcel</h3><p>No parcels found.</p>`
        // E3d: a grid of ordinal, LABELLED radios; the step recorded the date printed beside them.
        : `<table id="ctl00_gvSlots">${["Slot A - Morning", "Slot B - Midday", "Slot C - Afternoon"].map((s, i) => `<tr><td><input type="radio" id="ctl00_gvSlots_ctl0${i + 2}_rb" name="ctl00$gvSlots$rb" value="${i}"><label for="ctl00_gvSlots_ctl0${i + 2}_rb">${s}</label></td><td>Date: ${today}</td></tr>`).join("")}</table>`;
  return `<!doctype html><html><head><title>Application Details</title></head><body><h1>Application Details</h1>${body}</body></html>`;
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const v = u.searchParams.get("v") ?? "";
  const body = u.pathname === "/popup" ? popup(v) : u.pathname === "/dialog" ? dialogHost(v) : u.pathname === "/review" ? review(v) : u.pathname === "/contacts" ? contacts(v)
    : u.pathname === "/lots" ? `<!doctype html><html><body><h2>Search Results</h2>${grid("Lot", ["Number", "Lot"], [["R4410062210", "7"], ["R5521007731", "4"]], true, LOT_PP)}</body></html>`
      : u.pathname === "/addr" ? addressDecoy(v)
        : u.pathname === "/lic" ? licences(v)
          : u.pathname === "/licdialog" ? `<!doctype html><html><head><title>Licensed Professional</title></head><body><h1>Step 2: Licensed Professional</h1><iframe name="ACADialogFrame" id="ACADialogFrame" src="/lic?v=${v}" style="width:900px;height:600px"></iframe></body></html>`
            : u.pathname === "/anchor" ? anchorPage(v) : "";
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

// The generic results-row pass's address step: the marker, the note — no id, no frame.
const GENERIC_ADDRESS_STEP: RecipeStep = {
  action: "click", phase: "fill", selector: { css: '[data-al-resultrow="1"]' },
  note: "address row: pick the search result matching this project's address",
};
// The audit's licence step (15d6d558 #24 shape) with the LEARN company's licence (invented) as label.
const LIC_STEP: RecipeStep = {
  action: "check", phase: "fill",
  selector: { label: "085531", frame: POPUP, fallbacks: [{ css: `#${LP}_ctl02_CB_0`, frame: POPUP }] },
  note: "085531",
  fingerprint: { id: `${LP}_ctl02_CB_0`, name: "ctl00$phPopup$refLicenseList$gdvLicenseList$ctl02$CB_0", section: "Showing 1-2 of 2" },
};

const recipeOf = (path: string, steps: RecipeStep[], discipline = "electrical"): PortalRecipe => ({
  id: "r235", scopeType: "ahj", profileKey: "id|fernhollow|x", state: "ID", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "auto-learned", portalUrl: `${base}${path}`, status: "complete", version: 1, discipline,
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
// ---- E3e (the grid told by a same-shaped sibling id) --------------------------------------------
// This job's search returned ONE address row, so the recorded row's id (_CB_1) is not on the page,
// and the step names no radio group (an older recording: id only). The owner list beside it shows the
// owner's mailing address — the property's own. The address grid is still told by the recorded
// control (its sibling _CB_0 has the same shape): read every row instead and the owner's row is a
// second "address" match, and this job's own row is refused as ambiguous. (main: the run fails after
// ~85 s with nothing ticked.)
{
  const page = await freshPage();
  const idOnly = { ...DIALOG_STEPS[0], fingerprint: { id: `${PP}_ucAddressList_gv_CB_1` } };
  const r = await replay(page, recipeOf("/dialog?v=E3e", [idOnly]), THIS_JOB);
  const t = await ticked(page);
  console.log(`   E3e: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(t)}\n       ${notes(r)}`);
  check("E3e: the one address row (this job's) is ticked, read from the address grid only", t.AddressList_gv_CB_0 === true && t.OwnerList_gv_CB_0 !== true, JSON.stringify(t));
  await page.context().close();
}
// ---- E3f (a same-shaped id is no "only row" authority) --------------------------------------------
// The recorded parcel list (…gvList2_CB_1) returned nothing; another list whose ids differ only by a
// digit (…gvList1, the address results) holds one row, and this job has no parcel number to compare.
// That row is another list's: never ticked as "the only row". (main: the run fails after ~75 s, and
// that row ends up ticked.)
{
  const page = await freshPage();
  const { parcelNumber: _none, ...noParcel } = THIS_JOB;
  void _none;
  const r = await replay(page, recipeOf("/anchor?v=E3f", [{
    action: "check", phase: "fill",
    selector: { label: "R7730012645", fallbacks: [{ css: "#ctl00_phPopup_gvList2_CB_1" }] },
    note: "R7730012645",
    fingerprint: { id: "ctl00_phPopup_gvList2_CB_1", section: "Parcel Number Lot Block Subdivision" },
  }]), noParcel);
  const radios = await page.evaluate(() => Array.from(document.querySelectorAll("input[type=radio]")).map((el) => (el as HTMLInputElement).checked)).catch(() => [true]);
  const drift = ((r.data.driftWarnings ?? []) as string[]).join(" | ");
  console.log(`   E3f: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(radios)}\n       ${notes(r)}`);
  check("E3f: another list's one row is NOT ticked as the parcel list's only row", radios.every((x) => !x), JSON.stringify(radios));
  check("E3f: ...and the refusal is named", /parcel row: this job has no parcel number on file, and the one result's grid is not told by the recorded control itself/.test(drift), drift);
  await page.context().close();
}
// ---- E5 / E5b / E5c, and the reachable shapes E5d (title) / E5e (unlabelled) -----------------
for (const variant of ["E5", "E5b", "E5c", "E5d", "E5e"]) {
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
// A grid tick whose control names no role ("ucSearchResult_ucLotList") is not routed to a picker;
// its recorded label is a number another row printed. main skips it (its label re-anchor finds no
// shared word); this pins that a long number is not waived as "no identity" into an ordinal tick.
{
  const page = await freshPage();
  const r = await replay(page, recipeOf("/lots", [{
    action: "check", phase: "fill",
    selector: { label: "R7730012645", fallbacks: [{ css: `#${LOT_PP}_ucLotList_gv_CB_0` }] },
    note: "R7730012645",
    fingerprint: { id: `${LOT_PP}_ucLotList_gv_CB_0`, name: `${LOT_PP}_ucLotList_gv_RadioButtonFieldGroupName` },
  }]), THIS_JOB);
  const lots = await page.evaluate(() => Array.from(document.querySelectorAll("input[type=radio]")).map((el) => (el as HTMLInputElement).checked)).catch(() => [true]);
  console.log(`   E3c: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(lots)}\n       ${notes(r)}`);
  check("E3c: an unrouted grid tick with a numeric label ticks NO row (never the recorded position)", lots.every((x) => !x), JSON.stringify(lots));
  await page.context().close();
}
// ---- E3d (the dated waiver never ticks a results-grid row by position) -------------------------
// A grid of ordinal, labelled radios; the step recorded the date printed beside them as its label.
// The date is no identity, so the dated-label waiver would keep the recorded id's row — but a row of
// a results grid is never chosen by the position the recording held. main skips it too.
{
  const page = await freshPage();
  const r = await replay(page, recipeOf("/anchor?v=E3d", [{
    action: "check", phase: "fill",
    selector: { label: "Date: 09/28/2026", fallbacks: [{ css: "#ctl00_gvSlots_ctl03_rb" }] },
    note: "Date: 09/28/2026",
  }]), THIS_JOB);
  const slots = await page.evaluate(() => Array.from(document.querySelectorAll("input[type=radio]")).map((el) => (el as HTMLInputElement).checked)).catch(() => [true]);
  console.log(`   E3d: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(slots)}\n       ${notes(r)}`);
  check("E3d: a date-labelled tick in a grid of ordinal siblings ticks NO row", slots.every((x) => !x), JSON.stringify(slots));
  await page.context().close();
}
// ---- C4 / C5 / C5b (the identity guard keeps main's answers: #235 review) ------------------------
// C4 — a numeric control name as the label is NOT waived: resolved by its id onto a box the page labels
//      "Owner Phone", the valuation is refused (main's "UNRELATED control" skip), never written there.
// C5 — a recorded label that AGREES with the box's own label (a stable numeric code) is kept, even in
//      a list of ordinal siblings.
// C5b — an unlabelled box has nothing to contradict: kept, even in a layout table beside another.
{
  const page = await freshPage();
  const r = await replay(page, recipeOf("/anchor?v=C4", [{
    action: "fill", phase: "fill", selector: { css: "#fld20456" }, note: "fld20456", field: "declaredValuation",
  }]), { ...THIS_JOB, declaredValuation: "18500" });
  const value = await page.evaluate(() => (document.getElementById("fld20456") as HTMLInputElement | null)?.value ?? "?").catch(() => "?");
  console.log(`   C4: ok=${r.ok} ${r.seconds.toFixed(1)}s value=${JSON.stringify(value)}\n       ${notes(r)}`);
  check("C4: a numeric name used as the label is still identity — the valuation is NOT written into \"Owner Phone\"", value === "", JSON.stringify(value));
  check("C4: ...and the refusal is named", /UNRELATED control labelled "Owner Phone"/.test(((r.data.driftWarnings ?? []) as string[]).join(" | ")), notes(r));
  await page.context().close();
}
for (const [variant, step, want] of [
  ["C5", { action: "check", phase: "fill", selector: { label: "10046", fallbacks: [{ css: "#workClass_ctl03_chk" }] }, note: "10046" }, "workClass_ctl03_chk"],
  ["C5b", { action: "check", phase: "fill", selector: { css: "#field267070" }, note: "field267070" }, "field267070"],
] as Array<[string, RecipeStep, string]>) {
  const page = await freshPage();
  const r = await replay(page, recipeOf(`/anchor?v=${variant}`, [step]), THIS_JOB);
  const boxes = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("input[type=checkbox]")).map((el) => [(el as HTMLInputElement).id, (el as HTMLInputElement).checked]))).catch(() => ({} as Record<string, boolean>));
  console.log(`   ${variant}: ok=${r.ok} ${r.seconds.toFixed(1)}s boxes=${JSON.stringify(boxes)}\n       ${notes(r)}`);
  check(`${variant}: the recorded box (${want}) is ticked, and only it`, Object.entries(boxes).every(([id, on]) => on === (id === want)), JSON.stringify(boxes));
  await page.context().close();
}
// ---- A1 / A1b (the generic address step reads every row: #235 review) ---------------------------
// The generic results-row pass records no id, so nothing says which table is the results grid. A
// header that says "address" is no evidence: a search form (A1) or a mailing-address box (A1b) says it
// too, carries a button, and was taken for the grid — the job's row was never read and the step was
// refused as "no result matched". main reads every row, and so must this.
for (const variant of ["A1", "A1b"]) {
  const page = await freshPage();
  const r = await replay(page, recipeOf(`/addr?v=${variant}`, [GENERIC_ADDRESS_STEP]), { ...THIS_JOB, streetNumber: "6120", street: "6120 Marrowbend Dr" });
  const picked = await page.evaluate(() => (window as unknown as { __picked?: string }).__picked ?? "").catch(() => "?");
  console.log(`   ${variant}: ok=${r.ok} ${r.seconds.toFixed(1)}s picked=${JSON.stringify(picked)}\n       ${notes(r)}`);
  check(`${variant}: this job's address row is chosen (r-this), read from the results grid`, picked === "r-this", `${JSON.stringify(picked)} ${notes(r)}`);
  await page.context().close();
}
// ---- L1 / L1n / L2 / L2s / L1z (licence rows: #235 review) ---------------------------------------
// The recorded licence (the learn company's) labels row ctl02; main ticks that position on every job.
// MUST: the row carrying THIS job's licence; with two of the company's licences, the permit's trade
// decides; no licence on file over two rows, or two matches with no trade to decide, is refused,
// named. The pager row ("Showing 1-2 of 2", no control) is never a result.
{
  const licTicks = async (page: Page): Promise<Record<string, boolean>> => {
    const f = page.frame({ name: POPUP });
    return f ? await f.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("input[type=checkbox]")).map((e) => [(e as HTMLInputElement).id.replace(/^.*gdvLicenseList_/, ""), (e as HTMLInputElement).checked]))).catch(() => ({})) : {};
  };
  const cases: Array<[string, string, Record<string, string>, string, string]> = [
    ["L1", "L1", { electricalLicenseNumber: "063318" }, "electrical", "ctl03_CB_0"],
    ["L1n", "L1", {}, "electrical", ""],
    ["L2", "L2", { electricalLicenseNumber: "063318", ccbLicenseNumber: "0072954" }, "electrical", "ctl03_CB_0"],
    ["L2s", "L2", { electricalLicenseNumber: "063318", ccbLicenseNumber: "0072954" }, "structural", ""],
    ["L1z", "L1", { electricalLicenseNumber: "63318" }, "electrical", "ctl03_CB_0"],
  ];
  for (const [name, v, values, discipline, want] of cases) {
    const page = await freshPage();
    const r = await replay(page, recipeOf(`/licdialog?v=${v}`, [LIC_STEP], discipline), values);
    const t = await licTicks(page);
    const drift = JSON.stringify(r.data.driftWarnings ?? []);
    console.log(`   ${name}: ok=${r.ok} ${r.seconds.toFixed(1)}s ticked=${JSON.stringify(t)}\n       ${notes(r)}`);
    if (want) check(`${name}: the row with this job's licence (${want}) is ticked, and only it`, Object.keys(t).length === 2 && Object.entries(t).every(([id, on]) => on === (id === want)), JSON.stringify(t));
    else {
      check(`${name}: no row is ticked (the recorded position ctl02 is another company's or a guess)`, Object.keys(t).length === 2 && Object.values(t).every((on) => !on), JSON.stringify(t));
      check(`${name}: ...and the refusal is named for a person`, name === "L1n" ? /licence row: this job has no licence number on file and the grid offers 2 rows/.test(drift) : /licence row: 2 of the 2 results/.test(drift), drift);
    }
    await page.context().close();
  }
  // L3 — the number is the link: the link showing THIS job's licence is clicked; main clicks the
  // recorded position's link (another company's licence).
  {
    const page = await freshPage();
    const clicked: string[] = [];
    page.on("console", (m) => { const hit = /^LICENCE (ctl\d+)$/.exec(m.text()); if (hit) clicked.push(hit[1]); });
    const step: RecipeStep = {
      action: "click", phase: "fill",
      selector: { role: "link", name: "085531", frame: POPUP, fallbacks: [{ css: `#${LP}_ctl02_lnkLicense`, frame: POPUP }] },
      note: "085531",
      fingerprint: { id: `${LP}_ctl02_lnkLicense`, section: "Showing 1-2 of 2" },
    };
    const r = await replay(page, recipeOf("/licdialog?v=L3", [step]), { electricalLicenseNumber: "063318" });
    console.log(`   L3: ok=${r.ok} ${r.seconds.toFixed(1)}s clicked=${JSON.stringify(clicked)}\n       ${notes(r)}`);
    check("L3: the link showing this job's licence (ctl03) is clicked, and only it", clicked.length === 1 && clicked[0] === "ctl03", JSON.stringify(clicked));
    await page.context().close();
  }
}
// ---- p2A / p2B / p2C, and p2D / p2E (the learn company's own record, other action wording) ----
// p2D / p2E replay the recipe for the company it was LEARNED for (main's css matches it, and adds):
// an Add button carrying its icon's text, and a "Select Contact" link. The action word is a word of
// the control's text, not its whole text (#235 review).
const SAME_CLIENT: Record<string, string> = {
  ...THIS_JOB, installerCompanyName: "Brightfold Energy LLC", installerStreetNumber: "929", installerStreet: "929 Harrowgate Rd",
};
for (const [variant, want] of [["p2A", "c1"], ["p2B", "c2"], ["p2C", ""], ["p2D", "c1"], ["p2E", "c1"], ["p2F", "c2"]] as const) {
  const page = await freshPage();
  const added: string[] = [];
  page.on("console", (m) => { const hit = /^ADDED (c\d+)$/.exec(m.text()); if (hit) added.push(hit[1]); });
  const r = await replay(page, recipeOf(`/contacts?v=${variant}`, CONTACT_STEPS), variant === "p2D" || variant === "p2E" ? SAME_CLIENT : THIS_JOB);
  const drift = JSON.stringify(r.data.driftWarnings ?? []);
  console.log(`   ${variant}: ok=${r.ok} ${r.seconds.toFixed(1)}s added=${JSON.stringify(added)} msg=${r.message.slice(0, 160)}\n       ${notes(r)}`);
  if (want) check(`${variant}: THIS client's row's action is pressed (${want}), and only it`, added.length === 1 && added[0] === want, JSON.stringify(added));
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
