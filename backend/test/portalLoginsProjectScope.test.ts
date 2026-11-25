// THE PORTAL LOGINS MODAL SHOWS THE OPEN PROJECT'S LOGINS, NOT EVERY LOGIN THE CLIENT HOLDS (#684).
//
// Owner, 2026-11-09: "Its currently just showing them all it seems cluttered. Just show the ones
// needed to submit/missing for the portal we're working on." This runs the SHIPPED selection and
// list code, cut out of frontend/dashboard.js (brace-balanced, as recipeFlagRender.test.ts does),
// over synthetic tracks and credential METADATA (the API never returns a secret; none is used here).
//
// KILL: make plListHtml render view.others by default (or drop the plProjectPortals filter) ->
// (b) fails; drop the PL_NO_LOGIN_CHANNELS skip -> (a) fails; hide logins when tracks are unknown
// -> (c) fails; drop the missing-first sort -> (a) fails.
//
//   npx tsx backend/test/portalLoginsProjectScope.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";

const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
const constLine = (name: string): string => {
  const m = new RegExp(`^const ${name} = .*;$`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find const ${name}`);
  return m[0];
};
const constBlock = (name: string): string => {
  const m = new RegExp(`^const ${name} = \\[[\\s\\S]*?\\n\\];$`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find const ${name}`);
  return m[0];
};
const bundle = [
  ...["PL_NO_LOGIN_CHANNELS", "PORTAL_TYPE_NAMES", "PORTAL_VENDOR_NAMES"].map(constLine),
  constBlock("FEE_PAYER_CHOICES"),
  ...["esc", "humanize", "plPortalSlug", "portalHostname", "portalDisplayName", "plLoginFits", "plProjectPortals", "feePayerControlHtml", "plCredRowHtml", "plListHtml"].map(cut),
].join("\n\n");

type Cred = { id: string; portalType: string; portalUrl: string; usernameReference: string; hasSecret: boolean; feeResponsibility?: string };
type Portal = { label: string; url: string; slug: string; host: string; matched: boolean; payerMissing?: boolean };
type View = { known: boolean; portals: Portal[]; used: Cred[]; others: Cred[] };
const lib = new Function(`${bundle}\nreturn { plProjectPortals, plListHtml };`)() as {
  plProjectPortals: (tracks: unknown, creds: Cred[]) => View;
  plListHtml: (view: View, showAll: boolean, clientName: string) => string;
};

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { failed++; console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`); }
};

// Synthetic portals on reserved .test hosts. Two portal tracks, one emailed track.
const tracks = [
  { type: "building", label: "Building permit", channel: "City permits portal", channelKind: "portal", recipePortalUrl: "https://permits.city-a.test/tenant1/Login" },
  { type: "nem", label: "Interconnection", channel: "Utility portal", channelKind: "unknown", recipePortalUrl: "https://apply.utility-b.test/" },
  { type: "electrical", label: "Electrical permit", channel: "Emailed to the county", channelKind: "email", recipePortalUrl: "" },
];
const cred = (id: string, portalType: string, portalUrl: string): Cred => ({ id, portalType, portalUrl, usernameReference: `user-${id}`, hasSecret: true });
const creds = [
  cred("c-city", "city_permits_portal", "https://permits.city-a.test/tenant1/Login"),
  cred("c-other1", "elsewhere_permits", "https://portal.elsewhere-c.test/"),
  cred("c-other2", "another_utility", "https://apply.another-d.test/"),
];
const rowIds = (html: string) => [...html.matchAll(/data-pl-del="([^"]*)"/g)].map((m) => m[1]);

check("(a) chips: one per portal track, a non-portal track gets none, an unknown channel still asks, missing first", () => {
  const v = lib.plProjectPortals(tracks, creds);
  assert.equal(v.known, true);
  assert.deepEqual(v.portals.map((p) => [p.label, p.matched]), [["Interconnection", false], ["Building permit", true]]);
});

check("(b) list: only this project's logins by default; the rest behind a toggle that names the count", () => {
  const v = lib.plProjectPortals(tracks, creds);
  assert.deepEqual(v.used.map((c) => c.id), ["c-city"]);
  assert.deepEqual(v.others.map((c) => c.id), ["c-other1", "c-other2"]);
  const shut = lib.plListHtml(v, false, "Acme Solar");
  assert.deepEqual(rowIds(shut), ["c-city"]);
  assert.match(shut, /data-pl-toggle="1" aria-expanded="false"/);
  assert.match(shut, /Show 2 other saved logins for Acme Solar/);
  const open = lib.plListHtml(v, true, "Acme Solar");
  assert.deepEqual(rowIds(open), ["c-city", "c-other1", "c-other2"]);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /Hide 2 other saved logins/);
});

check("(c) tracks unknown (not loaded, or none): every login shows, no toggle (nothing hidden on a guess)", () => {
  for (const t of [null, undefined, []]) {
    const v = lib.plProjectPortals(t, creds);
    assert.equal(v.known, false);
    assert.equal(v.portals.length, 0);
    const html = lib.plListHtml(v, false, "Acme Solar");
    assert.deepEqual(rowIds(html), ["c-city", "c-other1", "c-other2"]);
    assert.doesNotMatch(html, /data-pl-toggle/);
  }
});

check("(d) a project that files only outside a portal says so, and the client's logins stay one click away", () => {
  const v = lib.plProjectPortals([tracks[2]], creds);
  assert.equal(v.portals.length, 0);
  assert.equal(v.used.length, 0);
  const html = lib.plListHtml(v, false, "Acme Solar");
  assert.match(html, /files outside any portal/);
  assert.deepEqual(rowIds(html), []);
  assert.match(html, /Show 3 other saved logins/);
});

check("(e) a portal with no saved login yet reads as missing, with the pick-a-portal hint", () => {
  const v = lib.plProjectPortals(tracks, [creds[1]]);
  assert.ok(v.portals.every((p) => !p.matched));
  const html = lib.plListHtml(v, false, "Acme Solar");
  assert.match(html, /No saved login fits this project's portals yet/);
  assert.match(html, /Show 1 other saved login for/);
});

check("(f) the client name is escaped into the toggle", () => {
  const html = lib.plListHtml(lib.plProjectPortals(tracks, creds), false, "<b>x</b>");
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

// #201: who pays each portal's fees. A saved login with no answer stalls the job at the portal's fee
// screen, so the project's portal is flagged and the row says so; an answered login is not flagged.
check("(g) a project portal whose login has no 'who pays' is flagged; an answered one is not", () => {
  const answered = creds.map((c) => (c.id === "c-city" ? { ...c, feeResponsibility: "card-on-file" } : c));
  const v = lib.plProjectPortals(tracks, answered);
  const byLabel = Object.fromEntries(v.portals.map((p) => [p.label, p]));
  assert.equal(byLabel["Building permit"].payerMissing, false);
  const html = lib.plListHtml(v, false, "Acme Solar");
  assert.match(html, /data-pl-fee="c-city"/);
  const blank = lib.plProjectPortals(tracks, creds);
  assert.ok(blank.portals.filter((p) => p.matched).every((p) => p.payerMissing), JSON.stringify(blank.portals));
  assert.match(lib.plListHtml(blank, false, "Acme Solar"), /who pays not set/);
  assert.ok(lib.plProjectPortals(tracks, []).portals.every((p) => !p.payerMissing), "a missing login is 'needs login', not 'who pays'");
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nportalLoginsProjectScope: all checks passed");
