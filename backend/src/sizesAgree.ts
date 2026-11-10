// WHEN TWO SYSTEM SIZES DISAGREE — one tolerance for every reader that cross-checks a size (the approval
// sheet's DC / AC rows, the gate's city.elec.ac-size-mismatch). A leaf module: no imports.

/** Two sizes (kW) disagree when they differ by more than 3% (and more than 0.05 kW): a rounding on the
 *  title block never reads as a mismatch, a missing panel or a wrong inverter count does. */
export const sizesDisagree = (a: number, b: number): boolean => Math.abs(a - b) > Math.max(0.05, 0.03 * Math.max(a, b));
