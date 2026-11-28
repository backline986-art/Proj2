// ONE READ, ONE ANSWER (#263). A gate read built the reviewer report five times and the history
// report, application package and process map four times each; a job read took 0.75 s of blocked
// server on the production board. readMemo.ts shares each answer inside ONE synchronous read.
// These checks pin the rules that make that exact, on the real read paths.
//
// KILL (verified red by hand): take memoRead out of reviewerGateReportFor -> (r1) fails; drop the
// writeSeq comparison in memoRead -> (m3) and (r3) fail; return the stored value without
// structuredClone -> (m2) fails; skip the hash of an upload that shares its length -> (d1) fails.
//
//   npx tsx backend/test/readMemo.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-memo-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;
const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const docs = await import("../src/projectDocuments");
const sub = await import("../src/submissionDocuments");
const nextStep = await import("../src/nextStep");
const autopilot = await import("../src/autopilot");
const memo = await import("../src/readMemo");

let failures = 0;
const check = (name: string, fn: () => void) => { try { fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); } };
const touch = () => db.run("UPDATE projects SET updated_at = updated_at WHERE id = 'no-such-project'");

// ── The memo itself ──────────────────────────────────────────────────────────────────────
check("(m0) outside a read nothing is remembered", () => {
  let n = 0;
  memo.memoRead(db, "t:a", () => "", () => ++n);
  memo.memoRead(db, "t:a", () => "", () => ++n);
  assert.equal(n, 2);
  assert.equal(memo.readMemoActive(), false);
});
check("(m1) inside one read the answer is built once, and nested reads share it", () => {
  let n = 0;
  memo.withReadMemo(db, () => {
    memo.memoRead(db, "t:a", () => "", () => ({ n: ++n }));
    memo.withReadMemo(db, () => memo.memoRead(db, "t:a", () => "", () => ({ n: ++n })));
    assert.equal(memo.readMemoActive(), true, "the inner read must not end the outer one");
    assert.deepEqual(memo.memoRead(db, "t:a", () => "", () => ({ n: ++n })), { n: 1 });
  });
  assert.equal(n, 1);
});
check("(m2) every reader gets its own copy", () => {
  memo.withReadMemo(db, () => {
    const first = memo.memoRead(db, "t:b", () => "", () => ({ list: [1, 2] }));
    first.list.push(99);
    const second = memo.memoRead(db, "t:b", () => "", () => ({ list: [0] }));
    second.list.push(98);
    assert.deepEqual(memo.memoRead(db, "t:b", () => "", () => ({ list: [0] })).list, [1, 2]);
  });
});
check("(m3) MUST-EXCLUDE: any write between two readers means the answer is built again", () => {
  let n = 0;
  memo.withReadMemo(db, () => {
    memo.memoRead(db, "t:c", () => "", () => ++n);
    touch();
    memo.memoRead(db, "t:c", () => "", () => ++n);
  });
  assert.equal(n, 2);
});
check("(m4) MUST-EXCLUDE: an answer whose own build wrote something is never kept", () => {
  let n = 0;
  memo.withReadMemo(db, () => {
    memo.memoRead(db, "t:d", () => "", () => { touch(); return ++n; });
    memo.memoRead(db, "t:d", () => "", () => ++n);
  });
  assert.equal(n, 2);
});
check("(m5) MUST-EXCLUDE: a different input, or a different code-research setting, is a different answer", () => {
  let n = 0;
  const prev = process.env.SKIP_CODE_RESEARCH;
  memo.withReadMemo(db, () => {
    memo.memoRead(db, "t:e", () => "one", () => ++n);
    memo.memoRead(db, "t:e", () => "two", () => ++n);
    process.env.SKIP_CODE_RESEARCH = prev === "1" ? "" : "1";
    try { memo.memoRead(db, "t:e", () => "two", () => ++n); } finally { if (prev === undefined) delete process.env.SKIP_CODE_RESEARCH; else process.env.SKIP_CODE_RESEARCH = prev; }
  });
  assert.equal(n, 3);
});
check("(m6) a read that throws, or hands back a promise, leaves nothing behind", () => {
  assert.throws(() => memo.withReadMemo(db, () => { throw new Error("boom"); }));
  assert.equal(memo.readMemoActive(), false);
  void memo.withReadMemo(db, async () => 1);
  assert.equal(memo.readMemoActive(), false, "the memo must not be on while an await is pending");
});

// ── The real read paths ──────────────────────────────────────────────────────────────────
const project = repo.createProject(db, { owner: "Memo Owner", street: "1 Memo St", city: "Memoville", state: "OR", zip: "97000", ahj: "City of Memoville", utility: "Pacific Power", dcKw: "5", acKw: "4" } as never).project;
const save = (docType: string, bytes: string) =>
  docs.saveProjectDocument(db, project.id, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n${bytes}\n`), source: "upload" });
save("plan_set", "plan set pages");
save("module_spec", "module sheet");
const blank = (v: unknown) => JSON.stringify(v).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "T").replace(/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d\d:\d\d\s?[AP]M/g, "CLOCK");
const reads: Array<[string, () => unknown]> = [
  ["submit gate", () => repo.getSubmitGateReport(db, project.id)],
  ["installer packet", () => repo.getInstallerActionPacket(db, project.id)],
  ["process map", () => repo.getProjectProcessMap(db, project.id)],
  ["operations brief", () => repo.getOperationsBrief(db, project.id)],
  ["next step", () => nextStep.computeNextStep(db, project.id)],
  ["autopilot state", () => autopilot.getAutopilotState(db, project.id)],
];
// Warm everything a first read writes (the operations plan sync), so both passes read one state.
for (const [, read] of reads) read();

check("(r1) one gate read builds the reviewer report, history, package and process map once each", () => {
  memo.setReadMemoForTest(true);
  repo.getSubmitGateReport(db, project.id);
  // The gate builds each, then the process map and the installer packet ask again (2 reuses each);
  // the packet asks for the process map the gate already built (1 reuse).
  assert.deepEqual(memo.readMemoReuseCounts(), { gate: 2, hist: 2, appdocs: 2, pmap: 1 });
});
check("(r2) MUST-PASS: every read answers exactly what it answers with the memo off", () => {
  for (const [name, read] of reads) {
    memo.setReadMemoForTest(false);
    const plain = blank(read());
    assert.deepEqual(memo.readMemoReuseCounts(), {}, "memo off means nothing is reused");
    memo.setReadMemoForTest(true);
    assert.equal(blank(read()), plain, `${name} changed with the memo on`);
  }
});
check("(r3) MUST-EXCLUDE: a change to the job inside a read is seen by the next reader", () => {
  memo.setReadMemoForTest(true);
  memo.withReadMemo(db, () => {
    const before = repo.getProjectProcessMap(db, project.id);
    const again = repo.getProjectProcessMap(db, project.id);
    assert.equal(blank(again), blank(before));
    assert.equal(memo.readMemoReuseCounts().pmap, 1, "the unchanged job reuses the map");
    const gateBefore = memo.readMemoReuseCounts().gate || 0;
    db.run("UPDATE projects SET utility = ? WHERE id = ?", ["Portland General Electric", project.id]);
    const fresh = repo.getProjectDetail(db, project.id).project;
    assert.equal(fresh.utility, "Portland General Electric");
    repo.reviewerGateReportFor(db, fresh);
    assert.equal(memo.readMemoReuseCounts().gate || 0, gateBefore, "the changed job's reviewer report is built, not reused");
    const after = repo.getProjectProcessMap(db, project.id);
    assert.equal(memo.readMemoReuseCounts().pmap, 1, "after a write the map is built again, not reused");
    memo.setReadMemoForTest(false);
    const plain = repo.getProjectProcessMap(db, project.id);
    memo.setReadMemoForTest(true);
    assert.equal(blank(after), blank(plain), "and it is the changed job's map");
  });
});
check("(r4) the as-of-approval gate read (#226) is never shared", () => {
  memo.setReadMemoForTest(true);
  const p = repo.getProjectDetail(db, project.id).project;
  memo.withReadMemo(db, () => {
    repo.reviewerGateReportFor(db, p, { verdictsWrittenBefore: "2026-01-01T00:00:00.000Z" });
    repo.reviewerGateReportFor(db, p, { verdictsWrittenBefore: "2026-01-01T00:00:00.000Z" });
    assert.equal(memo.readMemoReuseCounts().gate || 0, 0);
    repo.reviewerGateReportFor(db, p);
    repo.reviewerGateReportFor(db, p, { verdictsWrittenBefore: "2026-01-01T00:00:00.000Z" });
    assert.equal(memo.readMemoReuseCounts().gate || 0, 0, "the plain answer must not stand in for the as-of read");
  });
});

// ── Duplicate uploads: only files of one length are hashed, and the answer is the same ─────
const file = (name: string, bytes: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, bytes); return f; };
check("(d1) MUST-EXCLUDE: byte-identical uploads are still found", () => {
  const a = file("a.pdf", "same bytes"), b = file("b.pdf", "same bytes"), c = file("c.pdf", "other length entirely");
  // No splitter cuts here (the second argument): these are uploads, and identical uploads are one document.
  assert.deepEqual(sub.duplicateUploads({ module_spec: a, inverter_spec: b, plan_set: c }, new Set()), [{ docType: "inverter_spec", sameAs: "module_spec" }]);
  assert.deepEqual(sub.duplicateUploads({ module_spec: a, inverter_spec: a }, new Set()), [{ docType: "inverter_spec", sameAs: "module_spec" }], "one stored file under two types");
});
check("(d2) MUST-PASS: same length, different bytes, is two documents", () => {
  assert.deepEqual(sub.duplicateUploads({ module_spec: file("d.pdf", "abcdefgh"), inverter_spec: file("e.pdf", "abcdefgX") }, new Set()), []);
});
check("(d3) a missing file changes nothing: the rest are compared as before", () => {
  const a = file("f.pdf", "same bytes"), b = file("g.pdf", "same bytes");
  assert.deepEqual(sub.duplicateUploads({ plan_set: path.join(tmp, "gone.pdf"), module_spec: a, inverter_spec: b }, new Set()), [{ docType: "inverter_spec", sameAs: "module_spec" }]);
});

memo.setReadMemoForTest(true);
if (failures) { console.error(`\n${failures} read-memo check(s) failed.`); process.exit(1); }
console.log("\nAll read-memo checks passed.");
process.exit(0);
