// THE CARD SAYS WHY THE LAST STATUS CHECK READ NOTHING (#173).
//
// Since #161 a check that reads nothing audits why (permit_status.unreadable), but the card kept
// only its last outcome and "last checked <date>": a filing whose checks keep coming back empty
// looked exactly like a quiet one. Now the target payload (getProjectDetail) and the track card's
// payload (getSubmittalTracks) carry `lastUnreadable: { reason, at }` — the newest unreadable reason,
// only while it is newer than the target's last recorded reading — and the card renders it.
//
// The browser is the only thing stubbed (setStatusCheckSeamsForTests); the sweep is the real
// runDuePermitChecks over targets and recipes written through the real writers, as in
// statusUnreadableReason.test.ts. The card renderers are the SHIPPED functions lifted out of
// frontend/dashboard.js (brace-balanced cut, no Chromium).
//
//   (a) MUST-PASS    an unreadable sweep puts its reason and time on the target AND the track payload
//   (b) MUST-PASS    a later readable sweep removes it (and a person's Record status does too)
//   (c) MUST-EXCLUDE another project's audit rows never appear on this project's payload, even a
//                    forged row naming this project's target id
//   (d) MUST-EXCLUDE rule 2: a typed value from a Playwright call log, a password after "password:",
//                    an email and the project's own account number never reach the audit row or card
//   (e) MUST-PASS    the track card and the target card render it, esc()'d; nothing when it is null
//
// Run: npx tsx backend/test/lastUnreadableOnCard.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("last-unreadable-on-card");
const { db, repo, recipes } = fx;
const { getSubmittalTracks } = await import("../src/submittalTracks");
// The live install's mode (see statusUnreadableReason.test.ts): an empty read is skipped, not mocked.
process.env.PORTAL_AUTOSEED = "1";
const PACIFICORP_NM = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
const REVIEW = { action: "stopForReview", selector: {} } as never;
const fill = (i: number) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` }) as never;

let report: string | null = null;
let statusText: string | null = null;
repo.setStatusCheckSeamsForTests({
  checkStatus: (async (_adapter: string, _apps: string[], opts: { onReason?: (r: string) => void }) => {
    if (statusText) return statusText;
    if (report) opts?.onReason?.(report);
    return null;
  }) as never,
  publicCheck: (async () => null) as never,
});

const nemTarget = (projectId: string, applicationNumber: string) => {
  repo.createPermitCheckTarget(db, projectId, { targetType: "nem", portalUrl: "", applicationNumber, jurisdiction: "Pacific Power", portalName: "PowerClerk", permitType: "nem" });
  return db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId])!.id;
};
const sweep = async (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  // link_lookup_at cleared: the once-a-day record-list throttle (#413) would answer every later sweep.
  for (const t of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL, link_lookup_at = NULL WHERE id = ?", [t]);
  await repo.runDuePermitChecks(db, "all");
};
const targetOf = (projectId: string, targetId: string) => repo.getProjectDetail(db, projectId).permitCheckTargets.find((t) => t.id === targetId)!;
const nemTrackOf = (projectId: string) => getSubmittalTracks(db, repo.getProjectDetail(db, projectId).project).find((t) => t.type === "nem");

const pac = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Pacific Power", portalUrl: PACIFICORP_NM, createdBy: "test" });
recipes.savePortalRecipeSteps(db, pac.id, [fill(1), fill(2), REVIEW], { status: "complete" });

const projectA = fx.newProject({ utility: "Pacific Power" });
const targetA = nemTarget(projectA, "APP-200001");
const projectB = fx.newProject({ utility: "Pacific Power" });
const targetB = nemTarget(projectB, "APP-200002");

await check("(a) MUST-PASS an unreadable sweep puts the reason and its time on the target and the track", async () => {
  report = "the sign-in failed: the portal rejected the stored login";
  const before = new Date().toISOString();
  await sweep(targetA);
  const t = targetOf(projectA, targetA);
  assert.ok(t.lastUnreadable, `no lastUnreadable on the target: ${JSON.stringify(t)}`);
  assert.equal(t.lastUnreadable!.reason, "the sign-in failed: the portal rejected the stored login");
  assert.ok(t.lastUnreadable!.at >= before, `stale time ${t.lastUnreadable!.at}`);
  const track = nemTrackOf(projectA);
  assert.deepEqual(track?.lastUnreadable, t.lastUnreadable, `the track card's payload differs: ${JSON.stringify(track?.lastUnreadable)}`);
  // A second unreadable sweep: the NEWEST reason wins.
  report = "searched \"Projects\" for the application number — no matching row";
  await sweep(targetA);
  assert.equal(targetOf(projectA, targetA).lastUnreadable?.reason, "searched \"Projects\" for the application number — no matching row");
});

await check("(c) MUST-EXCLUDE another project's audit rows never appear on this payload", async () => {
  // B reads nothing for its own reason. Then two NEWER forged rows: one filed under A naming B's
  // target, one filed under B naming A's. Each project shows only its own row for its own target.
  report = "the portal page held no status for this application";
  await sweep(targetB);
  const later = new Date(Date.now() + 60_000).toISOString();
  const forge = (id: string, projectId: string, targetId: string, reason: string) => db.run(
    "INSERT INTO audit_logs (id, project_id, actor_type, actor_name, action, details, created_at) VALUES (?, ?, 'system', 'permit monitor', 'permit_status.unreadable', ?, ?)",
    [id, projectId, JSON.stringify({ targetId, track: "nem", reason }), later]);
  forge("forged-1", projectA, targetB, "A's row naming B's target");
  forge("forged-2", projectB, targetA, "B's row naming A's target");
  assert.equal(targetOf(projectB, targetB).lastUnreadable?.reason, "the portal page held no status for this application", "project B's target does not show its own reason (or shows A's row)");
  assert.equal(nemTrackOf(projectB)?.lastUnreadable?.reason, "the portal page held no status for this application", "project B's track does not show its own reason (or shows A's row)");
  assert.equal(targetOf(projectA, targetA).lastUnreadable?.reason, "searched \"Projects\" for the application number — no matching row", "project A's target does not show its own reason (or shows B's row)");
  db.run("DELETE FROM audit_logs WHERE id IN ('forged-1', 'forged-2')");
});

await check("(d) MUST-EXCLUDE rule 2: typed values, a password, an email and the account number are scrubbed", async () => {
  report = "the sign-in failed: Login failed: locator.fill: Target closed; fill(\"Hunter2-Secret!\") password: Sw0rdfish ops@client.example acct 1234567890 at https://portal.example/login?session=tok123\nCall log:\n  - fill(\"Hunter2-Secret!\")";
  await sweep(targetA);
  const audited = fx.audits("permit_status.unreadable").map((a) => JSON.parse(a.details)).filter((d) => d.targetId === targetA).map((d) => String(d.reason));
  const newest = audited[audited.length - 1];
  const shown = targetOf(projectA, targetA).lastUnreadable?.reason ?? "";
  for (const [where, text] of [["audit row", newest], ["card payload", shown]] as const) {
    for (const leak of ["Hunter2-Secret!", "Sw0rdfish", "ops@client.example", "1234567890", "tok123", "Call log"]) {
      assert.ok(!text.includes(leak), `${where} carries ${JSON.stringify(leak)}: ${text}`);
    }
    assert.match(text, /^the sign-in failed: Login failed: /, `${where} lost the reason itself: ${text}`);
  }
  // A row written before the write-time scrub existed is scrubbed again where it is read.
  db.run("INSERT INTO audit_logs (id, project_id, actor_type, actor_name, action, details, created_at) VALUES (?, ?, 'system', 'permit monitor', 'permit_status.unreadable', ?, ?)",
    ["legacy-1", projectA, JSON.stringify({ targetId: targetA, track: "nem", reason: "the status read failed: fill(\"OldSecret99\") for 1234567890" }), new Date(Date.now() + 120_000).toISOString()]);
  const legacy = targetOf(projectA, targetA).lastUnreadable?.reason ?? "";
  assert.ok(!legacy.includes("OldSecret99") && !legacy.includes("1234567890"), `a legacy row reached the card unscrubbed: ${legacy}`);
  db.run("DELETE FROM audit_logs WHERE id = 'legacy-1'");
});

await check("(b) MUST-PASS a later readable sweep clears it; so does a person's Record status", async () => {
  report = null;
  statusText = "Application APP-200001 Status: Under Review";
  await sweep(targetA);
  statusText = null;
  assert.equal(targetOf(projectA, targetA).lastUnreadable ?? null, null, "a readable sweep left the unreadable reason on the target");
  assert.equal(nemTrackOf(projectA)?.lastUnreadable ?? null, null, "a readable sweep left the unreadable reason on the track");
  // Read nothing again, then a person records the status by hand: the card goes back to the outcome alone.
  report = "the portal page read was a sign-in wall";
  await sweep(targetA);
  assert.equal(targetOf(projectA, targetA).lastUnreadable?.reason, "the portal page read was a sign-in wall");
  await repo.recordPermitStatusCheck(db, projectA, { targetId: targetA, source: "manual", rawStatusText: "Under review" });
  assert.equal(targetOf(projectA, targetA).lastUnreadable ?? null, null, "a recorded status left the unreadable reason on the target");
});

// ── the card ────────────────────────────────────────────────────────────────────────────────────
const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = dashboard.slice(m.index, m.index + 6) === "const ";
  const open = isConst ? dashboard.slice(m.index).search(/[[{]/) + m.index : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  const [o, c] = dashboard[open] === "[" ? ["[", "]"] : ["{", "}"];
  let depth = 0, end = -1;
  for (let j = open; j < dashboard.length; j++) {
    if (dashboard[j] === o) depth++;
    else if (dashboard[j] === c) { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end) + (isConst ? ";" : "");
};
const bundle = ["esc", "httpUrl", "linkifyText", "fmtDate", "humanize", "statusBadge", "TRACK_CHANNEL_BASIS", "trackChannelHtml",
  "PERMIT_STATUS_PICKS", "permitTargetKindLabel", "portalSaysFor", "issuedDocumentsHtml", "permitTargetCardHtml"].map(cut).join("\n;\n");
const ui = new Function(`${bundle}\nreturn { trackChannelHtml, permitTargetCardHtml };`)() as {
  trackChannelHtml: (t: Record<string, unknown>) => string;
  permitTargetCardHtml: (t: Record<string, unknown>, checks: unknown[], ui: unknown) => string;
};

await check("(e) MUST-PASS both cards say the last check read nothing, why and when, esc()'d", () => {
  const lastUnreadable = { reason: "the sign-in failed: <b>no</b> & retry", at: "2026-10-04T15:00:00.000Z" };
  const track = ui.trackChannelHtml({ channel: "PowerClerk", lastCheckedAt: "2026-10-04T15:00:00.000Z", lastUnreadable });
  assert.match(track, /last checked .* · <span data-last-unreadable[^>]*>last check read nothing \([^)]+\): the sign-in failed: &lt;b&gt;no&lt;\/b&gt; &amp; retry<\/span>/, track);
  assert.doesNotMatch(ui.trackChannelHtml({ channel: "PowerClerk", lastCheckedAt: "2026-10-04T15:00:00.000Z", lastUnreadable: null }), /read nothing/);
  const target = { id: "t-1", projectId: "p-1", portalName: "PowerClerk", targetType: "nem", active: true, checkFrequencyDays: 1, lastUnreadable };
  const card = ui.permitTargetCardHtml(target, [], null);
  assert.match(card, /<p data-last-unreadable[^>]*>Last check read nothing \([^)]+\): the sign-in failed: &lt;b&gt;no&lt;\/b&gt; &amp; retry<\/p>/, card);
  assert.doesNotMatch(ui.permitTargetCardHtml({ ...target, lastUnreadable: null }, [], null), /read nothing/);
  assert.doesNotMatch(ui.permitTargetCardHtml({ ...target, active: false }, [], null), /read nothing/, "a stopped filing still shows the reason");
});

repo.setStatusCheckSeamsForTests(null);
finish("lastUnreadableOnCard");
