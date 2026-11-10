// SAFETY RULE 2 — THE BUILDER TABLE. EVERY prompt builder, fed synthetic secrets in every field,
// against a stub of the Messages API: none of them reaches the stub.
//
// The table is the point. It drives the REAL ClaudeLLMProvider (and fee research's own loop) with
// ANTHROPIC_BASE_URL pointed at a local stub, inside a job context whose project carries a synthetic
// account/meter/ESI/SSN and whose client holds a stored portal password + security answer. Every
// string field of every builder's input carries those values (in the separator-laden shapes real
// documents print them in) plus secret-shaped values nobody told us about. Each request the stub
// receives is checked for every one of them.
//
// THE TABLE FAILS WHEN A BUILDER EXISTS THAT IT DOES NOT LIST:
//   - every task in modelRouting.LLM_TASKS (the registry every model call's label must be in —
//     modelRouting.test pins that for llm.ts) must be produced by some row, and each row must
//     produce every task it claims;
//   - every method on ClaudeLLMProvider.prototype must be a row or a named helper;
//   - every source file that builds a model client (createModelClient) must be listed here;
//   - no request may reach the stub unlabelled.
// THE INTAKE ROWS prove the exemption is exactly rule 2's: the bill's account/meter DO reach the
// model on extractProjectFields / extractProjectFieldsFromImages, and nothing else does.
//
// Revert the scan (createModelClient → plain `new Anthropic`) and every row goes red.
// Browser-free, no network, no spend. Run: tsx backend/test/modelPayloadScanBuilders.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "model-payload-builders-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = "model-payload-builders-test-key-not-a-real-secret";
process.env.ANTHROPIC_API_KEY = "sk-ant-stub-key-not-real-0000";
process.env.WEB_RESEARCH_TIMEOUT_MS = "20000";
// The table proves REDACTION (production behaviour): with strict on, the first leak would throw
// before the stub could show what would have been sent. modelPayloadScan.test pins strict mode.
delete process.env.MODEL_PAYLOAD_SCAN_STRICT;

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// The stub API. Text "{}" for everything, except: a request offering the agent's `lookup_project`
// tool and holding no tool_result yet gets a tool_use back, so the agent's SECOND request carries
// a tool result built from project data — the forwarded-tool-result path.
// ---------------------------------------------------------------------------------------------
interface Captured { path: string; body: Record<string, unknown> }
const captured: Captured[] = [];
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function respond(body: Record<string, unknown>): { blocks: Array<Record<string, unknown>>; stop: string } {
  const tools = (body.tools as Array<{ name?: string }> | undefined) ?? [];
  const msgs = (body.messages as Array<{ content: unknown }> | undefined) ?? [];
  const hasResult = msgs.some((m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b.type === "tool_result"));
  if (tools.some((t) => t.name === "lookup_project") && !hasResult) {
    return { blocks: [{ type: "tool_use", id: "toolu_1", name: "lookup_project", input: { projectId: "p1" } }], stop: "tool_use" };
  }
  return { blocks: [{ type: "text", text: "{}" }], stop: "end_turn" };
}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw); } catch { /* keep {} */ }
    const url = req.url ?? "";
    captured.push({ path: url, body });
    if (url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 100 })); return; }
    const { blocks, stop } = respond(body);
    const message = { id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5", content: [] as unknown[], stop_reason: null as string | null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...message, content: blocks.map((b) => (b.type === "text" ? { ...b, citations: null } : b)), stop_reason: stop, usage: { input_tokens: 100, output_tokens: 10 } }));
      return;
    }
    let out = ev("message_start", { type: "message_start", message });
    blocks.forEach((b, i) => {
      if (b.type === "tool_use") {
        out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      } else {
        out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "", citations: null } });
        out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
      }
      out += ev("content_block_stop", { type: "content_block_stop", index: i });
    });
    out += ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
    out += ev("message_stop", { type: "message_stop" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(out);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { createPortalCredential } = await import("../src/portalCredentials");
const { runWithLlmContext } = await import("../src/llmAccounting");
const { ClaudeLLMProvider, PLANNER_USER_TOKEN_BUDGET } = await import("../src/llm");
const { LLM_TASKS, taskForLabel } = await import("../src/modelRouting");
const { recentModelPayloadScans, REDACTED } = await import("../src/modelPayloadScan");
const { claudeFeeScheduleResearcher } = await import("../src/feeSchedules");
const { redactSecretValues } = await import("../../shared/src/portalSafety");

const db = await openDatabase();

// ---------------------------------------------------------------------------------------------
// Synthetic secrets. KNOWN ones live on the job's project / client; UNKNOWN ones only have a shape.
// ---------------------------------------------------------------------------------------------
const ACCOUNT = "8814402937";
const METER = "80000100";
const ESI = "10443720001234567";
const SSN = "523-45-6789";
const PASSWORD = "Hunter-Solar-Pass";
const SECURITY_ANSWER = "Mrs Fennimore Oakhaven";
const UNKNOWN_ACCOUNT = "7712345678";
const UNKNOWN_METER = "55501234";
const WRITTEN_PASSWORD = "Sw0rdfish!";
const API_KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
const BEARER = "abcdefghijklmnopqrstuvwxyz012345";

const SECRET_TEXT = [
  "Customer acct 8814-402-937", "meter 80 000 100", `ESI ID ${ESI}`, `SSN ${SSN}`,
  `portal pw ${PASSWORD}`, `security answer ${SECURITY_ANSWER}`, "Account #: 7712 3456 78", "Meter No. 55501234",
  `password: ${WRITTEN_PASSWORD}`, `key ${API_KEY}`, `Authorization: Bearer ${BEARER}`,
].join(" | ");
const S = (prefix: string) => `${prefix} ${SECRET_TEXT}`;

/** What must never reach the model, by kind. Numbers are compared separator-blind. */
const NUMERIC = { account: [ACCOUNT, UNKNOWN_ACCOUNT], meter: [METER, UNKNOWN_METER], "utility-id": [ESI], ssn: [SSN] };
const LITERAL = { "portal-password": [PASSWORD, SECURITY_ANSWER], password: [WRITTEN_PASSWORD], "credential-token": [API_KEY, BEARER] };
const INTAKE_READABLE = new Set(["account", "meter", "utility-id"]);

const client = createClient(db, { companyName: "Builder Table Solar", ccbLicenseNumber: "999003", businessEmail: "office@builder-table.example" });
createPortalCredential(db, client.id, { portalType: "utility", portalUrl: "https://nem.example.com", username: "synthetic-user", password: PASSWORD, securityAnswers: SECURITY_ANSWER });
const projectId = createProject(db, { customerName: "Pat Example", address: "1 Example St", city: "Exampleville", state: "OR" } as never).project.id;
db.run("UPDATE projects SET account_number = ?, meter_number = ?, parser_json = ?, client_id = ? WHERE id = ?",
  [ACCOUNT, METER, JSON.stringify({ esiId: ESI, ownerSsn: SSN }), client.id, projectId]);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMG = { base64: PNG, mimeType: "image/png" as const };
const provider = new ClaudeLLMProvider("sk-ant-stub-key-not-real-0000");
const project = { id: projectId, homeownerName: S("Pat"), ahj: S("City of Example"), projectAddress: S("1 Example St"), city: "Exampleville", state: "OR", systemSizeDcKw: 7.2, utility: S("Example Power"), accountNumber: ACCOUNT, meterNumber: METER } as never;
const pageFields = [
  { index: 0, label: S("Account Number"), fieldType: "text", section: S("Utility"), options: [S("opt")] },
  { index: 1, label: "Continue", fieldType: "button" },
];

// ---------------------------------------------------------------------------------------------
// THE TABLE. One row per builder method; `tasks` = the LLM_TASKS its calls are labelled with
// (rows whose label is the CALLER's own name it under `callerLabels`).
// ---------------------------------------------------------------------------------------------
interface Row {
  method: string; tasks: string[]; callerLabels?: string[]; intake?: boolean;
  /** The builder takes no caller text at all (page images and page numbers only): nothing to redact,
   *  so the row proves only that its requests are labelled, scanned and clean. */
  textFree?: boolean;
  run: () => Promise<unknown>;
}
const ROWS: Row[] = [
  { method: "extractFields", tasks: ["extractFields"], run: () => provider.extractFields({ text: S("permit application"), notes: S("n") }) },
  {
    method: "extractProjectFields", tasks: ["extractProjectFields"], intake: true,
    run: () => provider.extractProjectFields({ planText: S("PV-1"), utilityBillText: S("BILL"), meterText: S("METER"), structuralLetterText: S("LETTER"), defaultState: "OR" }),
  },
  {
    method: "extractProjectFieldsFromImages", tasks: ["extractProjectFieldsFromImages"], intake: true,
    run: () => provider.extractProjectFieldsFromImages({ images: [{ kind: "utility_bill", ...IMG }, { kind: "meter_photo", ...IMG }], defaultState: S("OR") }),
  },
  { method: "classifyPlanPages", tasks: ["classifyPlanPages"], textFree: true, run: () => provider.classifyPlanPages({ pageImages: [{ page: 1, ...IMG }] }) },
  { method: "orientPlanPages", tasks: ["classifyPlanPages"], textFree: true, run: () => provider.orientPlanPages({ pages: [{ page: 1, versions: [{ rotate: 0, ...IMG }, { rotate: 90, ...IMG }] }] }) },
  { method: "classifyCorrection", tasks: ["classifyCorrection"], run: () => provider.classifyCorrection({ correctionText: S("Please correct"), project }) },
  { method: "draftResponse", tasks: ["draftResponse"], run: () => provider.draftResponse({ correctionText: S("Please correct"), project }) },
  { method: "visionExtract", tasks: ["visionExtract"], run: () => provider.visionExtract({ imageBase64: PNG, mimeType: "image/png", prompt: S("Read the label") }) },
  {
    method: "reviewPlanSetGeneral", tasks: ["reviewPlanSetGeneral"],
    run: () => provider.reviewPlanSetGeneral({ workType: "solar_pv" as never, jurisdictionLabel: S("City of Example"), codeSummary: S("2021 IRC"), verifiedProfile: false, pageImagesBase64: [PNG], extractedText: S("SLD"), applicantFacts: { owner: S("Pat"), account: S("acct") } }),
  },
  {
    method: "synthesizeKnowledge", tasks: ["synthesizeKnowledge"],
    run: () => provider.synthesizeKnowledge({ ahjName: S("City of Example"), state: "OR", utility: S("Example Power"), pastApplicationTexts: [S("app 1")], correctionPatterns: [S("corr 1")] }),
  },
  { method: "researchAhjRequirements", tasks: ["researchAhjRequirements", "researchAhjRequirements.fallback"], run: () => provider.researchAhjRequirements({ ahj: S("City of Example"), state: "OR", utility: S("Example Power"), knownContext: S("ctx") }) },
  { method: "researchUtilityRequirements", tasks: ["researchUtilityRequirements", "researchUtilityRequirements.fallback"], run: () => provider.researchUtilityRequirements({ utility: S("Example Power"), state: "OR", ahj: S("City of Example"), knownContext: S("ctx") }) },
  { method: "researchDesignCriteria", tasks: ["researchDesignCriteria"], run: () => provider.researchDesignCriteria({ ahj: S("City of Example"), state: "OR", issuerPage: { url: "https://example.gov/design", text: S("Design criteria") } }) },
  { method: "researchJurisdictionCodes", tasks: ["researchJurisdictionCodes"], run: () => provider.researchJurisdictionCodes({ ahj: S("City of Example"), state: "OR" } as never) },
  { method: "webLookup", tasks: ["webLookup"], callerLabels: ["builderTable.lookup"], run: () => provider.webLookup({ label: "builderTable.lookup", system: S("You look things up."), user: S("Find the fee"), readPages: true }) },
  {
    method: "suggestRecipeFieldBindings", tasks: ["suggestRecipeFieldBindings"],
    run: () => provider.suggestRecipeFieldBindings({ unbound: [{ index: 0, action: "fill", label: S("Account"), value: S("v") }], fieldValues: { accountNumber: S("v"), homeownerName: S("Pat") } }),
  },
  {
    method: "planPortalFields", tasks: ["planPortalFields", "planPortalFields.vision"],
    run: async () => {
      const page = { url: "https://portal.example.gov/apply", pageTitle: S("Step 2"), fields: pageFields, bodyText: S("Step 2 of 6"), projectFields: { accountNumber: S("v"), homeownerName: S("Pat") }, alreadyFilledLabels: [S("done")], kbContext: S("kb") };
      await provider.planPortalFields(page as never);
      await provider.planPortalFields({ ...page, screenshotBase64: PNG } as never);
    },
  },
  {
    method: "verifyPortalFill", tasks: ["verifyPortalFill"],
    run: () => provider.verifyPortalFill({ reviewFields: [{ label: S("Account"), value: S("v") }], projectFields: { accountNumber: S("v") }, bodyText: S("Review") }),
  },
  {
    method: "verifyPortalFillVision", tasks: ["verifyPortalFillVision"],
    run: () => provider.verifyPortalFillVision({ screenshotBase64: PNG, mimeType: "image/png", reviewFields: [{ label: S("Account"), value: S("v") }], projectFields: { accountNumber: S("v") }, bodyText: S("Review") }),
  },
  { method: "lookupInverterSpec", tasks: ["lookupInverterSpec", "lookupInverterSpec.web"], run: () => provider.lookupInverterSpec({ inverterModel: S("XQ-UNKNOWN-7600"), inverterQty: 1, acNameplateKw: 7.6, serviceVoltageV: 240 }) },
  { method: "findAhjFormUrl", tasks: ["findAhjFormUrl"], run: () => provider.findAhjFormUrl({ ahj: S("City of Example"), state: "OR", formType: S("solar"), knownContext: S("ctx"), documentNames: [S("Solar Permit Application")], maxSearches: 1, budgetMs: 20000 }) },
  {
    method: "mapAcroFormFields", tasks: ["mapAcroFormFields"],
    run: () => provider.mapAcroFormFields({ ahj: S("City of Example"), state: "OR", formName: S("Permit Application"), fields: [{ name: S("OwnerName"), type: "text", caption: S("Owner"), captions: { left: S("l") } }], availableSources: [S("project.homeownerName")] }),
  },
  {
    method: "mapFlatFormOverlay", tasks: ["mapFlatFormOverlay"],
    run: () => provider.mapFlatFormOverlay({ ahj: S("City of Example"), state: "OR", formName: S("Permit Application"), pages: [IMG], availableSources: [S("project.homeownerName")] }),
  },
  {
    method: "runToolAgent", tasks: ["runToolAgent"], callerLabels: ["correctionTriage"],
    run: () => provider.runToolAgent({
      label: "correctionTriage", system: S("You triage corrections."), user: S("Triage this correction"), maxIterations: 2,
      tools: [{
        name: "lookup_project", description: S("Look up the project"), input_schema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
        // The tool result is built from project data — the path a local tool could leak through.
        handler: async () => ({ kind: "json", value: { accountNumber: ACCOUNT, meter: "80-000-100", notes: SECRET_TEXT } }),
      }],
    } as never),
  },
];
/** Builders outside ClaudeLLMProvider that hold their own client (createModelClient). */
const EXTERNAL_ROWS: Row[] = [
  {
    method: "feeSchedules.claudeFeeScheduleResearcher", tasks: ["researchFeeSchedule"],
    run: () => claudeFeeScheduleResearcher({ track: "permit", state: "OR", ahj: S("City of Example"), utility: S("Example Power"), knownContext: S("ctx") } as never, {} as never),
  },
];
/** Files that may call createModelClient — each one's builder is a row above. */
const CLIENT_FILES = new Set(["backend/src/llm.ts", "backend/src/feeSchedules.ts"]);
/** ClaudeLLMProvider methods that are plumbing, not builders (they only run inside a row's builder). */
const HELPERS = new Set([
  "constructor", "instrument", "runOnce", "streamFinal", "withAdvisorNudge", "routeOf", "textOf", "cachedSystem", "countPlannerPrompt",
  "ask", "parseJson", "readStructured", "askLong", "askLongDetailed", "askLongWithImage", "normalizeExtraction", "askWithWebSearch",
  "cleanFieldSourceString", "extractProjectFieldsUnscoped", "extractProjectFieldsFromImagesUnscoped", "classifyCorrectionScoped", "draftResponseScoped",
]);

// ---------------------------------------------------------------------------------------------
// The leak check on one captured request
// ---------------------------------------------------------------------------------------------
function bodyText(body: Record<string, unknown>): string {
  // Base64 bytes are masked upstream (#293/#612) and are not text; drop them so a digit run inside
  // an image cannot read as a leak.
  return JSON.stringify(body, (k, v) => (k === "data" && typeof v === "string" && v.length > 64 ? "" : v));
}
function leaks(body: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  const s = bodyText(body);
  const out: string[] = [];
  for (const [kind, values] of Object.entries(NUMERIC)) {
    if (allowed.has(kind)) continue;
    for (const v of values) if (redactSecretValues(s, [v]) !== s) out.push(`${kind} ${v.slice(0, 3)}…`);
  }
  for (const [kind, values] of Object.entries(LITERAL)) {
    if (allowed.has(kind)) continue;
    for (const v of values) if (s.includes(v)) out.push(`${kind} ${v.slice(0, 3)}…`);
  }
  return out;
}

const seen = new Map<string, Set<string>>(); // row → labels its calls carried
for (const row of [...ROWS, ...EXTERNAL_ROWS]) {
  captured.length = 0;
  const since = Date.now();
  let err: unknown = null;
  await runWithLlmContext({ projectId, jobId: `job-${row.method}`, orgId: null }, async () => {
    try { await row.run(); } catch (e) { err = e; }
  });
  const scans = recentModelPayloadScans(since);
  seen.set(row.method, new Set(scans.map((s) => s.label)));
  await check(`${row.method}: ${captured.length} request(s) reached the stub, none carrying a secret${row.intake ? " the intake read may not see" : ""}`, () => {
    assert.ok(captured.length > 0, `the builder sent nothing (${err instanceof Error ? err.message : String(err)}) — the row proves nothing`);
    for (const c of captured) {
      const found = leaks(c.body, row.intake ? INTAKE_READABLE : new Set());
      assert.deepEqual(found, [], `${c.path} carried: ${found.join(", ")}`);
      if (c.path.includes("count_tokens")) continue;
    }
    if (!row.textFree) assert.ok(captured.some((c) => bodyText(c.body).includes(REDACTED)), "nothing was redacted — the fixture's secrets never reached the scan");
  });
  if (row.intake) {
    await check(`${row.method}: THE INTAKE READ still sees the bill's account and meter (the one allowed read)`, () => {
      const s = captured.map((c) => bodyText(c.body)).join("\n");
      assert.ok(s.includes("8814-402-937"), "the account the intake read exists to find was redacted");
      assert.ok(s.includes("80 000 100"), "the meter the intake read exists to find was redacted");
      assert.ok(scans.every((x) => x.intakeRead), "an intake builder's call was not recognised as the intake read");
    });
  } else {
    await check(`${row.method}: no call outside intake was treated as the intake read`, () => {
      assert.ok(scans.every((x) => !x.intakeRead), `intakeRead on ${scans.filter((x) => x.intakeRead).map((x) => x.label).join(", ")}`);
    });
  }
  await check(`${row.method}: every request was labelled and its audit row names the builder, never a value`, () => {
    assert.ok(scans.length >= captured.length, `${captured.length} requests but ${scans.length} scans — something bypassed the scan`);
    assert.ok(!scans.some((s) => s.label === "(unlabelled)"), "an unlabelled request reached the model");
    const rows = db.query<{ details: string }>("SELECT details FROM audit_logs WHERE action = 'model_payload_redacted' AND details LIKE ?", [`%job-${row.method}%`]);
    assert.ok(row.textFree || rows.length >= 1, "no audit row for this builder");
    for (const r of rows) {
      for (const v of [ACCOUNT, METER, ESI, "523456789", PASSWORD, SECURITY_ANSWER, WRITTEN_PASSWORD, API_KEY, BEARER, "8814"]) assert.ok(!r.details.includes(v), `audit row carries a value: ${r.details}`);
    }
  });
}
server.close();

// ---------------------------------------------------------------------------------------------
// The table must fail when a builder exists that it does not list.
// ---------------------------------------------------------------------------------------------
await check("EVERY LLM_TASKS task is produced by a row, and every row produced each task it claims", () => {
  const produced = new Set<string>();
  for (const row of [...ROWS, ...EXTERNAL_ROWS]) {
    const labels = seen.get(row.method) ?? new Set();
    const tasks = new Set([...labels].map((l) => taskForLabel(l.replace(/\.countTokens$/, ""))).filter((t): t is NonNullable<typeof t> => !!t));
    for (const l of labels) if (row.callerLabels?.some((c) => l.startsWith(c))) for (const t of row.tasks) tasks.add(t);
    for (const t of row.tasks) assert.ok(tasks.has(t as never), `${row.method} claims ${t} but its calls were labelled ${[...labels].join(", ")}`);
    for (const t of tasks) produced.add(t);
  }
  const missing = (LLM_TASKS as readonly string[]).filter((t) => !produced.has(t));
  assert.deepEqual(missing, [], `model tasks no row drives (add a row to this table): ${missing.join(", ")}`);
});

await check("EVERY ClaudeLLMProvider method is a row or a named helper (a new builder must join the table)", () => {
  const rowMethods = new Set(ROWS.map((r) => r.method));
  const unlisted = Object.getOwnPropertyNames(ClaudeLLMProvider.prototype).filter((m) => !rowMethods.has(m) && !HELPERS.has(m));
  assert.deepEqual(unlisted, [], `ClaudeLLMProvider methods the builder table does not list: ${unlisted.join(", ")}`);
});

await check("EVERY file that builds a model client is listed (its builders are rows)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); }
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && rel !== "backend/src/modelPayloadScan.ts"
        && /\bcreateModelClient\s*\(/.test(fs.readFileSync(path.join(root, rel), "utf8"))) found.push(rel);
    }
  };
  for (const d of ["backend/src", "portal-bot/src", "shared/src", "scripts"]) walk(d);
  const unlisted = found.filter((f) => !CLIENT_FILES.has(f));
  assert.deepEqual(unlisted, [], `files building a model client the table has no row for: ${unlisted.join(", ")}`);
  for (const f of CLIENT_FILES) assert.ok(found.includes(f), `${f} is listed but no longer builds a client — drop it from CLIENT_FILES`);
});

await check("no prompt tokens were added: PLANNER_USER_TOKEN_BUDGET is unchanged", () => {
  assert.equal(PLANNER_USER_TOKEN_BUDGET, 4000);
});

db.close();
fs.rmSync(scratch, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nevery prompt builder is covered and none sent a secret");
