// IDAHO (TREASURE VALLEY) REFERENCE DATA, SEEDED AND CITED. The rows this pins live in the shipped
// reference files that already hold each kind of fact (no new loader):
//   - backend/data/reference-ahj-processes.json: the ID process rows read from each city's own pages
//     (2026-11-10), each carrying `citations` (field, value, sourceUrl, verbatim quote, fetchedAt);
//   - backend/data/reference-utility-application-requirements.json: the utility's application list
//     and its `filingDoor` (the link its own "apply" page names);
//   - backend/data/reference-eligibility-limits.json: the utility's program size limit.
// Pins:
//   - every cited row and record lands SEEDED: the KB rows the boot seed writes are not verified and not
//     official, the requirement items are tier "seeded", the eligibility row is "seeded" (rule 3);
//   - a filing door (portal URL or intake address) never lands official or verified, and a person's
//     verified utility row is never overwritten by the shipped door (rule 3);
//   - each door passes THE one predicate for its own track and fails the other (rule 5);
//   - a seeded intake address is shown on the card but never becomes a sendable filing address (rule 1);
//   - each citation is whole: https source, verbatim quote, fetchedAt; a door's value is the cited value.
// The test reads the data by its STATE and SOURCE SHEET, and names places only in data it loads, so
// no place name sits in backend/src (placeNameGuard).
// Run: tsx backend/test/idahoSeedData.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AhjProcessProfile, ProjectRecord } from "../../shared/src/types";

const { openDatabase } = await import("../src/db");
const { findAhjProcessProfile } = await import("../src/processProfiles");
const { isVerifiedKnowledge, knowledgeProfileKey } = await import("../src/knowledgeBase");
const { hostFitsTrackAndEntity, isInformationalPageUrl, isUtilityPlatformUrl } = await import("../src/portalChannel");
const { findApplicationProfile } = await import("../src/applicationDocs");
const { utilityTrackPresentation } = await import("../src/utilityFilingLookup");
const { shippedRecordFor, requirementMayBlock, seedShippedUtilityFilingDoors, shippedUtilityRequirementRecords } = await import("../src/utilityRequirements");
const { eligibilityRecordsForState, evaluateEligibility } = await import("../src/eligibilityLimits");
const { filingEmailChannelFor } = await import("../src/filingEmail");

const db = await openDatabase();

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

interface Citation { field: string; value?: unknown; sourceUrl: string; quote: string; fetchedAt: string }
type CitedProfile = AhjProcessProfile & { citations?: Citation[] };
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", name), "utf8"));
const ahjFile = read("reference-ahj-processes.json") as { count: number; profiles: CitedProfile[] };
const STATE = "ID";
const cited = ahjFile.profiles.filter((p) => p.state === STATE && Array.isArray(p.citations) && p.citations.length > 0);
const project = (ahj: string, extra: Record<string, unknown> = {}) => ({ id: `t-${ahj}`, state: STATE, ahj, city: ahj, ...extra }) as unknown as ProjectRecord;
const URL_RE = /^https:\/\/\S+$/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const doorOf = (p: CitedProfile) => p.citations!.find((c) => c.field === "submissionMethod");

await run("the cited rows ship whole; count stays true", () => {
  assert.equal(ahjFile.count, ahjFile.profiles.length, "header count matches the rows");
  assert.ok(cited.length >= 6, `cited ${STATE} rows on file (${cited.length})`);
  const keys = cited.map((p) => p.ahj.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, "one row per AHJ");
  for (const p of cited) {
    assert.match(p.reviewerNotes, /NOT verified/, `${p.ahj}: notes say not verified`);
    for (const c of p.citations!) {
      assert.ok(c.field, `${p.ahj}: citation names its field`);
      assert.match(c.sourceUrl, URL_RE, `${p.ahj}: https source`);
      assert.ok(c.quote.trim().length >= 8, `${p.ahj}: verbatim quote`);
      assert.match(c.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${p.ahj}: fetchedAt`);
      assert.ok(!isInformationalPageUrl(String(c.value ?? "")) || c.field !== "submissionMethod", `${p.ahj}: a door is never an information page`);
    }
    if (p.documents) {
      assert.match(p.documents.sourceUrl, URL_RE, `${p.ahj}: documents cite an https page`);
      assert.ok(p.documents.items.length > 0 && p.documents.quote.length >= 8, `${p.ahj}: documents carry items and the page's words`);
    }
  }
});

await run("each cited row resolves for its city; its door is the cited value", () => {
  for (const p of cited) {
    const found = findAhjProcessProfile(project(`City of ${p.ahj}`)) ?? findAhjProcessProfile(project(p.ahj));
    assert.equal(found?.ahj, p.ahj, `${p.ahj}: resolves to its own row`);
    const door = doorOf(p);
    if (!door) continue;
    const value = String(door.value ?? "");
    assert.ok(value, `${p.ahj}: the door citation carries its value`);
    assert.ok(p.submissionMethod.includes(value), `${p.ahj}: the method holds the cited door ${value}`);
    // The quote or the page's own link carries the door: an address or a URL in the method, never a guess.
    assert.ok(URL_RE.test(p.submissionMethod) || EMAIL_RE.test(p.submissionMethod), `${p.ahj}: the method is a link or an address`);
  }
});

await run("every portal door fits the PERMIT track and is never a utility platform — rule 5", () => {
  let checked = 0;
  for (const p of cited) {
    if (!URL_RE.test(p.submissionMethod)) continue;
    checked++;
    assert.equal(isInformationalPageUrl(p.submissionMethod), false, `${p.ahj}: not an information page`);
    assert.equal(hostFitsTrackAndEntity("permit", null, p.submissionMethod, "kb").fits, true, `${p.ahj}: fits the permit track`);
    assert.equal(isUtilityPlatformUrl(p.submissionMethod), false, `${p.ahj}: never a utility door`);
  }
  assert.ok(checked >= 5, `portal doors checked (${checked})`);
});

await run("the boot seed writes each cited row as a SEEDED KB row: never verified, never official", () => {
  for (const p of cited) {
    const row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: STATE, ahj: p.ahj, utility: "" })]);
    assert.ok(row, `${p.ahj}: KB row seeded`);
    assert.equal(row!.confidence, "seeded", `${p.ahj}: confidence seeded`);
    assert.equal(isVerifiedKnowledge(row), false, `${p.ahj}: not verified`);
    assert.ok(!String(row!.verified_by ?? "").trim(), `${p.ahj}: no verifier stamped`);
  }
});

await run("a seeded intake ADDRESS shows on the card but is never a sendable filing address — rule 1", () => {
  const emailRows = cited.filter((p) => EMAIL_RE.test(p.submissionMethod) && !URL_RE.test(p.submissionMethod));
  assert.ok(emailRows.length >= 1, "an email-door row is on file");
  for (const p of emailRows) {
    const proj = project(`City of ${p.ahj}`);
    const profile = findApplicationProfile(proj);
    assert.ok(EMAIL_RE.test(profile.submissionMethod), `${p.ahj}: the card names the address (${profile.submissionMethod})`);
    for (const track of ["building", "combo", "electrical"] as const) {
      assert.equal(filingEmailChannelFor(db, proj, track), null, `${p.ahj}/${track}: no person-verified address, so nothing may send`);
    }
  }
  // An email method WITHOUT an address still reads "Email" (the operator rows are unchanged).
  const bare = ahjFile.profiles.find((p) => p.state === STATE && /^email$/i.test(p.submissionMethod.trim()));
  if (bare) assert.equal(findApplicationProfile(project(bare.ahj)).submissionMethod, "Email");
});

await run("the utility's shipped record: seeded items, a whole cited door, a block only where the words name it", () => {
  const withDoor = shippedUtilityRequirementRecords().filter((r) => r.states.includes(STATE) && r.filingDoor);
  assert.ok(withDoor.length >= 1, "a utility record with a filing door");
  for (const rec of withDoor) {
    const again = shippedRecordFor(STATE, rec.utility);
    assert.equal(again?.utility, rec.utility, `${rec.utility}: matches its own name`);
    for (const item of rec.requirements) {
      assert.equal(item.tier, "seeded", `${rec.utility}/${item.key}: seeded`);
      assert.match(item.sourceUrl, URL_RE, `${rec.utility}/${item.key}: https source`);
      assert.ok(item.quote.length >= 8 && item.fetchedAt, `${rec.utility}/${item.key}: quote + fetchedAt`);
      if (item.whenMissing === "blocker") assert.equal(requirementMayBlock(item), true, `${rec.utility}/${item.key}: a blocker only where the quote names the item`);
    }
    const door = rec.filingDoor!;
    assert.match(door.url, URL_RE);
    assert.match(door.sourceUrl, URL_RE);
    assert.ok(door.quote.length >= 8 && /^\d{4}-\d{2}-\d{2}/.test(door.fetchedAt), `${rec.utility}: door quote + fetchedAt`);
    assert.equal(isInformationalPageUrl(door.url), false, `${rec.utility}: the door is not an information page`);
    assert.equal(hostFitsTrackAndEntity("permit", null, door.url, "kb").fits, false, `${rec.utility}: never a permit door (rule 5)`);
  }
});

await run("the utility door lands SEEDED on the utility row and is what the NEM track reads; never official", () => {
  const rec = shippedUtilityRequirementRecords().find((r) => r.states.includes(STATE) && r.filingDoor)!;
  const row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: STATE, utility: rec.utility })]);
  assert.ok(row, "utility KB row seeded at boot");
  assert.equal(row!.portal_url, rec.filingDoor!.url);
  assert.equal(row!.confidence, "seeded");
  assert.equal(isVerifiedKnowledge(row), false);
  assert.doesNotMatch(String(row!.sources_json), /"sourceType":"official"/, "not an official source");
  const view = utilityTrackPresentation(db, { state: STATE, utility: rec.utility });
  assert.equal(view.portalUrl, rec.filingDoor!.url, "the NEM track names the door");
  assert.match(view.channel, /seeded/i, "and says it is seeded");
  assert.equal(seedShippedUtilityFilingDoors(db), 1, "re-seeding is idempotent (rewrites the same seeded row)");
});

await run("a person's verified utility row is never overwritten by the shipped door — rule 3", () => {
  const rec = shippedUtilityRequirementRecords().find((r) => r.states.includes(STATE) && r.filingDoor)!;
  const key = knowledgeProfileKey({ state: STATE, utility: rec.utility });
  const personUrl = "https://example.invalid/person-verified";
  db.run("UPDATE permit_utility_knowledge SET portal_url = ?, verified_at = ?, verified_by = ? WHERE profile_key = ?", [personUrl, "2026-11-10T00:00:00Z", "test-person", key]);
  assert.equal(seedShippedUtilityFilingDoors(db), 0, "nothing written over a verified row");
  const row = db.get<Record<string, unknown>>("SELECT portal_url, verified_by FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
  assert.equal(row!.portal_url, personUrl);
  assert.equal(row!.verified_by, "test-person");
  db.run("UPDATE permit_utility_knowledge SET verified_at = NULL, verified_by = '' WHERE profile_key = ?", [key]);
});

await run("an incomplete door is no door: no https link, no quote or no fetchedAt seeds nothing", () => {
  const base = shippedUtilityRequirementRecords().find((r) => r.states.includes(STATE) && r.filingDoor)!;
  const tmp = path.join(path.dirname(process.env.AUTOPILOT_DB_PATH || "/tmp/x"), "door-broken.json");
  const bad = (door: Record<string, unknown>, i: number) => ({ ...base, utility: `Broken Door Utility ${i}`, matchNames: [`broken door utility ${i}`], filingDoor: door });
  const good = base.filingDoor!;
  fs.writeFileSync(tmp, JSON.stringify({ records: [
    bad({ ...good, url: good.url.replace(/^https/, "http") }, 1),
    bad({ ...good, quote: "" }, 2),
    bad({ ...good, fetchedAt: "" }, 3),
  ] }));
  const records = shippedUtilityRequirementRecords(tmp);
  assert.equal(records.length, 3, "the records still load");
  assert.ok(records.every((r) => !r.filingDoor), "but no door survives");
  assert.equal(seedShippedUtilityFilingDoors(db, records), 0);
});

await run("the utility's program limit loads SEEDED, cited, and only warns (appliesOnlyTo)", () => {
  const recs = eligibilityRecordsForState(db, STATE).filter((r) => r.authorityKind === "utility_program" && r.authority);
  assert.ok(recs.length >= 1, "a program record on file");
  for (const r of recs) {
    assert.equal(r.confidence, "seeded", `${r.authority}: seeded`);
    const limit = r.limits.maxAcKw!;
    assert.ok(limit, `${r.authority}: an AC cap`);
    assert.match(limit.citation.sourceUrl, URL_RE);
    assert.ok(limit.citation.quote.includes(String(limit.value)), `${r.authority}: the quote carries ${limit.value}`);
    const findings = evaluateEligibility([r], {
      state: STATE, utility: r.authority, ahj: "", dcKw: 40, acKw: limit.value + 5, programDcKw: 40, programAcKw: limit.value + 5,
      combinedNote: "", micro: false, stringsPerInverter: null, productionMeterTexts: [], clientCertifications: null, today: "2026-11-10",
    } as never);
    const over = findings.find((f) => f.fieldName === "acKw");
    assert.ok(over, `${r.authority}: over the cap is reported`);
    assert.equal(over!.severity, "warning", `${r.authority}: a seeded, scoped cap warns, never blocks`);
  }
});

await run("nothing here claims official or verified: doors stay seeded whatever the host (rule 3, #683)", () => {
  const util = read("reference-utility-application-requirements.json") as { records: Array<{ states: string[] }> };
  const elig = read("reference-eligibility-limits.json") as { records: Array<{ state: string }> };
  const rows: unknown[] = [...cited, ...util.records.filter((r) => r.states.includes(STATE)), ...elig.records.filter((r) => r.state === STATE)];
  for (const r of rows) assert.doesNotMatch(JSON.stringify(r), /"verified(?:By|At)?"\s*:|"official"|"tier"\s*:/, "no verified / official claim");
  // A door on a government host is still only seeded: it never claims a tier.
  for (const p of cited) {
    const door = doorOf(p);
    if (door) assert.equal((door as { tier?: string }).tier, undefined, `${p.ahj}: the door claims no tier`);
  }
});

console.log(failures ? `\n${failures} failure(s)` : "\nall ok");
if (failures) process.exit(1);
