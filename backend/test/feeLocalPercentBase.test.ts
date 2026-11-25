// A LOCAL PERCENT FEE IS TAKEN ON THE FILING'S PERMIT FEES, NOT ON THE PERMIT LINE ALONE.
//
// Ground truth: the owner's paid receipts (export of 2026-11-23). In 19 jurisdictions a local
// technology or administrative fee is a percent, and the receipts print it on every permit line of
// the filing — the services/feeders line included — and on plan review where the schedule says so:
//   · 3% of a $150.00 renewable-energy line + a $150.00 services line = $9.00 (Keelix said $4.50);
//   · 10% of a $495.50 structural permit + $322.08 plan review = $81.76 (Keelix said $49.55).
//
//   MUST PASS    — a services line joins the base of a technology fee; plan review joins it when the
//                  schedule's own wording names plan review or total fees.
//   MUST EXCLUDE — no services line and no such wording: unchanged, the permit line alone; plan review
//                  stays a percent of the permit line; a "processing" charge that is plan review under
//                  another name (Portland's "Bldg Plan Rvw/Processing") keeps the permit line.
//
//   npx tsx backend/test/feeLocalPercentBase.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-local-percent-base-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.sqlite");
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
process.env.FEE_RESEARCH = "off";
process.env.ANTHROPIC_API_KEY = "";
delete process.env.PERMIT_FEE_ESTIMATE_RATE;
delete process.env.PERMIT_FEE_ESTIMATE_MIN_USD;
delete process.env.PERMIT_FEE_ESTIMATE_MAX_USD;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const F = await import("../src/feeSchedules");
const { buildPaymentQuote, buildProjectFeeSheet, feeConfirmRows } = await import("../src/submissionFees");

const db = await openDatabase();
let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
};

const URL = "https://fees.example.gov/schedule.pdf";
let seq = 0;
function put(state: string, ahj: string, discipline: string, basis: string, brackets: unknown[], track: "permit" | "nem" = "permit", utility = ""): void {
  const key = F.feeScheduleProfileKey({ state, ahj, utility }, track);
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO fee_schedules (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes, source_url, source_quote,
       source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by, payment_method, discipline, collected_by_profile_key,
       status, document_date, candidates_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', 'official', 'seeded', ?, ?, '', '', '', ?, '', 'ok', '', '[]')`,
    [`fs-${++seq}`, key, state, ahj, utility, track, basis, JSON.stringify(brackets), URL, ts, ts, discipline],
  );
}
const client = createClient(db, { companyName: "Synthetic Solar", billingMode: "monthly" });
function project(state: string, ahj: string, acKw: number | null, snapshot: Record<string, unknown> = { jobValue: "10000" }, utility = "Synthetic Power"): ProjectRecord {
  const pid = `p-${++seq}`;
  const now = new Date().toISOString();
  const dc = acKw == null ? null : acKw * 1.15;
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, ?, 'Synthetic Owner', ?, ?, ?, ?, ?, 'ready_to_stage', ?, ?, ?)`,
    [pid, client.id, state, ahj, utility, dc, acKw, JSON.stringify(snapshot), now, now],
  );
  return { id: pid, clientId: client.id, state, ahj, utility, systemSizeDcKw: dc, systemSizeAcKw: acKw, totalExportKw: null, parserSnapshot: snapshot } as unknown as ProjectRecord;
}

const line = (label: string, extra: Record<string, unknown>) => ({
  label, percentOf: "", conditional: false, condition: "", appliesTo: "", quote: label, sourceUrl: URL, matchedLine: label, ...extra,
});
const services = line("Services or feeders: 200 amps or less", { kind: "other", amountUsd: 150, appliesTo: "electrical" });
const charge = (q: ReturnType<typeof buildPaymentQuote>, label: RegExp) => q.permitFeeCharges.find((c) => label.test(c.label));
const upgrade = { scopeText: "Main panel upgrade to 200A", mainBreaker: "200A", hasBattery: "No", jobValue: "10000" };

{
  const tech = line("Local Technology Fee", { kind: "technology", percent: 3, percentOf: "of permit fees" });
  put("OR", "City of Techbay", "electrical", "system_kw", [{ minKw: 0, maxKw: 25, feeUsd: 150, label: "Renewable energy, 25 kVA or less | $ | 150.00", ancillaryCharges: [services, tech] }]);
  const withService = buildPaymentQuote(db, project("OR", "City of Techbay", 7, upgrade), "permit");
  const t = charge(withService, /Technology/);
  check("1. MUST PASS: 3% of the permit line AND its services line ($150 + $150) = $9.00",
    t?.amountUsd === 9 && /\$300\.00/.test(t?.quote ?? ""), JSON.stringify(t));
  const without = buildPaymentQuote(db, project("OR", "City of Techbay", 7), "permit");
  const u = charge(without, /Technology/);
  check("2. MUST EXCLUDE: no services line, the permit line alone: 3% of $150 = $4.50", u?.amountUsd === 4.5, JSON.stringify(u));
}
{
  const review = line("Structural plan review", { kind: "plan_review", percent: 65, percentOf: "of the building permit fee" });
  const named = line("Local Technology Fee", { kind: "technology", percent: 5, percentOf: "of permit and plan review fees" });
  put("OR", "Reviewton County", "structural", "flat", [{ feeUsd: 200, label: "Structural building permit fee", ancillaryCharges: [review, named] }]);
  const q = buildPaymentQuote(db, project("OR", "Reviewton County", 7), "permit");
  const r = charge(q, /plan review/i), t = charge(q, /Technology/);
  check("3. MUST PASS: plan review stays 65% of the permit line ($130.00)", r?.amountUsd === 130, JSON.stringify(r));
  check("4. MUST PASS: the schedule names plan review, so 5% of $200 + $130 = $16.50",
    t?.amountUsd === 16.5 && /plan review/.test(t?.quote ?? ""), JSON.stringify(t));
  const plain = line("Local Technology Fee", { kind: "technology", percent: 5, percentOf: "of the permit fee" });
  put("OR", "Plainton County", "structural", "flat", [{ feeUsd: 200, label: "Structural building permit fee", ancillaryCharges: [review, plain] }]);
  const p = charge(buildPaymentQuote(db, project("OR", "Plainton County", 7), "permit"), /Technology/);
  check("5. MUST EXCLUDE: wording that names the permit fee only keeps the permit line: 5% of $200 = $10.00", p?.amountUsd === 10, JSON.stringify(p));
}
{
  const processing = line("Bldg Plan Rvw/Processing RS/MI/MP", { kind: "processing", percent: 65, percentOf: "the building permit fee" });
  put("OR", "City of Processville", "electrical", "system_kw", [{ minKw: 0, maxKw: 25, feeUsd: 100, label: "Electrical permit | $ | 100.00", ancillaryCharges: [services, processing] }]);
  const c = charge(buildPaymentQuote(db, project("OR", "City of Processville", 7, upgrade), "permit"), /Plan Rvw/);
  check("6. MUST EXCLUDE: plan review under the name 'processing' stays 65% of the permit line ($65.00)", c?.amountUsd === 65, JSON.stringify(c));
}

db.close();
console.log(failures ? `\n${failures} FAILED` : "\nall local percent fee checks passed");
process.exit(failures ? 1 : 0);
