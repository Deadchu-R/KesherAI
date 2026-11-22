/**
 * The free cloud providers KesherAI can use with a key the user enters (Settings › Accounts / Models › Free cloud
 * helpers): what each one gives for free (short, from docs/research/c-20261122-13.md Part A, always with a link to the
 * provider's own page because free tiers change), its privacy terms, its default limits, and the rules that keep every
 * call free: no card is needed on any of them, and a model that costs money is never used.
 */

/** Text in both languages. */
export interface Bilingual {
  he: string;
  en: string;
}

/** One free provider. */
export interface FreeProviderInfo {
  /** The connection id in the config and the registry (`fc-` + the provider). */
  id: string;
  /** Short name for the card. */
  name: string;
  /** What is free, short. The card adds "check the provider's page". */
  free: Bilingual;
  /** Data and training terms, from the report. */
  privacy: Bilingual;
  /** True when the free plan trains on your prompts unless you opt out (the card shows a warning). */
  trains?: boolean;
  /** The provider's own page about its free plan or limits. */
  link: string;
  /** Where the user makes a key. */
  keyLink: string;
  /** Requests per minute and per day to stay under (0 = not counted here). Conservative; the provider's headers win. */
  limits: { rpm: number; rpd: number };
  /** The model used when the user chose none. A free one. */
  defaultModel: string;
  /** Cloudflare: the account id is part of the address. */
  needsAccountId?: boolean;
}

/** The providers, in their default order (the user can reorder them). */
export const FREE_PROVIDERS: readonly FreeProviderInfo[] = [
  {
    id: "fc-groq",
    name: "Groq",
    free: { he: "שכבה חינמית קבועה, בלי כרטיס אשראי: כ-30 בקשות בדקה ו-1,000 עד 2,000 ביום.", en: "A permanent free tier, no card: about 30 requests a minute and 1,000 to 2,000 a day." },
    privacy: { he: "לא מאמנים מודלים על הפרומפטים. נשמר עד 30 יום רק לאבחון תקלות ולמניעת ניצול לרעה.", en: "Prompts are not used to train models. Kept up to 30 days for troubleshooting and abuse checks only." },
    link: "https://console.groq.com/docs/rate-limits",
    keyLink: "https://console.groq.com/keys",
    limits: { rpm: 30, rpd: 1000 },
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    id: "fc-openrouter",
    name: "OpenRouter (:free)",
    free: { he: "רק מודלים שמסתיימים ב-:free: 20 בקשות בדקה ו-50 ביום בלי רכישה. KesherAI לא משתמש באף מודל בתשלום.", en: "Only models ending in :free: 20 requests a minute and 50 a day without a purchase. KesherAI never uses a paid model." },
    privacy: { he: "לא נשמרים גופי הפרומפטים כברירת מחדל. בחשבון יש מתג שמונע ספקים שמאמנים על הפרומפטים: כדאי להפעיל אותו.", en: "Prompt bodies are not logged by default. The account has a switch that avoids providers that train on prompts: turn it on." },
    link: "https://openrouter.ai/docs/api-reference/limits",
    keyLink: "https://openrouter.ai/keys",
    limits: { rpm: 20, rpd: 50 },
    defaultModel: "openrouter/free",
  },
  {
    id: "fc-cloudflare",
    name: "Cloudflare Workers AI",
    free: { he: "10,000 Neurons ביום בחינם (מתאפס ב-00:00 UTC), בלי כרטיס. מעבר לזה הבקשה נכשלת ואין חיוב.", en: "10,000 Neurons a day free (resets at 00:00 UTC), no card. Beyond that the request fails and nothing is charged." },
    privacy: { he: "אין שמירת נתונים בהסקה, ולא מאמנים מודלים על הנתונים שלך.", en: "No data is kept for inference, and your data is not used to train models." },
    link: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    keyLink: "https://dash.cloudflare.com/profile/api-tokens",
    limits: { rpm: 0, rpd: 0 },
    defaultModel: "@cf/meta/llama-3.1-8b-instruct",
    needsAccountId: true,
  },
  {
    id: "fc-mistral",
    name: "Mistral (free plan)",
    free: { he: "התוכנית החינמית (Experiment): בערך בקשה או שתיים בשנייה ומכסת טוקנים חודשית. נדרש אימות בטלפון, בלי כרטיס.", en: "The free Experiment plan: about one or two requests a second and a monthly token limit. Phone verification, no card." },
    privacy: { he: "בתוכנית החינמית הפרומפטים משמשים לאימון המודלים של Mistral. אפשר לכבות בהגדרות הפרטיות של Mistral.", en: "On the free plan your prompts are used to train Mistral's models. You can turn that off in Mistral's privacy settings." },
    trains: true,
    link: "https://docs.mistral.ai/deployment/laplateforme/tier/",
    keyLink: "https://console.mistral.ai/api-keys",
    limits: { rpm: 30, rpd: 0 },
    defaultModel: "mistral-small-latest",
  },
  {
    id: "fc-zhipu",
    name: "Zhipu GLM-4-Flash",
    free: { he: "glm-4-flash בחינם: כ-3 בקשות בדקה ו-1,000 ביום. העברית חלשה. ההרשמה בסין דורשת מספר טלפון סיני; הפורטל הבינלאומי z.ai פתוח יותר.", en: "glm-4-flash is free: about 3 requests a minute and 1,000 a day. Hebrew is weak. Signing up in China needs a Chinese phone number; the international z.ai portal is more open." },
    privacy: { he: "כפוף לתקנות רישום ותקשורת לפי הפורטל. אל תשלחו לשם מידע רגיש.", en: "Subject to the logging rules of the portal you use. Do not send sensitive data there." },
    link: "https://open.bigmodel.cn/pricing",
    keyLink: "https://open.bigmodel.cn/usercenter/apikeys",
    limits: { rpm: 3, rpd: 1000 },
    defaultModel: "glm-4-flash",
  },
];

/** The ids of {@link FREE_PROVIDERS}, in their default order. */
export const FREE_PROVIDER_IDS: readonly string[] = FREE_PROVIDERS.map((p) => p.id);

/**
 * @param id - A connection id.
 * @returns The free provider's info, or undefined for any other connection.
 */
export function freeProvider(id: string): FreeProviderInfo | undefined {
  return FREE_PROVIDERS.find((p) => p.id === id);
}

/** What the user can choose about where a provider is. */
export interface FreeAddress {
  /** Cloudflare's account id (letters and digits). */
  accountId?: string;
  /** Zhipu: the mainland portal or the international z.ai. */
  region?: "cn" | "global";
}

/** A Cloudflare account id: 32 hex characters (accepted loosely, as letters and digits, so nothing odd lands in a URL). */
const ACCOUNT_ID = /^[A-Za-z0-9]{8,64}$/;

/**
 * Whether a Cloudflare account id is safe to put in the address.
 *
 * @param id - What the user typed.
 */
export function validAccountId(id: string | undefined): id is string {
  return !!id && ACCOUNT_ID.test(id);
}

/**
 * The API address of a provider.
 *
 * @param id - The connection id.
 * @param where - The account id and region the provider needs.
 * @returns The base URL (OpenAI style), or undefined when something it needs is missing.
 */
export function freeBaseUrl(id: string, where: FreeAddress = {}): string | undefined {
  switch (id) {
    case "fc-groq":
      return "https://api.groq.com/openai/v1";
    case "fc-openrouter":
      return "https://openrouter.ai/api/v1";
    case "fc-cloudflare":
      return validAccountId(where.accountId) ? `https://api.cloudflare.com/client/v4/accounts/${where.accountId}/ai/v1` : undefined;
    case "fc-mistral":
      return "https://api.mistral.ai/v1";
    case "fc-zhipu":
      return where.region === "global" ? "https://api.z.ai/api/paas/v4" : "https://open.bigmodel.cn/api/paas/v4";
    default:
      return undefined;
  }
}

/** What the guard knows about one model's price. */
export interface PriceFacts {
  /** The listing said the model costs money per token. */
  priced?: boolean;
}

/**
 * Why a model must not be used, or undefined when it is free. KesherAI never uses a model that costs money:
 * OpenRouter only with the `:free` suffix (or its `openrouter/free` router) and a listed price of zero; Zhipu only the
 * Flash models, which are its free ones. The other providers have no card on file, so their free allowance is the
 * limit and a call over it fails without a charge.
 *
 * @param providerId - The connection id.
 * @param modelId - The provider's own model id.
 * @param facts - The price the listing showed, when it showed one.
 * @returns The reason (English, for the error and the warning), or undefined when the model is free.
 */
export function paidModelReason(providerId: string, modelId: string, facts: PriceFacts = {}): string | undefined {
  if (facts.priced) return `${modelId} costs money (its listed price is above zero).`;
  if (providerId === "fc-openrouter" && !(modelId === "openrouter/free" || /:free$/.test(modelId))) return `${modelId} is not a :free model on OpenRouter.`;
  if (providerId === "fc-zhipu" && !/flash/i.test(modelId)) return `${modelId} is not one of Zhipu's free Flash models.`;
  return undefined;
}

/** A model of a provider's listing, after the free filter. */
export interface ListedModel {
  id: string;
  /** Free to use (see {@link paidModelReason}). */
  free: boolean;
  /** Why it is not free, when it is not. */
  reason?: string;
}

/** Models that are not for chat (speech, embeddings, safety filters). */
const NOT_CHAT = /whisper|tts|embed|rerank|guard|moderation|orpheus|ocr|image|flux|stable-diffusion/i;

/**
 * Reads a provider's model list and marks the free ones.
 *
 * @param providerId - The connection id.
 * @param json - The JSON the provider answered (OpenAI style `data[]`, or Cloudflare's `result[]`).
 * @returns The chat models, each marked free or not. OpenRouter's price (`pricing.prompt` / `pricing.completion`) is read.
 */
export function parseModelList(providerId: string, json: unknown): ListedModel[] {
  const o = (json && typeof json === "object" ? json : {}) as { data?: unknown; result?: unknown };
  const rows = (Array.isArray(o.data) ? o.data : Array.isArray(o.result) ? o.result : []) as Array<Record<string, unknown>>;
  const out: ListedModel[] = [];
  for (const m of rows) {
    const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
    if (!id || NOT_CHAT.test(id)) continue;
    const pricing = m.pricing as { prompt?: unknown; completion?: unknown } | undefined;
    const price = (v: unknown) => (v === undefined || v === null || v === "" ? 0 : Number(v));
    const priced = !!pricing && (price(pricing.prompt) > 0 || price(pricing.completion) > 0 || Number.isNaN(price(pricing.prompt)) || Number.isNaN(price(pricing.completion)));
    const reason = paidModelReason(providerId, id, { priced });
    out.push({ id, free: !reason, ...(reason ? { reason } : {}) });
  }
  return out;
}

/**
 * Where a provider lists its models.
 *
 * @param id - The connection id.
 * @param baseUrl - The provider's base URL.
 * @returns The address to GET.
 */
export function modelListUrl(id: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Cloudflare's OpenAI-style address has no model list; its own search lists the text models.
  if (id === "fc-cloudflare") return `${base.replace(/\/ai\/v1$/, "")}/ai/models/search?task=Text%20Generation&per_page=100`;
  return `${base}/models`;
}
