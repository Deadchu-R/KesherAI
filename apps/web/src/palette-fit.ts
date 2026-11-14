/**
 * How well a query fits a text: whole word starts first, then anywhere, then the letters in order (a fuzzy match).
 *
 * @returns 0 for no match; higher is better.
 */
export function fit(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const s = text.toLowerCase();
  if (s.startsWith(q)) return 100;
  const at = s.indexOf(q);
  if (at > 0 && /[\s/#._-]/.test(s[at - 1]!)) return 80;
  if (at >= 0) return 60;
  let i = 0;
  let gaps = 0;
  for (const c of s) {
    if (c === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return Math.max(5, 40 - gaps);
  }
  return 0;
}
