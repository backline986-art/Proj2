// THE SECOND-STAGE BLOCK ON THE TRACK CARD (#28 part 1) — the SHIPPED renderer (frontend/dashboard.js,
// lifted from the file like feeTracksDisplay.test), fed the server's `secondStage` view:
//   described    the cited sentence, its source and quote, and a Confirm a person presses; the
//                card's other buttons are as they were (a description changes nothing).
//   confirmed    before any application: Approve & auto-submit is HELD (this portal's submit is not
//                the whole filing) and "I submitted it" is gone; "the application was made by hand" is offered.
//   waiting      "Not filed yet", the documents to upload, the mark-done form; Approve held, no
//                "I submitted it".
//   invite       a link the server let through is a plain link; a hidden one shows its HOST and why,
//                never an href; a non-http link the server might ever send is never an href.
//   everything interpolated is escaped.
// DASHBOARD_JS_PATH points a kill run at a mutated copy.
//   npx tsx backend/test/secondStageCard.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
/** Lift a top-level `[async] function NAME(` or `const NAME = ` by bracket balance (boardGateTruth's lift). */
const lift = (name: string): string => {
  const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  if (isConst && !"{[(".includes(dashboard[i])) { const semi = dashboard.indexOf(";\n", i); return dashboard.slice(m.index, semi + 1); }
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const CARD_NAMES = [
  "esc", "humanize", "fmtDate", "statusBadge", "httpUrl", "portalHostname",
  "TRACK_STATUS_CLASS", "TRACK_CHANNEL_BASIS", "linkifyText", "trackChannelHtml", "OFF_TOOL_CHANNEL", "offToolChannelHtml", "trackPrerequisitesHtml", "ESS_STEP_BASIS", "trackEssStepHtml", "trackNextActionText",
  "TRACK_ISSUER_KEY", "TRACK_ISSUER_SOURCE", "trackIssuerHtml", "trackIssuerEditHtml", "FEE_RESPONSIBILITY_TEXT", "trackPaymentHtml", "trackPaidFormHtml", "trackFeeDueHtml", "trackSecondStageHtml", "STAGE_GAP_LINK", "trackStageGapsHtml", "trackCardHtml",
];
const cardCode = `const screenshotMisses = new Set(); const screenshotKey = (a, b, c) => \`\${a}:\${b}:\${c}\`;\n${CARD_NAMES.map(lift).join("\n\n")}\n${lift("APPROVE_HELD_BY_STAGED_DRAFT")}`;
// eslint-disable-next-line no-new-func
const card = new Function("$", "state", "window", `${cardCode}\nreturn { trackCardHtml };`)(() => null, { selectedProjectId: "p1" }, {}) as { trackCardHtml: (t: Record<string, unknown>) => string };

const permit = {
  type: "building", label: "Building permit", category: "permit", status: "not_started", statusLabel: "Not started", nextAction: "Stage it.",
  captureFields: [{ key: "applicationNumber", label: "Application #" }], applicationNumber: "", permitNumber: "", confirmationNumber: "", trackingUrl: "", submittedAt: null, lastCheckedAt: null,
  outstanding: true, hasRecipe: true, recipeStatus: "complete", recipeScopeType: "ahj",
};
const stage = {
  agency: "City of Twostep", system: "PlanDesk <Review>", trigger: "an invite email after the fee is paid",
  sourceUrl: "https://www.twostep.example.gov/solar", quote: 'you will receive an "invitation" <b>',
};
const approveButton = (html: string): string => /<button[^>]*data-track-approve="[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
const held = (html: string): boolean => /\sdisabled[\s>]/.test(approveButton(html));
const offersSubmitted = (html: string): boolean => /data-track-submit="building"/.test(html);
const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

check("no second stage on file: an unfiled agency track offers a person the Confirm, collapsed; a filed one and the utility's track offer nothing", () => {
  const html = card.trackCardHtml({ ...permit });
  assert.match(html, /data-second-stage-add="building"/);
  assert.match(html, /data-second-stage-confirm="building"/);
  assert.equal(held(html), false);
  assert.equal(offersSubmitted(html), true);
  assert.doesNotMatch(card.trackCardHtml({ ...permit, status: "submitted", statusLabel: "Submitted" }), /data-second-stage/);
  assert.doesNotMatch(card.trackCardHtml({ ...permit, type: "nem", category: "utility", recipeScopeType: "utility" }), /data-second-stage/);
});

check("described: the sentence, source and quote are shown escaped with a Confirm; the card's other buttons are unchanged", () => {
  const html = card.trackCardHtml({ ...permit, secondStage: { ...stage, basis: "described", state: "described", pending: false, statusLabel: "", sentence: "The page says <so>." } });
  assert.match(html, /data-second-stage-state="described"/);
  assert.match(html, /described, not confirmed by a person/);
  assert.match(html, /data-second-stage-confirm="building"/);
  assert.ok(html.includes("The page says &lt;so&gt;."));
  assert.ok(html.includes("PlanDesk &lt;Review&gt;"));
  assert.ok(!html.includes("<b>") && !html.includes("<so>") && !html.includes("<Review>"), "server text reached the page unescaped");
  assert.ok(hrefs(html).includes("https://www.twostep.example.gov/solar"));
  assert.equal(held(html), false, "a description must not hold Approve");
  assert.equal(offersSubmitted(html), true, "a description must not remove \"I submitted it\"");
});

check("confirmed, no application yet: Approve is held, \"I submitted it\" is gone, the by-hand application form is offered", () => {
  const html = card.trackCardHtml({ ...permit, secondStage: { ...stage, basis: "verified", verifiedBy: "Vera <V>", verifiedAt: "2026-11-11T09:00:00Z", state: "before_application", pending: false, statusLabel: "", sentence: "s" } });
  assert.match(html, /data-second-stage-state="before_application"/);
  assert.match(html, /data-second-stage-application="building"/);
  assert.match(html, /data-second-stage-remove="building"/);
  assert.ok(html.includes("confirmed by Vera &lt;V&gt;"));
  assert.equal(held(html), true, approveButton(html));
  assert.match(html, /this portal's submit is not the whole filing/);
  assert.equal(offersSubmitted(html), false);
});

const waiting = {
  ...permit, status: "staged", statusLabel: "Application made — waiting for the plan-upload invite", nextAction: "NOT filed yet.",
  secondStage: {
    ...stage, basis: "verified", verifiedBy: "Vera", verifiedAt: "2026-11-11T09:00:00Z", state: "waiting_invite", pending: true, statusLabel: "x", sentence: "s",
    application: { number: "BLD-<1>", at: "2026-11-11T10:00:00Z", by: "Pat", via: "paid" },
    documents: [{ label: "Plan <set>", docType: "plan_set", present: true, via: "upload" }, { label: "Structural letter", docType: "structural_letter", present: false, via: "" }],
  },
};
check("waiting: Not filed yet, the documents to upload, the mark-done form; Approve held and no \"I submitted it\"", () => {
  const html = card.trackCardHtml(waiting);
  assert.match(html, /data-second-stage-state="waiting_invite"/);
  assert.match(html, /<strong>Not filed yet\.<\/strong>/);
  assert.match(html, /data-second-stage-no-invite="building"/);
  assert.match(html, /data-second-stage-documents="building"/);
  assert.ok(html.includes("Plan &lt;set&gt;") && html.includes("BLD-&lt;1&gt;"));
  assert.match(html, /Structural letter — <strong>not on file yet<\/strong>/);
  assert.match(html, /data-second-stage-field="confirmationNumber"/);
  assert.match(html, /type="file" accept="image\/png,image\/jpeg" data-second-stage-field="screenshot"/);
  assert.match(html, /data-second-stage-uploaded="building"/);
  assert.equal(held(html), true, approveButton(html));
  assert.equal(offersSubmitted(html), false);
});

check("invite: a link the server let through is a plain link; a hidden one shows its host and why, never an href", () => {
  const shown = card.trackCardHtml({ ...waiting, secondStage: { ...waiting.secondStage, state: "upload", invite: { subject: "Invite <now>", from: "desk@twostep.example.gov", receivedAt: "2026-11-11T12:00:00Z", link: "https://permits.twostep.example.gov/upload?r=1" } } });
  assert.ok(hrefs(shown).includes("https://permits.twostep.example.gov/upload?r=1"));
  assert.match(shown, /you open it; nothing opens it for you/);
  assert.ok(shown.includes("Invite &lt;now&gt;"));
  const hidden = card.trackCardHtml({ ...waiting, secondStage: { ...waiting.secondStage, state: "upload", invite: { subject: "Invite", from: "x", receivedAt: "2026-11-11T12:00:00Z", linkHidden: { host: "plandesk.example.com", why: "not the portal a person verified" } } } });
  assert.match(hidden, /data-second-stage-invite-hidden="building"/);
  assert.match(hidden, /Its link \(on plandesk\.example\.com\) is not shown: not the portal a person verified\. Open it from the email itself\./);
  assert.equal(hrefs(hidden).some((h) => /plandesk/.test(h)), false, "a hidden link's host became an href");
  const script = card.trackCardHtml({ ...waiting, secondStage: { ...waiting.secondStage, state: "upload", invite: { subject: "Invite", from: "x", receivedAt: "2026-11-11T12:00:00Z", link: "javascript:alert(1)" } } });
  assert.equal(hrefs(script).some((h) => /^javascript:/i.test(h)), false, "a non-http link became an href");
});

check("uploaded: one muted line with the confirmation number; a screenshot link only for this track's own route", () => {
  const done = { ...permit, status: "submitted", statusLabel: "Submitted" };
  const html = card.trackCardHtml({ ...done, secondStage: { ...stage, basis: "verified", state: "uploaded", pending: false, statusLabel: "", sentence: "Plans uploaded.", uploaded: { at: "2026-11-11", by: "Uma", confirmationNumber: "PD-<9>", screenshotUrl: "/api/projects/p1/submittal-tracks/building/second-stage/screenshot" } } });
  assert.match(html, /data-second-stage-state="uploaded"/);
  assert.ok(html.includes("Confirmation PD-&lt;9&gt;."));
  assert.ok(hrefs(html).includes("/api/projects/p1/submittal-tracks/building/second-stage/screenshot"));
  const odd = card.trackCardHtml({ ...done, secondStage: { ...stage, basis: "verified", state: "uploaded", pending: false, statusLabel: "", sentence: "Plans uploaded.", uploaded: { at: "2026-11-11", by: "Uma", confirmationNumber: "", screenshotUrl: "https://elsewhere.example.com/x.png" } } });
  assert.equal(hrefs(odd).some((h) => /elsewhere/.test(h)), false, "a screenshot link that is not this track's route was rendered");
});

if (failures) { console.error(`\n${failures} secondStageCard test(s) failed.`); process.exit(1); }
console.log("\nAll secondStageCard tests passed.");
process.exit(0);
