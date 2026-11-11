// A STATE'S ELECTRICAL PERMIT AUTHORITY, AS CITED DATA READ FROM THE STATE'S OWN PAGES (2026-11-11).
//
// Where a state issues electrical permits wherever a city or county does not run its own program, the
// state's own government pages can say, for every local authority at once, who issues the electrical
// permit. The rows this pins live in backend/data/reference-ahj-processes.json (no new loader, no code):
//   - each local row carries a citations[field=electricalPermitIssuer] read from the STATE's page
//     (first word "city" / "county" = the AHJ itself, "state" = the state authority's row);
//   - the state authority's own row (stateAuthorityFor "electrical") carries its permit system, its
//     fee for a solar / storage job and what its inspector asks for, each as a cited note.
// Pins, on the real reference file, selected by STATE and by the state authority's own cited host
// (no place name here):
//   1. every issuer citation read from the state's page is whole, on a government host, in the
//      vocabulary, and agrees with what the AHJ's own page already said (none is silently ignored);
//   2. a row the state's page gives to the STATE routes its electrical track to the state authority's
//      row, and its building track stays with the AHJ; a row it gives to the AHJ routes nowhere else;
//   3. the state authority's door is NOT on file: no submission method and no door citation. Its
//      online permit system is a cited note, never a filing door (a person records the door);
//   4. the state's fee lines are whole, on a government host, and each quote prints the amounts;
//   5. EACH ROW LOADS AT THE TIER IT CLAIMS: none claims a tier, so each loads seeded — its KB row is
//      not verified and not official, and the shared loader's answer for an unclaimed row is "seeded".
// Run: tsx backend/test/stateElectricalIssuerData.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AhjProcessProfile, ProjectRecord } from "../../shared/src/types";

const { openDatabase } = await import("../src/db");
const { wholeCitations, citedElectricalIssuer, electricalIssuerKindOf, stateAuthorityRowFor, isStateAuthorityRow } = await import("../src/ahjRowCitations");
const { projectForTrack, trackIssuer } = await import("../src/permitProcess");
const { isVerifiedKnowledge, knowledgeProfileKey } = await import("../src/knowledgeBase");
const { isOfficialSourceHost, shippedRowTier, sourceHostOf, siteOfHost } = await import("../../shared/src/officialSource");

const db = await openDatabase();

let failures = 0;
const run = (label: string, fn: () => void) => {
  try { fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const file = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "reference-ahj-processes.json"), "utf8")) as { count: number; profiles: AhjProcessProfile[] };
const raw = (p: AhjProcessProfile) => ((p as unknown as { citations?: Array<Record<string, string>> }).citations ?? []);
const URL_RE = /^https:\/\/\S+$/i;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// The states whose electrical authority row cites its own permit system: this data's subject.
const authorities = file.profiles.filter((p) => isStateAuthorityRow(p) && p.stateAuthorityFor!.includes("electrical") && wholeCitations(p, "permitSystem").length > 0);
/** The state authority's own site (the host its permit-system note was read on). */
const stateSite = (authority: AhjProcessProfile) => siteOfHost(sourceHostOf(wholeCitations(authority, "permitSystem")[0].sourceUrl));
/** A local row's issuer citations that were read on the STATE's site. */
const fromState = (p: AhjProcessProfile, authority: AhjProcessProfile) =>
  wholeCitations(p, "electricalPermitIssuer").filter((c) => siteOfHost(sourceHostOf(c.sourceUrl)) === stateSite(authority));
const localRows = (authority: AhjProcessProfile) => file.profiles.filter((p) => p.state === authority.state && !isStateAuthorityRow(p) && fromState(p, authority).length > 0);
const project = (p: AhjProcessProfile) => ({ id: `t-${p.ahj}`, state: p.state, ahj: p.ahj, city: "", utility: "" }) as unknown as ProjectRecord;

run("a state electrical authority with a cited permit system is on file, one per state", () => {
  assert.ok(authorities.length >= 1, "at least one state authority row");
  for (const a of authorities) assert.equal(stateAuthorityRowFor(a.state, "electrical")?.ahj, a.ahj, `${a.state}: exactly one authority row`);
  assert.equal(file.count, file.profiles.length, "header count matches the rows");
});

run("every issuer citation read from the state's page is whole, on a government host, and agrees with the AHJ's own page", () => {
  for (const a of authorities) {
    const rows = localRows(a);
    assert.ok(rows.length >= 10, `${a.state}: local rows cited from the state's page (${rows.length})`);
    const kinds = new Set<string>();
    for (const p of rows) {
      for (const c of fromState(p, a)) {
        assert.match(c.sourceUrl, URL_RE, `${p.ahj}: https source`);
        assert.match(c.fetchedAt, AT_RE, `${p.ahj}: fetchedAt`);
        assert.equal(isOfficialSourceHost(c.sourceUrl), true, `${p.ahj}: the state's page is on a government host`);
        assert.ok(c.quote.length >= 20, `${p.ahj}: the page's own words`);
        const kind = electricalIssuerKindOf(c.value);
        assert.ok(kind, `${p.ahj}: "${c.value}" is in the issuer vocabulary`);
        kinds.add(kind!);
      }
      // All of the row's issuer citations (its own page's and the state's) say the same kind: no conflict.
      assert.equal(raw(p).filter((c) => c.field === "electricalPermitIssuer").length, wholeCitations(p, "electricalPermitIssuer").length, `${p.ahj}: every issuer citation is whole`);
      assert.ok(citedElectricalIssuer(p), `${p.ahj}: its issuer citations agree`);
      assert.match(p.reviewerNotes, /NOT verified/, `${p.ahj}: notes say not verified`);
    }
    assert.deepEqual([...kinds].sort(), ["ahj", "state"], `${a.state}: the state's page gives some rows to the AHJ and some to the state`);
  }
});

run("a row the state's page gives to the STATE files its electrical permit with the state authority; the building permit stays with the AHJ", () => {
  for (const a of authorities) {
    let toState = 0;
    for (const p of localRows(a)) {
      const proj = project(p);
      const kind = citedElectricalIssuer(p)!.kind;
      const view = projectForTrack(proj, "electrical");
      assert.equal(projectForTrack(proj, "building"), proj, `${p.ahj}: the building view is the project itself`);
      if (kind === "state") {
        toState++;
        assert.equal(view.ahj, a.ahj, `${p.ahj}: the electrical track's issuer is the state authority`);
        assert.equal(trackIssuer(proj, "mpu").name, a.ahj, `${p.ahj}: a panel upgrade follows electrical`);
      } else {
        assert.equal(view, proj, `${p.ahj}: the AHJ issues its own electrical permit`);
      }
    }
    assert.ok(toState >= 2, `${a.state}: rows routed to the state (${toState})`);
  }
});

run("the state authority's door is not on file: its online permit system is a cited note, never a filing door", () => {
  for (const a of authorities) {
    assert.equal(String(a.submissionMethod ?? "").trim(), "", `${a.ahj}: no submission method (a person records the door)`);
    assert.ok(!raw(a).some((c) => c.field === "submissionMethod"), `${a.ahj}: no door citation`);
    assert.doesNotMatch(a.reviewerNotes, /https?:\/\//i, `${a.ahj}: the notes name no address (nothing reads one out of prose)`);
    for (const c of wholeCitations(a, "permitSystem")) assert.equal(isOfficialSourceHost(c.sourceUrl), true, `${a.ahj}: read on the state's own government page`);
    assert.match(a.reviewerNotes, /NOT verified/);
  }
});

run("the state's fee lines for a solar / storage job are whole, on a government host, and each quote prints its amounts", () => {
  const amountsOf = (s: string) => s.match(/\$\d[\d,]*(?:\.\d+)?/g) ?? [];
  for (const a of authorities) {
    const fees = wholeCitations(a, "fees");
    assert.ok(fees.length >= 4, `${a.ahj}: fee lines on file (${fees.length})`);
    assert.equal(fees.length, raw(a).filter((c) => c.field === "fees").length, `${a.ahj}: every fee line is whole`);
    let priced = 0;
    for (const c of fees) {
      assert.equal(isOfficialSourceHost(c.sourceUrl), true, `${a.ahj}: fee read on a government page`);
      for (const amount of amountsOf(c.value)) { priced++; assert.ok(c.quote.includes(amount), `${a.ahj}: the quote prints ${amount} ("${c.value}")`); }
    }
    assert.ok(priced >= 4, `${a.ahj}: priced fee lines (${priced})`);
    assert.ok(fees.some((c) => /solar|renewable/i.test(c.quote) && /storage/i.test(c.quote)), `${a.ahj}: a quote names solar and storage`);
    assert.ok(a.documents && URL_RE.test(a.documents.sourceUrl) && a.documents.items.length > 0, `${a.ahj}: what the inspector asks for is cited`);
  }
});

run("each row loads at the tier it claims: none claims a tier, so each loads SEEDED (rule 3)", () => {
  for (const a of authorities) {
    for (const p of [a, ...localRows(a)]) {
      assert.doesNotMatch(JSON.stringify(p), /"verified(?:By|At)?"\s*:|"tier"\s*:|"confidence"\s*:/, `${p.ahj}: no tier, confidence or verified claim`);
      // The one shared loader for a shipped row's tier: an unclaimed row is seeded, whatever its host.
      for (const c of wholeCitations(p)) {
        const t = shippedRowTier((c as unknown as { tier?: unknown }).tier, { sourceUrl: c.sourceUrl, quote: c.quote, fetchedAt: c.fetchedAt, quoteStatesValue: () => true });
        assert.equal(t.tier, "seeded", `${p.ahj}/${c.field}: loads seeded`);
      }
      const row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: p.state, ahj: p.ahj, utility: "" })]);
      if (!row) continue;
      assert.equal(isVerifiedKnowledge(row), false, `${p.ahj}: the KB row is not verified and not official`);
      assert.ok(!String(row.verified_by ?? "").trim(), `${p.ahj}: no verifier stamped`);
      assert.doesNotMatch(String(row.sources_json ?? ""), /"sourceType":"official"/, `${p.ahj}: not an official source`);
    }
  }
});

console.log(failures ? `\n${failures} failure(s)` : "\nall ok");
process.exit(failures ? 1 : 0);
