// ISSUE #664 — a utility whose interconnection / net-metering application is filed INSIDE the city's
// permit application (one application in the city's permit system carries the building permit and
// the net-metering paperwork). Universal: a method on the utility filing row (data), never code keyed
// to a utility, city or state. Invented utility and city names throughout; no network.
//
// Pins:
//   (a) the lookup: a cited page that says "apply through the city's building permit portal" →
//       method with_ahj_permit, NO URL kept (the permit portal's URL is dropped evidence — rule 5);
//       a page that only says a permit is ALSO required is not that method; a page naming the
//       utility's own portal is unchanged;
//   (b) SEEDED with-permit row (a proposal, rule 3): the NEM card stays "not yet identified" /
//       "filing location unverified" with its human step, does not follow the permit, Stage is not
//       held on it, nothing joins the permit checklist;
//   (c) VERIFIED by a named person: no portal (no URL, no recipe), channel kind with_permit, Stage
//       refused on the NEM track (route sentence + job 409), autopilot stages only the permit, the
//       utility's application row joins the PERMIT checklist (blocking when the record lists its
//       documents) and travels in the permit packet — never the bill;
//   (d) status follows the permit: submitted → submitted; permit issued → "approved with the permit —
//       meter set pending" with the meter-set call as a person's step, and the NEM track NOT done;
//   (e) the verify door: a named person; a stated with-permit fact cites its page; a lookup never
//       overwrites the verified row; the schema refuses a URL in the statement.
//
// KILL TESTS (each run red by hand before the fix):
//   K1 parseUtilityFilingAnswer ignores `method`                         → (a) fails.
//   K2 utilityTrackPresentation reads a SEEDED with-permit row as verified → (b) fails.
//   K3 getSubmittalTracks without the follow-the-permit status          → (d) fails.
//
// Run: npx tsx backend/test/nemFiledWithPermit.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("nem-filed-with-permit");
const { db, repo } = fx;
const ufl = await import("../src/utilityFilingLookup");
const tracks = await import("../src/submittalTracks");
const autopilot = await import("../src/autopilot");
const reqDocs = await import("../src/requiredDocuments");
const subDocs = await import("../src/submissionDocuments");
const docs = await import("../src/projectDocuments");
const nextStep = await import("../src/nextStep");
const { utilityFilingVerifySchema } = await import("../src/validation");
const { hostFitsTrackAndEntity } = await import("../src/portalChannel");

const STATE = "UT";
const CITY = "Maplecrest";
const AHJ = "City of Maplecrest";
const UTILITY = "Maplecrest City Light & Power"; // invented
const PAGE = "https://www.maplecrest.example.gov/light-power/solar";
const PERMIT_PORTAL = "https://maplecrest.cityinspect.example.com/apply";
const QUOTE = "Apply for net metering through the city's building permit portal; the net metering agreement is part of the permit application.";

const project = (id: string) => repo.getProjectDetail(db, id).project;
const newJob = () => fx.newProject({ state: STATE, city: CITY, ahj: AHJ, utility: UTILITY });
const nemCard = (id: string) => tracks.getSubmittalTracks(db, project(id)).find((t) => t.type === "nem")!;
const permitCard = (id: string) => tracks.getSubmittalTracks(db, project(id)).find((t) => t.type !== "nem")!;
const permitTrack = (id: string) => tracks.requiredTracks(project(id)).find((t) => t !== "nem")!;

// ── (a) the lookup's door ─────────────────────────────────────────────────────────────────
await check("(a) a cited page saying the application goes through the city's permit portal → with_ahj_permit, no URL kept", () => {
  const answer = JSON.stringify({
    filing: { value: { name: "City building permit application", url: PERMIT_PORTAL, method: "with_ahj_permit", documents: ["Net metering agreement signed by the property owner", "One-line diagram on our form"] }, sourceUrl: PAGE, quote: QUOTE },
    program: { value: "net_metering", programName: "Net Metering", sourceUrl: PAGE, quote: QUOTE },
  });
  const parsed = ufl.parseUtilityFilingAnswer(answer, [PAGE, PERMIT_PORTAL]);
  assert.equal(parsed.filing.value?.method, "with_ahj_permit");
  assert.equal(parsed.filing.value?.url, null, "a with-permit filing never keeps a URL (rule 5)");
  assert.deepEqual(parsed.filing.droppedUrls, [PERMIT_PORTAL], "the permit portal is kept only as evidence");
  assert.equal(parsed.filing.value?.documents?.length, 2);
  assert.ok(parsed.dropped.some((d) => /hard rule 5/.test(d)));
  // Dropped whatever the host: even one the NEM predicate would not refuse (an unknown vendor here).
  assert.equal(hostFitsTrackAndEntity("nem", null, PERMIT_PORTAL, "research").fits, true);
});
await check("(a) a page that only says a building permit is ALSO required is not the with-permit method", () => {
  const answer = JSON.stringify({ filing: { value: { name: "City building permit application", url: null, method: "with_ahj_permit" }, sourceUrl: PAGE, quote: "Submit your interconnection application to us. You must also obtain a building permit from the city." } });
  const parsed = ufl.parseUtilityFilingAnswer(answer, [PAGE]);
  assert.equal(parsed.filing.value, null, JSON.stringify(parsed.filing));
  assert.equal(ufl.quoteStatesFiledWithPermit("Apply for interconnection with Example Power and obtain a building permit."), false);
  assert.equal(ufl.quoteStatesFiledWithPermit("Net metering applications are submitted with your building permit application."), true);
  assert.equal(ufl.quoteStatesFiledWithPermit("The interconnection application is separate from the building permit."), false);
});
await check("(a) MUST-PASS unchanged: a page naming the utility's OWN portal keeps its URL and no method", () => {
  const tenant = "https://maplecrestinterconnect.powerclerk.com/MvcAccount/Login";
  const answer = JSON.stringify({ filing: { value: { name: "PowerClerk", url: tenant }, sourceUrl: PAGE, quote: "Apply online through our PowerClerk portal." } });
  const parsed = ufl.parseUtilityFilingAnswer(answer, [PAGE, tenant]);
  assert.equal(parsed.filing.value?.url, tenant);
  assert.equal(parsed.filing.value?.method, undefined);
});

// ── (b) a SEEDED with-permit row is a proposal ────────────────────────────────────────────────
const seed = () => ufl.saveUtilityFilingLookup(db, {
  state: STATE, utility: UTILITY,
  filing: { value: { name: "City building permit application", url: null, method: "with_ahj_permit", documents: ["Net metering agreement signed by the property owner"] }, sourceUrl: PAGE, quote: QUOTE, origin: "lookup", droppedUrls: [PERMIT_PORTAL] },
  program: { value: "net_metering", sourceUrl: PAGE, quote: QUOTE, origin: "lookup" },
  lookedUpAt: new Date().toISOString(),
});
const seededJob = newJob();
await check("(b) SEEDED: the NEM track stays 'not yet identified' / unverified with its human step — never 'with the permit'", () => {
  seed();
  assert.equal(ufl.nemFiledWithPermit(db, project(seededJob)), null);
  const nem = nemCard(seededJob);
  assert.equal(nem.channelKind, "unknown", nem.channel);
  assert.match(nem.channel, /not yet identified/);
  assert.match(nem.channel, /filing location unverified/);
  assert.equal(nem.recipePortalUrl ?? "", "", "no portal on the NEM track");
  assert.match(nem.nextAction, /^Find where this utility takes interconnection applications/, nem.nextAction);
  assert.equal(nem.stageBlocked ?? "", "", "Stage is not held by a seeded row");
  assert.ok(autopilot.tracksToStage(db, project(seededJob)).includes("nem"));
  const inv = reqDocs.documentInventory(db, project(seededJob));
  assert.ok(!inv.required.some((r) => r.docType === "utility_application"), "nothing joins the permit checklist");
});
await check("(b) SEEDED: the NEM status does NOT follow the permit", () => {
  tracks.markTrackSubmitted(db, project(seededJob), permitTrack(seededJob), { applicationNumber: "BLD-SEED-1", submittedBy: "test" });
  assert.equal(nemCard(seededJob).status, "not_started");
});

// ── (c) a person VERIFIES it ─────────────────────────────────────────────────────────────────
const verifiedJob = newJob();
await check("(e) the verify door: a named person, a cited page; a blank name verifies nothing", () => {
  assert.equal(ufl.verifyUtilityFilingLookup(db, { state: STATE, utility: UTILITY }, { verifiedBy: "  " }).saved, false);
  assert.equal(ufl.verifyUtilityFilingLookup(db, { state: STATE, utility: UTILITY }, { verifiedBy: "Pat Operator", filedWithPermit: { sourceUrl: "not a url", quote: QUOTE } }).saved, false);
  assert.equal(utilityFilingVerifySchema.safeParse({ filedWithPermit: { sourceUrl: PAGE, quote: QUOTE, url: PERMIT_PORTAL } }).success, false, "no URL can be stated (rule 5)");
  const r = ufl.verifyUtilityFilingLookup(db, { state: STATE, utility: UTILITY }, { verifiedBy: "Pat Operator" });
  assert.equal(r.saved, true, r.reason);
  assert.equal(r.lookup?.confidence, "verified");
  assert.deepEqual(r.lookup?.filing.droppedUrls, [PERMIT_PORTAL]);
  const w = ufl.nemFiledWithPermit(db, project(verifiedJob));
  assert.ok(w, "the verified row switches the track");
  assert.equal(w!.verifiedBy, "Pat Operator");
});
await check("(e) a lookup never overwrites the verified row (rule 3)", async () => {
  const run = await ufl.runUtilityFilingLookup(db, { webLookup: async () => { throw new Error("must not be called"); } } as never, { state: STATE, utility: UTILITY, force: true });
  assert.equal(run.saved, false);
  assert.ok(ufl.nemFiledWithPermit(db, project(verifiedJob)));
});
await check("(c) VERIFIED: no portal, channel kind with_permit, Stage held with the reason", () => {
  const nem = nemCard(verifiedJob);
  assert.equal(nem.channelKind, "with_permit", nem.channel);
  assert.match(nem.channel, /Filed inside the AHJ permit application/);
  assert.equal(nem.recipePortalUrl ?? "", "");
  assert.equal(nem.hasRecipe, false);
  assert.match(nem.stageBlocked ?? "", /no separate utility filing to stage/);
  assert.match(nem.nextAction, /No separate utility filing/);
  assert.match(nem.nextAction, /never pays/, "fees stay human (rule 1)");
  assert.match(nem.statusLabel, /^With the permit/);
});
await check("(c) VERIFIED: Stage on the NEM track is refused (409); autopilot stages the permit only", async () => {
  await assert.rejects(() => repo.prepareSubmission(db, verifiedJob, "nem"), (err: { status?: number; details?: Record<string, unknown> }) => {
    assert.equal(err.status, 409);
    assert.equal(err.details?.nemFiledWithPermit, true);
    return true;
  });
  const staged = autopilot.tracksToStage(db, project(verifiedJob));
  assert.ok(!staged.includes("nem"), staged.join(","));
  assert.ok(staged.length > 0, "the permit track still stages");
  assert.ok(!fx.latestRun(verifiedJob), "nothing opened");
});
await check("(c) VERIFIED: the utility's application joins the PERMIT checklist and the permit packet — never the bill", () => {
  const inv = reqDocs.documentInventory(db, project(verifiedJob));
  const row = inv.presence.find((r) => r.docType === "utility_application");
  assert.ok(row, "the row is on the checklist");
  assert.equal(row!.lane, "permit");
  assert.equal(row!.blocking, true, "the verified record lists the utility's documents");
  assert.ok(inv.missingBlocking.some((r) => r.docType === "utility_application"));
  assert.match(row!.why, /Net metering agreement signed by the property owner/);
  assert.match(row!.why, /nothing here signs for the owner/);
  const p = project(verifiedJob);
  docs.saveProjectDocument(db, verifiedJob, { docType: "utility_application", filename: "nem-agreement.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% nem agreement\n", "utf8"), source: "upload" });
  docs.saveProjectDocument(db, verifiedJob, { docType: "utility_bill", filename: "bill.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% bill\n", "utf8"), source: "upload" });
  const packet = subDocs.submissionDocumentsByType(db, p, permitTrack(verifiedJob));
  assert.ok(packet.utility_application, Object.keys(packet).join(","));
  assert.equal(packet.utility_bill, undefined, "the bill never rides in the permit packet");
  assert.ok(reqDocs.documentInventory(db, project(verifiedJob)).presence.find((r) => r.docType === "utility_application")!.present);
  // The seeded job's packet carries no utility application.
  docs.saveProjectDocument(db, seededJob, { docType: "utility_application", filename: "nem-agreement.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% nem agreement 2\n", "utf8"), source: "upload" });
});

// ── (d) the NEM status follows the permit ─────────────────────────────────────────────────────
await check("(d) VERIFIED: the permit submitted → the NEM track reads submitted with it; nextStep never asks to stage it", async () => {
  tracks.markTrackSubmitted(db, project(verifiedJob), permitTrack(verifiedJob), { applicationNumber: "BLD-0001", submittedBy: "test" });
  const nem = nemCard(verifiedJob);
  assert.equal(nem.status, permitCard(verifiedJob).status === "in_review" ? "in_review" : "submitted", `${nem.status} vs ${permitCard(verifiedJob).status}`);
  const facts = nextStep.loadNextStepFacts(db, [project(verifiedJob)]).get(verifiedJob)!;
  const t = facts.tracks.find((x) => x.track === "nem")!;
  assert.equal(t.followsPermit, true);
  assert.equal(t.filed, true);
  const step = nextStep.decideNextStep(facts);
  assert.notEqual(step.key, "ready_to_stage", step.headline);
  const progress = tracks.trackProgress(db, project(verifiedJob)).find((x) => x.type === "nem")!;
  assert.equal(progress.status, nem.status, "the client timeline reads the same answer");
});
await check("(d) VERIFIED: the permit issued → approved with the permit, meter set pending (a person's call), NEM NOT done", () => {
  db.run("UPDATE permit_check_targets SET latest_outcome = 'issued' WHERE project_id = ? AND active = 1", [verifiedJob]);
  assert.equal(permitCard(verifiedJob).status, "issued");
  const nem = nemCard(verifiedJob);
  assert.equal(nem.status, "ready_for_issue");
  assert.equal(nem.statusLabel, "Approved with the permit — meter set pending");
  assert.match(nem.nextAction, /calls .* to set the meter/);
  assert.equal(nem.outstanding, true);
  assert.equal(tracks.isTrackDone(db, verifiedJob, "nem", tracks.requiredTracks(project(verifiedJob))), false);
  const step = nextStep.decideNextStep(nextStep.loadNextStepFacts(db, [project(verifiedJob)]).get(verifiedJob)!);
  assert.equal(step.who, "me");
  assert.match(step.headline, /set the meter/, step.headline);
});
await check("(d) SEEDED job still reads unfollowed after the verified job's changes (per-utility data, not global)", () => {
  // Same utility, so the verified row now speaks for it too — it is the utility's fact, shared on purpose.
  assert.ok(ufl.nemFiledWithPermit(db, project(seededJob)));
  // Another utility's NEM track is untouched.
  const other = fx.newProject({ state: STATE, city: CITY, ahj: AHJ, utility: "Juniper Valley Electric Cooperative" });
  const nem = nemCard(other);
  assert.notEqual(nem.channelKind, "with_permit");
  assert.equal(nem.stageBlocked ?? "", "");
  assert.ok(autopilot.tracksToStage(db, project(other)).includes("nem"));
});

finish("nemFiledWithPermit");
