// A REQUIRED UPLOAD SLOT A LEARN COULD NOT FILL BECOMES PART OF THE AHJ'S CHECKLIST (#140, owner).
//
// City of Star's iWorQ form (watched learn 2026-11-11) requires a "Bid" upload; the job held no bid,
// the portal said "The required uploads were not found" and kept Submit disabled. Reporting it on
// that run is not enough: the NEXT job at the same AHJ must be stopped at staging, naming the
// document, before the portal is touched — and a person sees it on the project.
//
// Through the REAL autoLearnPortal (only the browser and the LLM stubbed, learnTrustBlanks' pattern)
// on a FICTIONAL AHJ:
//   (1) a learn reporting missingRequiredDocs ["Bid", "Choose File"] writes ONE seeded line for
//       "Bid" into the AHJ's shared required-documents list — never the picker face;
//   (2) the next project at that AHJ: documentInventory reports "bid" missing and BLOCKING, on the
//       structural (building) track only; the staging wording is "attach it"; the submit gate the
//       person reads names it;
//   (3) attaching a bid clears it; the generated bid_sheet worksheet is a different slot;
//   (4) a person-verified AHJ row is NEVER changed (rule 3) — the learn's issues say so instead;
//   (5) the label filter alone: a rejected upload, a bare placeholder, a slot no vocabulary maps,
//       and a picker face write nothing.
//
// KILLS (each verified red with its fix removed — see the commit message):
//   K1 autoLearn: drop the learnPortalRequiredUploads hook        -> (1), (2) fail.
//   K2 requiredDocuments: drop portalRequiredUploadItems          -> (2), (3) fail.
//   K3 learnPortalRequiredUploads: drop the verified-row skip      -> (4) fails.
//
// Run: npx tsx backend/test/portalRequiredUpload.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("portal-required-upload");
const { db, repo } = fx;
const autoLearn = await import("../src/autoLearn");
const llmMod = await import("../src/llm");
const kb = await import("../src/knowledgeBase");
const reqDocs = await import("../src/requiredDocuments");
const docs = await import("../src/projectDocuments");
const { parsePortalRequiredUpload } = await import("../src/requirementSlots");

let nextLearn: Record<string, unknown> = {};
const failedLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => ({ ...failedLearn, ...nextLearn })) as never });
const verified = { accurate: true, overallConfidence: "high" as const, issues: [], notes: "", matches: [{ label: "Description of Work", expected: "PV", found: "PV", ok: true }] };
const base = llmMod.createLLMProvider(); // no API key -> the stub provider
autoLearn.setAutoLearnSeamsForTests({ llm: () => Object.assign(Object.create(base), {
  verifyPortalFill: async () => verified,
  verifyPortalFillVision: async () => verified,
  planPortalFields: async () => ({ fills: [], advanceIndex: null, navigateIndex: null, finalSubmitIndex: null, atReview: false, notes: "" }),
}) });

const STATE = "ID";
const AHJ = "City of Zzstar";
const VERIFIED_AHJ = "City of Zzverified";
const portalUrl = "https://zzstar.permits.example/new-permit/600";
const atAhj = (ahj: string) => ({ state: STATE, ahj, city: ahj.replace(/^City of /, "") });

/** A walk that reached review on the portal's one page and left the named required slots empty. */
const learnResult = (missingRequiredDocs: string[]) => ({
  ok: true, portalName: "Zzstar Permits", pageCount: 2, pauseReason: null, finalSubmitRecorded: true,
  reachedReview: true, filledSomething: true, message: "reached review",
  steps: [
    { action: "goto", value: portalUrl, note: "entry url" },
    { action: "fill", selector: { name: "f0" }, field: "homeownerName", note: "Owner" },
    { action: "stopForReview", selector: {} },
    { action: "click", selector: { text: "Submit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked)" },
  ],
  reviewScreen: { fields: [{ label: "Owner", value: "x" }], bodyTextSnippet: "Review your application before submitting." },
  reviewScreenshotBase64: "iVBORw0KGgo=",
  requiredFieldMisses: [], missingRequiredDocs, validationBlocks: [], equipmentNotHeld: [],
  pageExitReads: { read: [2], unread: [] },
});
const ahjRow = (ahj: string) => kb.findKnowledgeForLearn(db, { state: STATE, ahj }).ahj;
const portalLines = (ahj: string) => (ahjRow(ahj)?.requiredDocuments ?? []).filter((l) => parsePortalRequiredUpload(l));

await check("(1) a learn that left \"Bid\" empty writes ONE seeded line into the AHJ's list — never the picker face", async () => {
  const projectId = fx.newProject(atAhj(AHJ));
  nextLearn = learnResult(["Bid", "Choose File"]);
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl, createdBy: "operator", permitType: "structural" });
  assert.match((result.verification?.issues ?? []).join(" | "), /Required document\(s\) not attached: Bid, Choose File/, "the learn still reports both on its own run");
  const lines = portalLines(AHJ);
  assert.deepEqual(lines, ["Required upload on the permit portal [structural]: Bid"], `the AHJ row's portal lines: ${JSON.stringify(ahjRow(AHJ)?.requiredDocuments)}`);
  const row = ahjRow(AHJ)!;
  assert.equal(kb.isVerifiedKnowledge(row), false, "a learned line never verifies the row");
  assert.notEqual(row.confidence, "mixed", "a portal-learned line never raises the row's confidence");
  assert.ok(row.sources.some((s) => /Required upload slot met on the permit portal/.test(s.label)), `the line's source is not recorded: ${JSON.stringify(row.sources)}`);
  assert.equal(fx.audits("portal.required_upload_learned").length, 1, "the write is audited once");
});

await check("(2) the NEXT job at that AHJ is blocked at staging naming \"Bid\" — structural track only — and the gate says so", async () => {
  const projectId = fx.newProject(atAhj(AHJ));
  const project = repo.getProjectDetail(db, projectId).project;
  const inv = reqDocs.documentInventory(db, project);
  const bid = inv.missingBlocking.find((d) => d.docType === "bid");
  assert.ok(bid, `no blocking bid row: ${JSON.stringify(inv.missingBlocking.map((d) => d.docType))}`);
  assert.equal(bid!.label, "Bid");
  assert.equal(bid!.lane, "permit");
  assert.equal(bid!.discipline, "structural");
  assert.match(reqDocs.owedDocumentAction(bid!), /^attach it/);
  assert.ok(repo.stagingMissingDocuments(inv, "building").some((d) => d.docType === "bid"), "the building track must be stopped");
  assert.ok(!repo.stagingMissingDocuments(inv, "electrical").some((d) => d.docType === "bid"), "an electrical permit is a different filing");
  assert.ok(!repo.stagingMissingDocuments(inv, "nem").some((d) => d.docType === "bid"), "the utility filing never owes the AHJ's bid");
  const owed = reqDocs.owedMissingDocuments(db, project, inv).owed;
  assert.ok(owed.some((d) => d.docType === "bid"), "the submit gate's owed list carries it");
  const gate = JSON.stringify(repo.getSubmitGateReport(db, projectId));
  assert.match(gate, /Bid — attach it/, "the gate the person reads names the bid and what to do");
  // Stage itself refuses, naming it, before any portal run exists.
  await assert.rejects(repo.prepareSubmission(db, projectId, "building" as never), /staging blocked.*Bid \(attach it/i);
  assert.ok(fx.latestRun(projectId) == null, `a portal run was started for a job staging refused: ${JSON.stringify(fx.latestRun(projectId))?.slice(0, 200)}`);
});

await check("(3) attaching a bid clears the row; the generated bid_sheet worksheet is not the bid", async () => {
  const projectId = fx.newProject(atAhj(AHJ));
  const project = repo.getProjectDetail(db, projectId).project;
  const row = reqDocs.documentInventory(db, project).presence.find((d) => d.docType === "bid");
  assert.ok(row && !(row.altDocTypes ?? []).includes("bid_sheet"), `the bid row must not accept the worksheet: ${JSON.stringify(row)}`);
  docs.saveProjectDocument(db, projectId, { docType: "bid", filename: "zz-bid.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% zz bid\n", "utf8"), source: "upload" });
  const after = reqDocs.documentInventory(db, repo.getProjectDetail(db, projectId).project);
  assert.ok(!after.missingBlocking.some((d) => d.docType === "bid"), "an attached bid still reads missing");
  assert.ok(after.presence.find((d) => d.docType === "bid")?.present, "the bid row reads present");
});

await check("(4) a person-verified AHJ row is never changed (rule 3); the learn says so instead", async () => {
  kb.saveVerifiedAhjProfile(db, { state: STATE, ahj: VERIFIED_AHJ, portalUrl, requiredDocuments: ["Plan set"], verifiedBy: "Row Verifier" });
  const before = JSON.stringify(ahjRow(VERIFIED_AHJ)?.requiredDocuments);
  const projectId = fx.newProject(atAhj(VERIFIED_AHJ));
  nextLearn = learnResult(["Bid"]);
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl, createdBy: "operator", permitType: "structural" });
  assert.equal(JSON.stringify(ahjRow(VERIFIED_AHJ)?.requiredDocuments), before, "the verified row's list changed");
  assert.match((result.verification?.issues ?? []).join(" | "), /person-verified, so it was not changed/);
  const inv = reqDocs.documentInventory(db, repo.getProjectDetail(db, fx.newProject(atAhj(VERIFIED_AHJ))).project);
  assert.ok(!inv.missingBlocking.some((d) => d.docType === "bid"), "nothing was learned onto the verified AHJ");
});

await check("(5) the label filter: a rejected upload, a placeholder, an unmapped slot and a picker face write nothing", () => {
  const projectId = fx.newProject(atAhj("City of Zzempty"));
  const project = repo.getProjectDetail(db, projectId).project;
  const r = kb.learnPortalRequiredUploads(db, project, [
    "Choose File", "Required document", "Proof of Workers Comp Exemption",
    "Bid (portal rejected the upload: File size exceeds the 5.00 MB limit)",
    "Attachments were uploaded but the portal's Save did not confirm them — re-attach and click Save by hand before submitting.",
  ], "building");
  assert.deepEqual(r, { skipped: "nothing" });
  assert.equal(kb.portalRequiredUploadLabel("Bid (on the review page — attach it by hand; automation clicks no upload widget there)"), "Bid");
  assert.equal(kb.portalRequiredUploadLabel("Plans *"), "Plans");
});

finish("portal required upload");
