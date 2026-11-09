// EVERY FEE LINE FOR AN AHJ WITH NO SCHEDULE: PRICED AND CITED, OR NAMED UNPRICED (#661).
//
// A city the product has never filed in gets researched from its own published documents.
// What must hold, all of it on SYNTHETIC documents (no network, no real jurisdiction's data):
//
//   1. The itemiser reads one synthetic document per line kind — plan review %, technology fee,
//      minimum, surcharge, zoning and fire review, revision, reinspection, card fee,
//      administrative fee — and names each with its printed line and its URL. Another trade's
//      line and a commercial-only line are not this filing's.
//   2. Through researchFeeSchedule: a line the document PRINTS that research did not price, and a
//      line the strictest default expects that no document names, both land on the stored row
//      as named-unpriced lines; the quote reads "AT LEAST $X" and names them. Nothing is dropped.
//   3. A document that prices every expected line produces a TOTAL, not a floor — the strict
//      default does not fire on a jurisdiction that answered it.
//   4. A held minimum is a floor on the permit line, never a charge on top; a revision or
//      reinspection fee is listed and never totalled, however research marked it.
//   5. A jurisdiction with no findable document is "NOT FOUND" with the hosts tried, and no
//      schedule is written.
//   6. Everything lands 'seeded'; a human-verified row is never touched (hard rule 3).
//   7. The write path: unpriced lines survive a findings-file replay (they can only make a quote
//      less certain), and apply-fee-findings.ts is a DRY RUN unless --apply is passed.
//
//   npx tsx backend/test/feeLineCoverage.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-line-coverage-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_LOG_FILE = "";
  delete process.env.PERMIT_FEE_ESTIMATE_RATE;

  const { openDatabase } = await import("../src/db");
  const {
    researchFeeSchedule, getFeeSchedule, feeScheduleProfileKey, feeForProject, newFeeDocumentLedger,
    corroborateAncillaryCharges, attachAncillaryCharges, markFeeScheduleVerified, saveFeeSchedule,
  } = await import("../src/feeSchedules");
  const { itemiseFeeDocuments, classifyFeeLine } = await import("../src/feeLineKinds");
  const { createProject, getProjectDetail } = await import("../src/repository");
  const { buildPaymentQuote } = await import("../src/submissionFees");
  const { adHocTarget } = await import("../../scripts/research-fee-schedules");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  type Ledger = import("../src/feeSchedules").FeeDocumentLedger;

  const db = await openDatabase();
  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   - ${name}`);
  };

  // ---------------------------------------------------------------------------
  // 1. THE ITEMISER — one synthetic document per line kind.
  // ---------------------------------------------------------------------------
  const kindOf = (url: string, text: string) => itemiseFeeDocuments([{ url, text }]);
  const cases: Array<{ kind: string; text: string; amount?: number; percent?: number }> = [
    { kind: "plan_review", text: "p1  Plan Review | 65% of the building permit fee", percent: 65 },
    { kind: "technology", text: "p1  Technology Fee | 4% of permit fee", percent: 4 },
    { kind: "minimum", text: "p2  Minimum permit fee | $75.00", amount: 75 },
    { kind: "surcharge", text: "p1  State surcharge | 1% of the permit fee", percent: 1 },
    { kind: "land_use_review", text: "Zoning review - residential solar | $40.00", amount: 40 },
    { kind: "fire_review", text: "Fire marshal review - solar photovoltaic | $85.00", amount: 85 },
    { kind: "revision", text: "Plan revisions after permit issuance | $50.00 per hour", amount: 50 },
    { kind: "reinspection", text: "Reinspection fee | $60.00", amount: 60 },
    { kind: "convenience", text: "Credit card convenience fee | 3% of the amount paid", percent: 3 },
    { kind: "processing", text: "Administrative fee | $15.00", amount: 15 },
  ];
  for (const c of cases) {
    const url = `https://example-falls.example.test/${c.kind}.pdf`;
    const got = kindOf(url, `City of Example Falls Fee Schedule\n${c.text}`);
    const hit = got.find((s) => s.kind === c.kind);
    check(`1. itemises a ${c.kind} line with its citation`,
      !!hit && hit.sourceUrl === url && hit.printedLine.includes(c.text.replace(/^p\d+\s+/, "").split(" | ")[0])
        && (c.amount == null || hit.amountUsd === c.amount) && (c.percent == null || hit.percent === c.percent),
      JSON.stringify(got));
  }
  // A label cell above its value cell is ONE row.
  const wrapped = kindOf("https://example-falls.example.test/wrapped.pdf", "Technology Fee\n4% of the permit fee");
  check("1. a label above its value is read as one row", wrapped.length === 1 && wrapped[0].kind === "technology"
    && wrapped[0].percent === 4 && /Technology Fee — 4%/.test(wrapped[0].printedLine), JSON.stringify(wrapped));
  // Priority: a fire plan review is a fire review; a plan revision is a revision.
  check("1. 'Fire plan review' classifies as fire_review, not plan_review", classifyFeeLine("Fire plan review - solar")?.kind === "fire_review");
  check("1. 'Plan revision fee' classifies as revision, not plan_review", classifyFeeLine("Plan revision fee | $40")?.kind === "revision");
  // Another trade's and a commercial-only line are not this filing's (the caller's predicate).
  const skip = (line: string) => /\bplumbing\b|\bcommercial\b/i.test(line);
  const excluded = itemiseFeeDocuments([{ url: "https://x.example.test/a", text: "Plumbing plan review | $80.00\nCommercial plan review | 65%" }], { skip });
  check("1. another trade's / a commercial plan review is not itemised", excluded.length === 0, JSON.stringify(excluded));
  // A zoning line that names no solar/residential work is not this filing's.
  const zoningOther = itemiseFeeDocuments([{ url: "https://x.example.test/z", text: "Zoning review - conditional use permit | $500.00" }]);
  check("1. a zoning line that names no solar/residential work is not this filing's", zoningOther.length === 0, JSON.stringify(zoningOther));

  // ---------------------------------------------------------------------------
  // 2–4. THROUGH researchFeeSchedule, with a researcher that READS a synthetic document.
  // ---------------------------------------------------------------------------
  const STATE = "UT"; // a state with no per-state surcharge rule in code: the document must say it.
  /** A researcher that "opens" one synthetic document (into the ledger, as openFeeDocument does)
   *  and reports the permit line plus whichever charges it names — corroborated against that
   *  document exactly as the default researcher does. */
  const researcherReading = (url: string, corpus: string, permitFee: number, permitLabel: string, reported: unknown[]) =>
    async (_input: unknown, options?: { ledger?: Ledger }): Promise<Finding> => {
      const ledger = options!.ledger!;
      (ledger.attempted ??= []).push(url);
      ledger.evidence.push({ url, via: "http", status: 200, kind: "pdf", bytes: corpus.length, handed: 10 });
      ledger.corpus.push(corpus);
      const finding: Finding = {
        found: true, reason: "", basis: "flat",
        brackets: [{ feeUsd: permitFee, label: permitLabel }],
        notes: "", sourceUrl: url, sourceQuote: `${permitLabel} | $${permitFee.toFixed(2)}`, sourceKind: "official",
        paymentMethod: "portal",
      };
      const { held } = corroborateAncillaryCharges(reported, finding, ledger);
      attachAncillaryCharges(finding.brackets, held);
      return finding;
    };
  const project = (ahj: string, kw = 7) =>
    ({ state: STATE, ahj, utility: "", systemSizeAcKw: kw, systemSizeDcKw: kw, parserSnapshot: {} }) as never;

  // 2. PRINTED-BUT-UNPRICED + EXPECTED-BUT-ABSENT. The document prints a plan review (research
  //    prices it), a technology fee (research does NOT), and no surcharge line at all.
  const AHJ1 = "City of Partial Falls";
  const URL1 = "https://partialfalls.example.test/fee-schedule.pdf";
  const CORPUS1 = [
    "p1  City of Partial Falls | Building Fee Schedule",
    "p1  Solar photovoltaic system - residential | $100.00",
    "p1  Plan Review | 65% of the building permit fee",
    "p2  Technology Fee | 4% of permit fee",
    "p2  Reinspection fee | $60.00",
  ].join("\n");
  const r1 = await researchFeeSchedule(db, { state: STATE, ahj: AHJ1, track: "permit" }, {
    researcher: researcherReading(URL1, CORPUS1, 100, "Solar photovoltaic system - residential", [
      { label: "Plan Review", kind: "plan_review", percent: 65, percentOf: "of the building permit fee", conditional: false, appliesTo: "" },
    ]),
  });
  const row1 = r1.schedule;
  const unpriced1 = row1?.brackets[0]?.unpricedLines ?? [];
  check("2. saved as SEEDED", r1.saved && row1?.confidence === "seeded", JSON.stringify({ saved: r1.saved, reason: r1.reason }));
  const tech = unpriced1.find((u) => u.kind === "technology");
  check("2. the printed technology fee is named unpriced, cited to its line and document",
    tech?.why === "printed_unpriced" && /Technology Fee/.test(tech.printedLine) && tech.sourceUrl === URL1, JSON.stringify(unpriced1));
  const sur = unpriced1.find((u) => u.kind === "surcharge");
  check("2. the surcharge no document names is named unpriced by the strict default (never $0)",
    sur?.why === "not_found" && sur.printedLine === "" && sur.sourceUrl === "", JSON.stringify(unpriced1));
  check("2. the plan review research priced is NOT named unpriced", !unpriced1.some((u) => u.kind === "plan_review"), JSON.stringify(unpriced1));
  check("2. the notes say which lines are unpriced", /LINE COVERAGE — 3 LINE\(S\) NAMED UNPRICED/.test(row1?.notes ?? "")
    && /Technology fee/.test(row1?.notes ?? "") && /State \/ local surcharge/.test(row1?.notes ?? ""), row1?.notes?.slice(0, 400));

  const fee1 = feeForProject(db, project(AHJ1), "permit");
  check("2. the total is null — a filing missing a line is not a smaller filing", fee1?.feeUsd === null, JSON.stringify(fee1?.feeUsd));
  check("2. the floor is every line that priced: permit $100 + 65% plan review = $165", fee1?.pricedSubtotalUsd === 165, JSON.stringify(fee1?.pricedSubtotalUsd));
  check("2. the floor names each unpriced line",
    !!fee1?.unpricedItems?.some((i) => /Technology Fee/.test(i)) && !!fee1?.unpricedItems?.includes('"State / local surcharge"'),
    JSON.stringify(fee1?.unpricedItems));
  check("2. the reinspection line is listed but never part of the floor or the unknowns",
    !!fee1?.charges.some((c) => c.kind === "reinspection" && c.futureContingent === true)
      && !fee1?.unpricedItems?.some((i) => /Reinspection/i.test(i)), JSON.stringify(fee1?.charges));

  const p1 = createProject(db, {
    owner: "Line Coverage Test", street: "1 Test Way", city: "Partial Falls", state: STATE, zip: "84000",
    ahj: AHJ1, utility: "", account: "1", meter: "1", dcKw: "7", acKw: "7",
  } as never);
  const quote1 = buildPaymentQuote(db, getProjectDetail(db, p1.project.id).project, "permit");
  check("2. the quote reads AT LEAST $165.00 and names the unpriced lines",
    /AT LEAST \$165\.00/.test(quote1.permitFeeBasis) && /Technology Fee/.test(quote1.permitFeeBasis) && /State \/ local surcharge/.test(quote1.permitFeeBasis),
    quote1.permitFeeBasis.slice(0, 500));

  // 3. A DOCUMENT THAT PRICES EVERY EXPECTED LINE gives a TOTAL. Permit $100, plan review 65%,
  //    state surcharge 1%: $100 + $65 + $1 = $166, and the notes say coverage is complete.
  const AHJ3 = "City of Whole Falls";
  const URL3 = "https://wholefalls.example.test/fees.pdf";
  const CORPUS3 = [
    "p1  City of Whole Falls | Fee Schedule",
    "p1  Solar photovoltaic system - residential | $100.00",
    "p1  Plan Review | 65% of the building permit fee",
    "p1  State surcharge | 1% of the permit fee",
  ].join("\n");
  const r3 = await researchFeeSchedule(db, { state: STATE, ahj: AHJ3, track: "permit" }, {
    researcher: researcherReading(URL3, CORPUS3, 100, "Solar photovoltaic system - residential", [
      { label: "Plan Review", kind: "plan_review", percent: 65, percentOf: "of the building permit fee", conditional: false, appliesTo: "" },
      { label: "State surcharge", kind: "surcharge", percent: 1, percentOf: "of the permit fee", conditional: false, appliesTo: "" },
    ]),
  });
  check("3. no line named unpriced when every expected line is priced", r3.saved && !(r3.schedule?.brackets[0]?.unpricedLines?.length),
    JSON.stringify(r3.schedule?.brackets[0]?.unpricedLines));
  const fee3 = feeForProject(db, project(AHJ3), "permit");
  check("3. a complete schedule quotes a TOTAL ($166.00), not a floor", fee3?.feeUsd === 166 && !fee3?.unpricedItems?.length, JSON.stringify({ fee: fee3?.feeUsd, u: fee3?.unpricedItems }));
  check("3. the notes say line coverage is complete", /LINE COVERAGE: every line kind/.test(r3.schedule?.notes ?? ""), r3.schedule?.notes?.slice(0, 300));

  // 4. A HELD MINIMUM IS A FLOOR; A REVISION FEE IS NEVER TOTALLED. The permit prints $40 and the
  //    schedule's minimum is $75, so the permit line is $75; plan review 65% and surcharge 1% are
  //    OF that $75. The revision fee is reported as an unconditional charge (a mis-marking) and
  //    must still stay out of the total.
  const AHJ4 = "City of Floor Falls";
  const URL4 = "https://floorfalls.example.test/fees.pdf";
  const CORPUS4 = [
    "p1  City of Floor Falls | Fee Schedule",
    "p1  Solar photovoltaic system - residential | $40.00",
    "p1  Minimum permit fee | $75.00",
    "p1  Plan Review | 65% of the building permit fee",
    "p1  State surcharge | 1% of the permit fee",
    "p1  Plan revisions after permit issuance | $50.00",
  ].join("\n");
  const r4 = await researchFeeSchedule(db, { state: STATE, ahj: AHJ4, track: "permit" }, {
    researcher: researcherReading(URL4, CORPUS4, 40, "Solar photovoltaic system - residential", [
      { label: "Minimum permit fee", kind: "minimum", amountUsd: 75, conditional: false, appliesTo: "" },
      { label: "Plan Review", kind: "plan_review", percent: 65, percentOf: "of the building permit fee", conditional: false, appliesTo: "" },
      { label: "State surcharge", kind: "surcharge", percent: 1, percentOf: "of the permit fee", conditional: false, appliesTo: "" },
      { label: "Plan revisions after permit issuance", kind: "revision", amountUsd: 50, conditional: false, appliesTo: "" },
    ]),
  });
  const fee4 = feeForProject(db, project(AHJ4), "permit");
  check("4. the minimum raises the permit line to $75 and is not added on top: $75 + $48.75 + $0.75 = $124.50",
    r4.saved && fee4?.feeUsd === 124.5 && !fee4.charges.some((c) => c.kind === "minimum"), JSON.stringify({ fee: fee4?.feeUsd, reason: fee4?.reason, charges: fee4?.charges.map((c) => [c.kind, c.amountUsd]) }));
  check("4. the bracket label says the schedule's minimum applies", /minimum applies/.test(fee4?.lines[0]?.bracketLabel ?? ""), fee4?.lines[0]?.bracketLabel);
  const rev = fee4?.charges.find((c) => c.kind === "revision");
  check("4. a revision fee is listed, outside the total, even when reported unconditional",
    rev?.futureContingent === true && rev.amountUsd === null && /NOT PART OF THIS QUOTE/.test(rev.reason), JSON.stringify(rev));

  // ---------------------------------------------------------------------------
  // 5. NOT FOUND, WITH THE HOSTS TRIED — and nothing written.
  // ---------------------------------------------------------------------------
  const AHJ5 = "City of Nowhere Falls";
  const r5 = await researchFeeSchedule(db, { state: STATE, ahj: AHJ5, track: "permit" }, {
    researcher: async (_input: unknown, options?: { ledger?: Ledger }) => {
      const ledger = options!.ledger!;
      // One host refused us (no evidence), one answered with a page that names no fee.
      (ledger.attempted ??= []).push("https://www.nowherefalls.example.test/building", "https://records.county.example.test/fees.pdf");
      ledger.evidence.push({ url: "https://records.county.example.test/fees.pdf", via: "http", status: 200, kind: "pdf", bytes: 10, handed: 1 });
      ledger.corpus.push("Records retention schedule");
      return { found: false, reason: "No published schedule located.", basis: "other", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "" };
    },
  });
  check("5. not found is reported NOT FOUND, never as no fees", !r5.found && /NOT FOUND/.test(r5.reason) && /not a finding that .* charges nothing/.test(r5.reason), r5.reason);
  check("5. the reason names every host tried, refused or not",
    r5.reason.includes("www.nowherefalls.example.test") && r5.reason.includes("records.county.example.test"), r5.reason);
  check("5. no schedule is written", !r5.saved && !getFeeSchedule(db, feeScheduleProfileKey({ state: STATE, ahj: AHJ5 }, "permit"), "permit"));
  const r5b = await researchFeeSchedule(db, { state: STATE, ahj: "City of Silent Falls", track: "permit" }, {
    researcher: async () => ({ found: false, reason: "", basis: "other", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "" }),
  });
  check("5. with no host reached, it says so", /no document was retrieved from any host/.test(r5b.reason), r5b.reason);

  // ---------------------------------------------------------------------------
  // 6. HARD RULE 3: a human-verified row is never touched by research.
  // ---------------------------------------------------------------------------
  const key3 = feeScheduleProfileKey({ state: STATE, ahj: AHJ3 }, "permit");
  markFeeScheduleVerified(db, key3, "permit", "test operator");
  const r6 = await researchFeeSchedule(db, { state: STATE, ahj: AHJ3, track: "permit" }, {
    researcher: researcherReading(URL1.replace("partialfalls", "wholefalls"), CORPUS1.replace("Partial", "Whole"), 999, "Solar photovoltaic system - residential", []),
  });
  const after6 = getFeeSchedule(db, key3, "permit");
  check("6. research against a verified row refuses, and adds no unpriced line",
    r6.refusedVerified && after6?.confidence === "verified" && after6.brackets[0].feeUsd === 100 && !after6.brackets[0].unpricedLines?.length,
    JSON.stringify({ refused: r6.refusedVerified, fee: after6?.brackets[0]?.feeUsd }));

  // ---------------------------------------------------------------------------
  // 7. THE WRITE PATH.
  // ---------------------------------------------------------------------------
  const replay = saveFeeSchedule(db, { state: STATE, ahj: "City of Replay Falls", track: "permit" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ feeUsd: 120, label: "Solar PV residential", unpricedLines: [{ kind: "plan_review", label: "Plan review", why: "not_found", printedLine: "", sourceUrl: "", appliesTo: "" }] }] as never,
    notes: "", sourceUrl: "https://replayfalls.example.test/fees", sourceQuote: "Solar PV residential | $120.00", sourceKind: "official",
  });
  check("7. a replayed unpriced line survives the untrusted path (it fails safe)",
    replay.saved && replay.schedule?.confidence === "seeded" && replay.schedule.brackets[0].unpricedLines?.[0]?.kind === "plan_review",
    JSON.stringify(replay.schedule?.brackets));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const findingsPath = path.join(dir, "findings.json");
  fs.writeFileSync(findingsPath, JSON.stringify({
    generatedAt: "2026-11-09T00:00:00Z", database: "scratch",
    findings: [{
      state: STATE, ahj: "City of Dryrun Falls", utility: "", track: "permit", discipline: "combo",
      finding: {
        found: true, reason: "", basis: "flat", brackets: [{ feeUsd: 90, label: "Solar PV residential" }], notes: "",
        paymentMethod: "portal", sourceUrl: "https://dryrunfalls.example.test/fees", sourceQuote: "Solar PV residential | $90.00", sourceKind: "official",
      },
    }],
  }), "utf8");
  const dryKey = feeScheduleProfileKey({ state: STATE, ahj: "City of Dryrun Falls" }, "permit");
  const run = (extra: string[]) => spawnSync(process.execPath, [tsxCli, path.join(repoRoot, "scripts", "apply-fee-findings.ts"), findingsPath, "--db", process.env.AUTOPILOT_DB_PATH as string, ...extra],
    { cwd: repoRoot, encoding: "utf8", timeout: 180_000 });
  db.close();
  const dry = run([]);
  const db2 = await openDatabase();
  check("7. apply-fee-findings is a DRY RUN by default: it writes nothing",
    dry.status === 0 && /DRY RUN/.test(dry.stdout) && !getFeeSchedule(db2, dryKey, "permit", "combo"), `${dry.stdout}\n${dry.stderr}`.slice(-600));
  db2.close();
  const wet = run(["--apply"]);
  const db3 = await openDatabase();
  check("7. --apply writes the finding as SEEDED",
    wet.status === 0 && /saved as SEEDED/.test(wet.stdout) && getFeeSchedule(db3, dryKey, "permit", "combo")?.confidence === "seeded", `${wet.stdout}\n${wet.stderr}`.slice(-600));
  db3.close();

  // The research script's ad-hoc target: any AHJ, named on the command line.
  const flags = (m: Record<string, string>) => (name: string) => m[name] ?? "";
  const t = adHocTarget(flags({ state: "ut", ahj: "City of Example Falls", discipline: "electrical" }));
  check("7. --state/--ahj names one permit target for any jurisdiction",
    t?.state === "UT" && t.ahj === "City of Example Falls" && t.track === "permit" && t.discipline === "electrical", JSON.stringify(t));
  check("7. no --state/--ahj falls back to the default list", adHocTarget(flags({})) === null);
  let threw = false;
  try { adHocTarget(flags({ ahj: "City of Example Falls" })); } catch { threw = true; }
  check("7. --ahj without a two-letter --state is refused", threw);

  if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
  console.log("all line-coverage checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
