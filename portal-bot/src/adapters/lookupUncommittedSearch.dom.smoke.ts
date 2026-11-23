// A SEARCH TYPED BUT NEVER COMMITTED — real Chromium, the bench's self-service replica.
// Run: npx tsx portal-bot/src/adapters/lookupUncommittedSearch.dom.smoke.ts
//
// A self-service portal's contractor lookup is a text box that posts NOTHING (no name), a Search
// button, a results table and a named hidden input only a row's "Add" writes (EnerGov's contractor
// search; the bench's selfserve base). The walk typed into the box and walked on: the portal kept no
// contractor, nothing was required-blank, so the lookup pass never pressed Search (rules 1 and 2 did
// not apply). Rule 3 of lookupButtonPass: a box that posts nothing holds a value AND the section's
// named hidden inputs are all empty -> press the section's Search, then pick THIS company's row.
//
// The results carry a NAMESAKE ("Kestrel Energy LLC" and "Kestrel Energy Supply Inc"): the row is the
// one whose own cell IS the company (shared/src/rowPick.ts companyKey).
//
// MUST-PASS  [1] typed licence, hidden empty -> Search pressed, the LLC row's Add (318822) commits,
//                a step is recorded; never the Supply Inc row (318828).
// MUST-NOT   [2] the hidden input already holds a contractor -> nothing pressed;
//            [3] the box carries a name (it posts its own value) -> nothing pressed;
//            [4] nothing typed -> nothing pressed.
// KILL: drop rule 3's `return l` in lookupButtonPass -> [1] fails.
import "../smokeArtifactDirs";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter } from "./autoLearnAdapter";
import { buildWizard } from "../replica/fixtures/wizards";
import { startSyntheticReplica } from "../replica/syntheticServer";
import type { RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const w = buildWizard("selfserve", "base");
const r = await startSyntheticReplica({ wizard: w, credential: { username: "kestrel-ops", password: "synthetic-pass" } });
const contactsSlug = w.pages.find((p) => /contacts/i.test(p.heading))!.slug;
const browser = await chromium.launch();

const signedInPage = async (): Promise<Page> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  if (!r.state.loggedIn) {
    await page.goto(`${r.base}/${contactsSlug}`);
    await page.fill("#Username", "kestrel-ops");
    await page.fill("#Password", "synthetic-pass");
    await page.click("#btnSignIn");
    await page.waitForLoadState("domcontentloaded");
  }
  await page.goto(`${r.base}/${contactsSlug}`);
  await page.waitForLoadState("domcontentloaded");
  return page;
};

const BOX = 'input[placeholder="License # or business name"]';
const hiddenValue = async (page: Page): Promise<string> =>
  page.evaluate((sel) => {
    const box = document.querySelector(sel) as HTMLInputElement | null;
    const h = box ? document.querySelector(`input[type=hidden][data-commit-for="${box.id}"]`) as HTMLInputElement | null : null;
    return h ? h.value : "(no hidden)";
  }, BOX);

const runPass = async (page: Page): Promise<{ pressed: number; steps: RecipeStep[]; stop: unknown }> => {
  const adapter = new AutoLearnAdapter("Lookup Uncommitted Search Smoke", null as never, {
    maxPages: 1,
    contactIdentity: { companyName: "Kestrel Energy LLC", fullName: "Dana Kestrel" },
  } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  a.page = page;
  const steps: RecipeStep[] = [];
  const out = await a.lookupButtonPass({ steps, url: page.url(), pageCount: 1, alreadyFilledLabels: [], portalNotices: [], pageTrace: [] });
  return { pressed: Number(out?.pressed ?? 0), steps, stop: out?.stop ?? null };
};

// [1] MUST-PASS
{
  const page = await signedInPage();
  await page.fill(BOX, "318822");
  const out = await runPass(page);
  const held = await hiddenValue(page);
  const notes = out.steps.map((s) => `${s.action}:${s.note ?? ""}`).join(" | ");
  console.log(`   [1] pressed=${out.pressed} hidden=${held} steps=${notes.slice(0, 400)}`);
  check("[1] the uncommitted search is pressed", out.pressed >= 1, `pressed=${out.pressed}`);
  check("[1] THIS company's row (Kestrel Energy LLC, 318822) is committed, never the namesake", held === "318822", `hidden=${held}`);
  check("[1] the press and the row pick are recorded", out.steps.some((s) => s.action === "click" && /search/i.test(`${s.selector?.name ?? ""} ${s.note ?? ""}`)) && out.steps.length >= 2, notes);
  await page.context().close();
}

// [2] MUST-NOT: the hidden input already holds a contractor (a person picked one).
{
  const page = await signedInPage();
  await page.fill(BOX, "2204");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForSelector(".lookup-results tbody tr", { timeout: 8000 });
  await page.locator(".lookup-results tbody tr", { hasText: "220417" }).getByRole("button", { name: "Add", exact: true }).click();
  await page.fill(BOX, "318822");
  const out = await runPass(page);
  const held = await hiddenValue(page);
  console.log(`   [2] pressed=${out.pressed} hidden=${held}`);
  check("[2] a committed contractor: nothing is pressed, the pick stands", out.pressed === 0 && held === "220417", `pressed=${out.pressed} hidden=${held}`);
  await page.context().close();
}

// [3] MUST-NOT: the typed box carries a name (it posts its own value; nothing to commit).
{
  const page = await signedInPage();
  await page.evaluate((sel) => { (document.querySelector(sel) as HTMLInputElement).setAttribute("name", "Contractor.SearchText"); }, BOX);
  await page.fill(BOX, "318822");
  const out = await runPass(page);
  console.log(`   [3] pressed=${out.pressed}`);
  check("[3] a named typed box is not an uncommitted search: nothing pressed", out.pressed === 0, `pressed=${out.pressed}`);
  await page.context().close();
}

// [4] MUST-NOT: nothing typed.
{
  const page = await signedInPage();
  const out = await runPass(page);
  console.log(`   [4] pressed=${out.pressed}`);
  check("[4] nothing typed: nothing pressed", out.pressed === 0, `pressed=${out.pressed}`);
  await page.context().close();
}

await browser.close();
await r.close?.();
if (failures > 0) { console.error(`\nlookupUncommittedSearch.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nlookupUncommittedSearch.dom.smoke: PASS");
process.exit(0);
