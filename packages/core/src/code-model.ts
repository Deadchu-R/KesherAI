/**
 * The best model on this computer for long coding runs (self-work): good at
 * tools and long context, and fast enough here to work for hours. Ranked from
 * public results for local coding agents (Nov 2026): Qwen3-Coder 30B-A3B
 * (long-horizon RL, 256K context, fast as a mixture of experts), the Qwen 3.6/3.8
 * 27B coding models, GLM-4.7-Flash, Devstral 24B, gpt-oss; dense general
 * models below; small models last. Cloud models are never picked on their own
 * (they cost money per token); the user can still choose one.
 */

/** A model that could do the work. */
export interface CandidateModel {
  id: string;
  name: string;
  category: string;
  location: "local" | "server" | "cloud";
  details?: Record<string, string | number | boolean>;
}

/** Families for agentic coding, best first: [pattern, score, why]. */
const FAMILIES: Array<[RegExp, number, string]> = [
  [/gpt-?oss.?120b/i, 96, "gpt-oss 120B: strong at tools and long tasks"],
  [/qwen3.?coder.?(480|235)/i, 97, "Qwen3-Coder (large): the strongest open coder"],
  [/qwen3.?coder.?30b|qwen3.?coder.*a3b/i, 92, "Qwen3-Coder 30B: made for coding agents, 256K context, fast (mixture of experts)"],
  [/qwen3\.?[68].*27b|qwen3\.[68].*coder/i, 90, "Qwen 3.6/3.8 27B: agentic coding upgrade, 256K context"],
  [/glm.?4\.[5-9].?air/i, 91, "GLM-4.5/4.7 Air: strong agentic coder (needs a lot of memory)"],
  [/glm.?4\.[6-9].?flash/i, 86, "GLM-4.7-Flash: 30B-class coder, long context"],
  [/devstral/i, 85, "Devstral: trained for software-engineering agents"],
  [/gpt-?oss.?20b/i, 78, "gpt-oss 20B: good at tools, light"],
  [/qwen2\.5.?coder.?32b/i, 74, "Qwen2.5-Coder 32B: solid coder, shorter context"],
  [/qwen3.?32b/i, 76, "Qwen3 32B: strong general model with tools"],
  [/llama.?3\.3.?70b/i, 72, "Llama 3.3 70B: general model, good with tools"],
  [/qwen3.?14b/i, 64, "Qwen3 14B: decent tools, mid size"],
  [/qwen2\.5.?coder.?14b/i, 60, "Qwen2.5-Coder 14B"],
  [/qwen3.?8b/i, 50, "Qwen3 8B: light coding"],
  [/qwen2\.5.?coder.?7b/i, 45, "Qwen2.5-Coder 7B: small coder"],
];

/** Speed ratings from the hardware estimate (the Models screen's ones), when known. */
export type Fit = "good" | "ok" | "slow" | "too-big" | undefined;

/**
 * Picks the model for a long coding run.
 *
 * @param models - Chat models that can be used now (local, another computer's, cloud).
 * @param fitOf - The speed rating of a model on this computer, when it is known.
 * @returns The pick and the reason, or undefined when there is no usable model.
 */
export function pickCodeModel(models: CandidateModel[], fitOf: (m: CandidateModel) => Fit = () => undefined): { id: string; why: string } | undefined {
  const scored = models
    .filter((m) => m.category === "chat" && m.location !== "cloud")
    .map((m) => {
      const text = `${m.id} ${m.name}`;
      const fam = FAMILIES.find(([re]) => re.test(text));
      let score = fam ? fam[1] : /coder|code/i.test(text) ? 55 : 30;
      const fit = fitOf(m);
      // Hours of work: a model that is slow here costs more than a slightly weaker fast one.
      if (fit === "too-big") score -= 100;
      else if (fit === "slow") score -= 25;
      else if (fit === "ok") score -= 5;
      // Another computer's model (over the network) is a little behind one on this computer.
      if (m.location === "server") score -= 2;
      const ctx = Number(m.details?.contextLength ?? m.details?.context_length ?? 0);
      if (ctx && ctx < 16_000) score -= 15;
      return { m, score, why: fam ? fam[2] : "the best coding model found here" };
    })
    .filter((x) => x.score > -50)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best ? { id: best.m.id, why: best.why } : undefined;
}
