// THE FILING-EMAIL SCREEN ON THE TRACK CARD (#672) and THE PAID ROW'S CONFIRMATION LINK (#665) — the
// REAL functions lifted from frontend/dashboard.js.
//
//   (a) a usable record shows the address, who verified it, its source page and the words; an unusable
//       one lists every reason; no record offers the form.
//   (b) THE SCREEN NEVER SENDS: its only buttons are "I verified this address" and "Withdraw"; the only
//       calls it makes are GET / PUT / DELETE /filing-email; the .eml download is offered for a draft or
//       a failed send only, on this project's own route.
//   (c) the name is never filled in for the person; everything interpolated is escaped; a non-http
//       source is never a link.
//   (d) the card carries the panel; a Paid row links only its filing's masked confirmation route.
//   DASHBOARD_JS_PATH points a kill run at a mutated copy.
//
// Run: npx tsx backend/test/filingEmailPanel.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
/** Lift a top-level `[async] function NAME(` or `const NAME = ` by bracket balance (feeTracksDisplay's lift). */
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

const code = ["esc", "httpUrl", "portalHostname", "FILING_EMAIL_STATUS_TEXT", "filingEmailPanelHtml", "trackPaidFormHtml", "trackFeeDueHtml"].map(lift).join("\n\n");
// eslint-disable-next-line no-new-func
const ui = new Function(`${code}\nreturn { filingEmailPanelHtml, trackFeeDueHtml };`)() as {
  filingEmailPanelHtml: (type: string, data: unknown, projectId: string) => string;
  trackFeeDueHtml: (t: Record<string, unknown>) => string;
};

const authority = { kind: "utility", state: "ZZ", name: "Example Electric", table: "utility_filing_lookups", profileKey: "zz|example electric" };
const record = {
  address: "apply@example-electric.test", sourceUrl: "https://www.example-electric.test/solar", quote: "Email applications to apply@example-electric.test.",
  verifiedBy: "A. Person", verifiedAt: "2026-11-09T22:00:00.000Z",
};
const send = (status: string, id = `s-${status}`) => ({
  id, status, recipient: record.address, subject: "Utility interconnection application — 1 Test St [Ref 1A2B3C4D-NEM]", createdAt: "2026-11-09T22:05:00.000Z",
  attachments: [{ filename: "1-plan_set.pdf" }], refusals: status === "draft" ? ["no automatic send was asked for"] : [], detail: "",
});

// (a)
const usable = ui.filingEmailPanelHtml("nem", { authority, record, usable: true, problems: [], sends: [] }, "proj-1");
check("(a) a usable record shows the address, the verifier, the source page and the words",
  usable.includes(record.address) && usable.includes("A. Person") && usable.includes('href="https://www.example-electric.test/solar"') && usable.includes("Email applications to") && usable.includes("data-filing-email-usable"));
const unusable = ui.filingEmailPanelHtml("nem", { authority, record, usable: false, problems: ["the address does not appear verbatim in the quoted words", "no named person verified"], sends: [] }, "proj-1");
check("(a) an unusable record lists every reason", unusable.includes("data-filing-email-problems") && unusable.includes("verbatim") && unusable.includes("no named person verified") && !unusable.includes("data-filing-email-usable"));
const none = ui.filingEmailPanelHtml("building", { authority: { ...authority, kind: "ahj", name: "Example City" }, record: null, usable: false, problems: [], sends: [] }, "proj-1");
check("(a) no record: says so and offers the verify form, no Withdraw", none.includes("data-filing-email-empty") && none.includes("data-filing-email-save") && !none.includes("data-filing-email-withdraw"));
check("(a) no authority: nothing to record", ui.filingEmailPanelHtml("nem", { authority: null }, "proj-1").includes("data-filing-email-none"));

// (b)
const withSends = ui.filingEmailPanelHtml("nem", { authority, record, usable: true, problems: [], sends: ["draft", "failed", "sent", "sending", "superseded"].map((s) => send(s)) }, "proj-1");
const buttons = withSends.match(/<button[^>]*>/g) ?? [];
check("(b) the only buttons are verify and withdraw — nothing sends",
  buttons.length === 2 && buttons.every((b) => /data-filing-email-(save|withdraw)=/.test(b)), buttons.join(" | "));
const downloads = [...withSends.matchAll(/data-filing-email-download="([^"]+)"/g)].map((m) => m[1]);
check("(b) the .eml is offered for a draft and a failed send only", JSON.stringify(downloads) === JSON.stringify(["s-draft", "s-failed"]), JSON.stringify(downloads));
check("(b) the download is this project's own route", withSends.includes('href="/api/projects/proj-1/filing-email/drafts/s-draft/eml"'));
check("(b) a refusal and each status are shown", withSends.includes("Not sent automatically: no automatic send was asked for") && withSends.includes("check the filings mailbox"));
// Every call the screen makes to the filing-email API, in the source: GET (no method), PUT, DELETE.
const panelFns = ["loadFilingEmailPanel", "saveFilingEmail", "withdrawFilingEmail"].map(lift).join("\n");
const methods = [...panelFns.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]).sort();
check("(b) the screen calls only GET / PUT / DELETE on /filing-email — never a send", JSON.stringify(methods) === JSON.stringify(["DELETE", "PUT"]) && !/\/send\b|smtp|sendEmail/i.test(panelFns), JSON.stringify(methods));

// (c)
const nameInput = /<input data-filing-email-field="verifiedBy"[^>]*>/.exec(withSends)?.[0] ?? "";
check("(c) the verifier's name is never filled in for the person", Boolean(nameInput) && !/\svalue=/.test(nameInput), nameInput);
check("(c) saveFilingEmail sends no fallback name", !/verifiedBy\s*[:=]\s*["'`][^"'`]+["'`]|\|\|\s*["']operator|\|\|\s*["']dashboard/.test(lift("saveFilingEmail")));
const hostile = ui.filingEmailPanelHtml("nem", {
  authority: { ...authority, name: "<img src=x onerror=alert(1)>" },
  record: { ...record, quote: '"><script>alert(1)</script>', sourceUrl: "javascript:alert(1)" }, usable: true, problems: [], sends: [{ ...send("draft"), subject: "<b>x</b>" }],
}, "proj-1");
check("(c) everything is escaped", !hostile.includes("<script>") && !hostile.includes("<img") && !hostile.includes("<b>x</b>"));
check("(c) a non-http source is never a link", !hostile.includes('href="javascript:'));

// (d)
check("(d) the track card carries the filing-email panel", /function trackCardHtml\([\s\S]*data-filing-email="\$\{esc\(t\.type\)\}"/.test(lift("trackCardHtml")));
check("(d) renderSubmittalTracks loads it when opened", /details\[data-filing-email\][\s\S]*loadFilingEmailPanel/.test(lift("renderSubmittalTracks")));
const paidTrack = (confirmationUrl: string) => ui.trackFeeDueHtml({ type: "combo", paid: [{ kind: "issuance", amountUsd: 275, recordNumber: "BLD-1", paidBy: "", paidAt: "2026-11-09", confirmationUrl }] });
check("(d) #665: a Paid row links its filing's confirmation route",
  paidTrack("/api/projects/p1/submissions/s1/confirmation-screenshot").includes('href="/api/projects/p1/submissions/s1/confirmation-screenshot"'));
check("(d) #665: a file path or an outside URL is never linked",
  !paidTrack("/srv/runs/outcome.png").includes("data-track-paid-confirmation") && !paidTrack("https://evil.test/x").includes("data-track-paid-confirmation") && !paidTrack("").includes("data-track-paid-confirmation"));

if (failures) { console.error(`\n${failures} filingEmailPanel check(s) failed.`); process.exit(1); }
console.log("\nAll filingEmailPanel checks passed.");
