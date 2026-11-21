/**
 * Made-up links in a model's answer (a small local model wrote "[▶️ נגן שיר](download://music/x.mp3)" and "#/docs/…"
 * as if the app had a player and a page there). The app shows real files, players and documents by itself, so a
 * link the app cannot open is taken out and only its text stays.
 *
 * What stays: web addresses (http, https), mailto and tel, app routes (`#/…`) that can be real, and links to files
 * the app really has (`/api/assets/<id>`, `attachment:<id>`) when the caller says they exist.
 */

/** Whether a stored file exists (the chat's assets); undefined means "do not check", every well-formed id passes. */
export type AssetExists = (id: string) => boolean | Promise<boolean>;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A document's id: a UUID, or `chat-<chat id>` for the chat's own document (docs.ts). */
const DOC_ROUTE = new RegExp(`^#/docs/(?:chat-)?[\\w-]{8,64}$`, "i");
const ASSET_ROUTE = new RegExp(`^(?:/api/assets/|attachment:)(${UUID})$`, "i");
const SAFE_SCHEME = /^(?:https?:\/\/|mailto:|tel:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `![alt](target)` or `[label](target)`; the target has no spaces or brackets. */
const MD_LINK = /(!?)\[([^\]\n]*)\]\(\s*<?([^()\s>]*)>?(?:\s+"[^"]*")?\s*\)/g;
/** An address with an invented scheme, or an app route to a page that is not there, written without a link. */
const BARE = /(?:\b(?:download|sandbox|computer|file|attachment|blob|data):(?:\/\/)?[^\s)\]>"']+|#\/docs\/[^\s)\]>"']*)/gi;

/**
 * Whether one link target can be opened by the app.
 *
 * @param target - The address inside the link's parentheses.
 * @param exists - Checks that an asset id is a real stored file.
 * @returns True when the link is real or cannot be judged.
 */
async function isRealTarget(target: string, exists?: AssetExists): Promise<boolean> {
  if (!target) return false;
  if (SAFE_SCHEME.test(target)) return true;
  const asset = ASSET_ROUTE.exec(target);
  if (asset) return exists ? await exists(asset[1]!.toLowerCase()) : true;
  if (target.startsWith("#/docs/")) return DOC_ROUTE.test(target);
  if (target.startsWith("#/") || target.startsWith("#")) return true;
  // Any other address with a scheme (download://, sandbox:, file://) is something the model invented.
  return !HAS_SCHEME.test(target);
}

/**
 * Takes the links the app cannot open out of an answer: a markdown link keeps its text, a picture keeps its alt text,
 * a bare invented address is removed. Code (fenced or inline) is left as it is.
 *
 * @param text - The model's answer.
 * @param exists - Optional check that an `/api/assets/<id>` or `attachment:<id>` file really exists.
 * @returns The answer without invented links.
 */
export async function neutralizeLinks(text: string, exists?: AssetExists): Promise<string> {
  if (!/[[(]|#\/docs\/|:/.test(text)) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  for (let i = 0; i < parts.length; i += 2) {
    let part = parts[i]!;
    const jobs: Array<Promise<[string, string]>> = [];
    for (const m of part.matchAll(MD_LINK)) jobs.push(isRealTarget(m[3]!, exists).then((ok) => [m[0], ok ? m[0] : m[2]!] as [string, string]));
    for (const [from, to] of await Promise.all(jobs)) if (from !== to) part = part.split(from).join(to);
    // What is left of an invented address without a link around it. A real link was left alone above, so look only
    // at text outside link parentheses.
    parts[i] = part.replace(new RegExp(`(\\]\\([^)]*\\))|${BARE.source}`, "gi"), (all, link) => (link ? link : ""));
  }
  return parts.join("").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n");
}
