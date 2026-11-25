// AUTOMATION FILES ONLY THROUGH A DOOR A NAMED PERSON VERIFIED.
//
// Owner 2026-11-10 08:45 ("Go with your recommendation"): filing doors (where a track files) stay
// person-verified, never automatic. Before this, the final-submit gate (repository.
// automaticSubmitRefusals) checked the environment switch, the named approval of this run, a borrowed
// recipe, relaxed / unacknowledged review items and the recipe's shape, and never WHERE the run files:
// an approved run on a complete recipe could click the final submit on a door that was only seeded,
// cited, shipped or researched. The gate now also refuses when no named person verified this track's
// filing door (submittalTracks.personVerifiedFilingDoor, the card's "verified by a person"), and when
// the recipe drives a different host / shared-instance tenant than that door (portalChannel.
// sameFilingDoor). Tightening only: staging to review is unchanged.
//
// KILL TESTS:
//   K1 repository.automaticSubmitRefusals: drop the `!doorUrl` refusal           → (a2) (a3) (a4) (e1) (f) fail.
//   K2 drop the recipe-drives-the-door check                                       → (b1) (b2) (b3) fail.
//   K3 portalChannel.sameFilingDoor: host-only on a shared instance                → (c2) (c3) fail.
//   K4 personVerifiedFilingDoor: accept any basis with a URL (cited / known)       → (h) fails.
//   K5 prepareSubmission passes the run's own URL instead of the verified read     → (i) fails.
//
// Run: npx tsx backend/test/filingDoorGate.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("filing-door-gate");
const { db, repo, recipes } = fx;
const kb = await import("../src/knowledgeBase");
const { sameFilingDoor } = await import("../src/portalChannel");
const { personVerifiedFilingDoor, getSubmittalTracks } = await import("../src/submittalTracks");

const ENV = { PORTAL_ALLOW_FINAL_SUBMIT: "1" };
const OTHER = "https://other-host.example/apply";
const reasonsOf = (r: string[]) => JSON.stringify(r);

// ── The one gate, asked directly ────────────────────────────────────────────────────────────
await check("(a1) MUST-PASS: every other check clean + a person-verified door the recipe drives → no refusal", () => {
  const recipe = fx.completeRecipe();
  const r = repo.automaticSubmitRefusals(db, { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "a1" }, runId: "a1", env: ENV, filingDoor: { url: fx.FIXTURE_DOOR } });
  assert.deepEqual(r, [], "a fully approved run on a verified door was refused — a gate nothing passes is an outage");
  assert.equal(repo.maySubmitAutomatically(db, { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "a1" }, runId: "a1", env: ENV, filingDoor: { url: fx.FIXTURE_DOOR } }), true);
});

await check("(a2) no person-verified door (null) → refused, with a plain reason, and nothing else changes", () => {
  const recipe = fx.completeRecipe();
  const r = repo.automaticSubmitRefusals(db, { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "a2" }, runId: "a2", env: ENV, filingDoor: null });
  assert.equal(r.length, 1, reasonsOf(r));
  assert.match(r[0], /filing destination is not person-verified/);
  assert.match(r[0], /named person/);
});

await check("(a3) a caller that never says (filingDoor absent at runtime) is refused, not waved through", () => {
  const recipe = fx.completeRecipe();
  const input = { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "a3" }, runId: "a3", env: ENV } as unknown as Parameters<typeof repo.automaticSubmitRefusals>[1];
  const r = repo.automaticSubmitRefusals(db, input);
  assert.ok(r.some((x) => /not person-verified/.test(x)), reasonsOf(r));
  assert.equal(repo.maySubmitAutomatically(db, input), false);
});

await check("(a4) the door refusal adds to the others; it never replaces them (no approval + no door → both named)", () => {
  const recipe = fx.completeRecipe();
  const r = repo.automaticSubmitRefusals(db, { recipeId: recipe.id, runApproval: null, runId: "a4", env: {}, filingDoor: null });
  assert.ok(r.some((x) => /PORTAL_ALLOW_FINAL_SUBMIT/.test(x)), reasonsOf(r));
  assert.ok(r.some((x) => /no named person approved/.test(x)), reasonsOf(r));
  assert.ok(r.some((x) => /not person-verified/.test(x)), reasonsOf(r));
});

await check("(b1) the recipe drives ANOTHER host than the verified door → refused, naming both hosts", () => {
  const recipe = fx.completeRecipe();
  const r = repo.automaticSubmitRefusals(db, { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "b1" }, runId: "b1", env: ENV, filingDoor: { url: OTHER } });
  assert.equal(r.length, 1, reasonsOf(r));
  assert.match(r[0], /the recipe drives permits\.portland\.example, not the person-verified filing destination \(other-host\.example\)/);
});

await check("(b2) a goto step that leaves the verified door → refused; a goto on the door's own host is fine", () => {
  const away = fx.completeRecipe([{ action: "goto", value: OTHER } as RecipeStep, ...fx.fills(3), fx.REVIEW, fx.FINAL]);
  const r = repo.automaticSubmitRefusals(db, { recipeId: away.id, runApproval: { approver: "A. Person", runId: "b2" }, runId: "b2", env: ENV, filingDoor: { url: fx.FIXTURE_DOOR } });
  assert.equal(r.length, 1, reasonsOf(r));
  assert.match(r[0], /drives other-host\.example/);
  const home = fx.completeRecipe([{ action: "goto", value: "https://permits.portland.example/apply/step-2" } as RecipeStep, ...fx.fills(3), fx.REVIEW, fx.FINAL]);
  assert.deepEqual(repo.automaticSubmitRefusals(db, { recipeId: home.id, runApproval: { approver: "A. Person", runId: "b2b" }, runId: "b2b", env: ENV, filingDoor: { url: fx.FIXTURE_DOOR } }), []);
});

await check("(b3) a recipe with no portal URL cannot be matched to the door → refused", () => {
  const recipe = fx.completeRecipe();
  db.run("UPDATE portal_recipes SET portal_url = '' WHERE id = ?", [recipe.id]);
  const r = repo.automaticSubmitRefusals(db, { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "b3" }, runId: "b3", env: ENV, filingDoor: { url: fx.FIXTURE_DOOR } });
  assert.ok(r.some((x) => /names no portal URL/.test(x)), reasonsOf(r));
});

// ── The door predicate ───────────────────────────────────────────────────────────────────────
await check("(c1) sameFilingDoor: same host matches (www and path ignored); another host or a non-URL does not", () => {
  assert.equal(sameFilingDoor("https://permits.example.gov/apply", "https://www.permits.example.gov/other/page"), true);
  assert.equal(sameFilingDoor("https://permits.example.gov/apply", "https://permits.example.org/apply"), false);
  assert.equal(sameFilingDoor("", "https://permits.example.gov/apply"), false);
  assert.equal(sameFilingDoor("https://permits.example.gov/apply", "not a url"), false);
});

await check("(c2) sameFilingDoor on a shared vendor instance: the same named tenant only", () => {
  assert.equal(sameFilingDoor("https://aca-prod.accela.com/TENANTA/Default.aspx", "https://aca-prod.accela.com/TENANTA/Cap/CapHome.aspx"), true);
  assert.equal(sameFilingDoor("https://aca-prod.accela.com/TENANTA/Default.aspx", "https://aca-prod.accela.com/TENANTB/Cap/CapHome.aspx"), false, "another agency's tenant on the same host matched");
  assert.equal(sameFilingDoor("https://www.citizenserve.com/Portal/PortalController?installationID=111", "https://www.citizenserve.com/Portal/PortalController?installationID=222"), false, "another installation matched");
  assert.equal(sameFilingDoor("https://www.citizenserve.com/Portal/PortalController?installationID=111", "https://www.citizenserve.com/Portal/PortalController?Action=x&installationID=111"), true);
});

await check("(c3) a door that names no tenant on a shared instance is nobody's door: it matches nothing", () => {
  assert.equal(sameFilingDoor("https://aca-prod.accela.com/", "https://aca-prod.accela.com/"), false);
  assert.equal(sameFilingDoor("https://www.bsaonline.com/", "https://www.bsaonline.com/?uid=413"), false);
});

// ── End to end through prepareSubmission (the stubbed replay) ───────────────────────────────
type Seen = { autoSubmit?: boolean; runApproval?: unknown };
async function stageApproved(projectId: string): Promise<{ seen: Seen | null; approvalId: string }> {
  const approval = repo.createRunApproval(db, { projectId, track: "permit", approver: "A. Person", approverUserId: null, acknowledgements: fx.acknowledgeAll(projectId, null) });
  let seen: Seen | null = null;
  fx.stubRunner(async (_r, _p, _f, _d, _files, options) => {
    seen = { autoSubmit: options?.autoSubmit, runApproval: options?.runApproval ?? null };
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  try { await repo.prepareSubmission(db, projectId, undefined, true, undefined, approval.id); } finally { delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; }
  return { seen, approvalId: approval.id };
}
const declined = (projectId: string) => fx.audits("portal.auto_submit_declined").filter((a) => a.project_id === projectId).map((a) => JSON.parse(a.details));
const allowed = (projectId: string) => fx.audits("portal.auto_submit_allowed").filter((a) => a.project_id === projectId).map((a) => JSON.parse(a.details));

await check("(e1) MUST-EXCLUDE: an approved run on a door nobody verified still STAGES to review, but is not allowed to submit", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const project = repo.getProjectDetail(db, projectId).project;
  assert.equal(personVerifiedFilingDoor(db, "permit", project), null, "setup: the fixture door is already verified");
  const { seen, approvalId } = await stageApproved(projectId);
  assert.ok(seen, "the run did not reach the replay — staging to review must be unchanged");
  assert.equal(seen!.autoSubmit, false, "the runner was told it may click the final submit on an unverified door");
  assert.equal(seen!.runApproval, null);
  const d = declined(projectId);
  assert.equal(d.length, 1, "no auto_submit_declined audit row");
  assert.equal(d[0].approvedBy, "A. Person", "the refusal was 'no approval', not the door");
  assert.ok(d[0].reasons.some((r: string) => /not person-verified/.test(r)), JSON.stringify(d[0].reasons));
  const row = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [approvalId]);
  assert.ok(row?.consumed_at, "a refused run must still burn its approval (single use)");
});

await check("(f) a SEEDED knowledge-base row naming the very same URL is not a person's verification", async () => {
  kb.importSeededAhjKnowledge(db, { state: "OR", ahj: "Portland", portalUrl: fx.FIXTURE_DOOR, sourceLabel: "test reference sheet" });
  fx.completeRecipe();
  const projectId = fx.newProject();
  assert.equal(personVerifiedFilingDoor(db, "permit", repo.getProjectDetail(db, projectId).project), null, "a seeded row counted as a person's verification");
  const { seen } = await stageApproved(projectId);
  assert.equal(seen!.autoSubmit, false);
  assert.ok(declined(projectId)[0].reasons.some((r: string) => /not person-verified/.test(r)));
});

await check("(g) staging WITHOUT a final-submit request is untouched by the door check (no decline row, the replay runs)", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  let calls = 0;
  fx.stubRunner(async () => { calls += 1; return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] }; });
  await repo.prepareSubmission(db, projectId);
  assert.equal(calls, 1, "a plain stage did not run");
  assert.equal(declined(projectId).length, 0, "a plain stage was audited as a declined submit");
});

await check("(e2) MUST-PASS: once a named person verifies the door, the same approved run is allowed, and the allowed row names the door", async () => {
  fx.verifyDoor({ verifiedBy: "Dana Verifier" });
  fx.completeRecipe();
  const projectId = fx.newProject();
  const project = repo.getProjectDetail(db, projectId).project;
  assert.deepEqual(personVerifiedFilingDoor(db, "permit", project), { url: fx.FIXTURE_DOOR });
  // ONE ANSWER: the card shows the same door as verified by a person.
  const card = getSubmittalTracks(db, project).find((t) => t.category === "permit");
  assert.ok(card, "setup: no permit track card");
  assert.equal(card!.channelBasis, "verified", `the card and the gate disagree: ${card!.channel}`);
  const { seen } = await stageApproved(projectId);
  assert.equal(seen!.autoSubmit, true, `a fully approved run on a verified door was refused: ${JSON.stringify(declined(projectId))}`);
  const a = allowed(projectId);
  assert.equal(a.length, 1);
  assert.equal(a[0].filingDoor, fx.FIXTURE_DOOR, "the allowed audit row does not name the door");
});

await check("(h) NEM: a utility's door a named person verified is that track's door; before it, none", () => {
  const projectId = fx.newProject();
  const project = repo.getProjectDetail(db, projectId).project;
  const before = personVerifiedFilingDoor(db, "nem", project);
  assert.equal(before, null, `setup: the utility door is already verified (${JSON.stringify(before)})`);
  fx.verifyDoor({ scope: "utility", utility: "PGE", portalUrl: "https://utility-portal.example/Login" });
  assert.deepEqual(personVerifiedFilingDoor(db, "nem", project), { url: "https://utility-portal.example/Login" });
});

await check("(i) static: prepareSubmission asks the gate with the person-verified read, never the run's own URL", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { REPO } = await import("./_isolate");
  const src = fs.readFileSync(path.join(REPO, "backend/src/repository.ts"), "utf8");
  assert.match(src, /const filingDoor = wantsFinalSubmit \? personVerifiedFilingDoor\(db, track \?\? "permit", portalProject\) : null;/);
  assert.match(src, /automaticSubmitRefusals\(db, \{[^}]*filingDoor \}\)/);
});

finish("filing-door-gate");
