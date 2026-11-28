// RAPID SHUTDOWN FROM THE MAKER'S OWN SPEC SHEET (#220; owner card 2026-11-13).
//
// city.elec.rapid-shutdown-edition-evidence fired on 22 of 26 real jobs because no plan set says the
// equipment is LISTED for 690.12(B)(2), while the microinverter maker's own datasheet does. Keelix
// finds that sheet once per make + model, keeps it, and attaches a copy to the job's package; the
// reviewer rule is unchanged and clears because the package now carries the maker's words.
//
// Pinned here:
//   A. the maker's own domain (never a distributor), the model named on the sheet, the sheet's words
//      read by the reviewer's own predicate;
//   B. the lookup: only URLs the search RETURNED, only real PDFs on the maker's site (a redirect off
//      it refused), a sheet that does not say it is kept as no_listing and never attached;
//   C. a project: attached as an inverter_spec document once, the rule's listed-equipment gap
//      clears, nothing attached where the package already says it or the job has no micro.
//
// Every fixture is SYNTHETIC; no network (fetch and the lookup are fakes), no model.
//
// Run: npx tsx backend/test/makerSpecSheet.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { CodeEdition, JurisdictionCodeProfile, WebLookupResult } from "../../shared/src/types";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "maker-spec-sheet-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");

const { openDatabase } = await import("../src/db");
const sheets = await import("../src/makerSpecSheets");
const repo = await import("../src/repository");
const { buildCodeContext } = await import("../src/codeProfiles");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

async function pdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 10, font }));
  return doc.save();
}
const MAKER = "Testphase Energy";
const MODEL = "TQ8M-72-2-US";
const LISTED_SHEET = await pdf([
  "TQ8 Series Microinverters",
  "Models: TQ8M-72-2-US, TQ8A-72-2-US",
  "UL Listed as PV Rapid Shutdown Equipment and conforms with NEC 690.12.",
  "Peak output power 330 VA",
]);
const UNLISTED_SHEET = await pdf(["TQ8 Series Microinverters", "Models: TQ8M-72-2-US", "Peak output power 330 VA"]);
const OTHER_MODEL_SHEET = await pdf(["TQ7 Series Microinverters", "Models: TQ7PLUS-72-2-US", "UL Listed as PV Rapid Shutdown Equipment."]);

type Served = Record<string, { bytes?: Uint8Array; finalUrl?: string; status?: number }>;
const fetcher = (served: Served) => (async (url: string) => {
  const hit = served[url];
  if (!hit) return { ok: false, status: 404, contentType: "", via: "http", reason: "HTTP 404", finalUrl: url };
  return { ok: true, status: 200, contentType: "application/pdf", bytes: hit.bytes, via: "http", reason: "ok", finalUrl: hit.finalUrl ?? url };
}) as never;
const lookup = (text: string, resultUrls: string[], grounded = 1) => ({
  calls: 0,
  async webLookup(input: { user: string }): Promise<WebLookupResult> {
    this.calls++;
    assert.ok(!/owner|street|address/i.test(input.user), "only make + model go to the lookup");
    return { text, groundedSearches: grounded, stopReason: "end_turn", resultUrls, pagesRead: 0 };
  },
});
const eq = (make = MAKER, model = MODEL) => sheets.rsdEquipmentForJob({ pvMicroMake: make, pvMicroModel: model })!;

console.log("A. Whose sheet, which model, what it says");

await check("the maker's own registrable domain fits; a brand in a distributor's subdomain does not", () => {
  assert.equal(sheets.makerKey("Testphase Energy Inc."), "testphase");
  assert.equal(sheets.makerHostFits(MAKER, "https://testphase.com/datasheet.pdf"), true);
  assert.equal(sheets.makerHostFits(MAKER, "https://www.testphase.com/a/b.pdf"), true);
  assert.equal(sheets.makerHostFits(MAKER, "https://usa.testphase.co.uk/x.pdf"), true);
  assert.equal(sheets.makerHostFits(MAKER, "https://testphase.solarshop.com/x.pdf"), false);
  assert.equal(sheets.makerHostFits(MAKER, "https://testphasestore.com/x.pdf"), false);
  assert.equal(sheets.makerHostFits(MAKER, "not a url"), false);
});
await check("the sheet must name the model: exact, or its family token at a boundary — never a longer sibling", () => {
  assert.equal(sheets.modelOnSheet("TQ8M-72-2-US", "Models: TQ8M-72-2-US"), true);
  assert.equal(sheets.modelOnSheet("TQ8M-72-M-US", "TQ8M Series: TQ8M-72-2-US"), true);
  assert.equal(sheets.modelOnSheet("TQ8M", "Models: TQ8MC-72-2-US"), false);
  assert.equal(sheets.modelOnSheet("TQ8", "TQ8M-72-2-US"), false);
});
await check("the sheet's words are read by the reviewer's own predicate", () => {
  assert.match(sheets.sheetRsdQuote("UL Listed as PV Rapid Shutdown Equipment"), /Listed as PV Rapid Shutdown/);
  assert.equal(sheets.sheetRsdQuote("Rapid shutdown compliant. Not listed."), "");
});
await check("a job's micro is the equipment; no micro, or a person's 'not the micro', is none", () => {
  assert.equal(eq().modelKey, "TQ8M-72-2-US");
  assert.equal(sheets.rsdEquipmentForJob({ invMake: "Stringco", invModel: "SC7600" }), null);
});

console.log("B. The lookup");

await check("MUST-PASS: a returned maker PDF that names the model and says listed → found, kept with source, date, sha256", async () => {
  const url = "https://testphase.com/docs/tq8-datasheet.pdf";
  const llm = lookup(JSON.stringify({ urls: [url] }), [url]);
  const row = await sheets.runMakerSpecSheetLookup(db, llm, eq(), { fetchDocument: fetcher({ [url]: { bytes: LISTED_SHEET } }) });
  assert.equal(row.status, "found", row.detail);
  assert.equal(row.sourceUrl, url);
  assert.equal(row.host, "testphase.com");
  assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.match(row.rsdQuote, /Listed as PV Rapid Shutdown/);
  assert.ok(fs.existsSync(row.storedPath));
  assert.equal(sheets.makerSpecSheetFor(db, eq())?.status, "found");
});
await check("MUST-EXCLUDE: a URL the model wrote that the search never returned is not fetched", async () => {
  const llm = lookup(JSON.stringify({ urls: ["https://testphase.com/remembered.pdf"] }), ["https://testphase.com/support"]);
  let fetched = 0;
  const row = await sheets.runMakerSpecSheetLookup(db, llm, eq(MAKER, "TQ9-1"), { fetchDocument: (async () => { fetched++; return { ok: false }; }) as never });
  assert.equal(row.status, "not_found");
  assert.equal(fetched, 0);
});
await check("MUST-EXCLUDE: a distributor's copy is never used, even when it is the only result", async () => {
  const url = "https://solarshop.example.com/testphase-tq8.pdf";
  const row = await sheets.runMakerSpecSheetLookup(db, lookup(JSON.stringify({ urls: [url] }), [url]), eq(MAKER, "TQ9-2"), { fetchDocument: fetcher({ [url]: { bytes: LISTED_SHEET } }) });
  assert.equal(row.status, "not_found");
});
await check("MUST-EXCLUDE: a redirect off the maker's site is refused", async () => {
  const url = "https://testphase.com/go/tq8.pdf";
  const row = await sheets.runMakerSpecSheetLookup(db, lookup(JSON.stringify({ urls: [url] }), [url]), eq(MAKER, "TQ9-3"),
    { fetchDocument: fetcher({ [url]: { bytes: LISTED_SHEET, finalUrl: "https://mirror.example.net/tq8.pdf" } }) });
  assert.equal(row.status, "not_found");
  assert.match(row.detail, /redirected off/);
});
await check("MUST-EXCLUDE: a sheet for another model is not this model's sheet", async () => {
  const url = "https://testphase.com/tq7.pdf";
  const row = await sheets.runMakerSpecSheetLookup(db, lookup(JSON.stringify({ urls: [url] }), [url]), eq(MAKER, "TQ8A-72-2-US"), { fetchDocument: fetcher({ [url]: { bytes: OTHER_MODEL_SHEET } }) });
  assert.equal(row.status, "not_found");
  assert.match(row.detail, /does not name/);
});
await check("a sheet that does not say it is kept as no_listing (never attached)", async () => {
  const url = "https://testphase.com/tq8-plain.pdf";
  const row = await sheets.runMakerSpecSheetLookup(db, lookup(JSON.stringify({ urls: [url] }), [url]), eq(MAKER, "TQ8M-60-2-US"), { fetchDocument: fetcher({ [url]: { bytes: await pdf(["Models: TQ8M-60-2-US", "Peak output power 300 VA"]) } }) });
  assert.equal(row.status, "no_listing");
});

// AN ANSWER CUT OFF BEFORE ITS JSON IS NOT "NO LINK" (audit 2026-11-28). KILL (verified red by hand):
// drop the second ask → (c1) fails; put the token budget back to 400 → (c1) fails on the budget;
// drop the reason from the detail → (c2), (c4), (c5) fail; ask again on any cut-off → (c3) fails.
const answers = (seq: Array<Partial<WebLookupResult>>) => ({
  calls: 0,
  budgets: [] as number[],
  async webLookup(input: { user: string; maxTokens?: number }): Promise<WebLookupResult> {
    this.budgets.push(Number(input.maxTokens ?? 0));
    const a = seq[Math.min(this.calls++, seq.length - 1)];
    return { text: "", groundedSearches: 1, stopReason: "end_turn", resultUrls: [], pagesRead: 0, ...a };
  },
});
await check("(c1) MUST-PASS: an answer cut off at the token limit is asked once more, and the sheet is found", async () => {
  const url = "https://testphase.com/tq10.pdf";
  const llm = answers([{ stopReason: "max_tokens", resultUrls: ["https://testphase.com/support"] }, { text: JSON.stringify({ urls: [url] }), resultUrls: [url] }]);
  const row = await sheets.runMakerSpecSheetLookup(db, llm, eq(MAKER, "TQ10-1"), { fetchDocument: fetcher({ [url]: { bytes: await pdf(["Models: TQ10-1", "UL Listed as PV Rapid Shutdown Equipment."]) } }) });
  assert.equal(row.status, "found", row.detail);
  assert.equal(llm.calls, 2);
  assert.ok(llm.budgets.every((b) => b >= 2000), `the lookup's token budget covers a search turn: ${llm.budgets.join(",")}`);
});
await check("(c2) cut off both times: asked twice, never a third time, and the row says that is why", async () => {
  const llm = answers([{ stopReason: "max_tokens", resultUrls: ["https://testphase.com/support"] }]);
  const row = await sheets.runMakerSpecSheetLookup(db, llm, eq(MAKER, "TQ10-2"), { fetchDocument: (async () => { throw new Error("must not fetch"); }) as never });
  assert.equal(row.status, "not_found");
  assert.equal(llm.calls, 2);
  assert.match(row.detail, /cut off at the token limit both times/);
});
await check("(c3) MUST-EXCLUDE: a cut-off answer that already named its links is not asked again", async () => {
  const url = "https://testphase.com/tq10-3.pdf";
  const llm = answers([{ stopReason: "max_tokens", text: JSON.stringify({ urls: [url] }), resultUrls: [url] }]);
  const row = await sheets.runMakerSpecSheetLookup(db, llm, eq(MAKER, "TQ10-3"), { fetchDocument: fetcher({ [url]: { bytes: await pdf(["Models: TQ10-3", "UL Listed as PV Rapid Shutdown Equipment."]) } }) });
  assert.equal(row.status, "found", row.detail);
  assert.equal(llm.calls, 1);
});
await check("(c4) a complete answer with no link is asked once, and the row says the answer named none", async () => {
  const llm = answers([{ text: JSON.stringify({ urls: [] }), resultUrls: ["https://testphase.com/support"] }]);
  const row = await sheets.runMakerSpecSheetLookup(db, llm, eq(MAKER, "TQ10-4"), { fetchDocument: (async () => { throw new Error("must not fetch"); }) as never });
  assert.equal(llm.calls, 1);
  assert.match(row.detail, /named no link and the search returned no PDF/);
});
await check("(c5) a sheet found only on someone else's site: the row says the host did not fit", async () => {
  const url = "https://zzfixture-distributor.com/tq10-5.pdf";
  const llm = answers([{ text: JSON.stringify({ urls: [url] }), resultUrls: [url] }]);
  const row = await sheets.runMakerSpecSheetLookup(db, llm, eq(MAKER, "TQ10-5"), { fetchDocument: (async () => { throw new Error("must not fetch"); }) as never });
  assert.equal(row.status, "not_found");
  assert.match(row.detail, /link\(s\) were found, none on .* own site/);
});
await check("a search that returned nothing (model memory) stores not_found and fetches nothing", async () => {
  const row = await sheets.runMakerSpecSheetLookup(db, lookup(JSON.stringify({ urls: ["https://testphase.com/x.pdf"] }), [], 0), eq(MAKER, "TQ9-4"), { fetchDocument: (async () => { throw new Error("must not fetch"); }) as never });
  assert.equal(row.status, "not_found");
});

console.log("C. A project");

const STATE = "ZZ";
const AHJ = "City of Testville";
const PLAN = "E-2 SOLAR PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN. TURN RAPID SHUTDOWN SWITCH TO THE OFF POSITION. RAPID SHUTDOWN INITIATION SWITCH OUTSIDE AT THE SERVICE ENTRANCE, READILY ACCESSIBLE.";
const profile: JurisdictionCodeProfile = {
  key: `${STATE.toLowerCase()}|${AHJ.toLowerCase()}|unknown`, state: STATE, ahj: AHJ, confidence: "verified",
  adoptedCodes: [{ code: "NEC", edition: "2023", title: "National Electrical Code" } as CodeEdition], amendments: [],
  designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "", researchedAt: "2026-09-01T00:00:00.000Z",
} as JurisdictionCodeProfile;
const listedGap = (projectId: string) => {
  const project = repo.getProjectDetail(db, projectId).project;
  const f = evaluateDesignCodeFindings(project, null, buildCodeContext(STATE, AHJ, profile), [], repo.designDocumentTexts(db, projectId))
    .find((x) => x.id === "city.elec.rapid-shutdown-edition-evidence");
  return !!f && /Listed PV hazard control system or listed rapid shutdown equipment/.test(f.message);
};
const newJob = (extra: Record<string, unknown> = {}) => {
  const p = repo.createProject(db, { owner: "Synthetic Owner", street: "1 Test Rd", city: "Testville", state: STATE, ahj: AHJ, utility: "Test Power", dcKw: "6", acKw: "5", mounting: "Roof Mount", ...extra } as never).project;
  db.run("UPDATE projects SET parser_json = json_set(parser_json, '$.pvMicroMake', ?, '$.pvMicroModel', ?, '$.planSetExtractedText', ?) WHERE id = ?", [MAKER, MODEL, PLAN, p.id]);
  return p.id;
};

await check("(fixture) the plan set alone leaves the listed-equipment gap", () => {
  const id = newJob();
  assert.equal(repo.getProjectDetail(db, id).project.parserSnapshot?.pvMicroModel, MODEL);
  assert.equal(listedGap(id), true);
});
await check("MUST-PASS: the kept sheet is attached once as the job's inverter_spec, and the rule's gap clears", async () => {
  const id = newJob();
  const row = sheets.makerSpecSheetFor(db, eq())!;
  const first = await sheets.attachMakerSpecSheet(db, id, row);
  assert.equal(first.attached, true, first.reason);
  const docs = db.query<{ doc_type: string; source: string; original_filename: string }>("SELECT doc_type, source, original_filename FROM project_documents WHERE project_id = ?", [id]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].doc_type, "inverter_spec");
  assert.equal(docs[0].source, sheets.MAKER_SPEC_SHEET_SOURCE);
  assert.match(docs[0].original_filename, /from testphase\.com/);
  assert.equal(listedGap(id), false, "the maker's words in the package answer 690.12(B)(2)");
  const again = await sheets.attachMakerSpecSheet(db, id, row);
  assert.equal(again.attached, false);
  const audit = db.query<{ action: string }>("SELECT action FROM audit_logs WHERE project_id = ? AND action = 'documents.maker_spec_sheet_attached'", [id]);
  assert.equal(audit.length, 1);
});
await check("the job flow: kept sheet → attached without a lookup", async () => {
  const id = newJob();
  const llm = lookup("{}", []);
  const res = await sheets.runMakerSpecSheetJob(db, { make: MAKER, model: MODEL }, id, llm);
  assert.equal(res.attached, true, String(res.attachReason));
  assert.equal(llm.calls, 0, "a kept sheet is not looked up again");
});
await check("MUST-EXCLUDE: a no_listing sheet is never attached", async () => {
  const id = newJob();
  const res = await sheets.attachMakerSpecSheet(db, id, sheets.makerSpecSheetFor(db, eq(MAKER, "TQ8M-60-2-US"))!);
  assert.equal(res.attached, false);
  assert.equal(db.query("SELECT id FROM project_documents WHERE project_id = ?", [id]).length, 0);
});
await check("MUST-EXCLUDE: a package that already says it gets nothing", async () => {
  const id = newJob();
  db.run("UPDATE projects SET parser_json = json_set(parser_json, '$.planSetExtractedText', ?) WHERE id = ?", [`${PLAN} MICROINVERTERS ARE LISTED RAPID SHUTDOWN EQUIPMENT.`, id]);
  assert.equal(listedGap(id), false);
  const res = await sheets.attachMakerSpecSheet(db, id, sheets.makerSpecSheetFor(db, eq())!);
  assert.equal(res.attached, false);
});
await check("MUST-EXCLUDE: a kept file that no longer matches its sha256 is not attached", async () => {
  const id = newJob();
  const row = { ...sheets.makerSpecSheetFor(db, eq())!, sha256: "0".repeat(64) };
  assert.equal((await sheets.attachMakerSpecSheet(db, id, row)).attached, false);
});
await check("the QC trigger: attaches a kept sheet, skips a job with no micro, honours MAKER_SPEC_SHEETS=off", async () => {
  const id = newJob();
  assert.equal(await sheets.ensureMakerSpecSheetForProject(db, id), "attached");
  const none = repo.createProject(db, { owner: "Synthetic Owner", street: "2 Test Rd", city: "Testville", state: STATE, ahj: AHJ, utility: "Test Power", dcKw: "6", acKw: "5" } as never).project.id;
  assert.equal(await sheets.ensureMakerSpecSheetForProject(db, none), "skipped");
  process.env.MAKER_SPEC_SHEETS = "off";
  assert.equal(await sheets.ensureMakerSpecSheetForProject(db, newJob()), "skipped");
  delete process.env.MAKER_SPEC_SHEETS;
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nmaker spec sheet: all checks passed");
