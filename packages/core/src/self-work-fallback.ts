import { FREE_PROVIDERS, isFreeOpencodeModel } from "@kesher/shared";
import { pickCodeModel, type CandidateModel } from "./code-model.js";

/**
 * The models self-work falls back to when its model keeps stopping with errors, best first: the model loaded on this
 * PC (when given), the other local models (best coding model first), then the free ones the task inbox already uses.
 * A free service whose tier may train on prompts is left out (the run works on private code).
 *
 * @param models - The models that can be used now.
 * @param loaded - The local model that is loaded now (its registry id), if any.
 * @returns Model ids, each once, in the order to try.
 */
export function fallbackModelList(models: readonly CandidateModel[], loaded?: string): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  if (loaded && models.some((m) => m.id === loaded)) add(loaded);
  let rest = models.filter((m) => m.location !== "cloud" && !out.includes(m.id));
  for (let pick = pickCodeModel(rest); pick; pick = pickCodeModel(rest)) {
    add(pick.id);
    rest = rest.filter((m) => m.id !== pick!.id);
  }
  for (const m of models) {
    if (m.category !== "chat" || m.location !== "cloud") continue;
    if (FREE_PROVIDERS.some((p) => !p.trainsOnData && p.allowed(m.id)) || isFreeOpencodeModel(m.id)) add(m.id);
  }
  return out;
}
