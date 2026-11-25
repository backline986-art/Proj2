// CENTRAL OREGON REFERENCE DATA, SEEDED AND CITED (2026-11-10). The rows this pins live in the shipped
// reference files that already hold each kind of fact (no new loader, no code change):
//   - backend/data/reference-ahj-processes.json: the county's OR process row, now carrying `citations`
//     read from the county's own pages and the state building division's (door, electrical issuer,
//     building + electrical permits, documents, posted review times, fees);
//   - backend/data/reference-utility-application-requirements.json: a cooperative's application list and
//     its `filingDoor` (the agreement form its own net-metering page links);
//   - backend/data/reference-eligibility-limits.json: two cooperatives' program size limits;
//   - backend/data/reference-hand-check-pages.json: the pages a person must read by hand (a city site
//     that refused every automated read; a utility's address map the research does not call).
// Pins:
//   - every cited row lands SEEDED (rule 3): KB row not verified and not official; items tier "seeded";
//     program limits "seeded" and warn only; nothing claims a tier;
//   - the county door fits the PERMIT track only (rule 5) and is proposed for one-click Confirm because
//     its page is on a government host; the cooperative's door fits the NEM track, no AHJ row names it,
//     and it is proposed for Edit only (its host is not a government host);
//   - the cited fields decide the structure: building + electrical, both issued by the county, same door;
//   - each citation is whole: https source, verbatim quote, fetchedAt.
// The test selects the data by STATE, never by a place name (placeNameGuard).
// Run: tsx backend/test/oregonCentralSeedData.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AhjProcessCitation, AhjProcessProfile, ProjectRecord } from "../../shared/src/types";

const { openDatabase } = await import("../src/db");
const { findAhjProcessProfile } = await import("../src/processProfiles");
const { isVerifiedKnowledge, knowledgeProfileKey } = await import("../src/knowledgeBase");
const { hostFitsTrackAndEntity, isInformationalPageUrl, isUtilityPlatformUrl } = await import("../src/portalChannel");
const { citedElectricalIssuer, citedRowStructure } = await import("../src/ahjRowCitations");
const { permitCandidates, shippedDoorCandidates, candidateSkipReasons } = await import("../src/filingDestinationProposals");
const { shippedRecordFor, requirementMayBlock, shippedUtilityRequirementRecords } = await import("../src/utilityRequirements");
const { eligibilityRecordsForState, evaluateEligibility } = await import("../src/eligibilityLimits");
const { handCheckPages, handCheckPagesFor } = await import("../src/handCheckPages");

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

type CitedProfile = AhjProcessProfile & { citations?: AhjProcessCitation[] };
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", name), "utf8"));
const ahjFile = read("reference-ahj-processes.json") as { count: number; profiles: CitedProfile[] };
const STATE = "OR";
const cited = ahjFile.profiles.filter((p) => p.state === STATE && Array.isArray(p.citations) && p.citations.length > 0);
const project = (ahj: string) => ({ id: `t-${ahj}`, state: STATE, ahj, city: "", utility: "" }) as unknown as ProjectRecord;
const URL_RE = /^https:\/\/\S+$/i;
const doorOf = (p: CitedProfile) => p.citations!.find((c) => c.field === "submissionMethod");
const utilRecords = () => shippedUtilityRequirementRecords().filter((r) => r.states.includes(STATE) && r.filingDoor);

await run("the cited rows ship whole; count stays true", () => {
  assert.equal(ahjFile.count, ahjFile.profiles.length, "header count matches the rows");
  assert.ok(cited.length >= 1, `cited ${STATE} rows on file (${cited.length})`);
  for (const p of cited) {
    assert.match(p.reviewerNotes, /NOT verified/, `${p.ahj}: notes say not verified`);
    for (const c of p.citations!) {
      assert.ok(c.field, `${p.ahj}: citation names its field`);
      if (c.value !== undefined) assert.equal(typeof c.value, "string", `${p.ahj}: a citation's value is a string`);
      assert.match(c.sourceUrl, URL_RE, `${p.ahj}: https source`);
      assert.ok(c.quote.trim().length >= 8, `${p.ahj}: verbatim quote`);
      assert.match(c.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${p.ahj}: fetchedAt`);
    }
    assert.ok(p.documents && URL_RE.test(p.documents.sourceUrl) && p.documents.items.length > 0, `${p.ahj}: documents cite a page`);
  }
});

await run("each cited row resolves for its jurisdiction; its door is the cited value and fits the PERMIT track only (rule 5)", () => {
  for (const p of cited) {
    assert.equal(findAhjProcessProfile(project(p.ahj))?.ahj, p.ahj, `${p.ahj}: resolves to its own row`);
    const door = doorOf(p)!;
    assert.ok(door, `${p.ahj}: a cited door`);
    assert.equal(p.submissionMethod, door.value, `${p.ahj}: the method is the cited door`);
    assert.match(p.submissionMethod, URL_RE);
    assert.equal(isInformationalPageUrl(p.submissionMethod), false, `${p.ahj}: not an information page`);
    assert.equal(hostFitsTrackAndEntity("permit", null, p.submissionMethod, "kb").fits, true, `${p.ahj}: fits the permit track`);
    assert.equal(isUtilityPlatformUrl(p.submissionMethod), false, `${p.ahj}: never a utility door`);
  }
});

await run("the cited fields decide the structure: building + electrical, issued by the AHJ itself at the same door", () => {
  for (const p of cited) {
    const issuer = citedElectricalIssuer(p);
    assert.equal(issuer?.kind, "ahj", `${p.ahj}: the AHJ issues the electrical permit`);
    assert.equal(issuer?.separateCounter, null, `${p.ahj}: no other counter`);
    const s = citedRowStructure(p);
    assert.ok(s && "structure" in s && s.structure === "separate", `${p.ahj}: two permits, read from the cited flags`);
  }
});

await run("the AHJ door is PROPOSED for a person's one-click Confirm (government page), never verified by the data", () => {
  for (const p of cited) {
    const cands = permitCandidates({ profile: p, lookup: null, tracks: ["building", "electrical"] });
    const door = cands.find((c) => c.kind === "portal" && c.address === p.submissionMethod);
    assert.ok(door, `${p.ahj}: the cited door is a candidate`);
    assert.deepEqual(candidateSkipReasons(door!, []), [], `${p.ahj}: its page passes the one citation test`);
    const row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: STATE, ahj: p.ahj, utility: "" })]);
    if (row) {
      assert.equal(isVerifiedKnowledge(row), false, `${p.ahj}: the KB row is not verified`);
      assert.ok(!String(row.verified_by ?? "").trim(), `${p.ahj}: no verifier stamped`);
    }
  }
});

await run("the cooperative's record: seeded items, a whole NEM door off a government host (Edit only), a block only where the words name it", () => {
  const withDoor = utilRecords();
  assert.ok(withDoor.length >= 1, "a utility record with a filing door");
  for (const rec of withDoor) {
    assert.equal(shippedRecordFor(STATE, rec.utility)?.utility, rec.utility, `${rec.utility}: matches its own name`);
    for (const item of rec.requirements) {
      assert.equal(item.tier, "seeded", `${rec.utility}/${item.key}: seeded`);
      assert.match(item.sourceUrl, URL_RE);
      assert.ok(item.quote.length >= 8 && item.fetchedAt, `${rec.utility}/${item.key}: quote + fetchedAt`);
      if (item.whenMissing === "blocker") assert.equal(requirementMayBlock(item), true, `${rec.utility}/${item.key}: the quote names the item`);
    }
    const door = rec.filingDoor!;
    assert.match(door.url, URL_RE);
    assert.equal(isInformationalPageUrl(door.url), false, `${rec.utility}: the door is not an information page`);
    // The cooperative's own web form: it fits the NEM track (rule 5's predicate), and no AHJ row names it.
    assert.equal(hostFitsTrackAndEntity("nem", null, door.url, "kb").fits, true, `${rec.utility}: fits the NEM track`);
    assert.ok(!cited.some((p) => JSON.stringify(p).includes(door.url)), `${rec.utility}: no AHJ row names the NEM door`);
    const cand = shippedDoorCandidates(STATE, rec.utility);
    assert.equal(cand.length, 1, `${rec.utility}: the door is a candidate`);
    assert.ok(candidateSkipReasons(cand[0], []).some((r) => /not a government host/.test(r)), `${rec.utility}: not one-click (host is not official)`);
  }
});

await run("the cooperative's door lands SEEDED on its KB row; never official or verified", () => {
  for (const rec of utilRecords()) {
    const row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: STATE, utility: rec.utility })]);
    if (!row) continue; // only a utility whose door the boot seed writes; checked where present
    assert.equal(isVerifiedKnowledge(row), false, `${rec.utility}: not verified`);
    assert.doesNotMatch(String(row.sources_json ?? ""), /"sourceType":"official"/, `${rec.utility}: not official`);
  }
});

await run("the cooperatives' program limits load SEEDED, cited, and only warn (appliesOnlyTo)", () => {
  const recs = eligibilityRecordsForState(db, STATE).filter((r) => r.authorityKind === "utility_program" && r.authority && r.limits.maxDcKw && /coop/i.test(r.authority));
  assert.ok(recs.length >= 2, `cooperative program records on file (${recs.length})`);
  for (const r of recs) {
    assert.equal(r.confidence, "seeded", `${r.authority}: seeded`);
    const limit = r.limits.maxDcKw!;
    assert.match(limit.citation.sourceUrl, URL_RE);
    assert.match(limit.citation.quote.replace(/\s+/g, ""), new RegExp(`${limit.value}kW`, "i"), `${r.authority}: the quote carries ${limit.value} kW`);
    const findings = evaluateEligibility([r], {
      state: STATE, utility: r.authority, ahj: "", dcKw: limit.value + 10, acKw: limit.value + 5, programDcKw: limit.value + 10, programAcKw: limit.value + 5,
      combinedNote: "", micro: false, stringsPerInverter: null, productionMeterTexts: [], clientCertifications: null, today: "2026-11-10",
    } as never);
    const over = findings.find((f) => f.fieldName === "dcKw");
    assert.ok(over, `${r.authority}: over the cap is reported`);
    assert.equal(over!.severity, "warning", `${r.authority}: a seeded, scoped cap warns, never blocks`);
  }
});

await run("pages a person reads by hand load for their authority", () => {
  const pages = handCheckPages().filter((p) => p.state === STATE);
  assert.ok(pages.length >= 3, `${STATE} hand-check pages (${pages.length})`);
  for (const p of pages) {
    assert.match(p.pageUrl, /^https?:\/\//);
    assert.equal(handCheckPagesFor(p.authorityKind, STATE, p.authority).some((q) => q.pageUrl === p.pageUrl), true, `${p.authority}: found by its own name`);
  }
});

await run("nothing here claims official or verified: doors stay seeded whatever the host (rule 3, #683)", () => {
  const util = read("reference-utility-application-requirements.json") as { records: Array<{ states: string[]; filingDoor?: unknown }> };
  const elig = read("reference-eligibility-limits.json") as { records: Array<{ state: string }> };
  const rows: unknown[] = [...cited, ...util.records.filter((r) => r.states.includes(STATE) && r.filingDoor), ...elig.records.filter((r) => r.state === STATE)];
  for (const r of rows) assert.doesNotMatch(JSON.stringify(r), /"verified(?:By|At)?"\s*:|"official"|"tier"\s*:/, "no verified / official claim");
});

console.log(failures ? `\n${failures} failure(s)` : "\nall ok");
if (failures) process.exit(1);
