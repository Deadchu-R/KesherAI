/** A file path on the computer as an LSP URI (`C:\a b\x.cs` → `file:///c%3A/a%20b/x.cs`). */
export function fileUri(path: string): string {
  const n = path.replace(/\\/g, "/");
  const withSlash = n.startsWith("/") ? n : `/${n}`;
  return `file://${withSlash.split("/").map((s, i) => (i === 1 && /^[A-Za-z]:$/.test(s) ? `${s[0]!.toLowerCase()}%3A` : encodeURIComponent(s))).join("/")}`;
}
