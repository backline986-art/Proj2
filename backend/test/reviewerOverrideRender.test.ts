// THE OVERRIDE CONTROL ON THE REVIEWER GATE (#640): AN "Override…" FOLD ON EACH BLOCKER, A NOTE AND
// A WITHDRAW BUTTON ON AN OVERRIDDEN CALLOUT, AND WHY A VOID OVERRIDE NO LONGER APPLIES.
//
// Runs the SHIPPED renderers, reviewerOverrideControlHtml and reviewerOverrideNoteHtml, lifted out of
// frontend/dashboard.js (brace-balanced cut, as structuralLetterCardRender.test.ts does), and checks
// renderReviewerGate places and wires them. No Chromium.
//
// KILL: drop an esc() around the reason or the name → (d) fails; drop the control from the issue card
// or its listener → (e) fails.
//
//   npx tsx backend/test/reviewerOverrideRender.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

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
// The dashboard keeps no list of non-overridable findings: it reads the server's overrideRefusal.
if (/REVIEWER_OVERRIDE_OWN_DOOR/.test(dashboard)) throw new Error("dashboard.js grew its own non-overridable list again; read finding.overrideRefusal");
const lib = new Function(`${cut("esc")}\n${cut("reviewerOverrideControlHtml")}\n${cut("reviewerOverrideNoteHtml")}\nreturn { control: reviewerOverrideControlHtml, note: reviewerOverrideNoteHtml };`)() as {
  control: (finding: unknown, authOn: boolean) => string;
  note: (finding: unknown) => string;
};

const RSD = "city.elec.rapid-shutdown-missing";
const blocker = { id: RSD, severity: "blocker", title: "Rapid shutdown" };
const offCtl = lib.control(blocker, false);
check("(a) a blocker carries an Override… fold with a reason box and, with sign-in off, a name box",
  /<summary>Override…<\/summary>/.test(offCtl) && offCtl.includes("data-reviewer-override-reason") && offCtl.includes("data-reviewer-override-name")
  && /<button[^>]*data-reviewer-override-action="override"[^>]*data-finding-id="city\.elec\.rapid-shutdown-missing"/.test(offCtl), offCtl);
const onCtl = lib.control(blocker, true);
check("(a2) with sign-in on there is no name box (the session names the person)", !onCtl.includes("data-reviewer-override-name") && onCtl.includes("data-reviewer-override-reason"), onCtl);
check("(a3) a warning or a callout gets no Override control", lib.control({ ...blocker, severity: "warning" }, false) === "" && lib.control({ ...blocker, severity: "callout" }, false) === "");
const tokened = lib.control({ ...blocker, overrideSeenAs: "abc123" }, false);
check("(a4) the Override button carries the blocker's page token (data-seen-as), which the action sends",
  /<button[^>]*data-reviewer-override-action="override"[^>]*data-seen-as="abc123"/.test(tokened)
  && /seenAs: btn\.getAttribute\("data-seen-as"\)/.test(cut("reviewerOverrideAction")), tokened);
const { NOT_OVERRIDABLE } = await import("../src/reviewerOverrides");
for (const [fid, door] of NOT_OVERRIDABLE) {
  // The finding as the gate serves it: the fold attaches the server's refusal (reviewerBlockerOverride (e) pins that).
  const structural = lib.control({ id: fid, severity: "blocker", overrideRefusal: door }, false);
  check(`(b) ${fid} gets no Override button, and names its own door`,
    !structural.includes("data-reviewer-override-action") && /structural-letter card/.test(structural), structural);
}
check("(b2) the refusal text is escaped", !lib.control({ id: "x", severity: "blocker", overrideRefusal: "<img src=x onerror=1>" }, false).includes("<img"));

const overridden = { id: RSD, severity: "callout", overriddenFrom: "blocker", override: { id: "o1", by: "Jane Example", at: "2026-11-09T12:00:00.000Z", reason: "Engineer confirmed on E-2" } };
const note = lib.note(overridden);
check("(c) an overridden callout reads 'Overridden by Jane Example on 2026-11-09: …' with a Withdraw button",
  note.includes("Overridden by Jane Example on 2026-11-09: Engineer confirmed on E-2")
  && /<button[^>]*data-reviewer-override-action="withdraw"[^>]*data-finding-id="city\.elec\.rapid-shutdown-missing"[^>]*>Withdraw<\/button>/.test(note), note);
check("(c2) a vision-relaxed callout carries no override note", lib.note({ id: RSD, severity: "callout", visionRelaxedFrom: "blocker" }) === "");

const hostile = lib.note({ ...overridden, override: { id: "o2", by: "<script>x</script>", at: "2026-11-09", reason: `<img src=x onerror="alert(1)">` } });
check("(d) every value is esc()'d: a hostile name or reason never becomes markup",
  !hostile.includes("<script>") && !hostile.includes("<img") && hostile.includes("&lt;script&gt;") && hostile.includes("&lt;img"), hostile);
const voided = lib.control({ ...blocker, overrideVoided: { id: "o3", by: "<b>Jane</b>", at: "2026-11-08T00:00:00Z", reason: "ok", why: "the plan set was replaced since the override was recorded" } }, false);
check("(d2) a void override says who, when, and why it no longer applies — esc()'d",
  /no longer applies: the plan set was replaced since the override was recorded/.test(voided) && voided.includes("&lt;b&gt;Jane") && !voided.includes("<b>Jane"), voided);
check("(d3) a void override keeps a Withdraw button, so the stale row can be cleared",
  /kx-override-void[\s\S]*<button[^>]*data-reviewer-override-action="withdraw"[^>]*data-finding-id="city\.elec\.rapid-shutdown-missing"[^>]*>Withdraw<\/button>/.test(voided), voided);

const gate = cut("renderReviewerGate");
check("(e) renderReviewerGate puts the control on each issue card, the note in the checks column, and wires both",
  gate.includes("reviewerOverrideControlHtml(finding, authOn)") && gate.includes("reviewerOverrideNoteHtml(item)")
  && /querySelectorAll\("\[data-reviewer-override-action\]"\)/.test(gate) && gate.includes("reviewerOverrideAction("), gate.slice(0, 200));
check("(e2) overridden callouts lead the checks column (it shows only the first 14)", /overriddenFrom === "blocker"\) - Number/.test(gate));

if (failures) { console.error(`\nreviewerOverrideRender: ${failures} failure(s)`); process.exit(1); }
console.log("\nreviewerOverrideRender: all checks passed");
process.exit(0);
