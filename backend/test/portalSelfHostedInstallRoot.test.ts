// ISSUE #152 — A SELF-HOSTED PERMIT SYSTEM'S INSTALL ROOT ON A STATE GOVERNMENT HOST IS A PORTAL.
//
// A state's FAQ links its online electrical permit system at the root of a self-hosted install
// (https://<state host>/etrakit3/, no page after it). isInformationalPageUrl's state-agency rule
// (#86) read that bare root as an agency content page, so hostFitsTrackAndEntity answered
// not_a_portal on the permit track: the lookup dropped the link and the Destinations queue could
// neither Confirm nor Edit it, so the state's electrical track had no door at all.
//
// Pins (rule 5 — the ONE predicate, hostFitsTrackAndEntity → isInformationalPageUrl):
//   (r) MUST-PASS: the install root of a recognised self-hosted permit system (the existing
//       SELF_HOSTED_PERMIT_PATH_SEGMENT list) on a state government host is not an information page
//       and fits the permit track, from the KB and from research;
//   (c) MUST-EXCLUDE: an agency content page on the SAME host stays an information page and fits
//       neither track;
//   (u) MUST-EXCLUDE: the install root never fits the NEM track (a permit system is never a
//       utility's interconnection portal);
//   (d) the shipped state authority row's seeded door is that install root, and it fits the
//       permit track and not the NEM track.
// Synthetic hosts except the one public address the issue names. No network.
//
// KILL TEST: drop the SELF_HOSTED_PERMIT_PATH_SEGMENT line in isAgencyContentPage → (r) and (d) fail.
//
// Run: npx tsx backend/test/portalSelfHostedInstallRoot.test.ts
import { REPO } from "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { isInformationalPageUrl, hostFitsTrackAndEntity } = await import("../src/portalChannel");

let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   - ${label}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${label}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const ISSUE_URL = "https://web.dbs.idaho.gov/etrakit3/";
const INSTALL_ROOTS = [
  ISSUE_URL,
  "https://permits.licensing.zz-example.id.gov/eTRAKiT/",
  "https://web.building.ut.gov/EnerGov_Prod/",
  "https://apply.labor.or.gov/CityViewPortal/",
  "https://web.dbs.idaho.gov/etrakit3",
];
const CONTENT_PAGES = [
  "https://web.dbs.idaho.gov/about/",
  "https://web.dbs.idaho.gov/electrical/permits/",
  "https://dopl.idaho.gov/ele/ele-faqs/",
];

await check("(r) the install root on a state host is not an information page and fits the permit track", () => {
  for (const url of INSTALL_ROOTS) {
    assert.equal(isInformationalPageUrl(url), false, `${url}: not an information page`);
    for (const source of ["kb", "research"] as const) {
      for (const track of ["electrical", "building"]) {
        const fit = hostFitsTrackAndEntity(track, null, url, source);
        assert.equal(fit.fits, true, `${track} ${source} ${url}: ${fit.reason}`);
      }
    }
  }
});

await check("(c) an agency content page on the same host stays an information page", () => {
  for (const url of CONTENT_PAGES) {
    assert.equal(isInformationalPageUrl(url), true, `${url}: still informational`);
    for (const track of ["electrical", "nem"]) {
      const fit = hostFitsTrackAndEntity(track, null, url, "kb");
      assert.equal(fit.fits, false, `${track} ${url}`);
      assert.equal(fit.code, "not_a_portal", `${track} ${url}: ${fit.code}`);
    }
  }
});

await check("(u) the install root never fits the NEM track", () => {
  for (const url of INSTALL_ROOTS) {
    for (const source of ["kb", "research"] as const) {
      const fit = hostFitsTrackAndEntity("nem", null, url, source);
      assert.equal(fit.fits, false, `nem ${source} ${url}: fits`);
    }
  }
});

await check("(d) the shipped state authority row's seeded door is an install root that fits the permit track only", () => {
  const file = JSON.parse(fs.readFileSync(path.join(REPO, "backend/data/reference-ahj-processes.json"), "utf8")) as { profiles: Array<{ submissionMethod?: string; stateAuthorityFor?: string[] }> };
  const doors = file.profiles.filter((p) => p.stateAuthorityFor?.includes("electrical") && String(p.submissionMethod ?? "").trim());
  assert.ok(doors.length > 0, "a state authority row carries a seeded door");
  for (const p of doors) {
    const url = String(p.submissionMethod).trim();
    assert.equal(hostFitsTrackAndEntity("electrical", null, url, "kb").fits, true, url);
    assert.equal(hostFitsTrackAndEntity("nem", null, url, "kb").fits, false, url);
  }
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nportalSelfHostedInstallRoot: all checks passed");
