/**
 * Study: medication calculations (always computed here, never by a model) and the nursing references (drug cards, lab values).
 * Re-exported by study.ts, so everything imports it from there as before.
 */

// ── Medication calculations ────────────────────────────────────────────────────────────────────────────────────────

/** A calculation's answer with the steps that lead to it (numbers and units, the same in every language). */
export interface CalcResult {
  value: number;
  unit: string;
  steps: string[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fmt = (n: number) => String(round(n));

function need(...ns: number[]): void {
  if (ns.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error("Every number must be above zero.");
}

/** The kinds of medication calculation. */
export type CalcKind = "volume" | "tablets" | "weight" | "rate" | "drops" | "infusion";

/**
 * Volume to give: what is ordered ÷ what is in the bottle × its volume ("desired over have").
 *
 * @param doseMg - Ordered dose.
 * @param haveMg - Amount of drug in the stock volume.
 * @param perMl - The stock volume (mL).
 */
export function volumeToGive(doseMg: number, haveMg: number, perMl: number): CalcResult {
  need(doseMg, haveMg, perMl);
  const v = (doseMg / haveMg) * perMl;
  return { value: round(v), unit: "mL", steps: [`${fmt(doseMg)} mg ÷ ${fmt(haveMg)} mg × ${fmt(perMl)} mL = ${fmt(v)} mL`] };
}

/**
 * Tablets to give.
 *
 * @param doseMg - Ordered dose.
 * @param tabletMg - One tablet's strength.
 */
export function tabletsToGive(doseMg: number, tabletMg: number): CalcResult {
  need(doseMg, tabletMg);
  const t = doseMg / tabletMg;
  return { value: round(t), unit: "tab", steps: [`${fmt(doseMg)} mg ÷ ${fmt(tabletMg)} mg = ${fmt(t)}`] };
}

/**
 * A dose by body weight, with an optional top dose.
 *
 * @param mgPerKg - The dose per kilogram.
 * @param kg - Weight.
 * @param maxMg - The highest single dose, when there is one.
 */
export function doseByWeight(mgPerKg: number, kg: number, maxMg?: number): CalcResult {
  need(mgPerKg, kg);
  const d = mgPerKg * kg;
  const steps = [`${fmt(mgPerKg)} mg/kg × ${fmt(kg)} kg = ${fmt(d)} mg`];
  if (maxMg && d > maxMg) {
    steps.push(`${fmt(d)} mg > ${fmt(maxMg)} mg (max) → ${fmt(maxMg)} mg`);
    return { value: round(maxMg), unit: "mg", steps };
  }
  return { value: round(d), unit: "mg", steps };
}

/**
 * Infusion pump rate.
 *
 * @param volumeMl - Volume to run.
 * @param hours - Over how long.
 */
export function pumpRate(volumeMl: number, hours: number): CalcResult {
  need(volumeMl, hours);
  const r = volumeMl / hours;
  return { value: round(r, 1), unit: "mL/h", steps: [`${fmt(volumeMl)} mL ÷ ${fmt(hours)} h = ${round(r, 1)} mL/h`] };
}

/**
 * Gravity drip rate (drops per minute, whole drops).
 *
 * @param volumeMl - Volume to run.
 * @param minutes - Over how long.
 * @param dropFactor - Drops per mL of the set (20 for a regular set, 60 for a micro-drip).
 */
export function dropRate(volumeMl: number, minutes: number, dropFactor: number): CalcResult {
  need(volumeMl, minutes, dropFactor);
  const raw = (volumeMl * dropFactor) / minutes;
  return { value: Math.round(raw), unit: "gtt/min", steps: [`${fmt(volumeMl)} mL × ${fmt(dropFactor)} gtt/mL ÷ ${fmt(minutes)} min = ${fmt(raw)} → ${Math.round(raw)} gtt/min`] };
}

/**
 * Pump rate for a dose per kilogram per minute (e.g. dopamine in mcg/kg/min).
 *
 * @param mcgPerKgMin - Ordered dose.
 * @param kg - Weight.
 * @param drugMg - Drug in the bag.
 * @param bagMl - The bag's volume.
 */
export function infusionRate(mcgPerKgMin: number, kg: number, drugMg: number, bagMl: number): CalcResult {
  need(mcgPerKgMin, kg, drugMg, bagMl);
  const perMin = mcgPerKgMin * kg;
  const perHourMg = (perMin * 60) / 1000;
  const conc = drugMg / bagMl;
  const r = perHourMg / conc;
  return {
    value: round(r, 1),
    unit: "mL/h",
    steps: [
      `${fmt(mcgPerKgMin)} mcg/kg/min × ${fmt(kg)} kg = ${fmt(perMin)} mcg/min`,
      `${fmt(perMin)} mcg/min × 60 ÷ 1000 = ${fmt(perHourMg)} mg/h`,
      `${fmt(drugMg)} mg ÷ ${fmt(bagMl)} mL = ${round(conc, 3)} mg/mL`,
      `${fmt(perHourMg)} mg/h ÷ ${round(conc, 3)} mg/mL = ${round(r, 1)} mL/h`,
    ],
  };
}

/** A practice problem: its numbers, and the answer computed by the functions above. */
export interface CalcProblem {
  kind: CalcKind;
  values: Record<string, number>;
  result: CalcResult;
}

const pick = <T>(xs: readonly T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)]!;

/**
 * A random practice problem with realistic numbers.
 *
 * @param kind - Which calculation.
 * @param rnd - Random numbers in [0, 1) (tests pass a fixed one).
 */
export function practiceProblem(kind: CalcKind, rnd: () => number = Math.random): CalcProblem {
  switch (kind) {
    case "volume": {
      const haveMg = pick([25, 50, 100, 250, 500], rnd);
      const perMl = pick([1, 2, 5, 10], rnd);
      const doseMg = haveMg * pick([0.5, 1, 1.5, 2, 0.25], rnd);
      return { kind, values: { doseMg, haveMg, perMl }, result: volumeToGive(doseMg, haveMg, perMl) };
    }
    case "tablets": {
      const tabletMg = pick([5, 10, 25, 50, 250, 500], rnd);
      const doseMg = tabletMg * pick([0.5, 1, 2, 3], rnd);
      return { kind, values: { doseMg, tabletMg }, result: tabletsToGive(doseMg, tabletMg) };
    }
    case "weight": {
      const mgPerKg = pick([0.1, 0.5, 1, 2, 5, 10, 15], rnd);
      const kg = pick([8, 12, 20, 35, 50, 62, 70, 85], rnd);
      return { kind, values: { mgPerKg, kg }, result: doseByWeight(mgPerKg, kg) };
    }
    case "rate": {
      const volumeMl = pick([250, 500, 1000], rnd);
      const hours = pick([2, 4, 6, 8, 12, 24], rnd);
      return { kind, values: { volumeMl, hours }, result: pumpRate(volumeMl, hours) };
    }
    case "drops": {
      const volumeMl = pick([100, 250, 500, 1000], rnd);
      const minutes = pick([30, 60, 120, 240, 480], rnd);
      const dropFactor = pick([20, 60], rnd);
      return { kind, values: { volumeMl, minutes, dropFactor }, result: dropRate(volumeMl, minutes, dropFactor) };
    }
    case "infusion": {
      const mcgPerKgMin = pick([2, 3, 5, 8, 10], rnd);
      const kg = pick([50, 60, 70, 80, 90], rnd);
      const drugMg = pick([200, 400, 800], rnd);
      const bagMl = pick([250, 500], rnd);
      return { kind, values: { mcgPerKgMin, kg, drugMg, bagMl }, result: infusionRate(mcgPerKgMin, kg, drugMg, bagMl) };
    }
  }
}

/**
 * Whether an answer is right: within 1% (at least 0.05) of the computed one; drops must be the whole number.
 *
 * @param answer - What the student wrote.
 * @param result - The computed answer.
 */
export function calcCorrect(answer: number, result: CalcResult): boolean {
  if (!Number.isFinite(answer)) return false;
  if (result.unit === "gtt/min") return Math.round(answer) === result.value;
  return Math.abs(answer - result.value) <= Math.max(0.05, Math.abs(result.value) * 0.01);
}

// ── Nursing ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A drug card (the fields nursing drug guides use). Only what the student's material says is filled. */
export interface StudyDrug {
  id: string;
  name: string;
  /** Brand names (Israeli ones when the material gives them). */
  brands?: string;
  drugClass?: string;
  action?: string;
  uses?: string;
  dose?: string;
  sideEffects?: string;
  contraindications?: string;
  nursing?: string;
  teaching?: string;
  lectureId?: string;
}

/** One normal adult lab range. Ranges differ between labs: the page says to check the hospital's own. */
export interface LabValue {
  group: "electrolytes" | "blood" | "kidney" | "gases" | "coagulation" | "other";
  name: string;
  he: string;
  range: string;
  unit: string;
  note?: string;
}

/** Common adult reference ranges as taught in nursing courses (textbook values; each lab has its own). */
export const LAB_VALUES: LabValue[] = [
  { group: "electrolytes", name: "Sodium (Na⁺)", he: "נתרן", range: "135–145", unit: "mEq/L" },
  { group: "electrolytes", name: "Potassium (K⁺)", he: "אשלגן", range: "3.5–5.0", unit: "mEq/L" },
  { group: "electrolytes", name: "Chloride (Cl⁻)", he: "כלוריד", range: "98–106", unit: "mEq/L" },
  { group: "electrolytes", name: "Calcium (total)", he: "סידן", range: "8.5–10.5", unit: "mg/dL" },
  { group: "electrolytes", name: "Magnesium (Mg²⁺)", he: "מגנזיום", range: "1.5–2.5", unit: "mg/dL" },
  { group: "electrolytes", name: "Phosphate", he: "זרחן", range: "2.5–4.5", unit: "mg/dL" },
  { group: "blood", name: "Hemoglobin", he: "המוגלובין", range: "♀ 12–16 · ♂ 14–18", unit: "g/dL" },
  { group: "blood", name: "Hematocrit", he: "המטוקריט", range: "♀ 37–47 · ♂ 42–52", unit: "%" },
  { group: "blood", name: "WBC", he: "כדוריות דם לבנות", range: "4.5–11", unit: "×10³/µL" },
  { group: "blood", name: "Platelets", he: "טסיות", range: "150–400", unit: "×10³/µL" },
  { group: "blood", name: "Glucose (fasting)", he: "סוכר בצום", range: "70–99", unit: "mg/dL" },
  { group: "blood", name: "HbA1c", he: "המוגלובין מסוכרר", range: "< 5.7", unit: "%" },
  { group: "kidney", name: "Creatinine", he: "קריאטינין", range: "0.6–1.2", unit: "mg/dL" },
  { group: "kidney", name: "BUN", he: "שתנן בדם", range: "7–20", unit: "mg/dL" },
  { group: "gases", name: "pH (arterial)", he: "חומציות", range: "7.35–7.45", unit: "" },
  { group: "gases", name: "PaCO₂", he: "פחמן דו-חמצני", range: "35–45", unit: "mmHg" },
  { group: "gases", name: "HCO₃⁻", he: "ביקרבונט", range: "22–26", unit: "mEq/L" },
  { group: "gases", name: "PaO₂", he: "חמצן", range: "80–100", unit: "mmHg" },
  { group: "gases", name: "SpO₂", he: "רוויון חמצן", range: "95–100", unit: "%" },
  { group: "coagulation", name: "INR", he: "INR", range: "0.8–1.1", unit: "", note: "on warfarin, usually 2–3" },
  { group: "coagulation", name: "PT", he: "זמן פרותרומבין", range: "11–13.5", unit: "s" },
  { group: "coagulation", name: "aPTT", he: "aPTT", range: "30–40", unit: "s" },
  { group: "other", name: "Digoxin level", he: "רמת דיגוקסין", range: "0.5–2.0", unit: "ng/mL" },
  { group: "other", name: "Albumin", he: "אלבומין", range: "3.5–5.0", unit: "g/dL" },
];
