// WHEN TWO SYSTEM SIZES DISAGREE — one tolerance for every reader that cross-checks a size (the approval
// sheet's DC / AC rows, the gate's city.elec.ac-size-mismatch). A leaf module: no imports.

/** Two sizes (kW) disagree when they differ by more than 3% (and more than 0.05 kW): a rounding on the
 *  title block never reads as a mismatch, a missing panel or a wrong inverter count does. */
export const sizesDisagree = (a: number, b: number): boolean => Math.abs(a - b) > Math.max(0.05, 0.03 * Math.max(a, b));

/** What the inverters add up to in AC, as the plan set states them — ONE reader for the gate's
 *  city.elec.ac-size-mismatch rule and the approval sheet's AC row (review-audit drafts 04 and 11).
 *  `kw` is the derived total, `how` the arithmetic in words ("20 x 1.6 A x 240 V (assumed)"). */
export interface InverterAcReading {
  kw: number;
  how: string;
  /** The voltage is a single-phase assumption, not the plan's own figure. */
  voltageAssumed: boolean;
  /** "W" when the per-unit output was written in watts, "A" when it is a current. */
  unit: "W" | "A";
  /** How far the total can sit from `kw` from the stated output's own rounding alone (kW): a current
   *  written "1.6 A" is anything from 1.55 to 1.65 A, which across 20 units at 240 V is ±0.24 kW. */
  roundingKw: number;
}

/** The project's AC size and the inverters' derived AC disagree: beyond the shared tolerance AND the
 *  stated output's own rounding (a rounded datasheet current is not a missing inverter). */
export const acSizesDisagree = (acKw: number, reading: InverterAcReading): boolean =>
  Math.abs(acKw - reading.kw) > Math.max(0.05, 0.03 * Math.max(acKw, reading.kw)) + reading.roundingKw;

/** The inverters' AC from the parser's own keys. invOutputW / pvMicroOutputW hold the per-unit output
 *  CURRENT in amps (the parser prompt, despite the name); real payloads sometimes carry watts instead,
 *  so a value above 100 is read as watts and an amp value as amps x the service's single-phase
 *  voltage (208 when the plan says so, else 240, "assumed" when the plan states none). Null when it
 *  cannot be derived or the sum is a different number on purpose: a battery (a hybrid or battery
 *  inverter adds or caps AC), an existing system on the same service, a three-phase service.
 *  The caller supplies how a key reads (its own number parser), so this stays a leaf. */
export function inverterAcFromPlan(
  read: { num: (key: string) => number | null; text: (key: string) => string },
  job: { battery: boolean; existingSystem: boolean },
): InverterAcReading | null {
  if (job.battery || job.existingSystem) return null;
  const stringOut = read.num("invOutputW");
  const unitOut = stringOut ?? read.num("pvMicroOutputW");
  const unitQty = stringOut != null ? read.num("invQty") : (read.num("pvMicroQty") ?? read.num("invQty"));
  if (unitOut == null || !(unitOut > 0) || unitQty == null || !(unitQty > 0)) return null;
  const voltsRaw = read.text("serviceVoltage") || read.text("voltage");
  const phaseRaw = read.text("servicePhase") || read.text("phase");
  const service = `${voltsRaw} ${phaseRaw}`;
  if (/(?<!\d)(?:277|480)(?!\d)|\b3\s*-?\s*(?:ph|phase)\b|three[-\s]?phase|\b3\s*(?:Ø|φ)/i.test(service)) return null;
  const asWatts = unitOut > 100;
  const volts = /(?<!\d)208(?!\d)/.test(voltsRaw) ? 208 : 240;
  const kw = unitQty * (asWatts ? unitOut / 1000 : (unitOut * volts) / 1000);
  const voltageAssumed = !asWatts && !voltsRaw;
  // Half a unit in the last decimal place the output was written to, across every unit.
  const decimals = (String(unitOut).split(".")[1] ?? "").length;
  const halfStep = 0.5 * 10 ** -decimals;
  const roundingKw = unitQty * (asWatts ? halfStep / 1000 : (halfStep * volts) / 1000);
  const how = asWatts ? `${unitQty} x ${unitOut} W` : `${unitQty} x ${unitOut} A x ${volts} V${voltageAssumed ? " (assumed)" : ""}`;
  return { kw, how, voltageAssumed, unit: asWatts ? "W" : "A", roundingKw };
}
