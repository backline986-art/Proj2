// #448 — A PORTAL'S OWN RECORD-NUMBER FORMAT, LEARNED FROM THE PORTAL. Owner: "Remember, universality."
//
// After a person files, the capture trusted only hand-written shapes (Accela, PowerClerk APP-######).
// PGE's PGENM-45058 and every portal we have not met were read only beside a label — never `high`. The
// format is now learned from the portal's own numbers: the ids in the account's list (ledgerBefore,
// read at sign-in) and the shapes a person confirmed on this recipe before (recipe.recordNumberShapes).
//
// MUST-PASS: fixture 1 (PowerClerk-like PGENM-) and fixture 2 (a portal never seen, SOL-2026-000123) →
// high, with no code change for either portal; through the real RecipeAdapter capture too.
// MUST-EXCLUDE: a learned-shape number on a page that does not say it completed; a PSE Part 1 draft
// page; a phone/date that fits; a shape learned on one tenant applied to another; an id the account
// already had; a lone stray id. UNCHANGED: with nothing learned the reading is today's.
//
// KILLS (on main 7f108f47): learnRecordFormat / the `learned` argument do not exist (the file does not
// typecheck); with the argument ignored, the fixture-1/2 and adapter cases read `low` (labelled).
//   npx tsx portal-bot/src/recordNumberLearned.test.ts
import type { PortalRecipe } from "../../shared/src/types";
import { extractRecordNumber, learnRecordFormat, recordNumberCandidates, recordShapeOf } from "./recordNumber";
import { RecipeAdapter } from "./adapters/recipeAdapter";
import { readApplicationLedgerInPage, recordLinkForNumberInPage, type LedgerEntry, type SubmitRecordRead } from "./adapters/submissionLedger";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const DONE = "Thank you for your submission. Your application has been submitted.";

console.log("\n#448 — the shape of a portal's own numbers");
check("PGENM-45058 → PGENM-#####", recordShapeOf("PGENM-45058") === "PGENM-#####", String(recordShapeOf("PGENM-45058")));
check("SOL-2026-000123 → SOL-####-######", recordShapeOf("SOL-2026-000123") === "SOL-####-######");
check("an Accela number keeps its discipline suffix", recordShapeOf("187-26-000328-STR") === "###-##-######-STR");
for (const v of ["503-555-0199", "555-0199", "2026-11-09", "11-09-2026", "97201-1234", "8830012", "AB-12", "Roof 1"]) {
  check(`MUST-EXCLUDE: "${v}" is no record format`, recordShapeOf(v) === null, String(recordShapeOf(v)));
}

console.log("\n#448 — fixture 1 (PowerClerk-like) and fixture 2 (a portal never seen)");
{
  const pge = learnRecordFormat(["PGENM-45058", "PGENM-45406", "PGENM-45110"]);
  const page = `${DONE}\nProject PGENM-45999 — Net Metering\nQuestions? 503-555-0100`;
  const r = extractRecordNumber(page, pge);
  check("fixture 1: a new PGENM- number on a completion page → high", r.value === "PGENM-45999" && r.confidence === "high" && r.source === "learned", JSON.stringify(r));
  const before = extractRecordNumber(page);
  check("fixture 1, nothing learned: unchanged (not high)", before.confidence !== "high", JSON.stringify(before));
  const rolled = extractRecordNumber(`${DONE}\nProject PGENM-100000`, pge);
  check("fixture 1: the counter rolling over a digit still reads", rolled.value === "PGENM-100000" && rolled.confidence === "high", JSON.stringify(rolled));

  const sol = learnRecordFormat(["SOL-2026-000123", "SOL-2026-000124"]);
  const r2 = extractRecordNumber(`${DONE}\nYour reference is SOL-2026-000187. Submitted 11/09/2026.`, sol);
  check("fixture 2: a portal never seen, SOL-2026-000187 → high", r2.value === "SOL-2026-000187" && r2.confidence === "high", JSON.stringify(r2));
}

console.log("\n#448 — MUST-EXCLUDE");
{
  const pge = learnRecordFormat(["PGENM-45058", "PGENM-45406"]);
  const notDone = extractRecordNumber("Project PGENM-45999 — continue editing your application.", pge);
  check("a learned-shape number on a page that does not say it completed → still a candidate (low)", notDone.value === "PGENM-45999" && notDone.confidence === "low", JSON.stringify(notDone));
  const listed = extractRecordNumber(`${DONE}\nPGENM-45058 Submitted\nPGENM-45406 Approved`, pge);
  check("an id the account already had is never the new filing's", listed.source !== "learned" && listed.value !== "PGENM-45058", JSON.stringify(listed));
  const phony = learnRecordFormat(["503-555-0199", "503-555-0142", "2026-11-09", "2026-10-01"]);
  check("phone- and date-shaped list values teach no format", phony.shapes.length === 0, JSON.stringify(phony.shapes));
  const fits = extractRecordNumber(`${DONE}\nCall 503-555-0199 on 2026-11-09`, learnRecordFormat(["PGENM-45058", "PGENM-45406"], ["###-###-####", "####-##-##"]));
  check("a stored phone/date 'shape' is refused on read; a phone or date is never the number", fits.value === "", JSON.stringify(fits));
  // Tenant isolation: PGE's shape never reads PacifiCorp's or another tenant's number as learned.
  const other = recordNumberCandidates(`${DONE}\nSOL-2026-000187 APP-111681 PGENMX-45999 PGENM-45999-B`, pge);
  check("a shape learned on one tenant never applies to another tenant's numbers", !other.some((c) => c.source === "learned"), JSON.stringify(other));
  const stray = learnRecordFormat(["INV-00042", "PGENM-45058", "PGENM-45406"]);
  check("a lone stray id beside the list teaches nothing", JSON.stringify(stray.shapes) === JSON.stringify(["PGENM-#####"]), JSON.stringify(stray.shapes));
  check("a single id teaches nothing on its own (the confirmed shape covers a one-filing account)", learnRecordFormat(["PGENM-45058"]).shapes.length === 0);
  const bogus = learnRecordFormat([], ["####", "ABC", "PGENM-#####", "PGENM-12345"]);
  check("stored shapes are re-validated: only a real shape survives", JSON.stringify(bogus.shapes) === JSON.stringify(["PGENM-#####"]), JSON.stringify(bogus.shapes));
}

console.log("\n#448 — UNCHANGED with nothing learned");
{
  const acc = extractRecordNumber("Your application has been successfully submitted.\nRecord Number: 187-26-000328-STR");
  check("Accela sample", acc.value === "187-26-000328-STR" && acc.confidence === "high" && acc.source === "accela", JSON.stringify(acc));
  const pc = extractRecordNumber("Your application has been submitted.\nPP - Application Submitted (APP-111681)");
  check("PacifiCorp APP- sample", pc.value === "APP-111681" && pc.confidence === "high" && pc.source === "powerclerk", JSON.stringify(pc));
  const pcLearned = extractRecordNumber("Your application has been submitted.\nPP - Application Submitted (APP-111681)", learnRecordFormat(["APP-111600", "APP-111601"]));
  check("PacifiCorp with its own list learned: the same number, still high", pcLearned.value === "APP-111681" && pcLearned.confidence === "high", JSON.stringify(pcLearned));
}

// ── Through the real RecipeAdapter capture, on a stub page (no Chromium) ──────────────────────────
const recipeWith = (shapes?: string[]) => ({
  id: "record-number-learned", scopeType: "utility", profileKey: "or|fernhollow-power|", state: "OR", ahj: "", utility: "Fernhollow Power",
  portalPlatform: "fixture", portalUrl: "https://portal.example/login", status: "complete", version: 1, createdBy: "test", createdAt: "", updatedAt: "", notes: "",
  steps: [], ...(shapes ? { recordNumberShapes: shapes } : {}),
} as unknown as PortalRecipe);

interface Internals {
  page: unknown; ledgerBefore: LedgerEntry[] | null; reviewReading: unknown;
  readPageForCapture: () => Promise<unknown>;
  captureSubmissionConfirmation: () => Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }>;
}
const stubPage = (text: string) => ({
  url: () => "https://portal.example/projects/done",
  waitForLoadState: async () => undefined,
  locator: () => ({ innerText: async () => text }),
  evaluate: async (fn: unknown) => {
    if (fn === readApplicationLedgerInPage) return [];
    if (fn === recordLinkForNumberInPage) return "";
    throw new Error("unexpected page.evaluate in this test");
  },
});
const capture = async (text: string, opts: { shapes?: string[]; ledger?: string[]; handedOver?: boolean }) => {
  const adapter = new RecipeAdapter(recipeWith(opts.shapes), {}, {}, {}) as unknown as Internals;
  adapter.page = stubPage(text);
  adapter.ledgerBefore = opts.ledger ? opts.ledger.map((id) => ({ id, href: "", row: `${id} Submitted` })) : null;
  if (opts.handedOver) {
    adapter.reviewReading = { numbers: new Set<string>(), filingControl: "Submit", completionPhrase: null };
    adapter.readPageForCapture = async () => ({ text, cellFree: text, filingControl: "", reviewPage: false });
  }
  const r = await adapter.captureSubmissionConfirmation();
  return { data: r.data ?? {}, recordRead: r.data?.recordRead as SubmitRecordRead | undefined };
};

console.log("\n#448 — the real capture: the recipe's confirmed shape, the account list's shape");
{
  const page = `${DONE}\nApplication PGENM-45999 is in review.`;
  const learned = await capture(page, { shapes: ["PGENM-#####"] });
  check("a shape a person confirmed on this recipe: the new number is recorded high", learned.recordRead?.confidence === "high" && learned.recordRead.recordNumber === "PGENM-45999", JSON.stringify(learned.recordRead));
  const fromList = await capture(page, { ledger: ["PGENM-45058", "PGENM-45406"] });
  check("a shape learned from the account's own list: recorded high", fromList.recordRead?.confidence === "high" && fromList.recordRead.recordNumber === "PGENM-45999", JSON.stringify(fromList.recordRead));
  const none = await capture(page, {});
  check("nothing learned: unchanged — a person confirms it (low)", none.recordRead?.confidence === "low", JSON.stringify(none.recordRead));
  const otherTenant = await capture(`${DONE}\nApplication SOL-2026-000187 is in review.`, { shapes: ["PGENM-#####"] });
  check("another tenant's number is not read through this recipe's shape", otherTenant.recordRead?.confidence !== "high", JSON.stringify(otherTenant.recordRead));
  const draft = await capture("Your draft application NEM-900017 has been created. Please continue to Interconnection Application - Part 2", { shapes: ["NEM-######"], ledger: ["NEM-900001", "NEM-900002"] });
  check("MUST-EXCLUDE: a PSE Part 1 draft in the learned shape is a draft, never a filing",
    !!(draft.data.draftCreated as { draft?: boolean } | undefined)?.draft && draft.data.permitNumber === "" && !draft.recordRead, JSON.stringify(draft.data));
}

console.log("\n#448 — the handed-over capture (judgeCompletion) takes the learned tier first");
{
  // An Accela-looking reference sits beside the portal's own number: the hand-written tier used to win.
  const page = `${DONE}\nApplication PGENM-45999 received. Batch 2026-11-000123.`;
  const learned = await capture(page, { ledger: ["PGENM-45058", "PGENM-45406"], handedOver: true });
  check("the portal's own number, not the look-alike, is the filing's", learned.recordRead?.recordNumber === "PGENM-45999" && learned.recordRead.confidence === "high", JSON.stringify(learned.recordRead));
}

console.log(`\n${total - failures}/${total} passed`);
if (failures) { console.error(`${failures} recordNumberLearned check(s) failed`); process.exit(1); }
