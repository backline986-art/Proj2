// ---------------------------------------------------------------------------
// APPLICATION PROGRAMME CHOICE — the screen between "new application" and a form.
//
// Some portals answer the entry click with a drawer/dialog whose FIRST screen is not a
// form but a CHOICE of which programme to apply under. ComEd's Intellio Connect offers
// "Distributed Generation" and "Distributed Generation Rebates"; no field exists until one
// is picked, so a learn that ignores the choice reports "nothing fillable" while standing
// on it (live: 6 pages, 4 planner calls, no steps recorded).
//
// Two invariants, both learned the hard way:
//
//   SCOPE BY THE TIGHTEST GROUPING, NEVER BY DOCUMENT. The live page carried ~80 elements
//   matching [class*='drawer'] (drawer__title, drawer__content, ...) and the first attempt
//   took "the last visible panel" — an element holding no controls at all, so the pass
//   found nothing and returned silently. Worse, a document-wide scan finds the HEADER's
//   application-category switcher, whose label is the SAME TEXT as the real option; picking
//   it opens a menu instead of an application. So: consider each visible candidate
//   container, keep those offering >= 2 distinct options, and prefer the SMALLEST — the
//   radiogroup itself rather than the drawer that contains it, let alone the page.
//
//   A REBATE IS NOT AN INTERCONNECTION. Choosing the wrong programme files the wrong thing
//   entirely — the wrong-permit-type mistake in another costume — so a rebate/incentive
//   option is never eligible, and a drawer offering nothing that reads as an interconnection
//   or generation application is REFUSED rather than guessed at.
//
// Exported as one module (not inlined in the adapter) so the smoke test drives the SAME
// code the live run does. The previous version duplicated the logic into the test, and the
// hand-written fixture drifted from the portal: the test passed while the live run failed.
// ---------------------------------------------------------------------------

/** One selectable programme inside a candidate container. */
export interface ProgramOption {
  /** Learn-time marker attribute value, for clicking the exact element that was scanned. */
  key: string;
  label: string;
  /** True when the control (or a descendant) carries role=radio — see programSelector. */
  radio: boolean;
}

/** A visible container that offers two or more distinct options. */
export interface ProgramGroup {
  /** Rendered area in px^2; the tightest qualifying grouping wins. */
  area: number;
  options: ProgramOption[];
}

/**
 * Runs INSIDE the page (passed to page.evaluate). Self-contained by necessity: it is
 * serialized across the CDP boundary and cannot close over module scope.
 *
 * Tags every option it finds with data-al-prog so the caller can click the exact element
 * that was scanned rather than re-resolving by text.
 */
export function scanProgramGroups(): ProgramGroup[] {
  const vis = (e: Element): boolean => {
    const r = (e as HTMLElement).getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  // Deliberately broad — the point is a revealed panel, not one vendor's class names.
  const CONTAINER = [
    "mat-button-toggle-group",
    "[role='radiogroup']",
    "[role='listbox']",
    // A CHOICE IS NOT ALWAYS IN A DRAWER. Prince George's County (Momentum) asks which kind
    // of thing you are applying for on a PLAIN PAGE: <fieldset><legend>Pick a record
    // type.</legend> with two radios. Scoping only to revealed panels made that invisible,
    // and the learn clicked "Save & Continue" nine times against a gate it never answered.
    "fieldset",
    "mat-drawer",
    "mat-sidenav",
    "mat-dialog-container",
    "[role='dialog']",
    ".cdk-overlay-pane",
    ".modal.show",
    "[class*='drawer']",
    "[class*='new-application']",
  ].join(", ");
  const CONTROL = [
    "mat-button-toggle",
    "[role='radio']",
    "[role='option']",
    "input[type='radio']",
    "button",
    "a[role='button']",
  ].join(", ");

  const groups: ProgramGroup[] = [];
  let n = 0;
  for (const panel of Array.from(document.querySelectorAll(CONTAINER))) {
    if (!vis(panel)) continue;
    const rect = (panel as HTMLElement).getBoundingClientRect();
    const options: ProgramOption[] = [];
    for (const el of Array.from(panel.querySelectorAll(CONTROL))) {
      if (!vis(el)) continue;
      // AN <input> HAS NO innerText. A radio's name lives in its <label for=...>, which is a
      // SIBLING, not a descendant — so reading innerText returned "" and every radio-based
      // chooser was skipped silently. Momentum's is exactly this shape. Resolve the label
      // the way a browser's accessibility tree does: explicit label, wrapping label,
      // aria-label, aria-labelledby, then the control's own text.
      const labelFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const wrapping = el.closest("label");
      const labelledBy = (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      const label = (
        (el as HTMLElement).innerText ||
        (labelFor as HTMLElement | null)?.innerText ||
        (wrapping && wrapping !== el ? (wrapping as HTMLElement).innerText : "") ||
        el.getAttribute("aria-label") ||
        labelledBy ||
        ""
      ).replace(/\s+/g, " ").trim();
      if (!label || label.length > 60) continue;
      // A toggle and the <button> inside it both match; keep the OUTER one, so the offered
      // list reads like what a person sees rather than each option twice.
      if (options.some((o) => o.label === label)) continue;
      // The role lives on the INNER button (the outer mat-button-toggle is
      // role="presentation"), so look at the element AND its descendants — otherwise the
      // recorded step falls back to a bare text match that collides with page chrome.
      const radio =
        el.getAttribute("role") === "radio" ||
        (el as HTMLInputElement).type === "radio" ||
        !!el.querySelector("[role='radio'], input[type='radio']");
      const key = "ap" + String(n++);
      (el as HTMLElement).setAttribute("data-al-prog", key);
      options.push({ key, label, radio });
    }
    if (options.length >= 2) groups.push({ area: Math.round(rect.width * rect.height), options });
  }
  return groups;
}

/**
 * A rebate/incentive/enrolment programme is never the interconnection application.
 *
 * EVERY TERM IS ANCHORED ON WORD BOUNDARIES, and that is the whole point of this comment.
 * The list was written as bare substrings, which quietly refused the likeliest name a
 * solar programme can have:
 *
 *   "Renewable Energy Interconnection"  matched `renew`   -> EXCLUDED
 *   "Renewable Energy Systems"          matched `renew`   -> EXCLUDED
 *   "Solar Photovoltaic - Renewable"    matched `renew`   -> EXCLUDED
 *   "Backflow Prevention"               matched `back`    -> EXCLUDED
 *   "Enclosed Structure Permit"         matched `close`   -> EXCLUDED
 *   "Closed Loop Geothermal"            matched `close`   -> EXCLUDED
 *
 * On any portal calling its programme "Renewable Energy …" — which is what a great many
 * utilities call exactly the thing we are filing — the chooser found NO eligible option
 * and the learn could not enter the application at all. An exclusion list that rejects the
 * target is worse than no exclusion list, because it fails in the direction that looks
 * like a portal problem.
 *
 * "renew" must therefore match Renew and Renewal and never Renewable.
 *
 * "close" is narrower still: the ACTION, never the adjective. "Close Out Permit" is a
 * lifecycle transaction and excluded; "Closed Loop Geothermal" is the name of a thing you
 * can apply for and is not. Bare "Closed" as a programme option does not occur — you do
 * not start a closed application — so nothing is lost by requiring the verb.
 */
export const PROGRAM_EXCLUDE =
  /\brebate|\bincentive|\benrol{1,2}(ment)?\b|\brenew(al|als|ing)?\b|\bamend|\bwithdraw|\bcancel|\bclose\b|\bclosing\b|close[\s-]?out|\bback\b|\bhelp/i;

/** Most specific reading of "this is the interconnection application" first. */
export const PROGRAM_PREFER: RegExp[] = [
  /interconnect|net.?meter|\bnem\b/i,
  /solar|photovoltaic|\bpv\b/i,
  /distributed generation|\bdg\b/i,
  /generation/i,
];

/**
 * Picks the programme from the scanned groups, tightest qualifying container first.
 * Returns undefined when nothing reads as an interconnection/generation application —
 * an unrecognised drawer is left alone, never guessed at.
 */
/**
 * What an AHJ calls the thing you are applying for. The utility list above is useless on a
 * permit portal: Prince George's County offers "City Requests" and "Licenses & Permits", and
 * a chooser that only knows interconnection words refuses both — correctly by its own rules,
 * and uselessly for the run it is on.
 */
export const PROGRAM_PREFER_PERMIT: RegExp[] = [
  /licen[cs]e.{0,4}(and|&|\/).{0,4}permit|permit.{0,4}(and|&|\/).{0,4}licen[cs]e/i,
  /\bbuilding\b|\bconstruction\b|\btrade\b|\belectrical\b/i,
  /\bpermit(s)?\b/i,
  /\blicen[cs]e(s)?\b/i,
];

// ---------------------------------------------------------------------------
// JOB CLASS — which program, when a portal offers more than one that fits the track.
//
// The tiers above answer "is this the kind of application we came for?". They do not
// answer "is it for THIS job?". A utility that lists "Commercial Net Metering Application"
// above "Residential Net Metering Application" gave a residential learn the commercial
// program, because both match the first tier and the first in DOM order won — and the
// recipe then recorded that label for every replay on the tenant (#693).
//
// So the label's CLASS is read too, from a pattern list (never a utility list):
//
//   - a label that names only the OTHER class is not eligible for this job at all;
//   - among the options left at the deciding tier, ONE that names this job's class wins;
//   - when two or more remain and their labels do not settle it, the chooser returns
//     nothing: the supervising person picks, and the recipe records THEIR label.
//
// The strict default is the refusal. A portal whose labels say nothing about class and
// offers one fitting program is left exactly as it was; a portal that offers two and does
// not say which is ours is never guessed at by DOM order again.
// ---------------------------------------------------------------------------

/** The job's class as the chooser sees it. Residential unless the job is held as commercial. */
export type JobClass = "residential" | "commercial";

/**
 * Words a label uses to say "this program is for homes / small systems". "Small" counts
 * unless it qualifies a commercial or business customer ("Small Commercial" is commercial).
 */
export const RESIDENTIAL_CLASS_WORDS =
  /\bresiden(tial|ce|ces)\b|\bhomes?\b|\bhomeowners?\b|\bhousehold\b|\bsingle[\s-]?family\b|\bsmall\b(?![\s-]*(commercial|business|non[\s-]?residential))/i;

/** Words a label uses to say "this program is for businesses / large systems". */
export const COMMERCIAL_CLASS_WORDS =
  /\bcommercial\b|\bnon[\s-]?residential\b|\bbusiness(es)?\b|\blarge\b|\bindustrial\b|\bwholesale\b|\butility[\s-]?scale\b|\bmulti[\s-]?family\b/i;

/** A size bound a program label prints ("up to 25 kW", "over 1 MW", "10-25 kW"), in kW. */
export interface SizeBound {
  min?: number;
  minExclusive?: boolean;
  max?: number;
  maxExclusive?: boolean;
}

// A comma is a thousands separator ("1,000 kW"), never a decimal point, in the labels read here.
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
// "kW", "kWac", "kW-DC", "MW" — never "kWh", which is energy, not a system size.
const UNIT = String.raw`\s*(kw|mw)(?:[\s-]?(?:ac|dc))?\b`;
const toKw = (n: string, unit: string): number => {
  const v = Number(n.replace(/,/g, ""));
  return /mw/i.test(unit) ? v * 1000 : v;
};

/**
 * Reads the kW bound a label prints, if any. A label naming no bound returns undefined; a
 * label the parser cannot read cleanly returns undefined too, so it falls back to the words.
 */
export function readSizeBound(label: string): SizeBound | undefined {
  const s = String(label || "");
  const bound: SizeBound = {};
  // A range: "10-25 kW", "10 kW to 1 MW". The first unit is optional ("10-25 kW").
  const range = new RegExp(`${NUM}(?:${UNIT})?\\s*(?:-|–|—|to)\\s*${NUM}${UNIT}`, "i").exec(s);
  if (range) {
    const hiUnit = range[4];
    bound.min = toKw(range[1], range[2] || hiUnit);
    bound.max = toKw(range[3], hiUnit);
    return bound.min <= bound.max ? bound : undefined;
  }
  const upperBefore = new RegExp(
    `(≤|<=|<|\\bup to|\\bunder|\\bless than|\\bbelow|\\bsmaller than|\\bnot (?:to )?exceed(?:ing)?|\\bmax(?:imum)?(?: of)?|\\bno (?:more|greater|larger) than)\\s*${NUM}${UNIT}`, "i").exec(s);
  const upperAfter = new RegExp(`${NUM}${UNIT}\\s*(?:ac|dc)?\\s*(?:or|and)\\s*(?:less|under|below|smaller)`, "i").exec(s);
  const lowerBefore = new RegExp(
    `(≥|>=|>|\\bover|\\babove|\\bgreater than|\\bmore than|\\blarger than|\\bexceeding|\\bin excess of|\\bat least|\\bmin(?:imum)?(?: of)?)\\s*${NUM}${UNIT}`, "i").exec(s);
  const lowerAfter = new RegExp(`${NUM}${UNIT}\\s*(?:ac|dc)?\\s*(?:\\+|(?:or|and)\\s*(?:more|greater|above|larger|up|over))`, "i").exec(s)
    || new RegExp(`${NUM}\\s*\\+${UNIT}`, "i").exec(s);
  if (upperBefore) {
    bound.max = toKw(upperBefore[2], upperBefore[3]);
    bound.maxExclusive = /^(<|under|less|below|smaller)/i.test(upperBefore[1]) && !/^<=/.test(upperBefore[1]);
  } else if (upperAfter) {
    bound.max = toKw(upperAfter[1], upperAfter[2]);
  }
  if (lowerBefore) {
    bound.min = toKw(lowerBefore[2], lowerBefore[3]);
    bound.minExclusive = /^(>|over|above|greater|more|larger|exceeding|in excess)/i.test(lowerBefore[1]) && !/^>=/.test(lowerBefore[1]);
  } else if (lowerAfter) {
    bound.min = toKw(lowerAfter[1], lowerAfter[2]);
  }
  if (bound.min === undefined && bound.max === undefined) return undefined;
  if (bound.min !== undefined && bound.max !== undefined && bound.min > bound.max) return undefined;
  return bound;
}

function sizeFits(bound: SizeBound, kw: number): boolean {
  if (bound.min !== undefined && (bound.minExclusive ? kw <= bound.min : kw < bound.min)) return false;
  if (bound.max !== undefined && (bound.maxExclusive ? kw >= bound.max : kw > bound.max)) return false;
  return true;
}

/** The job as the chooser needs it. Every field optional: absent = residential, size unknown. */
export interface ProgramJob {
  jobClass?: JobClass;
  /** The system size the program thresholds are compared against (AC where known, else DC). */
  sizeKw?: number | null;
}

/**
 * How one label reads for this job:
 *   "fits"        names this job's class (or prints a size bound the job's size falls inside);
 *   "contradicts" names only the other class, or prints a size bound the job falls outside;
 *   "neutral"     says nothing about class.
 */
export function programClassFit(label: string, job: ProgramJob = {}): "fits" | "contradicts" | "neutral" {
  const ours: JobClass = job.jobClass === "commercial" ? "commercial" : "residential";
  const kw = typeof job.sizeKw === "number" && Number.isFinite(job.sizeKw) && job.sizeKw > 0 ? job.sizeKw : undefined;
  let residential = RESIDENTIAL_CLASS_WORDS.test(label);
  let commercial = COMMERCIAL_CLASS_WORDS.test(label);
  const wordsOurs = ours === "residential" ? residential : commercial;
  const wordsOther = ours === "residential" ? commercial : residential;
  const bound = readSizeBound(label);
  if (bound && kw !== undefined) {
    // A printed threshold and a known size: outside the bound is never ours ("Residential
    // up to 25 kW" is not a 30 kW job's program); inside it is ours unless the words name
    // only the other class ("Small Commercial up to 25 kW" is not a home's program).
    if (!sizeFits(bound, kw)) return "contradicts";
    return wordsOther && !wordsOurs ? "contradicts" : "fits";
  }
  if (bound) {
    // No size to compare: a floor reads as the large class, a ceiling alone as the small one.
    if (bound.min !== undefined && bound.min > 0) commercial = true;
    else if (bound.max !== undefined) residential = true;
  }
  const namesOurs = ours === "residential" ? residential : commercial;
  const namesOther = ours === "residential" ? commercial : residential;
  if (namesOurs) return "fits";
  if (namesOther) return "contradicts";
  return "neutral";
}

/** Why the chooser picked what it did, or why it picked nothing. */
export interface ProgramChoice {
  pick?: ProgramOption;
  /**
   * "matched"      one option fits the deciding tier for this job;
   * "ambiguous"    two or more fit the deciding tier and their labels do not settle which;
   * "other_class"  the only matching options name the other class (a commercial-only
   *                program offered to a residential job, or the reverse);
   * "unmatched"    nothing reads as something we came here to apply for.
   */
  reason: "matched" | "ambiguous" | "other_class" | "unmatched";
  /** The labels the decision was between — for a refusal the person can act on. */
  candidates: string[];
}

/**
 * Picks the programme from the scanned groups, tightest qualifying container first.
 *
 * `discipline` is the track this run is on (the project's permitType — "electrical",
 * "structural", or empty for a utility run). It decides which VOCABULARY leads: an
 * interconnection application and a building permit are different questions, and a chooser
 * that knows only one of them refuses the other. Both lists are still tried, so a portal
 * that words things unusually is not lost — only the ORDER changes.
 *
 * `job` carries the job's class and size (#693). Within the tightest group, the FIRST tier
 * with an eligible match decides: one candidate is taken; several are narrowed to the one
 * whose label names this job's class; anything still ambiguous is refused, never taken by
 * DOM order. A refusal is final — a looser group holds the same options plus page chrome.
 */
export function explainProgramChoice(groups: ProgramGroup[], discipline?: string, job: ProgramJob = {}): ProgramChoice {
  const permitTrack = /elec|struct|build|permit|mech|plumb/i.test(String(discipline || ""));
  const lists = permitTrack
    ? [...PROGRAM_PREFER_PERMIT, ...PROGRAM_PREFER]
    : [...PROGRAM_PREFER, ...PROGRAM_PREFER_PERMIT];
  const ranked = (Array.isArray(groups) ? groups.slice() : []).sort((a, b) => a.area - b.area);
  let otherClass: string[] = [];
  for (const group of ranked) {
    const eligible = (group.options || []).filter((o) => o && typeof o.label === "string" && !PROGRAM_EXCLUDE.test(o.label));
    for (const re of lists) {
      const matches = eligible.filter((o) => re.test(o.label));
      if (matches.length === 0) continue;
      const fit = matches.map((o) => ({ o, fit: programClassFit(o.label, job) }));
      const usable = fit.filter((x) => x.fit !== "contradicts");
      if (usable.length === 0) {
        // Every match at this tier is the other class's program. Keep looking at the looser
        // tiers ("Residential Solar" below "Commercial Interconnection" is still ours), and
        // remember what was passed over in case nothing else fits.
        for (const x of fit) if (!otherClass.includes(x.o.label)) otherClass.push(x.o.label);
        continue;
      }
      if (usable.length === 1) return { pick: usable[0].o, reason: "matched", candidates: [usable[0].o.label] };
      const ours = usable.filter((x) => x.fit === "fits");
      if (ours.length === 1) return { pick: ours[0].o, reason: "matched", candidates: usable.map((x) => x.o.label) };
      return { reason: "ambiguous", candidates: usable.map((x) => x.o.label) };
    }
  }
  if (otherClass.length) return { reason: "other_class", candidates: otherClass };
  return { reason: "unmatched", candidates: [] };
}

/**
 * The pick alone. Returns undefined when nothing reads as something we came here to apply
 * for, when only the other class's program is offered, or when two or more fit and the
 * labels do not say which — an unrecognised or unsettled choice is left alone rather than
 * guessed at.
 */
export function chooseProgram(groups: ProgramGroup[], discipline?: string, job: ProgramJob = {}): ProgramOption | undefined {
  return explainProgramChoice(groups, discipline, job).pick;
}

/**
 * The job's class from a project row. Residential unless the project is HELD as commercial.
 * Read loosely because the class field arrives with #688; until then every project reads
 * residential, which is what every project in the system is.
 */
export function jobClassOf(project: unknown): JobClass {
  const raw = project && typeof project === "object" ? (project as { projectClass?: unknown }).projectClass : undefined;
  return String(raw ?? "").trim().toLowerCase() === "commercial" ? "commercial" : "residential";
}

/** Every distinct label that was offered, for a diagnosable refusal. */
export function offeredLabels(groups: ProgramGroup[]): string[] {
  const seen: string[] = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const o of g.options || []) {
      if (o && typeof o.label === "string" && !seen.includes(o.label)) seen.push(o.label);
    }
  }
  return seen;
}

/**
 * How the choice is recorded for replay. BY LABEL, never by position — a programme chosen
 * by index is the mechanical-permit mistake in another costume. Scoped by role where the
 * DOM gives one, because the bare text "Distributed Generation" also matches the header's
 * category switcher on ComEd's own page.
 */
export function programSelector(pick: ProgramOption): {
  text?: string;
  role?: string;
  name?: string;
  fallbacks: Array<{ role?: string; name?: string; text?: string }>;
} {
  if (pick.radio) {
    return {
      role: "radio",
      name: pick.label,
      fallbacks: [{ role: "button", name: pick.label }, { text: pick.label }],
    };
  }
  return {
    text: pick.label,
    fallbacks: [{ role: "button", name: pick.label }, { role: "radio", name: pick.label }],
  };
}
