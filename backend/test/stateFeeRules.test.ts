// #663 — A STATE'S PERMIT-FEE RULES ARE CITED DATA, NOT PER-STATE CODE.
//
// The state surcharge used to be a constant on Oregon's entry in permitProcess.STATE_PERMIT_RULES:
// a job anywhere else got no surcharge and the quote said nothing (silently zero). Now each state's
// surcharge is a row of state_permit_rules (family "fee"), seeded from the reference JSON or landed
// by research, read by stateSurchargeFor and the quote. Pinned here, each red without its change:
//   1. Oregon's row comes from the reference file with its verbatim citation, and the Oregon quote
//      is UNCHANGED: $200 structural + 12% = $224, $150 electrical holding its own 12% = $168.
//   2. A state-rule ROW drives the surcharge for a non-Oregon state (a synthetic 3% row on WY).
//   3. A state with NO record: the quote says "State surcharge: not researched", never assumes none.
//   4. A verified row is never overwritten — not by a re-seed, not by research (rule 3).
//   5. Research: only what a retrieved page prints verbatim lands, seeded; one fetch per document;
//      a misquote, an amount the words do not print, an unofficial or uncited page land nothing.
//   6. The first-job trigger queues nothing in a process with no job worker, or once researched.
// Synthetic jurisdictions, amounts and statute text throughout (Oregon's own citation excepted).
// Run: npx tsx backend/test/stateFeeRules.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-fee-rules-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.sqlite");
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
process.env.FEE_RESEARCH = "off";
process.env.ANTHROPIC_API_KEY = "";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const F = await import("../src/feeSchedules");
const { buildPaymentQuote, stateSurchargeNotice } = await import("../src/submissionFees");
const SFR = await import("../src/stateFeeRules");
const RES = await import("../src/stateFeeResearch");
const { seedStatePermitRules } = await import("../src/stateRules");
const { STATE_PERMIT_RULES } = await import("../src/permitProcess");

const db = await openDatabase();
let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${name}`);
  else { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
};

const URL = "https://fees.example.gov/schedule.pdf";
let seq = 0;
function put(state: string, ahj: string, discipline: string, basis: string, brackets: unknown[]): void {
  const key = F.feeScheduleProfileKey({ state, ahj, utility: "" }, "permit");
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO fee_schedules (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes, source_url, source_quote,
       source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by, payment_method, discipline, collected_by_profile_key,
       status, document_date, candidates_json)
     VALUES (?, ?, ?, ?, '', 'permit', ?, ?, '', ?, '', 'official', 'seeded', ?, ?, '', '', '', ?, '', 'ok', '', '[]')`,
    [`fs-${++seq}`, key, state, ahj, basis, JSON.stringify(brackets), URL, ts, ts, discipline],
  );
}
const client = createClient(db, { companyName: "Synthetic Solar", billingMode: "monthly" });
function project(state: string, ahj: string): ProjectRecord {
  const pid = `p-${++seq}`;
  const now = new Date().toISOString();
  const snapshot = { jobValue: "10000" };
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, ?, 'Synthetic Owner', ?, ?, 'Synthetic Power', 8.05, 7, 'ready_to_stage', ?, ?, ?)`,
    [pid, client.id, state, ahj, JSON.stringify(snapshot), now, now],
  );
  return { id: pid, clientId: client.id, state, ahj, utility: "Synthetic Power", systemSizeDcKw: 8.05, systemSizeAcKw: 7, totalExportKw: null, parserSnapshot: snapshot } as unknown as ProjectRecord;
}
const feeRow = (state: string, key = "surcharge") => db.get<Record<string, unknown>>(
  "SELECT value_json, citation, source_url, confidence, verified_at, fetched_at FROM state_permit_rules WHERE state = ? AND family = 'fee' AND rule_key = ?", [state, key]);

// ── 1. OREGON: SEEDED FROM THE REFERENCE, TOTAL UNCHANGED ─────────────────────────────────────
console.log("\n1. Oregon's row is data, and Oregon's quote is unchanged");
{
  const or = feeRow("OR");
  const value = JSON.parse(String(or?.value_json ?? "null"));
  check("1a. Oregon's surcharge is a SEEDED fee row from the reference file, 12% of the permit fees, citing the statute verbatim with its URL",
    !!or && or.confidence === "seeded" && value?.percent === 12 && value?.appliesTo === "permit_fees"
      && /ORS 455\.210\(4\): "\(a\) For the purpose of partially defraying state administrative costs, there is imposed a surcharge in the amount of four percent of the total permit fees/.test(String(or.citation))
      && /^https:\/\/www\.oregonlegislature\.gov\//.test(String(or.source_url)) && or.fetched_at === "2026-11-09",
    JSON.stringify(or));
  check("1b. the Oregon constant is gone from code (STATE_PERMIT_RULES.OR has no surcharge)",
    !("surcharge" in (STATE_PERMIT_RULES.OR as Record<string, unknown>)));
  put("OR", "City of Twelveton", "structural", "flat", [{ feeUsd: 200, label: "Solar structural permit | $ | 200.00" }]);
  put("OR", "City of Twelveton", "electrical", "system_kw", [{ minKw: 0, maxKw: 25, feeUsd: 150, label: "Renewable energy, 25 kVA or less | $ | 150.00",
    stateSurcharge: { percent: 12, quote: "State surcharge (12% of permit fee)", sourceUrl: URL } }]);
  const p = project("OR", "City of Twelveton");
  const q = buildPaymentQuote(db, p, "permit");
  check("1c. PINNED: the Oregon quote is $392.00 ($200 + 12% modeled $24 + electrical $168 holding its own 12%), as before the move",
    q.permitFeeUsd === 392 && /INCLUDES \$24\.00 of state surcharge the schedule does not print — 12% of \$200\.00 = \$24\.00 \(ORS 455\.210\(4\) \+ 455\.220\(1\): state surcharge on permit fees, at most 12%\)/.test(q.permitFeeBasis)
      && !/not researched/.test(q.permitFeeBasis),
    `${q.permitFeeUsd} ${q.permitFeeBasis.slice(0, 400)}`);
}

// ── 2. A NON-OREGON STATE, DRIVEN BY ITS ROW ─────────────────────────────────────────────────
console.log("\n2. a state-rule row drives the surcharge in another state");
{
  put("WY", "Town of Rowburg", "", "flat", [{ feeUsd: 300, label: "Residential solar permit | $ | 300.00" }]);
  const p = project("WY", "Town of Rowburg");
  const before = buildPaymentQuote(db, p, "permit");
  check("2a. control: no WY row yet — $300, no surcharge added, and the quote says the state surcharge is NOT RESEARCHED",
    before.permitFeeUsd === 300 && /State surcharge: not researched for WY — no cited state fee rule is on file, so none is assumed/.test(before.permitFeeBasis),
    `${before.permitFeeUsd} ${before.permitFeeBasis.slice(0, 400)}`);
  check("2b. stateSurchargeFor: no record → null (never a modeled zero, never a guess)",
    F.stateSurchargeFor({ state: "WY", discipline: "" }, { feeUsd: 300 } as never, "permit", "", SFR.stateSurchargeRuleFor(db, "WY")) === null);
  db.run(
    `INSERT INTO state_permit_rules (state, family, rule_key, value_json, citation, source_url, confidence, updated_at)
     VALUES ('WY', 'fee', 'surcharge', ?, ?, 'https://legislature.example.gov/stat-9-9-999', 'seeded', ?)`,
    [JSON.stringify({ percent: 3, appliesTo: "permit_fees", section: "Synthetic Stat. 9-9-999(2)" }),
      "Synthetic Stat. 9-9-999(2): \"There is imposed a surcharge of three percent of the total permit fees.\"", new Date().toISOString()],
  );
  const after = buildPaymentQuote(db, p, "permit");
  check("2c. with the row, the same WY job is $309.00: the row's 3% is ADDED, itemised, cited to the row's section",
    after.permitFeeUsd === 309 && /INCLUDES \$9\.00 of state surcharge the schedule does not print — 3% of \$300\.00 = \$9\.00 \(Synthetic Stat\. 9-9-999\(2\): state surcharge on permit fees, 3%\)/.test(after.permitFeeBasis)
      && !/not researched/.test(after.permitFeeBasis),
    `${after.permitFeeUsd} ${after.permitFeeBasis.slice(0, 400)}`);
  const added = after.permitFeeCharges.filter((c) => c.kind === "state_surcharge" && !c.partOfLineFee);
  check("2d. …its charge carries the row's URL", added.length === 1 && added[0].sourceUrl === "https://legislature.example.gov/stat-9-9-999", JSON.stringify(added));
  // A row this quote cannot apply is NAMED, never priced and never read as zero.
  db.run("UPDATE state_permit_rules SET value_json = ? WHERE state = 'WY' AND family = 'fee'", [JSON.stringify({ percent: 3, appliesTo: "valuation", section: "Synthetic Stat. 9-9-999(2)" })]);
  const unmodeled = buildPaymentQuote(db, p, "permit");
  check("2e. a row whose surcharge is on something the quote does not model is named as NOT applied, never silently dropped",
    unmodeled.permitFeeUsd === 300 && /PLUS the state surcharge on file \(Synthetic Stat\. 9-9-999\(2\)\), which this quote does not apply because it applies to "valuation"/.test(unmodeled.permitFeeBasis),
    unmodeled.permitFeeBasis.slice(0, 400));
  // A cited "none" (percent 0) is an answer: nothing added, nothing said.
  db.run("UPDATE state_permit_rules SET value_json = ? WHERE state = 'WY' AND family = 'fee'", [JSON.stringify({ percent: 0, section: "Synthetic Stat. 9-9-999(2)" })]);
  const none = buildPaymentQuote(db, p, "permit");
  check("2f. a cited 'no state surcharge' row: $300, no surcharge and no not-researched notice",
    none.permitFeeUsd === 300 && !/surcharge/i.test(none.permitFeeBasis), none.permitFeeBasis.slice(0, 300));
}

// ── 3. NO RECORD IS SAID ─────────────────────────────────────────────────────────────────────
console.log("\n3. a state with no record is said in the quote");
check("3a. stateSurchargeNotice: a state with no record names it unresearched for the uncovered permits",
  /^ State surcharge: not researched for MT — no cited state fee rule is on file, so none is assumed on the Some County structural permit/.test(stateSurchargeNotice(db, "MT", ["Some County structural"])),
  stateSurchargeNotice(db, "MT", ["Some County structural"]));
check("3b. …and stays silent where every permit line already carries a surcharge (no gap)", stateSurchargeNotice(db, "MT", []) === "");

// #683's "official" tier (a quote read from an official page) is USED like any row on file.
{
  db.run("UPDATE state_permit_rules SET confidence = 'official' WHERE state = 'WY' AND family = 'fee'");
  db.run("UPDATE state_permit_rules SET value_json = ? WHERE state = 'WY' AND family = 'fee'", [JSON.stringify({ percent: 3, appliesTo: "permit_fees", section: "Synthetic Stat. 9-9-999(2)" })]);
  const r = SFR.stateSurchargeRuleFor(db, "WY");
  check("3c. an 'official' row is read and applied (usable at once), reported as official, never as person-verified",
    r.status === "rule" && r.percent === 3 && r.confidence === "official", JSON.stringify(r));
}

// ── 4. VERIFIED IS NEVER OVERWRITTEN ─────────────────────────────────────────────────────────
console.log("\n4. a verified row is never overwritten (rule 3)");
{
  const verifiedValue = JSON.stringify({ percent: 11, appliesTo: "permit_fees", section: "ORS 455.210(4) + 455.220(1)" });
  db.run("UPDATE state_permit_rules SET value_json = ?, citation = 'checked by a person', confidence = 'verified', verified_at = ?, verified_by = 'Synthetic Reviewer' WHERE state = 'OR' AND family = 'fee' AND rule_key = 'surcharge'",
    [verifiedValue, new Date().toISOString()]);
  const written = seedStatePermitRules(db);
  const or = feeRow("OR");
  check("4a. a re-seed from the reference does not touch the verified Oregon row", or?.value_json === verifiedValue && or?.citation === "checked by a person" && or?.confidence === "verified",
    JSON.stringify({ written, or }));
  check("4b. …and the read reports it verified, with the person's percentage", (() => { const r = SFR.stateSurchargeRuleFor(db, "OR"); return r.status === "rule" && r.percent === 11 && r.confidence === "verified"; })());
}

// ── 5. RESEARCH: ONLY WHAT A RETRIEVED PAGE PRINTS ───────────────────────────────────────────
console.log("\n5. research lands only verbatim, page-checked rules, seeded");
{
  const STAT = "https://legislature.example.gov/title-7/7-1-101";
  const BLOG = "https://solarblog.example.com/state-fees";
  const statPage = "<html><body><h1>7-1-101. Permit fee surcharges.</h1><p>(1) A municipality shall collect a surcharge of one percent of the total building permit fees.</p>"
    + "<p>(2) There is imposed an additional surcharge in the amount of 0.5% of the total permit fees for code training.</p>"
    + "<p>(3) The fee for a permit for a residential solar energy system may not exceed $450.</p></body></html>";
  const fetched: string[] = [];
  RES.setStateFeePageReaderForTests(async (url) => { fetched.push(url); return url === STAT ? { ok: true, text: statPage, status: 200 } : { ok: false, text: "", status: 404 }; });
  const answer = {
    rules: [
      { key: "surcharge", percent: 1.5, appliesTo: "permit_fees", atMost: false, section: "Synthetic Code 7-1-101(1)-(2)", sourceUrl: STAT,
        excerpts: ["A municipality shall collect a surcharge of one percent of the total building permit fees.", "There is imposed an additional surcharge in the amount of 0.5% of the total permit fees for code training."] },
      { key: "solarPermitFeeCap", maxUsd: 450, section: "Synthetic Code 7-1-101(3)", sourceUrl: STAT, excerpts: ["The fee for a permit for a residential solar energy system may not exceed $450."] },
    ],
  };
  const lookup = (rules: unknown, urls = [STAT]): Pick<import("../../shared/src/types").LLMProvider, "webLookup"> => ({
    webLookup: async (): Promise<WebLookupResult> => ({ text: JSON.stringify(rules), groundedSearches: 2, stopReason: "end_turn", resultUrls: urls, pagesRead: 1, fetchedUrls: [] }),
  });
  const r = await RES.runStateFeeResearch(db, { state: "Montana" }, lookup(answer));
  const mt = SFR.stateSurchargeRuleFor(db, "MT");
  const cap = feeRow("MT", "solarPermitFeeCap");
  check("5a. a surcharge whose verbatim parts (one percent + 0.5%) are on the retrieved page lands SEEDED at 1.5%, with its citation and URL",
    r.saved === 2 && mt.status === "rule" && mt.percent === 1.5 && mt.confidence === "seeded" && mt.sourceUrl === STAT
      && mt.citation.startsWith("Synthetic Code 7-1-101(1)-(2): \"A municipality shall collect a surcharge of one percent"),
    JSON.stringify({ r, mt }));
  check("5a2. …and records WHEN the page holding its words was fetched (provenance, #683)", /^\d{4}-\d{2}-\d{2}T/.test(mt.status === "rule" ? mt.fetchedAt : "") && /^\d{4}-\d{2}-\d{2}T/.test(String(feeRow("MT")?.fetched_at)), JSON.stringify(feeRow("MT")));
  check("5b. the solar fee cap lands as data ($450, cited)", !!cap && JSON.parse(String(cap.value_json)).maxUsd === 450 && cap.confidence === "seeded", JSON.stringify(cap));
  check("5c. gentle: ONE fetch for the one document both rules cite", fetched.length === 1, JSON.stringify(fetched));
  check("5d. a researched state's quote now prices its surcharge instead of saying not researched",
    stateSurchargeNotice(db, "MT", ["x"]).includes("up to 1.5% of the permit fee"), stateSurchargeNotice(db, "MT", ["x"]));

  const parse = (rules: unknown, urls = [STAT]) => RES.parseStateFeeLookup({ text: JSON.stringify(rules), groundedSearches: 1, resultUrls: urls, fetchedUrls: [] }, "ID");
  const one = (o: Record<string, unknown>) => ({ rules: [{ key: "surcharge", percent: 1, appliesTo: "permit_fees", section: "Synthetic Code 1", sourceUrl: STAT, excerpts: ["A municipality shall collect a surcharge of one percent of the total building permit fees."], ...o }] });
  check("5e. MUST-EXCLUDE: an amount its words do not print (2% claimed, the excerpt says one percent)", parse(one({ percent: 2 })).rules.length === 0);
  check("5f. MUST-EXCLUDE: a page the lookup never found", parse(one({}), ["https://legislature.example.gov/other"]).rules.length === 0);
  check("5g. MUST-EXCLUDE: an unofficial host", parse(one({ sourceUrl: BLOG }), [BLOG]).rules.length === 0);
  check("5h. MUST-EXCLUDE: an ungrounded answer (model memory)", RES.parseStateFeeLookup({ text: JSON.stringify(one({})), groundedSearches: 0, resultUrls: [STAT], fetchedUrls: [] }, "ID").rules.length === 0);
  const misquote = await RES.verifyStateFeeQuotes(parse(one({ excerpts: ["A municipality shall collect a surcharge of one percent of the total valuation."] })).rules);
  check("5i. MUST-EXCLUDE: an excerpt that is not on the retrieved page", misquote.rules.length === 0 && /quote not found on the page/.test(misquote.dropped.join(" ")), JSON.stringify(misquote));
  check("5j. percentStated reads digits and words", RES.percentStated("four percent of the total") === 4 && RES.percentStated("0.5% of fees") === 0.5 && RES.percentStated("no rate") === null);

  // Rule 3 through research: an Idaho row a person verified is not overwritten by a later pass.
  db.run(`INSERT INTO state_permit_rules (state, family, rule_key, value_json, citation, source_url, confidence, verified_at, verified_by, updated_at)
          VALUES ('ID', 'fee', 'solarPermitFeeCap', ?, 'checked by a person', 'https://legislature.example.gov/x', 'verified', ?, 'Synthetic Reviewer', ?)`,
    [JSON.stringify({ maxUsd: 999, section: "person" }), new Date().toISOString(), new Date().toISOString()]);
  const rid = await RES.runStateFeeResearch(db, { state: "ID" }, lookup(answer));
  const idCap = feeRow("ID", "solarPermitFeeCap");
  check("5k. research never overwrites a verified row: Idaho's verified cap keeps the person's $999 (its surcharge lands seeded beside it)",
    JSON.parse(String(idCap?.value_json)).maxUsd === 999 && idCap?.confidence === "verified" && SFR.stateSurchargeRuleFor(db, "ID").status === "rule",
    JSON.stringify({ rid, idCap }));
  const again = await RES.runStateFeeResearch(db, { state: "MT" }, { webLookup: async () => { throw new Error("must not be asked"); } });
  check("5l. a state already on file is not asked again", again.skipped === true, JSON.stringify(again));
  RES.setStateFeePageReaderForTests(null);
}

// ── 6. THE FIRST-JOB TRIGGER ─────────────────────────────────────────────────────────────────
console.log("\n6. the first-job trigger");
{
  process.env.FEE_RESEARCH = "";
  process.env.ANTHROPIC_API_KEY = "sk-synthetic-not-a-key";
  const count = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'state_fee_research'")?.n ?? 0);
  check("6a. a process with no job worker queues nothing", await RES.ensureStateFeeRulesResearched(db, { id: "p-x", state: "NE" }) === 0 && count() === 0);
  const { startJobWorker } = await import("../src/jobQueue");
  process.env.JOB_WORKER_INTERVAL_MS = "3600000";
  clearInterval(startJobWorker(db));
  const first = await RES.ensureStateFeeRulesResearched(db, { id: "p-x", state: "NE" });
  const second = await RES.ensureStateFeeRulesResearched(db, { id: "p-y", state: "Nebraska" });
  check("6b. the first permit job in an unresearched state queues ONE job; a second job in that state does not", first === 1 && second === 0 && count() === 1, `${first} ${second} ${count()}`);
  check("6c. a state already on file queues nothing", await RES.ensureStateFeeRulesResearched(db, { id: "p-z", state: "OR" }) === 0 && count() === 1);
  process.env.ANTHROPIC_API_KEY = "";
  process.env.FEE_RESEARCH = "off";
}

fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nstate fee rules: all checks passed");
process.exit(0);
