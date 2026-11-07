/**
 * Models offered under "Start here" on the Models screen: one click
 * installs the llama.cpp engine if needed, downloads the file and loads it.
 *
 * Each entry names a Hugging Face repo and a file pattern rather than an
 * exact file name, so a repo that renames its files keeps working.
 * Sizes are approximate and only shown to the user.
 */
export interface RecommendedModel {
  /** Stable id used by the API. */
  id: string;
  name: string;
  category: "chat";
  /** Hugging Face repo id. */
  repo: string;
  /** Picks the file in the repo (first match). */
  filePattern: string;
  /** Approximate download size in GB. */
  sizeGb: number;
  /** Rough memory needed (VRAM + RAM) in GB. */
  memoryGb: number;
  /** Share of the weights used per token; below 1 for mixture-of-experts models. */
  activeFraction?: number;
  /** Whether it handles tool calling well enough for the code agent. */
  goodForCode: boolean;
  /** One line on what it is for. */
  note: { en: string } & Record<string, string>;
}

/** The "Start here" list, smallest first. */
export const RECOMMENDED_MODELS: readonly RecommendedModel[] = [
  {
    id: "qwen3-4b",
    name: "Qwen3 4B",
    category: "chat",
    repo: "Qwen/Qwen3-4B-GGUF",
    filePattern: "Q4_K_M\\.gguf$",
    sizeGb: 2.5,
    memoryGb: 4,
    goodForCode: false,
    note: { en: "Small and fast. Runs on almost any computer.", he: "קטן ומהיר. רץ כמעט על כל מחשב." },
  },
  {
    id: "qwen3-8b",
    name: "Qwen3 8B",
    category: "chat",
    repo: "Qwen/Qwen3-8B-GGUF",
    filePattern: "Q4_K_M\\.gguf$",
    sizeGb: 5,
    memoryGb: 7,
    goodForCode: true,
    note: { en: "Good everyday chat and light coding. Needs about 8 GB of VRAM.", he: "צ'אט יומיומי טוב וקוד קל. צריך כ-8 GB זיכרון גרפי." },
  },
  {
    id: "qwen3-14b",
    name: "Qwen3 14B",
    category: "chat",
    repo: "Qwen/Qwen3-14B-GGUF",
    filePattern: "Q4_K_M\\.gguf$",
    sizeGb: 9,
    memoryGb: 11,
    goodForCode: true,
    note: { en: "Stronger reasoning and tool use. Best with 12–16 GB of VRAM.", he: "חשיבה ושימוש בכלים חזקים יותר. הכי טוב עם 12–16 GB זיכרון גרפי." },
  },
  {
    id: "gpt-oss-20b",
    name: "gpt-oss 20B",
    category: "chat",
    repo: "ggml-org/gpt-oss-20b-GGUF",
    filePattern: "^gpt-oss-20b-MXFP4\\.gguf$",
    sizeGb: 12,
    memoryGb: 14,
    activeFraction: 0.18,
    goodForCode: true,
    note: { en: "OpenAI's open-weight model. Strong at tools and reasoning.", he: "המודל הפתוח של OpenAI. חזק בכלים ובחשיבה." },
  },
  {
    id: "qwen3-coder-30b",
    name: "Qwen3 Coder 30B",
    category: "chat",
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    filePattern: "Q4_K_M\\.gguf$",
    sizeGb: 18.6,
    memoryGb: 22,
    activeFraction: 0.11,
    goodForCode: true,
    note: {
      en: "Made for coding agents. Mixture-of-experts, so it runs well split across VRAM and RAM.",
      he: "בנוי לסוכני קוד. בגלל המבנה שלו הוא רץ טוב גם כשהוא מתחלק בין הזיכרון הגרפי ל-RAM.",
    },
  },
];

/** How much of the computer "Set it up for me" may use. */
export type ResourceLevel = "conservative" | "balanced" | "extreme";

/** The speed rating of a model on this computer (see `estimatePerformance`). */
export type SpeedRating = "good" | "ok" | "slow" | "too-big";

/**
 * Picks models for "Set it up for me".
 *
 * - **conservative:** the model one size below the biggest fast one, leaving room for other apps.
 * - **balanced:** the biggest model that is still fast ("good").
 * - **extreme:** the biggest model that fits at all, even if it is slow.
 *
 * A separate coding model is suggested only when the chat pick is not good at tools.
 *
 * @param models - Recommended models with their rating on this computer, smallest first.
 * @param level - Resource level.
 * @returns Ids of the chat pick and, if different, the coding pick.
 */
export function pickSetup<M extends { id: string; goodForCode: boolean; rating: SpeedRating }>(
  models: readonly M[],
  level: ResourceLevel,
): { chat?: string; code?: string } {
  const pick = (list: readonly M[]): M | undefined => {
    const good = list.filter((m) => m.rating === "good");
    const fits = list.filter((m) => m.rating !== "too-big");
    if (level === "extreme") return fits.at(-1);
    if (level === "conservative") return good.length > 1 ? good.at(-2) : (good[0] ?? fits[0]);
    return good.at(-1) ?? list.filter((m) => m.rating === "ok").at(-1) ?? fits[0];
  };
  const chat = pick(models);
  const code = chat?.goodForCode ? undefined : pick(models.filter((m) => m.goodForCode));
  return { ...(chat ? { chat: chat.id } : {}), ...(code ? { code: code.id } : {}) };
}
