// THE BLOB WIPE IS AS PROTECTED AS THE FULL DELETE (issue #393).
//
// `ahj_form_templates` is shared across every tenant on purpose (CLAUDE.md). DELETE
// /api/ahj-templates/:id was already admin-only with a ?force=1 acknowledgement for a
// HUMAN-VERIFIED field map; its sibling DELETE /api/ahj-templates/:id/blob had neither, so
// any signed-in user of any org could NULL pdf_blob on any template. That leaves the
// verified map on paper and useless in practice: fill needs the blob, remap and the blank
// download answer 410 without it — for every tenant. Both routes now share ONE guard
// (guardSharedTemplateDestruction in server.ts).
//
// Boots the real server on a temp sqlite with AUTH_ENABLED=true (kbEntryDelete.test.ts
// shape) over two template rows this test seeds first: one with an unverified map, one
// whose map a person verified. Synthetic names only.
//
// KILL: drop the guard from the blob route → "a non-admin tenant gets 403" and "verified
// map without force is refused" fail with the blob gone; give the blob route its own 409
// text → "same wording as the full delete" fails.
//
// Run: tsx backend/test/templateBlobDeleteGate.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "template-blob-gate-test-"));

function freePortInBand(start: number, count: number): number {
  for (let i = 0; i < count; i++) {
    const candidate = start + i;
    try {
      execFileSync(process.execPath, ["-e", `require("net").createServer().listen(${candidate},"0.0.0.0",function(){this.close()}).on("error",()=>process.exit(1))`], { stdio: "ignore" });
      return candidate;
    } catch { /* held — try the next */ }
  }
  return start + Math.floor(Math.random() * count);
}
// Own band: 5980-5989 (the other server-booting suites sit elsewhere; see their "Own band" notes).
const PORT = freePortInBand(5980, 10);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(tmpDir, "test.sqlite");

let failures = 0;
const run = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Seed BEFORE the server boots.
// ---------------------------------------------------------------------------
const PLAIN = "tpl-plain";
const VERIFIED = "tpl-verified";
const VERIFIED_FULL = "tpl-verified-full";
const BLOB = Buffer.from("%PDF-1.4 synthetic template bytes\n%%EOF\n");
process.env.AUTOPILOT_DB_PATH = DB_PATH;
{
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  const now = new Date().toISOString();
  const insert = (id: string, map: Record<string, unknown>) => db.run(
    `INSERT INTO ahj_form_templates (id, ahj_name, state, original_filename, pdf_blob, field_map, created_at, updated_at)
     VALUES (?, 'City of Synthville', 'ZZ', 'synthville-app.pdf', ?, ?, ?, ?)`,
    [id, BLOB, JSON.stringify(map), now, now],
  );
  insert(PLAIN, { fillMode: "acroform", textFields: { OwnerName: "project.homeownerName" } });
  insert(VERIFIED, { fillMode: "acroform", textFields: { OwnerName: "project.homeownerName" }, verified: true, verifiedAt: now });
  insert(VERIFIED_FULL, { fillMode: "acroform", textFields: { OwnerName: "project.homeownerName" }, verified: true, verifiedAt: now });
  db.close();
}

const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: DB_PATH,
  PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
  BACKUP_DIR: path.join(tmpDir, "backups"),
  DATA_DIR: path.join(tmpDir, "data"),
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true",
  ADMIN_EMAIL: "owner@operator.test",
  ADMIN_PASSWORD: "owner-test-password-1",
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];

const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never answered ${BASE}/health within 60s (port ${PORT})\nlog tail:\n${serverLog.slice(-2000)}`);
}
const loginAs = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `login ${email}: ${await res.text()}`);
  return String(res.headers.get("set-cookie") || "").split(";")[0];
};
const as = (cookie: string) => (p: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers });
};
const blobOf = async (id: string): Promise<{ exists: boolean; blobBytes: number | null; verified: boolean }> => {
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  try {
    const row = db.get<{ pdf_blob: Buffer | null; field_map: string }>("SELECT pdf_blob, field_map FROM ahj_form_templates WHERE id = ?", [id]);
    if (!row) return { exists: false, blobBytes: null, verified: false };
    return { exists: true, blobBytes: row.pdf_blob ? row.pdf_blob.length : null, verified: JSON.parse(row.field_map || "{}").verified === true };
  } finally { db.close(); }
};
const blobPath = (id: string, force = false) => `/api/ahj-templates/${encodeURIComponent(id)}/blob${force ? "?force=1" : ""}`;

try {
  await waitForServer();
  const owner = as(await loginAs("owner@operator.test", "owner-test-password-1"));

  // A tenant org that holds the autopilot, with an ordinary (non-admin) user.
  let tenant: ReturnType<typeof as> | null = null;
  await run("a tenant org with a non-admin user can be created", async () => {
    const created = await owner("/api/orgs", { method: "POST", body: JSON.stringify({ name: "Acme Solar", edition: "full", products: ["autopilot"] }) });
    const text = await created.text();
    assert.equal(created.status, 201, text.slice(0, 300));
    const orgId = (JSON.parse(text).org as { id: string }).id;
    const user = await owner(`/api/orgs/${orgId}/users`, { method: "POST", body: JSON.stringify({ name: "Staff", email: "staff@acme.test", password: "tenant-pass-12345" }) });
    assert.equal(user.status, 201, (await user.text()).slice(0, 300));
    tenant = as(await loginAs("staff@acme.test", "tenant-pass-12345"));
  });

  await run("a non-admin tenant gets 403 on the blob wipe, and the blob is intact", async () => {
    assert.ok(tenant, "tenant session");
    const res = await tenant!(blobPath(PLAIN), { method: "DELETE" });
    assert.equal(res.status, 403, (await res.text()).slice(0, 300));
    assert.equal((await blobOf(PLAIN)).blobBytes, BLOB.length, "blob survived");
  });

  await run("?force=1 does not let a non-admin through either", async () => {
    assert.ok(tenant, "tenant session");
    const res = await tenant!(blobPath(VERIFIED, true), { method: "DELETE" });
    assert.equal(res.status, 403, (await res.text()).slice(0, 300));
    assert.equal((await blobOf(VERIFIED)).blobBytes, BLOB.length, "blob survived");
  });

  // The full delete's 409 on a verified row, so the blob wipe can be held to the same words.
  let fullDelete409 = "";
  await run("the full delete still refuses a verified map without force (the reference)", async () => {
    const res = await owner(`/api/ahj-templates/${VERIFIED_FULL}`, { method: "DELETE" });
    const body = await res.text();
    assert.equal(res.status, 409, body.slice(0, 300));
    fullDelete409 = String(JSON.parse(body).error || "");
    assert.match(fullDelete409, /HUMAN-VERIFIED/);
    assert.equal((await blobOf(VERIFIED_FULL)).exists, true, "row survived");
  });

  await run("an admin's blob wipe of a verified map without force is refused with 409, blob intact", async () => {
    const res = await owner(blobPath(VERIFIED), { method: "DELETE" });
    const body = await res.text();
    assert.equal(res.status, 409, body.slice(0, 300));
    const msg = String(JSON.parse(body).error || "");
    assert.equal(msg, fullDelete409, "same wording as the full delete");
    assert.equal((await blobOf(VERIFIED)).blobBytes, BLOB.length, "blob survived");
  });

  await run("an admin with ?force=1 clears the verified row's blob, keeping the row and its verified map", async () => {
    const res = await owner(blobPath(VERIFIED, true), { method: "DELETE" });
    assert.equal(res.status, 200, (await res.text()).slice(0, 300));
    const after = await blobOf(VERIFIED);
    assert.equal(after.exists, true, "row kept");
    assert.equal(after.blobBytes, null, "blob cleared");
    assert.equal(after.verified, true, "verified map kept");
  });

  await run("an admin clears an unverified row's blob without force", async () => {
    const res = await owner(blobPath(PLAIN), { method: "DELETE" });
    assert.equal(res.status, 200, (await res.text()).slice(0, 300));
    assert.equal((await blobOf(PLAIN)).blobBytes, null, "blob cleared");
  });

  await run("an unknown template id answers 404, not a silent success", async () => {
    const res = await owner(blobPath("tpl-no-such-template"), { method: "DELETE" });
    assert.equal(res.status, 404, (await res.text()).slice(0, 300));
  });
} catch (err) {
  failures++;
  console.error(`  FAIL - suite aborted: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\ntemplateBlobDeleteGate: all checks passed.");
