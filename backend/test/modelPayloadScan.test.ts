// SAFETY RULE 2 — THE ONE SCAN AT THE MODEL DOOR (backend/src/modelPayloadScan.ts).
//
// What this pins, with synthetic values only:
//   1. the matching: known values the way redactSecretValues matches them (separators, fullwidth),
//      a stored password with no digit as a literal, and the secret-shaped patterns — and the
//      shapes that must NOT be touched (a rating, a phone number, a date, a masked password);
//   2. the walk: every text part of a Messages request is read; signed / server-produced blocks
//      and base64 bytes are passed through byte-for-byte; the caller's objects are never mutated;
//   3. the job context: a project's account/meter/parser secrets and its client's stored portal
//      passwords (security answers too) are found with nothing passed in, and the audit row names
//      the builder and the KIND, never the value;
//   4. THE INTAKE LINE: only purpose INTAKE_DOCUMENT_READ *and* an intake task label exempts, and
//      only account/meter/utility ids — never an SSN, a password or a token;
//   5. strict mode throws, and is loud even when a builder swallows the throw;
//   6. the door is the only door: the guarded client scans create/stream/parse/countTokens/batches,
//      refuses the legacy completions API, and no source file builds a client or posts to the
//      Messages API any other way.
//
// Browser-free, no network (a local HTTP stub stands in for the API). Run: tsx backend/test/modelPayloadScan.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "model-payload-scan-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = "model-payload-scan-test-key-not-a-real-secret";
// The runner sets strict for every suite; this file drives leaks on purpose and turns strict on
// only for the checks about strict mode.
delete process.env.MODEL_PAYLOAD_SCAN_STRICT;

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { createPortalCredential } = await import("../src/portalCredentials");
const { runWithLlmContext } = await import("../src/llmAccounting");
const scan = await import("../src/modelPayloadScan");
const { scanText, scanModelRequest, runInModelCallScope, withIntakeDocumentRead, withModelSecrets, ModelPayloadLeakError, REDACTED, MODEL_PAYLOAD_AUDIT_ACTION, createModelClient } = scan;

const db = await openDatabase();

// Synthetic values. None is real; each has a shape the matcher must see through.
const ACCOUNT = "8814402937";
const METER = "80000100";
const ESI = "10443720001234567";
const SSN = "523-45-6789";
const PASSWORD = "Hunter-Solar-Pass"; // no digit: redactSecretValues alone would not match it
const SECURITY_ANSWER = "Mrs Fennimore Oakhaven";

const kindsOf = (hits: Map<string, number>) => Object.fromEntries(hits);

// ---------------------------------------------------------------------------------------------
// 1. Matching
// ---------------------------------------------------------------------------------------------
const known = [
  { kind: "account" as const, value: ACCOUNT },
  { kind: "meter" as const, value: METER },
  { kind: "portal-password" as const, value: PASSWORD },
];
const none = new Set<never>();

await check("known account/meter are found through separators, line breaks and fullwidth digits", () => {
  for (const variant of ["8814-402-937", "88 1440 2937", "8814\n402937", "８８１４４０２９３７", "8814­402937"]) {
    const hits = new Map();
    const out = scanText(`acct on file ${variant} thanks`, known, none, hits);
    assert.ok(!/\d{4}/.test(out.replace(/acct on file|thanks/g, "")), `${JSON.stringify(variant)} survived: ${out}`);
    assert.equal(hits.get("account"), 1, `${JSON.stringify(variant)} counted ${JSON.stringify(kindsOf(hits))}`);
  }
  const hits = new Map();
  assert.equal(scanText("site plan: exterior utility meter #80 000 100 on east wall", known, none, hits), `site plan: exterior utility meter #${REDACTED} on east wall`);
  assert.equal(hits.get("meter"), 1);
});

await check("a stored password with no digit is matched as an exact literal", () => {
  const hits = new Map();
  assert.equal(scanText(`login with ${PASSWORD} today`, known, none, hits), `login with ${REDACTED} today`);
  assert.equal(hits.get("portal-password"), 1);
});

await check("secret-shaped text nobody told us about is redacted, label kept", () => {
  const cases: Array<[string, string, string]> = [
    ["Account #: 7712 3456 78", `Account #: ${REDACTED}`, "account"],
    ["Acct No. 55501234-002X", `Acct No. ${REDACTED}`, "account"],
    ["Meter No. 55501234", `Meter No. ${REDACTED}`, "meter"],
    ["ESI ID: 10443720009999999", `ESI ID: ${REDACTED}`, "utility-id"],
    ["SA# 4455667788", `SA# ${REDACTED}`, "utility-id"],
    ["owner SSN 523456789", `owner SSN ${REDACTED}`, "ssn"],
    ["ref 523-45-6789 on file", `ref ${REDACTED} on file`, "ssn"],
    ["password: Sw0rdfish!", `password: ${REDACTED}`, "password"],
    ["Password is Sol@rPower!", `Password is ${REDACTED}`, "password"],
    ["key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV end", `key ${REDACTED} end`, "credential-token"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", `Authorization: Bearer ${REDACTED}`, "credential-token"],
    ["tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", `tok ${REDACTED}`, "credential-token"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----", REDACTED, "credential-token"],
    ["AWS AKIAIOSFODNN7EXAMPLE here", `AWS ${REDACTED} here`, "credential-token"],
  ];
  for (const [input, want, kind] of cases) {
    const hits = new Map();
    assert.equal(scanText(input, [], none, hits), want, input);
    assert.ok((hits.get(kind) ?? 0) >= 1, `${input} → kind ${kind}, got ${JSON.stringify(kindsOf(hits))}`);
  }
});

await check("shapes that are NOT secrets are left exactly as they are (no false positives)", () => {
  const clean = [
    "Main service panel 200A, meter 240 V, 120/240 V split phase",
    "Call the building desk at 503-555-0123 or (503) 555-0199",
    "Issued 2026-11-10, expires 2027-05-10; permit BLD-2026-04512",
    "Password: ******** (Forgot password?)",
    "Password: Forgot?",
    "Account Holder: Jane Example; Account number is printed on page 2",
    "Account number (\"Account Number\"/\"Account #\") → field: \"accountNumber\". Password / SSN → never fill.",
    "Module: REC Alpha Pure-R 410AA, 24 modules, 9.84 kW DC, azimuth 180",
    "Tesla string inverter part 1538000 = 7.6 kW / 31.7 A @ 240 V",
    "zip 97201, parcel 1S1E03BA 01200",
  ];
  for (const s of clean) {
    const hits = new Map();
    assert.equal(scanText(s, [], none, hits), s, `false positive on: ${s}`);
    assert.equal(hits.size, 0);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. The walk
// ---------------------------------------------------------------------------------------------
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const mkRequest = () => ({
  model: "claude-opus-5",
  max_tokens: 100,
  system: [{ type: "text", text: `You file for account ${ACCOUNT}.`, cache_control: { type: "ephemeral" } }],
  tools: [{ name: "lookup", description: `Look up meter ${METER}`, input_schema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: `Bill says account 8814-402-937, password ${PASSWORD}` },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `the account is ${ACCOUNT}`, signature: "sig-abc" },
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: `acct ${ACCOUNT}` } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.gov/x", title: `t ${ACCOUNT}`, encrypted_content: "enc" }] },
        { type: "text", text: `I will look up ${METER}` },
        { type: "tool_use", id: "tu_1", name: "lookup", input: { project: { meter: METER, nested: [`ssn ${SSN}`] }, name: `acct ${ACCOUNT}` } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: `{"accountNumber":"${ACCOUNT}"}` },
        { type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: `meter ${METER}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
        { type: "document", source: { type: "text", media_type: "text/plain", data: `Statement for account ${ACCOUNT}` }, title: `Bill ${ACCOUNT}` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        { type: "text", text: "Extract now." },
      ],
    },
  ],
});
const flat = (v: unknown): string => JSON.stringify(v);

await check("every text part is scanned: system, messages, tool_use input, tool_result (string and blocks), documents, tool descriptions", () => {
  const req = mkRequest();
  const out = runInModelCallScope({ label: "planPortalFields", secrets: known }, () => scanModelRequest(req));
  const sent = flat({ system: out.system, tools: out.tools, user0: out.messages[0], text: (out.messages[1].content as unknown[])[3], tu: (out.messages[1].content as unknown[])[4], user2: out.messages[2] });
  assert.ok(!sent.includes(ACCOUNT) && !sent.includes("8814-402-937"), "account reached the model");
  assert.ok(!sent.includes(METER), "meter reached the model");
  assert.ok(!sent.includes(PASSWORD), "password reached the model");
  assert.ok(!sent.includes(SSN), "ssn reached the model");
  assert.ok(sent.includes(REDACTED));
});

await check("signed / server-produced blocks and base64 bytes pass through byte-for-byte", () => {
  const req = mkRequest();
  const out = runInModelCallScope({ label: "planPortalFields", secrets: known }, () => scanModelRequest(req));
  const a = out.messages[1].content as Array<Record<string, unknown>>;
  assert.deepEqual(a[0], req.messages[1].content[0], "thinking block edited — its signature would no longer verify");
  assert.deepEqual(a[1], (req.messages[1].content as unknown[])[1]);
  assert.deepEqual(a[2], (req.messages[1].content as unknown[])[2]);
  const u = out.messages[2].content as Array<Record<string, unknown>>;
  assert.equal(((u[3].source as Record<string, unknown>).data), PNG);
  assert.equal(out.model, "claude-opus-5");
  assert.equal(out.max_tokens, 100);
  assert.deepEqual((out.system as Array<Record<string, unknown>>)[0].cache_control, { type: "ephemeral" }, "the cache breakpoint must survive");
});

await check("the caller's request is never mutated, and a clean request is returned as the same object", () => {
  const req = mkRequest();
  const before = flat(req);
  runInModelCallScope({ label: "planPortalFields", secrets: known }, () => scanModelRequest(req));
  assert.equal(flat(req), before);
  const clean = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "Find the permit fee for a 7 kW system." }] };
  assert.equal(runInModelCallScope({ label: "webLookup" }, () => scanModelRequest(clean)), clean);
});

// ---------------------------------------------------------------------------------------------
// 3. The job context and the audit row
// ---------------------------------------------------------------------------------------------
const client = createClient(db, { companyName: "Scan Test Solar", ccbLicenseNumber: "999002", businessEmail: "office@scan-test.example" });
createPortalCredential(db, client.id, { portalType: "utility", portalUrl: "https://nem.example.com", username: "synthetic-user", password: PASSWORD, securityAnswers: SECURITY_ANSWER });
const detail = createProject(db, { customerName: "Pat Example", address: "1 Example St", city: "Exampleville", state: "OR" } as never);
const projectId = detail.project.id;
db.run("UPDATE projects SET account_number = ?, meter_number = ?, parser_json = ?, client_id = ? WHERE id = ?",
  [ACCOUNT, METER, JSON.stringify({ esiId: ESI, ownerSsn: SSN, systemKw: 7.2 }), client.id, projectId]);

const auditRows = () => db.query<{ project_id: string | null; actor_name: string; action: string; details: string }>(
  "SELECT project_id, actor_name, action, details FROM audit_logs WHERE action = ? ORDER BY created_at", [MODEL_PAYLOAD_AUDIT_ACTION]);

await check("the job's project and its client's stored passwords (and security answers) are found from context alone", () => {
  const text = `acct ${ACCOUNT} meter ${METER} esi ${ESI} ssn ${SSN} pw ${PASSWORD} answer ${SECURITY_ANSWER}`;
  const out = runWithLlmContext({ projectId, jobId: "job-1", orgId: null }, () =>
    runInModelCallScope({ label: "reviewPlanSetGeneral" }, () => scanModelRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: text }] })));
  const sent = out.messages[0].content as string;
  for (const v of [ACCOUNT, METER, ESI, SSN, PASSWORD, SECURITY_ANSWER]) assert.ok(!sent.includes(v), `${v.slice(0, 3)}… reached the model: ${sent}`);
});

await check("ONE audit row per redacted request: names the builder and the KINDS, never a value", () => {
  const rows = auditRows();
  const last = rows[rows.length - 1];
  assert.ok(last, "no audit row written");
  assert.equal(last.project_id, projectId);
  assert.equal(last.actor_name, "modelPayloadScan");
  const d = JSON.parse(last.details) as { builder: string; kinds: Record<string, number>; where: string[]; jobId: string };
  assert.equal(d.builder, "reviewPlanSetGeneral");
  assert.equal(d.jobId, "job-1");
  for (const k of ["account", "meter", "utility-id", "ssn", "portal-password"]) assert.ok(d.kinds[k] >= 1, `kind ${k} missing from ${last.details}`);
  assert.deepEqual(d.where, ["message"]);
  for (const v of [ACCOUNT, METER, ESI, SSN, PASSWORD, SECURITY_ANSWER, "8814", "Hunter"]) assert.ok(!last.details.includes(v), `the audit row carries a value: ${last.details}`);
});

await check("a project object the caller holds (withModelSecrets) is matched outside a job context", () => {
  const out = withModelSecrets(scan.projectKnownSecrets({ accountNumber: "6655443322", meterNumber: null, parserSnapshot: {} }), () =>
    runInModelCallScope({ label: "classifyCorrection" }, () => scanModelRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "Please confirm acct 66 5544 3322." }] })));
  assert.equal(out.messages[0].content, `Please confirm acct ${REDACTED}.`);
});

// ---------------------------------------------------------------------------------------------
// 4. THE INTAKE LINE
// ---------------------------------------------------------------------------------------------
const intakeText = `UTILITY_BILL: Account Number 8814-402-937, Meter # 80 000 100, ESI ID ${ESI}. Customer SSN ${SSN}. Portal password: Sw0rdfish! pw ${PASSWORD}`;
const send = (label: string) => runWithLlmContext({ projectId, jobId: null, orgId: null }, () =>
  runInModelCallScope({ label }, () => scanModelRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: intakeText }] }).messages[0].content as string));

await check("INTAKE (purpose + intake label) may read account, meter and utility id off the customer's own bill", () => {
  for (const label of ["extractProjectFields", "extractProjectFieldsFromImages", "extractProjectFields#2"]) {
    const sent = withIntakeDocumentRead(() => send(label));
    assert.ok(sent.includes("8814-402-937"), `${label}: the account the intake read exists to find was redacted`);
    assert.ok(sent.includes("80 000 100") && sent.includes(ESI), `${label}: meter/ESI redacted`);
  }
});

await check("...but NEVER an SSN, a portal password or a written-out password, even inside intake", () => {
  const sent = withIntakeDocumentRead(() => send("extractProjectFieldsFromImages"));
  assert.ok(!sent.includes(SSN), "SSN reached the model on the intake read");
  assert.ok(!sent.includes(PASSWORD), "stored portal password reached the model on the intake read");
  assert.ok(!sent.includes("Sw0rdfish!"), "a written-out password reached the model on the intake read");
});

await check("the purpose alone exempts nothing: any other builder inside withIntakeDocumentRead is scanned in full", () => {
  for (const label of ["classifyPlanPages", "planPortalFields", "reviewPlanSetGeneral", "runTriage#1", "extractFields", "(unlabelled)"]) {
    const sent = withIntakeDocumentRead(() => send(label));
    assert.ok(!sent.includes("8814-402-937") && !sent.includes("80 000 100") && !sent.includes(ESI), `${label} got the intake exemption`);
  }
});

await check("the label alone exempts nothing: an intake label without the intake purpose is scanned in full", () => {
  const sent = send("extractProjectFieldsFromImages");
  assert.ok(!sent.includes("8814-402-937") && !sent.includes("80 000 100"), "an intake LABEL without the purpose got the exemption");
});

// ---------------------------------------------------------------------------------------------
// 5. Strict mode
// ---------------------------------------------------------------------------------------------
await check("strict (MODEL_PAYLOAD_SCAN_STRICT=1, as the test runner sets): a leak THROWS and marks the process red", () => {
  process.env.MODEL_PAYLOAD_SCAN_STRICT = "1";
  const realError = console.error;
  let printed = "";
  console.error = (...a: unknown[]) => { printed += a.join(" "); };
  try {
    assert.throws(
      () => runInModelCallScope({ label: "verifyPortalFill", secrets: known }, () => scanModelRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: `acct ${ACCOUNT}` }] })),
      (err: unknown) => err instanceof ModelPayloadLeakError && /verifyPortalFill/.test(err.message) && !err.message.includes(ACCOUNT),
    );
    assert.match(printed, /FAIL - model payload scan/, "a builder that swallows the throw must still leave a FAIL line");
    assert.equal(process.exitCode, 1, "a builder that swallows the throw must still leave a non-zero exit");
    // a clean request in strict mode is not an error
    runInModelCallScope({ label: "webLookup" }, () => scanModelRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "permit fee for 7 kW" }] }));
  } finally {
    console.error = realError;
    process.exitCode = 0;
    delete process.env.MODEL_PAYLOAD_SCAN_STRICT;
  }
});

// ---------------------------------------------------------------------------------------------
// 6. The guarded client is the only door
// ---------------------------------------------------------------------------------------------
const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw); } catch { /* keep {} */ }
    captured.push({ path: req.url ?? "", body });
    const url = req.url ?? "";
    res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
    if (url.includes("count_tokens")) { res.end(JSON.stringify({ input_tokens: 10 })); return; }
    if (url.includes("batches")) { res.end(JSON.stringify({ id: "msgbatch_1", type: "message_batch", processing_status: "in_progress", request_counts: {}, created_at: new Date().toISOString(), expires_at: new Date().toISOString() })); return; }
    const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "{}", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) { res.end(JSON.stringify(message)); return; }
    const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    res.end(
      ev("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } })
      + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } })
      + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "{}" } })
      + ev("content_block_stop", { type: "content_block_stop", index: 0 })
      + ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
      + ev("message_stop", { type: "message_stop" }),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const c = createModelClient({ apiKey: "sk-ant-test-not-real", baseURL: base, maxRetries: 0 });
const leaky = (extra: Record<string, unknown> = {}) => ({ model: "claude-opus-5", max_tokens: 10, system: `acct ${ACCOUNT}`, messages: [{ role: "user" as const, content: `meter ${METER} pw ${PASSWORD}` }], ...extra });

await check("every send method of the guarded client is scanned before the request leaves", async () => {
  captured.length = 0;
  await runInModelCallScope({ label: "webLookup", secrets: known }, async () => {
    await c.messages.create(leaky() as never);
    await c.messages.stream(leaky() as never).finalMessage();
    await c.messages.parse(leaky() as never);
    await c.messages.countTokens({ model: "claude-opus-5", system: `acct ${ACCOUNT}`, messages: [{ role: "user", content: `meter ${METER}` }] } as never);
    await c.beta.messages.stream(leaky({ betas: ["advisor-tool-2026-03-01"] }) as never).finalMessage();
    await c.beta.messages.create(leaky() as never);
    await c.messages.batches.create({ requests: [{ custom_id: "r1", params: leaky() }] } as never);
  });
  assert.equal(captured.length, 7, `expected 7 requests at the stub, saw ${captured.map((x) => x.path).join(", ")}`);
  for (const r of captured) {
    const s = flat(r.body);
    assert.ok(!s.includes(ACCOUNT) && !s.includes(METER) && !s.includes(PASSWORD), `${r.path} carried a secret: ${s.slice(0, 300)}`);
    assert.ok(s.includes(REDACTED), `${r.path} was not scanned`);
  }
});

await check("the legacy completions API is refused outright (it would bypass the scan)", async () => {
  assert.throws(() => (c as unknown as { completions: { create: (p: unknown) => unknown } }).completions.create({ model: "x", prompt: `acct ${ACCOUNT}`, max_tokens_to_sample: 1 }), /bypasses the rule-2 model payload scan/);
});

server.close();

await check("NO SOURCE FILE builds a model client or posts to the Messages API except through createModelClient", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  // The standalone PDF form-filler (tools/form-filler) is its own package, split out of this repo's
  // engine: it runs no Keelix job, reads no Keelix project or credential, and cannot import the
  // backend. Listed here by name so a SECOND exception has to be argued for the same way.
  const ALLOWED = new Set(["backend/src/modelPayloadScan.ts", "tools/form-filler/src/autoMap.ts"]);
  const dirs = ["backend/src", "portal-bot/src", "shared/src", "scripts", "tools"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(rel);
      else if (/\.(m?ts|m?js|tsx)$/.test(e.name) && !/\.test\.ts$|\.smoke\.ts$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(root, d))) walk(d);
  for (const f of fs.readdirSync(root)) if (/\.(m?ts|m?js)$/.test(f)) files.push(f);
  assert.ok(files.length > 200, `walked only ${files.length} files — the walk is broken`);
  const offenders: string[] = [];
  for (const f of files) {
    if (ALLOWED.has(f)) continue;
    const src = fs.readFileSync(path.join(root, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // comments may name the API
    if (/new\s+Anthropic\w*\s*\(/.test(src)) offenders.push(`${f}: new Anthropic(`);
    if (/api\.anthropic\.com|\/v1\/messages\b/.test(src)) offenders.push(`${f}: hand-built Messages API request`);
    if (/from\s+["']@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk)["']/.test(src) && !/^import\s+type\b/m.test(src.match(/^.*from\s+["']@anthropic-ai\/(?:sdk|bedrock-sdk|vertex-sdk)["'].*$/m)?.[0] ?? "") && f !== "backend/src/llm.ts") {
      offenders.push(`${f}: imports the SDK as a value (build the client with createModelClient)`);
    }
  }
  assert.deepEqual(offenders, [], `model requests that bypass the payload scan:\n  ${offenders.join("\n  ")}`);
});

db.close();
fs.rmSync(scratch, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall model payload scan checks passed");
