// AN AHJ'S BLANK FORM AS AN OFFICIAL DOCUMENT (official-source auto-verify, slice 5; CLAUDE.md rule 3;
// owner 2026-11-13: "Verified from <host>, <date>", and a government page vouches for a .org site).
//
// What these checks pin:
//   A. The grade from evidence alone (officialFormDocumentFrom): an official host, the stored bytes are
//      the bytes stamped at download (sourceHash), a retrieval date. Each missing piece → no grade.
//   B. Stored rows, graded at read time on the fill result and on the template listing: a government
//      host passes; a hand upload, a non-official host, a tampered blob, a missing date do not; a .org
//      host a government page vouched for in the authority's name passes; the county's blank filled for a
//      city job is graded against the county's own hosts.
//   C. The MAPPING stays a person's: map.verified is never set, widened or implied; the review gate
//      (unverifiedFormMappings) still lists an official blank with an unverified map, and only a person's
//      verify clears it; the words say "mapping not checked by a person" until then.
//   D. Not a door, not a send: the module reads nothing from the filing-door host lists, writes nothing.
//
// AHJs, hosts and bytes are invented; nothing is fetched; no model.
//
// Kill tests (each mutation → the checks that fail), run by hand on this branch:
//   K1  officialFormDocumentFrom: drop the host predicate                → A2, A5, B4, B7, B8.
//   K2  officialFormDocumentFrom: drop the hash comparison               → A3, B5.
//   K3  officialFormDocumentFrom: drop the retrieval-date check          → A4, B6.
//   K4  officialFormDocument: hosts = [] (no vouched / verified hosts)    → B7, B8.
//   K5  officialFormWords: no "mapping not checked" tail                  → A6, B1, B7.
//   K6  buildFilledFormsForProject: grade against the project's AHJ       → B8.
//   K7  storedTemplateFromRow: an official (.gov) blank's map counts verified → B1, C1, C2, C4.

import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "official-form-doc-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.DOCUMENT_FETCH_BROWSER = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const ofd = await import("../src/officialFormDocument");
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const review = await import("../src/approvalReviewItems");
const pp = await import("../src/permitProcess");
const repo = await import("../src/repository");
const { createClient } = await import("../src/clients");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

// A one-field AcroForm blank. `tag` makes each blank's bytes (and so its hash) its own.
async function blank(tag: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Solar permit application ${tag}`);
  const page = doc.addPage([612, 792]);
  doc.getForm().createTextField("Owner name").addToPage(page, { x: 72, y: 600, width: 300, height: 20 });
  return doc.save();
}
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const AT = "2026-11-12T18:00:00.000Z";
const MAP = { fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" };

function store(ahjName: string, sourceUrl: string, bytes: Uint8Array, formName = "Solar Permit Application"): string {
  return auto.storeAhjFormTemplate(db, {
    ahjName, state: "ZZ", formType: "electrical_application", filename: `${formName}.pdf`, bytes, retrievedAt: sourceUrl ? AT : undefined,
    map: { formName, sourceUrl, ...MAP },
  } as never);
}
const rowOf = (id: string) => db.get<{ field_map: string; retrieved_at: string; source_url: string }>("SELECT field_map, retrieved_at, source_url FROM ahj_form_templates WHERE id = ?", [id])!;
const mapOf = (id: string) => JSON.parse(rowOf(id).field_map) as { verified?: boolean; sourceHash?: string };

const client = createClient(db, { companyName: "Kestrel Test Solar", ccbLicenseNumber: "000111" });
const job = (ahj: string) => repo.createProject(db, {
  clientId: client.id, owner: `Owner ${ahj}`, street: "1 Test Rd", city: ahj, state: "ZZ", ahj, utility: "Larchmont Power",
  dcKw: "8", acKw: "7", permitPathOverride: "prescriptive",
} as never).project;
const fillFor = async (ahj: string) => (await forms.buildFilledFormsForProject(db, job(ahj))).forms.filter((f) => f.templateId);

// ── A. the grade from evidence ────────────────────────────────────────────────────────────────
const bytesA = await blank("A");
const good = { sourceUrl: "https://www.quillmerezz.gov/forms/solar.pdf", retrievedAt: AT, sourceHash: sha(bytesA), bytes: bytesA };
await check("(A1) a government host, the stamped bytes and a retrieval date: official, with the shared words", () => {
  const d = ofd.officialFormDocumentFrom(good, []);
  assert.deepEqual(d, { host: "www.quillmerezz.gov", sourceUrl: good.sourceUrl, fetchedAt: AT, words: "Verified from www.quillmerezz.gov, 2026-11-12" });
});
await check("(A2) a host that is not government and not the authority's own: no grade", () => {
  assert.equal(ofd.officialFormDocumentFrom({ ...good, sourceUrl: "https://www.formvaultzz.com/solar.pdf" }, []), null);
  assert.equal(ofd.officialFormDocumentFrom({ ...good, sourceUrl: "" }, []), null, "an upload has no source");
});
await check("(A3) bytes that are not the bytes stamped at download: no grade", () => {
  assert.equal(ofd.officialFormDocumentFrom({ ...good, sourceHash: sha(new Uint8Array([1, 2, 3])) }, []), null);
  assert.equal(ofd.officialFormDocumentFrom({ ...good, sourceHash: "" }, []), null, "no stamp at all");
  assert.equal(ofd.officialFormDocumentFrom({ ...good, bytes: null }, []), null, "no stored blob");
});
await check("(A4) no retrieval date: no grade", () => {
  assert.equal(ofd.officialFormDocumentFrom({ ...good, retrievedAt: "" }, []), null);
  assert.equal(ofd.officialFormDocumentFrom({ ...good, retrievedAt: "last spring" }, []), null);
});
await check("(A5) a .org host passes only when it is in the authority's own host list", () => {
  const org = { ...good, sourceUrl: "https://docs.cityofwrenfieldzz.org/solar.pdf" };
  assert.equal(ofd.officialFormDocumentFrom(org, []), null);
  assert.equal(ofd.officialFormDocumentFrom(org, ["www.cityofwrenfieldzz.org"])?.host, "docs.cityofwrenfieldzz.org");
});
await check("(A6) the words say whose the mapping is, and nothing when the blank is not official", () => {
  const d = ofd.officialFormDocumentFrom(good, []);
  assert.equal(ofd.officialFormWords(d, "unchecked"), "Blank form: Verified from www.quillmerezz.gov, 2026-11-12; mapping not checked by a person");
  assert.equal(ofd.officialFormWords(d, "built_in"), "Blank form: Verified from www.quillmerezz.gov, 2026-11-12; mapping built in for this exact revision");
  assert.equal(ofd.officialFormWords(d, "person"), "Blank form: Verified from www.quillmerezz.gov, 2026-11-12");
  assert.equal(ofd.officialFormWords(null, "unchecked"), "");
  assert.doesNotMatch(ofd.officialFormWords(d, "unchecked"), /Verified by/);
});

// ── B. stored rows, on the fill result ────────────────────────────────────────────────────────
const govId = store("Quillmere", "https://www.quillmerezz.gov/forms/solar.pdf", await blank("Quillmere"));
await check("(B1) a stored blank from a government host is official on the fill result; the map stays unverified", async () => {
  const [f] = await fillFor("Quillmere");
  assert.equal(f?.templateId, govId, JSON.stringify(f));
  assert.equal(f.officialDocument?.host, "www.quillmerezz.gov");
  assert.equal(f.officialDocument?.fetchedAt, AT);
  assert.equal(f.officialDocumentWords, "Blank form: Verified from www.quillmerezz.gov, 2026-11-12; mapping not checked by a person");
  assert.equal(f.verified, false);
  assert.equal(mapOf(govId).verified, false);
});
await check("(B2) the same blank on the template listing's grade", () => {
  const row = db.get<{ ahj_name: string; state: string; source_url: string; retrieved_at: string; field_map: string; pdf_blob: Buffer }>("SELECT * FROM ahj_form_templates WHERE id = ?", [govId])!;
  const d = ofd.officialFormDocument(db, { state: row.state, ahj: row.ahj_name }, { sourceUrl: row.source_url, retrievedAt: row.retrieved_at, sourceHash: String(JSON.parse(row.field_map).sourceHash), bytes: new Uint8Array(row.pdf_blob) });
  assert.equal(d?.host, "www.quillmerezz.gov");
});
await check("(B3) a hand upload (no source link) stays as it is today", async () => {
  store("Ashgrove", "", await blank("Ashgrove"));
  const [f] = await fillFor("Ashgrove");
  assert.ok(f, "the upload fills");
  assert.equal(f.officialDocument, null);
  assert.equal(f.officialDocumentWords, "");
});
await check("(B4) a blank from a host that is not official stays as it is today", async () => {
  store("Birchfold", "https://www.formvaultzz.com/birchfold/solar.pdf", await blank("Birchfold"));
  const [f] = await fillFor("Birchfold");
  assert.equal(f?.officialDocument, null);
});
await check("(B5) a stored blob that no longer hashes to its download stamp is not official", async () => {
  const id = store("Cobbleton", "https://www.cobbletonzz.gov/solar.pdf", await blank("Cobbleton"));
  db.run("UPDATE ahj_form_templates SET pdf_blob = ? WHERE id = ?", [Buffer.from(await blank("Cobbleton-other")), id]);
  const [f] = await fillFor("Cobbleton");
  assert.equal(f?.templateId, id);
  assert.equal(f.officialDocument, null);
});
await check("(B6) a row with no retrieval date is not official", async () => {
  const id = store("Dunmere", "https://www.dunmerezz.gov/solar.pdf", await blank("Dunmere"));
  db.run("UPDATE ahj_form_templates SET retrieved_at = '' WHERE id = ?", [id]);
  const [f] = await fillFor("Dunmere");
  assert.equal(f?.officialDocument, null);
});
await check("(B7) a .org host a government page vouched for in the authority's name passes", async () => {
  const site = "www.cityofwrenfieldzz.org";
  pp.savePermitProcessLookup(db, {
    state: "ZZ", ahj: "Wrenfield", lookedUpAt: AT,
    issuingAgency: { value: "Wrenfield", sourceUrl: `https://${site}/building`, quote: "City of Wrenfield Building Division", origin: "lookup" },
    permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not read" },
    permits: [],
    siteVouches: [{ host: site, vouchedByUrl: "https://www.hollowcountyzz.gov/cities", linkText: "City of Wrenfield", fetchedAt: AT }],
  } as never);
  store("Wrenfield", `https://${site}/forms/solar.pdf`, await blank("Wrenfield"));
  const [f] = await fillFor("Wrenfield");
  assert.equal(f?.officialDocument?.host, site, JSON.stringify(f?.officialDocument));
  assert.match(String(f.officialDocumentWords), /^Blank form: Verified from www\.cityofwrenfieldzz\.org, 2026-11-12; mapping not checked by a person$/);
  // The same .org form for an authority with no vouch stays as it is today.
  store("Yarrowby", "https://www.cityofyarrowbyzz.org/forms/solar.pdf", await blank("Yarrowby"));
  const [y] = await fillFor("Yarrowby");
  assert.equal(y?.officialDocument, null);
});
await check("(B8) the grade is the ROW's authority's: the project's own hosts never make another authority's blank official", async () => {
  const hostsMod = await import("../src/officialAuthorityHosts");
  // Wrenfield's vouched .org is Wrenfield's own, never another AHJ's.
  assert.deepEqual(hostsMod.officialAuthorityHosts(db, "ZZ", "Yarrowby"), []);
  const wrenRow = db.get<{ field_map: string; pdf_blob: Buffer; retrieved_at: string; source_url: string }>("SELECT * FROM ahj_form_templates WHERE ahj_name = 'Wrenfield'")!;
  const ev = { sourceUrl: wrenRow.source_url, retrievedAt: wrenRow.retrieved_at, sourceHash: String(JSON.parse(wrenRow.field_map).sourceHash), bytes: new Uint8Array(wrenRow.pdf_blob) };
  assert.equal(ofd.officialFormDocument(db, { state: "ZZ", ahj: "Yarrowby" }, ev), null);
  assert.equal(ofd.officialFormDocument(db, { state: "ZZ", ahj: "Wrenfield" }, ev)?.host, "www.cityofwrenfieldzz.org");
  // The fill grades with the row's own name: pin the call site.
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ahjForms.ts"), "utf8");
  assert.match(src, /officialFormDocument\(db, \{ state: stored\.def\.state \|\| project\.state, ahj: stored\.authority \}/);
});

// ── C. the mapping stays a person's ───────────────────────────────────────────────────────────
await check("(C1) the review gate still lists an official blank whose map no person verified", () => {
  const listed = review.unverifiedFormMappings(db, job("Quillmere")).map((t) => t.templateId);
  assert.deepEqual(listed, [govId]);
});
await check("(C2) only a person's verify clears it, and then the words drop the mapping tail", async () => {
  assert.equal(forms.setStoredTemplateVerified(db, govId, true), true);
  assert.deepEqual(review.unverifiedFormMappings(db, job("Quillmere")), []);
  const [f] = await fillFor("Quillmere");
  assert.equal(f.verified, true);
  assert.equal(f.officialDocumentWords, "Blank form: Verified from www.quillmerezz.gov, 2026-11-12");
  forms.setStoredTemplateVerified(db, govId, false);
  assert.deepEqual(review.unverifiedFormMappings(db, job("Quillmere")).map((t) => t.templateId), [govId]);
});
await check("(C3) map.verified is unchanged by grading, in every case", async () => {
  const before = db.query<{ id: string; field_map: string; pdf_blob: Buffer; retrieved_at: string; source_url: string }>("SELECT id, field_map, pdf_blob, retrieved_at, source_url FROM ahj_form_templates ORDER BY id");
  for (const ahj of ["Quillmere", "Ashgrove", "Birchfold", "Cobbleton", "Dunmere", "Wrenfield", "Yarrowby"]) await fillFor(ahj);
  const after = db.query<{ id: string; field_map: string; pdf_blob: Buffer; retrieved_at: string; source_url: string }>("SELECT id, field_map, pdf_blob, retrieved_at, source_url FROM ahj_form_templates ORDER BY id");
  assert.deepEqual(after.map((r) => [r.id, r.field_map, sha(new Uint8Array(r.pdf_blob)), r.retrieved_at, r.source_url]),
    before.map((r) => [r.id, r.field_map, sha(new Uint8Array(r.pdf_blob)), r.retrieved_at, r.source_url]), "a read writes nothing");
  assert.ok(after.every((r) => JSON.parse(r.field_map).verified !== true), "no row's map became verified");
});
await check("(C4) the stored template the fill and the submit gate read keeps `verified` as the person's word alone", () => {
  for (const t of forms.loadStoredTemplates(db, "Quillmere", "ZZ")) {
    assert.equal(t.verified, false);
    assert.equal(t.def.unverifiedMap, true, "the fill still treats the map as unverified");
  }
});
await check("(C5) a different official blank never overwrites a person-verified template", async () => {
  forms.setStoredTemplateVerified(db, govId, true);
  const before = rowOf(govId);
  assert.throws(() => store("Quillmere", "https://www.quillmerezz.gov/forms/solar-2027.pdf", bytesA), /verified/i);
  assert.deepEqual(rowOf(govId), before);
  forms.setStoredTemplateVerified(db, govId, false);
});

// ── D. not a door, not a send ─────────────────────────────────────────────────────────────────
await check("(D1) the module reads no filing-door host list and writes nothing", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "officialFormDocument.ts"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(src, /personVerifiedAuthorityHosts|utilityPersonVerifiedHosts|filingDestination|\.run\(|INSERT|UPDATE/);
});

if (failures) { console.error(`\nofficialFormDocument: ${failures} FAILED`); process.exit(1); }
console.log("\nofficialFormDocument: all passed");
process.exit(0);
