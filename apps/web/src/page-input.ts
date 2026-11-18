/**
 * The chat picture a page was opened with (`?c=<chat>&f=<file>`). Only a picture, and only for a page that declared
 * the picture models: a link cannot hand any page any file.
 *
 * @param query - The part after `?`.
 * @param uses - The page's declared models.
 * @returns The chat and file, or undefined.
 */
export function pageInput(query: string, uses: readonly string[] | undefined): { conversationId: string; path: string } | undefined {
  const q = new URLSearchParams(query);
  const c = q.get("c");
  const f = q.get("f");
  if (!c || !f || !/^[\w-]{1,80}$/.test(c) || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(f) || !uses?.includes("image")) return undefined;
  return { conversationId: c, path: f };
}
