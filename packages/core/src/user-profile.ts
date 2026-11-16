/** About the user: the name she set and how to address her, for the app and the chat models. */

/** How to address the user: f feminine, m masculine, p plural (neutral). */
export type Address = "f" | "m" | "p";

/**
 * The note the chat models get about the user (the start of their instructions).
 *
 * @param u - The setting (name, address).
 * @returns The note, or "" when nothing is set.
 */
export function aboutUserNote(u: { name?: string; address?: Address } | undefined): string {
  const name = u?.name?.trim();
  const how = u?.address === "f" ? "Address the user in the feminine (in Hebrew and other gendered languages)." : u?.address === "m" ? "Address the user in the masculine (in Hebrew and other gendered languages)." : u?.address === "p" ? "Address the user in the plural or gender-neutral forms (in Hebrew and other gendered languages)." : "";
  return [name ? `The user's name is ${name}.` : "", how].filter(Boolean).join(" ");
}
