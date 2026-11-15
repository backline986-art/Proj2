// A RECORDED FREE-TEXT VALUE THAT READS AS ONE JOB'S DATA IS THAT JOB'S (#236).
//
// The replay guard (recipeAdapter.looksLikeProjectData) was LABEL-first: apart from an email and a
// phone number it read only the label, so a box whose label names no project word replayed whatever
// the learn job typed into it. Measured in the 2026-11-14 audit of all 22 saved recipes: City of
// Tigard's "Describe Location of Solar Array" replays "Roof-mounted PV array …, south-facing (180°
// azimuth, 22° tilt)", the learn roof's orientation, on every job. The backend binder's R2 asked the
// same question with its own regex (kW, watts, a module count) and missed it too.
//
// So the VALUE is read as well, here, once; both doors ask this function:
//   orientation       degrees, azimuth or tilt: a roof's ("180°", "22 deg", "azimuth")
//   electrical units  a rating with its unit: a system's ("8.36 kW", "440W", "200 A", "240V", "13.5 kWh")
//   module count      "(19) ZNShine …": a count and a make
//   street address    a house number, a street and its type (draftCreated.siteKey or addressParse.readStreetLine)
//   prose             two or more sentences of three or more words: a narrative written for one job
//                     (a portal's own answer is a word or a phrase)
// A value with such a shape is left blank for gap-fill and the reviewer: a blank required box is a
// visible stop, another roof's orientation an invisible one.

import { siteKey } from "./draftCreated";
import { readStreetLine } from "./addressParse";

export type JobValueShape = "orientation" | "electrical units" | "module count" | "street address" | "prose";

const DEGREES = /\d\s*(?:°|º|˚|deg(?:rees?)?\b)/i;
const ORIENTATION_WORD = /\b(?:azimuth|tilt)\b/i;
/** A number with a unit attached. A ONE-letter unit needs two digits ("200 A", "60A", "440W"), so
 *  "Unit 1 A" or "Lot 3 W" never reads as a rating. */
const MULTI_LETTER_UNIT = /(?<![\w.])\d+(?:\.\d+)?\s?(?:kwh|kw|kva|mw|watts?|amps?|amperes?|volts?)(?![a-z])/i;
const ONE_LETTER_UNIT = /(?<![\w.])\d{2,}(?:\.\d+)?\s?[awv](?![a-z0-9])/i;
const MODULE_COUNT = /\(\d+\)\s*[A-Za-z]/;

/** Two or more sentences of three or more words. A sentence ends after a WORD (three lower-case
 *  letters before the stop), so an abbreviation's full stop ("N. Main", "St. Louis", "Dr.") never
 *  splits one sentence into two. */
function isProse(v: string): boolean {
  const sentences = v.split(/(?<=[a-z]{3}[.!?])\s+(?=[A-Z])/)
    .filter((s) => s.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length >= 3);
  return sentences.length >= 2;
}

/** The job-data shape a recorded value has, or null when it reads as a portal's own word. */
export function jobValueShape(value: unknown): JobValueShape | null {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (DEGREES.test(v) || ORIENTATION_WORD.test(v)) return "orientation";
  if (MODULE_COUNT.test(v)) return "module count";
  if (MULTI_LETTER_UNIT.test(v) || ONE_LETTER_UNIT.test(v)) return "electrical units";
  if (/^\d+[a-z]?\s/i.test(v)) {
    // Either street reading: siteKey reads a line that runs on into its city and ZIP; it stops at a
    // token spelling a state code, so an NE-quadrant or Court address is read by addressParse's
    // readStreetLine (the search boxes' reading, #236 review).
    const site = siteKey({ street: v }, true);
    const line = readStreetLine(v);
    if ((site && site.suffix) || (line.readable && line.suffix)) return "street address";
  }
  if (isProse(v)) return "prose";
  return null;
}
