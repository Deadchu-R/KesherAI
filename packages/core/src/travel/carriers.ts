/**
 * Israeli airlines, flagged in results (Roee's choice: Israel first). IATA code -> name. Other airlines get their
 * name from the provider's own dictionary.
 */
export const ISRAELI_CARRIERS: Readonly<Record<string, string>> = { LY: "El Al", "6H": "Israir", IZ: "Arkia" };

/** @returns Whether an IATA airline code is El Al, Israir or Arkia. */
export function isIsraeli(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISRAELI_CARRIERS, code.toUpperCase());
}

/** A few common names, used when a provider gives only the code. */
const COMMON: Readonly<Record<string, string>> = { A3: "Aegean", W6: "Wizz Air", FR: "Ryanair", U2: "easyJet", TK: "Turkish Airlines", LH: "Lufthansa", AZ: "ITA Airways", AF: "Air France", BA: "British Airways", KL: "KLM" };

/**
 * The airline's name for people.
 *
 * @param code - The IATA code.
 * @param given - The name the provider gave, if any (used unless it is an Israeli one we spell ourselves).
 * @returns A name, or the code when nothing is known.
 */
export function airlineName(code: string, given?: string): string {
  const c = code.toUpperCase();
  return ISRAELI_CARRIERS[c] ?? (given ? titleCase(given) : COMMON[c] ?? c);
}

/** "EL AL ISRAEL AIRLINES" -> "El Al Israel Airlines". */
function titleCase(s: string): string {
  return s.length > 3 && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()) : s;
}
