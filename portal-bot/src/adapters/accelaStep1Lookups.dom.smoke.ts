// ACCELA STEP 1: THE PAGE'S LOOKUP BUTTONS ARE PRESSED BEFORE A REQUIRED BLANK IS NAMED (#178).
//
// Live City of Meridian (2026-11-12, run 2026-11-12_04-02-08): the walk typed Street No. / Street
// Name, the solar questions and the signature, then Continue bounced — "Parcel Number: Required",
// "This section is required. Please add one record." for Contractor / Applicant / Contact. All four
// are filled by a BUTTON the walk never pressed: "Find Address" (the address search, which populates
// the Parcel section), "Autofill" (the account's contact into Applicant), "Look Up" (a licensed-
// professional search; the test client has no licence on file, so the honest outcome is "no record").
//
// A SYNTHETIC Step-1-shaped page (ACA ids, each section a heading row + body, the hidden required
// validator ACA marks a record section with, an ACADialogFrame iframe for Look Up's search). The URL
// has no "WorkLocation" and the page no "Enter Work Site Location", so the work-location pass does
// not take it; no "Select from Account", so the contact pass does not either. Fake data only.
//
// MUST-PASS nomatch: driven through the real AutoLearnAdapter.learn(): Find Address pressed (parcel
//           populated by the page's own script; the recorded step is the BUTTON click, `populates`
//           naming "Parcel Number:", no typed parcel anywhere in the steps), Autofill pressed (the
//           Applicant section holds a record), Look Up tried (its dialog searched by the business
//           name, "No records found."), and the walk stops NAMED on the Contractor section only;
//           0 Enter presses, 0 filing requests; FIND PARCEL (nothing typed in its section) and
//           Continue Application never pressed.
// MUST-PASS candidates: Find Address lists TWO addresses → the job's own (city/ZIP) is picked by the
//           ranked chooser, the parcel fills, Autofill pressed, Continue reaches "Step 2: Review";
//           0 Enter, 0 filing requests.
// MUST-PASS replay: the candidates recipe replays through the real RecipeAdapter in order — the
//           lookup click by its label, the row by the project's address, the parcel verified present
//           after the press, the Applicant record present, review reached; 0 Enter, 0 filing requests.
//
// Fails without the fix (the lookup pass commented out): the nomatch walk never presses Find Address
// and stops on "Parcel Number:" as required-never-filled with no lookup step recorded.
//
// Run: npx tsx portal-bot/src/adapters/accelaStep1Lookups.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const P = "ctl00_PlaceHolderMain";
const MOD = "module=Permitting&TabName=Permitting";
const CONT = `<div id="${P}_actionBarBottom"><a id="${P}_actionBarBottom_btnContinue" href="javascript:void(0);" title="Continue Application »" class="ACA_LgButton"><span>Continue Application &raquo;</span></a></div>`;
/** A section the way ACA renders one: a wrapper holding the heading row and the body. */
const section = (heading: string, instruction: string, body: string): string =>
  `<div><div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1><span>${heading}</span></h1></div><div class="ACA_Section_Instruction ACA_Section_Instruction_FontSize">${instruction}</div></div><div>${body}</div></div>`;
/** ACA's hidden required validator: how a RECORD section is marked required before it holds one. */
const validator = (ctl: string): string =>
  `<table style="display:none"><tr><td><input name="${P}$${ctl}$txtValidateSectionRequired" type="text" id="${P}_${ctl}_txtValidateSectionRequired" title="Required" aria-required="true"></td></tr></table>`;
const shell = (title: string, body: string, script = ""): string => `<!doctype html><html><head><title>${title}</title></head><body>
<div id="hdr"><a id="ctl00_HeaderNavigation_hlHome" href="/permits/Welcome.aspx">Home</a> <span>Logged in as: Permit Tech</span></div>
<form id="aspnetForm" method="post" action="#" onsubmit="return false">${body}</form>
<script>
var S = JSON.parse(sessionStorage.getItem("S") || '{"enters":0,"finds":0,"parcelFinds":0,"autofills":0,"lookups":0,"continues":0,"rowPicks":0}');
function save(){ sessionStorage.setItem("S", JSON.stringify(S)); } window.__S = S;
document.addEventListener("keydown", function(e){ if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") { S.enters++; save(); } });
${script}
</script></body></html>`;

const pages = (variant: string, path: string, q: URLSearchParams): string | null => {
  if (/CapEdit\.aspx$/i.test(path) && q.get("stepNumber") === "1") {
    const contractor = variant === "nomatch" ? section("Contractor",
      "For Residential permits, if no contractor and pulling permit as Property Owner, please indicate by clicking look up and search property owner under business name.",
      `${validator("License_409Edit")}<div id="contractorRecord"></div>
       <a id="${P}_License_409Edit_btnAddNewLP" title="Add New" href="javascript:void(0);"><span>Add New</span></a>
       <a id="${P}_License_409Edit_btnLookUpLP" title="Look Up" href="javascript:void(0);"><span>Look Up</span></a>`) : "";
    return shell("Accela Citizen Access", `<h1 class="ACA_Title_Color">Residential Electrical Solar Array</h1><p>Step 1: Application Information &gt; Application Details</p><p>* indicates a required field.</p>
    ${section("Site Address", 'TO USE: Enter a Street Number and Street Name. Click on "FIND ADDRESS" and all other fields will populate automatically.', `
      <div class="ACA_Form"><span class="ACA_Required_Indicator">*</span><label for="${P}_WorkLocationEdit_txtStreetNo">Street No.:</label> <input id="${P}_WorkLocationEdit_txtStreetNo" name="${P}$WorkLocationEdit$txtStreetNo" title="Required" aria-required="true"></div>
      <div class="ACA_Form"><span class="ACA_Required_Indicator">*</span><label for="${P}_WorkLocationEdit_txtStreetName">Street Name:</label> <input id="${P}_WorkLocationEdit_txtStreetName" name="${P}$WorkLocationEdit$txtStreetName" title="Required" aria-required="true"></div>
      <input type="hidden" id="${P}_WorkLocationEdit_txtRefAddressId" value="">
      <ul class="addressedit_button_section"><li><a id="${P}_WorkLocationEdit_btnSearch" title="Find Address" href="javascript:void(0);"><span>Find Address</span></a></li>
      <li><a id="${P}_WorkLocationEdit_btnClearAddress" title="Clear" href="javascript:void(0);"><span>Clear</span></a></li></ul>
      <div id="addrResults"></div><div id="addrMsg"></div>`)}
    ${section("Parcel", 'TO USE: Enter Parcel Number, i.e., R1000000000. Click on "FIND PARCEL"', `
      <div class="ACA_Form"><span class="ACA_Required_Indicator">*</span><label for="${P}_ParcelEdit_txtParcelNo">Parcel Number:</label> <input id="${P}_ParcelEdit_txtParcelNo" name="${P}$ParcelEdit$txtParcelNo" title="Required" aria-required="true"></div>
      <a id="${P}_ParcelEdit_btnSearch" title="FIND PARCEL" href="javascript:void(0);"><span>FIND PARCEL</span></a> <a id="${P}_ParcelEdit_btnClear" title="Clear" href="javascript:void(0);"><span>Clear</span></a>`)}
    ${contractor}
    ${section("Applicant", "Click Autofill to copy account information to applicant.", `
      ${validator("Applicant_410Edit")}<div id="applicantRecord"></div>
      <ul><li><a id="${P}_Applicant_410Edit_btnAddFromSaved" title="Autofill" href="javascript:void(0);"><span>Autofill</span></a></li></ul>`)}
    ${section("Detail Information", "", `
      <div class="ACA_Form"><span class="ACA_Required_Indicator">*</span><label for="${P}_DetailInfoEdit_txtApplicationName">Application Name:</label> <input id="${P}_DetailInfoEdit_txtApplicationName" title="Required" aria-required="true"></div>
      <div class="ACA_Form"><span class="ACA_Required_Indicator">*</span><label for="${P}_AppSpec_txt_0_4">Number of panels:</label> <input id="${P}_AppSpec_txt_0_4" title="Required" aria-required="true"></div>`)}
    <div id="errs"></div>
    ${CONT}
    <div id="dlgWrap" style="display:none"><a id="ACADialogFrame_Close" title="Close" href="javascript:void(0);">Close</a><iframe name="ACADialogFrame" id="ACADialogFrame" src="about:blank" style="width:600px;height:300px"></iframe></div>`,
    `var V = ${JSON.stringify(variant)};
    var el = function(s){ return document.getElementById("${P}_" + s); };
    var fillParcel = function(){ el("ParcelEdit_txtParcelNo").value = "R1234567890"; el("WorkLocationEdit_txtRefAddressId").value = "A-100"; };
    el("WorkLocationEdit_btnSearch").onclick = function(){
      S.finds++; save();
      var no = el("WorkLocationEdit_txtStreetNo").value.trim(), nm = el("WorkLocationEdit_txtStreetName").value.trim().toLowerCase();
      var hit = no === "33" && nm && "broadway".indexOf(nm) === 0;
      setTimeout(function(){
        if (!hit) { document.getElementById("addrMsg").textContent = "Address not found."; return; }
        if (V === "candidates") {
          document.getElementById("addrResults").innerHTML = '<table id="${P}_WorkLocationEdit_gdvAddress"><tr><td><a href="javascript:void(0);" class="pick" data-p="R1234567890">Select</a></td><td>33 BROADWAY AVE MERIDIAN ID 83642 CITY APPLICATIONS</td></tr><tr><td><a href="javascript:void(0);" class="pick" data-p="R9999999999">Select</a></td><td>33 BROADWAY CT NAMPA ID 83651 CITY APPLICATIONS</td></tr></table>';
          Array.prototype.forEach.call(document.querySelectorAll("a.pick"), function(a){ a.onclick = function(){ S.rowPicks++; S.pickedParcel = a.getAttribute("data-p"); save(); setTimeout(function(){ el("ParcelEdit_txtParcelNo").value = a.getAttribute("data-p"); el("WorkLocationEdit_txtRefAddressId").value = "A-100"; document.getElementById("addrResults").innerHTML = ""; }, 200); return false; }; });
        } else { fillParcel(); }
      }, 300);
      return false;
    };
    el("ParcelEdit_btnSearch").onclick = function(){ S.parcelFinds++; save(); return false; };
    el("Applicant_410Edit_btnAddFromSaved").onclick = function(){
      S.autofills++; save();
      setTimeout(function(){ document.getElementById("applicantRecord").innerHTML = '<div>Permit Tech<br>Keelix Test Co<br>permits@example.test</div><a id="${P}_Applicant_410Edit_btnEdit" title="Edit" href="javascript:void(0);"><span>Edit</span></a>'; el("Applicant_410Edit_btnAddFromSaved").style.display = "none"; }, 250);
      return false;
    };
    if (V === "nomatch") el("License_409Edit_btnLookUpLP").onclick = function(){
      S.lookups++; save();
      document.getElementById("ACADialogFrame").src = "/permits/Dialog.aspx?kind=licensee";
      document.getElementById("dlgWrap").style.display = "block";
      return false;
    };
    document.getElementById("ACADialogFrame_Close").onclick = function(){ document.getElementById("dlgWrap").style.display = "none"; return false; };
    el("actionBarBottom_btnContinue").onclick = function(){
      S.continues++; S.parcelAtContinue = el("ParcelEdit_txtParcelNo").value; S.applicantAtContinue = document.getElementById("applicantRecord").textContent.trim(); save();
      var errs = [];
      if (!el("ParcelEdit_txtParcelNo").value.trim()) errs.push("Parcel Number: Required");
      if (V === "nomatch" && !document.getElementById("contractorRecord").textContent.trim()) errs.push("Contractor - This section is required. Please add one record.");
      if (!document.getElementById("applicantRecord").textContent.trim()) errs.push("Applicant - This section is required. Please add one record.");
      if (!el("DetailInfoEdit_txtApplicationName").value.trim()) errs.push("Application Name: Required");
      if (errs.length) { document.getElementById("errs").innerHTML = errs.length + " error(s) occurred on current page. " + errs.join(" "); return false; }
      location.href = "/permits/Cap/CapConfirm.aspx?${MOD}";
      return false;
    };`);
  }
  if (/Dialog\.aspx$/i.test(path)) return `<!doctype html><html><head><title>Look Up</title></head><body>
    <h2>Licensed Professional Search</h2>
    <div><label for="txtLicenseNumber">License Number:</label> <input id="txtLicenseNumber"></div>
    <div><label for="txtBusinessName">Business Name:</label> <input id="txtBusinessName"></div>
    <a id="btnSearchLP" title="Search" href="javascript:void(0);"><span>Search</span></a>
    <div id="res"></div>
    <script>
      document.addEventListener("keydown", function(e){ if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") { var S = JSON.parse(sessionStorage.getItem("S") || "{}"); S.enters = (S.enters || 0) + 1; sessionStorage.setItem("S", JSON.stringify(S)); } });
      document.getElementById("btnSearchLP").onclick = function(){
        var D = JSON.parse(sessionStorage.getItem("D") || '{"searches":0}');
        D.searches++; D.lastName = document.getElementById("txtBusinessName").value; sessionStorage.setItem("D", JSON.stringify(D));
        setTimeout(function(){ document.getElementById("res").textContent = "No records found."; }, 250);
        return false;
      };
    </script></body></html>`;
  if (/CapConfirm\.aspx$/i.test(path)) return shell("Accela Citizen Access", `<h1>Step 2: Review</h1><p>Please review all information below. Your application will not be submitted until you click Continue Application.</p>
    <p>Work location: 33 BROADWAY AVE</p>${CONT}`,
  `document.getElementById("${P}_actionBarBottom_btnContinue").onclick = function(){ fetch("/permits/Cap/CapConfirm.aspx?submit=1", { method: "POST", body: "__EVENTTARGET=btnContinue" }).catch(function(){}); return false; };`);
  return null;
};

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { posts.push(url.pathname + url.search); res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  const variant = (req.headers.cookie || "").match(/v=(\w+)/)?.[1] || "nomatch";
  const html = pages(variant, url.pathname, url.searchParams);
  if (!html) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not found</h1>"); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const entry = `${base}/permits/Cap/CapEdit.aspx?stepNumber=1&${MOD}`;

// The planner stands in for the LLM: the split address boxes from the job (address_split_form), the
// detail boxes; never the parcel (it has no value for it), never a button. Advance by Continue.
const planner: LearnPlanner = async (req) => {
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  req.fields.forEach((f, i) => {
    const l = String(f.label ?? "");
    if (f.fieldType !== "text") return;
    if (/street no/i.test(l)) fills.push({ selectorIndex: i, value: "33", field: "streetNumber" });
    else if (/street name/i.test(l)) fills.push({ selectorIndex: i, value: "Broadway", field: "streetNameCore" });
    else if (/application name/i.test(l)) fills.push({ selectorIndex: i, value: "Test Owner", field: "homeownerName" });
    else if (/number of panels/i.test(l)) fills.push({ selectorIndex: i, value: "16", field: "moduleCount" });
  });
  const cont = req.fields.findIndex((f) => f.fieldType === "button" && /continue application/i.test(String(f.label ?? "")));
  return { fills, atReview: false, ...(cont >= 0 ? { advanceSelectorIndex: cont } : {}) };
};

type FixtureState = Record<string, unknown> & { dialog?: Record<string, unknown>; parcel?: string | null; applicant?: string | null };
const state = async (page: Page): Promise<FixtureState> => page.evaluate(() => ({
  ...(JSON.parse(sessionStorage.getItem("S") || "{}") as Record<string, unknown>),
  dialog: JSON.parse(sessionStorage.getItem("D") || "{}") as Record<string, unknown>,
  parcel: (document.getElementById("ctl00_PlaceHolderMain_ParcelEdit_txtParcelNo") as HTMLInputElement | null)?.value ?? null,
  applicant: document.getElementById("applicantRecord")?.textContent?.trim() ?? null,
}) as FixtureState).catch(() => ({} as FixtureState));
const project = { projectAddress: "33 N Broadway Ave, Meridian, ID 83642", city: "Meridian", state: "ID", zip: "83642", homeownerName: "Test Owner", permitType: "electrical", parserSnapshot: {} } as unknown as ProjectRecord;
const COMPANY = { companyName: "Keelix Test Co", firstName: "Permit", lastName: "Tech", email: "permits@example.test" };

const browser = await chromium.launch();
let candidateSteps: RecipeStep[] = [];
let nomatchSteps: RecipeStep[] = [];
try {
  for (const variant of ["nomatch", "candidates"]) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addCookies([{ name: "v", value: variant, url: base }]);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(entry);
    posts.length = 0;
    const adapter = new AutoLearnAdapter("ACA Step 1 Lookups Smoke", planner, {
      maxPages: 6, contactIdentity: COMPANY, siteContactIdentity: { lastName: "Owner" },
      siteIdentity: { city: "Meridian", zip: "83642", homeownerName: "Test Owner", isElectrical: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try { r = await adapter.learn({ portalUrl: entry } as never, project); } catch (e) { threw = String(e).slice(0, 300); }
    const st = await state(page);
    const where = page.url();
    await ctx.close().catch(() => null);
    const steps = r?.steps ?? [];
    const notes = steps.map((s) => String(s.note ?? ""));
    const filings = posts.filter((p) => /CapConfirm.*submit=1/i.test(p)).length;
    const msg = String(r?.message ?? threw).slice(0, 500);
    const stepsJson = JSON.stringify(steps);
    // The candidates walk leaves the page (review), so its Step 1 values are the ones the page saved
    // as Continue was pressed; the nomatch walk stays on the page.
    const parcelNow = st.parcel ?? st.parcelAtContinue;
    const applicantNow = st.applicant ?? st.applicantAtContinue;
    const findStep = steps.find((s) => s.action === "click" && /^lookup: Find Address/.test(String(s.note ?? "")));
    const autofillStep = steps.find((s) => s.action === "click" && /^lookup: Autofill/.test(String(s.note ?? "")));
    check(`${variant}: 0 Enter presses, 0 filing requests, FIND PARCEL never pressed`, st.enters === 0 && filings === 0 && st.parcelFinds === 0, `enters=${String(st.enters)} filings=${filings} parcelFinds=${String(st.parcelFinds)} POSTs=[${posts.join(",")}]`);
    check(`MUST-PASS ${variant}: Find Address pressed once, the parcel populated by the page, and NO typed parcel anywhere in the steps`,
      st.finds === 1 && parcelNow === "R1234567890" && !stepsJson.includes("R1234567890") && !steps.some((s) => s.action === "fill" && /parcel/i.test(String(s.note ?? "") + String(s.field ?? ""))),
      `finds=${String(st.finds)} parcel=${String(parcelNow)} notes=${JSON.stringify(notes)}`);
    check(`MUST-PASS ${variant}: the recorded step is the BUTTON click by its label, with a css fallback, before any Autofill step`,
      !!findStep && findStep.selector?.name === "Find Address" && findStep.selector?.exact === true && (findStep.selector?.fallbacks ?? []).some((f) => /btnSearch/.test(String(f.css ?? "")))
        && (!autofillStep || steps.indexOf(findStep) < steps.indexOf(autofillStep)),
      `findStep=${JSON.stringify(findStep)}`);
    check(`MUST-PASS ${variant}: Autofill pressed once and the Applicant section holds a record; recorded by label with populates naming the section`,
      st.autofills === 1 && /Keelix Test Co/.test(String(applicantNow)) && !!autofillStep && autofillStep.selector?.name === "Autofill" && (autofillStep.populates ?? []).includes("Applicant"),
      `autofills=${String(st.autofills)} applicant=${String(applicantNow)} autofillStep=${JSON.stringify(autofillStep)}`);
    if (variant === "nomatch") {
      nomatchSteps = steps;
      const lastGroup = steps[steps.indexOf(findStep as RecipeStep)];
      check("MUST-PASS nomatch: `populates` on the Find Address click names Parcel Number", (lastGroup?.populates ?? []).some((l) => /parcel number/i.test(l)), `populates=${JSON.stringify(lastGroup?.populates)}`);
      check("MUST-PASS nomatch: Look Up tried — its dialog searched ONCE by the business name, found nothing, no dialog steps kept",
        st.lookups === 1 && Number(st.dialog?.searches) === 1 && st.dialog?.lastName === "Keelix Test Co" && !notes.some((n) => /^lookup\(Contractor\)/.test(n)),
        `lookups=${String(st.lookups)} dialog=${JSON.stringify(st.dialog)} notes=${JSON.stringify(notes)}`);
      check("MUST-PASS nomatch: the walk stops NAMED on the Contractor section only (not Parcel, not Applicant), stopReason required_blank, Continue never pressed",
        r?.ok === false && r?.stopReason === "required_blank" && /"Contractor" section/.test(msg) && /Look Up/.test(msg) && !/Applicant|Parcel Number/.test(msg.replace(/the steps before this page were recorded\./, "")) && st.continues === 0 && /CapEdit/.test(where),
        `ok=${String(r?.ok)} stopReason=${String(r?.stopReason)} continues=${String(st.continues)} at=${where} msg=${msg}`);
    } else {
      candidateSteps = steps;
      const rowStep = steps.find((s) => /data-al-row/.test(String(s.selector?.css ?? "")));
      check("MUST-PASS candidates: two addresses listed → the job's own (Meridian 83642) picked by the ranked chooser, recorded as the row marker, populates on the pick",
        st.rowPicks === 1 && st.pickedParcel === "R1234567890" && !!rowStep && (rowStep.populates ?? []).some((l) => /parcel number/i.test(l)),
        `rowPicks=${String(st.rowPicks)} pickedParcel=${String(st.pickedParcel)} rowStep=${JSON.stringify(rowStep)}`);
      check("MUST-PASS candidates: the walk reaches Step 2: Review by Continue Application",
        r?.reachedReview === true && /CapConfirm/i.test(where) && st.continues === 1, `reachedReview=${String(r?.reachedReview)} at=${where} continues=${String(st.continues)} ${msg}`);
    }
  }

  // REPLAY the candidates recipe through the real RecipeAdapter.
  const recipe = {
    id: "aca-step1", scopeType: "ahj", profileKey: "id|city of meridian|", state: "ID", ahj: "City of Meridian", utility: "",
    portalPlatform: "accela", portalUrl: entry, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps: [...candidateSteps.filter((s) => !s.isFinalSubmit), { action: "stopForReview" } as RecipeStep],
  } as unknown as PortalRecipe;
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addCookies([{ name: "v", value: "candidates", url: base }]);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  posts.length = 0;
  // The field values the backend binds for a replay (bindRecipeForReplay): the project's own
  // city / ZIP are what the ranked chooser judges the address rows against.
  const adapter = new RecipeAdapter(recipe, { streetNumber: "33", streetNameCore: "Broadway", homeownerName: "Test Owner", moduleCount: "16", city: "Meridian", zip: "83642" }, {}, {});
  (adapter as unknown as { page: unknown }).page = page;
  let res: { ok: boolean; message: string; agingNotes?: string[] } | null = null;
  try { res = await adapter.fillApplication(project); } catch (e) { res = { ok: false, message: `threw ${String(e).slice(0, 200)}` }; }
  await page.waitForTimeout(300);
  const where = page.url();
  const stReplay = await page.evaluate(() => JSON.parse(sessionStorage.getItem("S") || "{}") as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
  await ctx.close().catch(() => null);
  const filings = posts.filter((p) => /CapConfirm.*submit=1/i.test(p)).length;
  check("replay: 0 Enter presses, 0 filing requests", stReplay.enters === 0 && filings === 0, `enters=${String(stReplay.enters)} filings=${filings}`);
  check("MUST-PASS replay: Find Address by label → the job's row picked → the parcel present when the walk moved on → Autofill → review reached, in order",
    stReplay.finds === 1 && stReplay.rowPicks === 1 && stReplay.pickedParcel === "R1234567890" && stReplay.autofills === 1 && stReplay.parcelAtContinue === "R1234567890" && /CapConfirm/i.test(where) && res?.ok === true,
    `finds=${String(stReplay.finds)} rowPicks=${String(stReplay.rowPicks)} picked=${String(stReplay.pickedParcel)} autofills=${String(stReplay.autofills)} parcelAtContinue=${String(stReplay.parcelAtContinue)} at=${where} ok=${String(res?.ok)} msg=${String(res?.message).slice(0, 300)}`);

  // REPLAY WHERE THE LOOKUP FINDS NOTHING: the nomatch recipe (Find Address with populates "Parcel
  // Number:", Autofill) for a street number the page does not know. The press lands, the parcel stays
  // blank, and the step must FAIL NAMED on the field — never a quiet advance to the portal's bounce.
  {
    const recipe2 = {
      ...recipe, id: "aca-step1-nomatch",
      steps: [...nomatchSteps.filter((s) => !s.isFinalSubmit), { action: "stopForReview" } as RecipeStep],
    } as unknown as PortalRecipe;
    const ctx2 = await browser.newContext();
    ctx2.setDefaultTimeout(8000);
    await ctx2.addCookies([{ name: "v", value: "nomatch", url: base }]);
    await ctx2.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page2 = await ctx2.newPage();
    posts.length = 0;
    const adapter2 = new RecipeAdapter(recipe2, { streetNumber: "34", streetNameCore: "Broadway", homeownerName: "Other Owner", moduleCount: "16", city: "Meridian", zip: "83642" }, {}, {});
    (adapter2 as unknown as { page: unknown }).page = page2;
    let res2: { ok: boolean; message: string } | null = null;
    try { res2 = await adapter2.fillApplication(project); } catch (e) { res2 = { ok: false, message: `threw ${String(e).slice(0, 200)}` }; }
    const st2 = await page2.evaluate(() => JSON.parse(sessionStorage.getItem("S") || "{}") as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
    const where2 = page2.url();
    await ctx2.close().catch(() => null);
    const filings2 = posts.filter((p) => /CapConfirm.*submit=1/i.test(p)).length;
    check("MUST-PASS replay (no match): the press landed, the parcel stayed blank, and the run FAILED NAMED on \"Parcel Number\" — Continue never pressed, 0 filing requests",
      Number(st2.finds) >= 1 && res2?.ok === false && /did not populate "Parcel Number"/.test(String(res2?.message)) && Number(st2.continues ?? 0) === 0 && /CapEdit/.test(where2) && filings2 === 0 && Number(st2.enters ?? 0) === 0,
      `finds=${String(st2.finds)} ok=${String(res2?.ok)} continues=${String(st2.continues)} at=${where2} msg=${String(res2?.message).slice(0, 300)}`);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} accela-step1-lookups check(s) FAILED.`); process.exit(1); }
console.log("\nAll accela-step1-lookups checks passed (real Chromium).");
process.exit(0);
