/**
 * The chat file a page was opened with (`?c=<chat>&f=<file>`): a picture for a page that declared `image`, a video for
 * one that declared `video`, a sound for one that declared `sound`. A link cannot hand any page any other file.
 *
 * @param query - The part after `?`.
 * @param uses - The page's declared models.
 * @returns The chat and file, or undefined.
 */
export function pageInput(query: string, uses: readonly string[] | undefined): { conversationId: string; path: string } | undefined {
  const q = new URLSearchParams(query);
  const c = q.get("c");
  const f = q.get("f");
  const picture = /\.(png|jpe?g|webp|gif|bmp)$/i.test(f ?? "") && uses?.includes("image");
  const video = /\.(mp4|webm|mov|m4v|mkv)$/i.test(f ?? "") && uses?.includes("video");
  const sound = /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(f ?? "") && uses?.includes("sound");
  if (!c || !f || !/^[\w-]{1,80}$/.test(c) || !(picture || video || sound)) return undefined;
  return { conversationId: c, path: f };
}
