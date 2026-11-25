// THE TYPE-AHEAD'S ENTER, AT THE SHARED ENTER DOOR (#139 fix round).
//
// #139 lets a location search press Enter after the job's whole one-line address, behind the shared
// in-page Enter question (portalSafety enterRefusalInPage), and taught that question one more
// positive identity: an autocomplete widget's own class stamp (jQuery UI "ui-autocomplete-input"). An
// adversarial probe (six box identities x ~30 synthetic forms, base vs branch, Enter pressed where
// allowed and every POST logged) found four holes, pinned here on SYNTHETIC forms:
//   1. the implicit-submit reading judged `button.formAction || form.action`, and button.formAction is
//      the PAGE's URL when the button has no formaction attribute — so a form posting to
//      /permit/submitApplication or /payment/checkout behind a plain <button>Go</button> was ALLOWED
//      and Enter POSTed it;
//   2. the stamp regex took any class containing "autocomplete" ("autocomplete-off",
//      "noautocomplete") and any placeholder saying it ("Autocomplete disabled") as an identity;
//   3. a form whose default button is "Request Signatures" was allowed (the replay's click gate
//      refuses it, the shared question did not);
//   4. the learner's classifier and the Enter identity held two copies of the stamp regex.
// Each MUST-REFUSE shape is also driven END TO END through fillTypeahead and the server counts the
// POSTs: a refusal that only shows in a string is not a refusal.
//
//   npx tsx portal-bot/src/adapters/typeaheadEnterGate.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import * as portalSafety from "../../../shared/src/portalSafety";
import { EXTRACT_SEL, extractFieldsInPage, toExtractedField } from "./autoLearnAdapter";
import { fillTypeahead } from "../typeaheadFill";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } = portalSafety;
/** THE one stamp predicate (read off the module, so a build without it fails its check, not its import). */
const stampPredicate = (portalSafety as unknown as { isAutocompleteWidgetClass?: (c: string) => boolean }).isAutocompleteWidgetClass;
const isStamp = (cls: string): boolean | undefined => (typeof stampPredicate === "function" ? stampPredicate(cls) : undefined);

const JOB = { street: "4821 W Quillfeather Dr", city: "Marrowvale", state: "UT", zip: "84999" };
const STAMP = `class="ui-autocomplete-input" autocomplete="off"`;
const box = (attrs = STAMP): string => `<label for="q">Search for location:</label><input type="text" id="q" name="q" ${attrs}>`;
const page = (body: string): string => `<!doctype html><html><head><title>Permit Application</title></head><body><h1>Location</h1>${body}</body></html>`;

// shape → [html, expected: "refuse" | "allow", refusal must match]
const SHAPES: Record<string, { html: string; expect: "refuse" | "allow"; why?: RegExp }> = {
  // 1. the form's action, whatever button it has
  formActionFiling: { html: page(`<form method="post" action="/permit/submitApplication">${box()}<button>Go</button></form>`), expect: "refuse", why: /submitApplication/ },
  formActionPay: { html: page(`<form method="post" action="/payment/checkout">${box()}<button>Go</button></form>`), expect: "refuse", why: /checkout/ },
  formActionOtherButton: { html: page(`<form method="post" action="/permit/submitApplication">${box()}<button formaction="/lookup">Go</button></form>`), expect: "refuse", why: /submitApplication/ },
  // 2. not a widget's stamp
  classOff: { html: page(`<form method="post" action="/permit/save">${box(`class="autocomplete-off"`)}<button>Go</button></form>`), expect: "refuse", why: /positively identified/ },
  classNoAuto: { html: page(`<form method="post" action="/permit/save">${box(`class="form-control noautocomplete"`)}<button>Go</button></form>`), expect: "refuse", why: /positively identified/ },
  classDisabled: { html: page(`<form method="post" action="/permit/save">${box(`class="typeahead-disabled"`)}<button>Go</button></form>`), expect: "refuse", why: /positively identified/ },
  placeholderOnly: { html: page(`<form method="post" action="/permit/save">${box(`class="form-control" placeholder="Autocomplete disabled"`)}<button>Go</button></form>`), expect: "refuse", why: /positively identified/ },
  // 3. a signature request as the form's default button
  sigDefault: { html: page(`<form method="post" action="/other">${box()}<button type="submit">Request Signatures</button></form>`), expect: "refuse", why: /signature request/ },
  sendForSignature: { html: page(`<form method="post" action="/other">${box()}<button type="submit">Send for Signature</button></form>`), expect: "refuse", why: /signature request/ },
  // SHOULD: a stamped box whose form's default is "Submit" (the iWorQ City of Star shape)
  submitDefault: { html: page(`<form method="post" action="/other">${box()}<input type="submit" id="submit-webform" value="Submit"></form>`), expect: "refuse", why: /submit-worded/ },
  // MUST PASS: the CityView shape — a hidden, unlabelled default meant for Enter, then Next Step
  cityViewShape: {
    html: page(`<form method="post" action="/Portal/Permit/Application"><input type="submit" name="brepeatlocation" aria-hidden="true" tabindex="-1" value="" style="position:absolute;left:-9999px;width:1px;height:1px">${box()}<button type="submit" name="bnext" value="1">Next Step</button></form>`),
    expect: "allow",
  },
  typeaheadToken: { html: page(`${box(`class="typeahead"`)}`), expect: "allow" },
  ttInput: { html: page(`${box(`class="tt-input"`)}`), expect: "allow" },
};

const posts: Record<string, string[]> = {};
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const shape = u.searchParams.get("s") || "";
  if (req.method === "POST") {
    (posts[shape] ??= []).push(u.pathname);
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(page("<p>posted</p>"));
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  // Every form posts back with its shape tagged, so the log says which shape posted.
  res.end((SHAPES[shape]?.html ?? page("")).replace(/action="([^"]+)"/g, (_m, a) => `action="${a}?s=${shape}"`).replace(/formaction="([^"]+)"/g, (_m, a) => `formaction="${a}?s=${shape}"`));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const ask = async (p: Page): Promise<string> => {
  await p.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
  return String(await p.locator("#q").evaluate((el: Element, g: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ps = (globalThis as any)[g];
    return ps.enterRefusalInPage(el);
  }, PORTAL_SAFETY_GLOBAL));
};

// ---- A) THE SHARED ENTER QUESTION, SHAPE BY SHAPE ----------------------------------------------
for (const [name, s] of Object.entries(SHAPES)) {
  const p = await ctx.newPage();
  await p.goto(`${base}/?s=${name}`);
  const why = await ask(p);
  console.log(`   ${name}: ${why ? `REFUSED — ${why.slice(0, 140)}` : "allowed"}`);
  if (s.expect === "allow") check(`${name}: Enter is allowed`, why === "", why);
  else check(`${name}: Enter is REFUSED${s.why ? ` (${s.why.source})` : ""}`, !!why && (!s.why || s.why.test(why)), why || "(allowed)");
  await p.close();
}

// ---- B) END TO END: the type-ahead fill presses nothing that posts on a refused shape -----------
for (const name of ["formActionFiling", "formActionPay", "sigDefault", "submitDefault"]) {
  const p = await ctx.newPage();
  await p.goto(`${base}/?s=${name}`);
  const out = await fillTypeahead(p, p.locator("#q"), { value: JOB.street, mode: "site", site: { ...JOB } });
  await p.waitForTimeout(500);
  console.log(`   e2e ${name}: outcome=${out.outcome} posts=${JSON.stringify(posts[name] ?? [])} why=${"why" in out ? out.why.slice(0, 200) : ""}`);
  check(`e2e ${name}: the type-ahead fill sends NO request (Enter refused at the door)`,
    !(posts[name]?.length) && out.outcome !== "picked" && "why" in out && /Enter was not pressed/.test(out.why),
    `posts=${JSON.stringify(posts[name] ?? [])} out=${JSON.stringify(out).slice(0, 300)}`);
  await p.close();
}

// ---- C) ONE PREDICATE: the learner's classifier and the Enter identity agree on every class ------
{
  const CLASSES: Array<[string, boolean]> = [
    ["ui-autocomplete-input", true], ["form-control ui-autocomplete-input", true], ["tt-input", true], ["autocomplete-input", true],
    ["k-autocomplete-input", true], ["typeahead", true],
    ["autocomplete-off", false], ["noautocomplete", false], ["typeahead-disabled", false], ["no-autocomplete-input", false],
    ["autocomplete", false], ["form-control", false], ["", false], ["typeahead-wrapper", false],
  ];
  const p = await ctx.newPage();
  for (const [cls, want] of CLASSES) {
    await p.setContent(page(`<label for="q">Lookup</label><input type="text" id="q" class="${cls}">`));
    const field = (await p.$$eval(EXTRACT_SEL, extractFieldsInPage)).map(toExtractedField).find((f) => f.label === "Lookup");
    await p.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
    const identity = String(await p.locator("#q").evaluate((el: Element, g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any)[g].enterIdentityInPage(el);
    }, PORTAL_SAFETY_GLOBAL));
    const classified = field?.fillStrategy === "typeahead";
    check(`class "${cls}": stamp=${want} — the predicate, the classifier and the Enter identity all say so`,
      isStamp(cls) === want && classified === want && (!!identity) === want,
      `predicate=${isStamp(cls)} classifier=${classified} identity=${JSON.stringify(identity)}`);
  }
  await p.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? "typeaheadEnterGate.dom.smoke: PASS" : `typeaheadEnterGate.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
