// THE SHIPPED COUNTY PARCEL RECORDS LOAD AT THE TIER THEY CLAIM (data brief "parcel county records",
// after review-audit draft 09).
//
// backend/data/reference-jurisdiction-lookup-sources.json is per-county DATA, added by hand from each
// county's own GIS page. A record that is quietly dropped at load (a non-government service host, a
// missing field) or quietly downgraded (claims "official" or "verified" without meeting the bar) would
// make the parcel check say "not checked" or warn where its author meant it to block — with nobody told.
// This pins: every shipped record loads, at exactly the tier it claims, on a government host — or, on
// an ArcGIS Online host, only as a person-verified record bound to its service root (draft 16 B; the
// owner's yes 2026-11-10; Helm's conditions, parcelMapPlatform.test.ts).
//
// Reads the shipped file only; no database, no network.
//   npx tsx backend/test/parcelCountyRecords.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { sanitizeLookupSource } = await import("../src/parcelJurisdiction");
const { isGovernmentHost, sourceHostOf } = await import("../../shared/src/officialSource");

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "..", "data", "reference-jurisdiction-lookup-sources.json");

/** Every way a list of records fails the shipped bar, one line each (empty = all good). */
function recordProblems(records: unknown[]): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  records.forEach((raw, i) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const label = `record ${i} (${String(o.state ?? "?")} ${String(o.county ?? "?")})`;
    const { source, problem } = sanitizeLookupSource(raw);
    if (!source) { out.push(`${label}: dropped at load — ${problem}`); return; }
    const claimed = String(o.tier ?? "seeded").trim() || "seeded";
    if (source.tier !== claimed) out.push(`${label}: claims tier "${claimed}" but loads as "${source.tier}"`);
    const host = sourceHostOf(source.queryUrl.replace(/\{[a-zA-Z]+\}/g, "x"));
    const platform = source.hostedOn === "map_platform";
    if (!isGovernmentHost(host) && !platform) out.push(`${label}: service host ${host} is not a government host`);
    if (/(^|\.)arcgis\.com$/.test(host) && !(platform && source.tier === "verified" && source.verifiedBy && source.verifiedService))
      out.push(`${label}: ArcGIS Online host ${host} without a person-verified service root`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(source.fetchedAt)) out.push(`${label}: no fetchedAt`);
    if (!source.sourceUrl || !source.quote) out.push(`${label}: no source page or quote`);
    if (keys.has(source.key)) out.push(`${label}: a second record for ${source.key}`);
    keys.add(source.key);
  });
  return out;
}

console.log("\nthe shipped county parcel records");
await check("the shipped file parses and has a records list", () => {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { records?: unknown };
  assert.ok(Array.isArray(data.records));
});
await check("every shipped record loads, at the tier it claims, on a government host, with its source quoted", () => {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { records: unknown[] };
  assert.deepEqual(recordProblems(data.records), []);
});

console.log("\nthe check itself bites (synthetic records; every host invented)");
const GOOD = {
  state: "ID", county: "Example County", covers: { cities: ["Sampleton"] },
  queryUrl: "https://gis.examplecounty.gov/arcgis/rest/services/Parcels/MapServer/0/query?where=SITE_ADDR%3D%27{street}%27&outFields=JURIS&f=json",
  recordsPath: "features", jurisdictionField: "attributes.JURIS", unincorporatedValues: ["UNINC"],
  sourceName: "Example County GIS", sourceUrl: "https://www.examplecounty.gov/gis",
  quote: "Parcel services are published at gis.examplecounty.gov", fetchedAt: "2026-11-10T00:00:00Z", tier: "official",
};
await check("a good official record passes", () => assert.deepEqual(recordProblems([GOOD]), []));
await check("a record claiming official from a non-government page is caught (it would load seeded)", () => {
  const p = recordProblems([{ ...GOOD, sourceUrl: "https://www.example-blog.com/gis" }]);
  assert.match(p.join(" | "), /claims tier "official" but loads as "seeded"/);
});
await check("a record claiming verified with no named person is caught", () => {
  assert.match(recordProblems([{ ...GOOD, tier: "verified" }]).join(" | "), /claims tier "verified" but loads as "seeded"/);
});
await check("a record on ArcGIS Online is caught (dropped at load: not a government host)", () => {
  const p = recordProblems([{ ...GOOD, queryUrl: "https://services1.arcgis.com/abc/ArcGIS/rest/services/Parcels/FeatureServer/0/query?where={street}" }]);
  assert.match(p.join(" | "), /dropped at load — .*services1\.arcgis\.com is not a government host/);
});
await check("a person-verified ArcGIS Online record bound to its service root passes (draft 16 B)", () => {
  const root = "https://services9.arcgis.com/SyntheticOrg0001/arcgis/rest/services/Parcels/FeatureServer";
  assert.deepEqual(recordProblems([{
    ...GOOD, tier: "verified", verifiedBy: "Synthetic Reviewer", verifiedService: root,
    queryUrl: `${root}/0/query?where=SITE_ADDR%3D%27{street}%27&outFields=JURIS&f=json`,
    pageLinksHost: "examplecounty.maps.arcgis.com", quote: "Parcel maps: examplecounty.maps.arcgis.com",
  }]), []);
});
await check("two records for one county, or one with no source, are caught", () => {
  assert.match(recordProblems([GOOD, GOOD]).join(" | "), /a second record for ID\|example county/);
  assert.match(recordProblems([{ ...GOOD, tier: "seeded", quote: "" }]).join(" | "), /no source page or quote/);
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
