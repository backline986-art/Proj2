// ISSUE #678 — the coverage report named a CITY's permit portal as the utility's interconnection
// portal. `knowledgeBasePortalUrl` took the first permit_utility_knowledge row for the utility with any
// portal_url — a `city|utility` row carries the city's permit portal (an iWorQ host in the run that
// found it) — and the NEM side had no mirror of the permit side's `permitSafe`.
//
// Pins (hard rule 5 — ONE predicate, portalChannel.hostFitsTrackAndEntity, as production asks it):
//   (a) a city|utility row holding a permit-portal URL → the NEM row reports NO portal;
//   (b) the utility's OWN row is preferred over a city|utility row;
//   (c) the single carve-out stays data: the utility's own human-VERIFIED record naming that exact
//       permit portal may be reported; a SEEDED utility row naming it never is;
//   (d) the permit side is unchanged: the city's row still reports its permit portal.
// Invented names; no network, no browser.
//
// KILL TEST: drop the nemSafe filter in resolveTrack → (a) and (c, seeded) fail.
//
// Run: npx tsx backend/test/coverageReportNemPermitPortal.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-nem-permit-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { knowledgeProfileKey } = await import("../src/knowledgeBase");
const { resolveTrack } = await import("../../scripts/coverage-report");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const STATE = "UT";
const now = new Date().toISOString();
let n = 0;
function seedKnowledge(opts: { ahj?: string; utility: string; portalUrl: string; verified?: boolean }): void {
  const key = knowledgeProfileKey({ state: STATE, ahj: opts.ahj, utility: opts.utility });
  db.run(
    `INSERT INTO permit_utility_knowledge
      (id, profile_key, state, ahj, utility, portal_name, portal_url, notes, confidence, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
     VALUES (?, ?, ?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, ?)`,
    [`kb-678-${++n}`, key, STATE, opts.ahj ?? "", opts.utility, opts.portalUrl, opts.verified ? "verified" : "seeded", now, now, now,
      opts.verified ? now : null, opts.verified ? "Pat Operator" : ""],
  );
}
const spec = (ahj: string, utility: string) => ({ state: STATE, ahj, utility, discipline: "", source: "test" });

// (a) a city|utility row with the city's permit portal, nothing else for the utility.
const BRIAR_PERMITS = "https://briarwood.portal.iworq.net/BRIARWOOD/permits/600";
seedKnowledge({ ahj: "City of Briarwood", utility: "Briarwood Valley Power", portalUrl: BRIAR_PERMITS });
check("(a) a city|utility row's permit portal is never reported as the utility's NEM portal", () => {
  const nem = resolveTrack(db, spec("City of Briarwood", "Briarwood Valley Power"), "nem");
  assert.equal(nem.portalUrl, "", nem.portalUrl);
});
check("(d) the permit side is unchanged: the city still reports its permit portal", () => {
  const permit = resolveTrack(db, spec("City of Briarwood", "Briarwood Valley Power"), "permit");
  assert.equal(permit.portalUrl, BRIAR_PERMITS);
});

// (b) the utility's own row beside a city|utility row.
const CEDAR_PERMITS = "https://cedarhollow.portal.iworq.net/CEDARHOLLOW/permits/600";
const CEDAR_OWN = "https://cedarhollowpower-interconnect.invalid/apply";
seedKnowledge({ ahj: "City of Cedar Hollow", utility: "Cedar Hollow Electric", portalUrl: CEDAR_PERMITS });
seedKnowledge({ utility: "Cedar Hollow Electric", portalUrl: CEDAR_OWN });
check("(b) the utility's own row is reported, not the city|utility row", () => {
  assert.equal(resolveTrack(db, spec("City of Cedar Hollow", "Cedar Hollow Electric"), "nem").portalUrl, CEDAR_OWN);
});

// (c) the rule-5 carve-out, as data.
const DUNMORE_PERMITS = "https://dunmore.portal.iworq.net/DUNMORE/permits/600";
seedKnowledge({ ahj: "City of Dunmore", utility: "Dunmore City Light", portalUrl: DUNMORE_PERMITS });
seedKnowledge({ utility: "Dunmore City Light", portalUrl: DUNMORE_PERMITS });
check("(c) a SEEDED utility row naming the city's permit portal never qualifies", () => {
  assert.equal(resolveTrack(db, spec("City of Dunmore", "Dunmore City Light"), "nem").portalUrl, "");
});
const ELM_PERMITS = "https://elmstead.portal.iworq.net/ELMSTEAD/permits/600";
seedKnowledge({ ahj: "City of Elmstead", utility: "Elmstead Municipal Power", portalUrl: ELM_PERMITS });
seedKnowledge({ utility: "Elmstead Municipal Power", portalUrl: ELM_PERMITS, verified: true });
check("(c) the utility's own human-VERIFIED record naming that exact portal may be reported", () => {
  assert.equal(resolveTrack(db, spec("City of Elmstead", "Elmstead Municipal Power"), "nem").portalUrl, ELM_PERMITS);
});

if (failures) { console.error(`\n${failures} coverageReportNemPermitPortal check(s) FAILED.`); process.exit(1); }
console.log("\nAll coverageReportNemPermitPortal checks passed.");
process.exit(0);
