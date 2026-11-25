/**
 * Which model services may use what is sent to them for training (Roee, 2026-11-23: a warning for every user). The one
 * table every part reads: provider presets, the task inbox's free services, the model menu, Settings › Connections,
 * task cards, the chat's warning line and the leak guard (leak-guard.ts) that hides sensitive text before a request
 * goes to such a service.
 */
/** The services known to train, or that may train, on what they are sent. Checked 2026-11-23 against each one's terms. */
export const TRAINING_RULES = [
    { connection: "nvidia-nim", risk: "yes", freeTierTrains: true, why: "The NVIDIA API trial key is for testing; its data may be used to improve NVIDIA's models." },
    { connection: "opencode-go", risk: "yes", models: /contributor-free$/, freeTierTrains: true, why: "OpenCode's Contributor free models answer only with the data-sharing opt-in." },
    { connection: "gemini", risk: "may", freeTierTrains: true, why: "Google may use prompts sent with a free Gemini API key to improve its products (a paid key does not)." },
    { connection: "mistral", risk: "may", freeTierTrains: true, why: "Mistral's free Experiment plan may use data to train models (paid plans do not)." },
    { connection: "openrouter", risk: "may", models: /(^|\/)[\w.-]+:free$|^openrouter\/free$/, freeTierTrains: false, why: "OpenRouter's free models are served by many providers; some log prompts and may train on them." },
    // The free cloud helpers' own connections (Settings › Free cloud helpers): free tiers only.
    { connection: "fc-mistral", risk: "yes", freeTierTrains: true, why: "The free cloud helpers use Mistral's free Experiment plan, which may use data to train models." },
    // A flat-rate relay the user pays for (Roee, 25.11: a one-month trial for heavy tasks without sensitive content).
    { connection: "ghostcli", risk: "may", freeTierTrains: false, why: "GhostCLI is an unofficial relay to other companies' models; what it keeps or passes on is unknown." },
    { connection: "fc-openrouter", risk: "may", freeTierTrains: false, why: "The free cloud helpers use OpenRouter's free models; some of their providers log prompts and may train on them." },
];
/** The rule for a model id (`<connection>/<model>`), when its service may train on prompts. */
function ruleOf(modelId) {
    const slash = modelId.indexOf("/");
    if (slash <= 0)
        return undefined;
    const conn = modelId.slice(0, slash);
    const model = modelId.slice(slash + 1);
    return TRAINING_RULES.find((r) => r.connection === conn && (!r.models || r.models.test(model)));
}
/**
 * Whether a model's service may train on what it is sent.
 *
 * @param modelId - A KesherAI model id (`<connection>/<model>`).
 * @returns `yes`, `may`, or undefined (no known training: local models, paid APIs that do not train).
 */
export function trainingRiskOf(modelId) {
    return modelId ? ruleOf(modelId)?.risk : undefined;
}
/**
 * Why a model's service may train (English), for a tooltip or a log line.
 *
 * @param modelId - A KesherAI model id.
 */
export function trainingWhy(modelId) {
    return ruleOf(modelId)?.why;
}
/**
 * Whether a connection may train on prompts, for its row in Settings › Connections. `some`: only some of its models
 * (OpenRouter's `:free` ones, OpenCode's contributor ones).
 *
 * @param connectionId - The connection id.
 */
export function connectionTrainingRisk(connectionId) {
    const r = TRAINING_RULES.find((x) => x.connection === connectionId);
    return r ? (r.models ? "some" : r.risk) : undefined;
}
/**
 * Whether a connection's free tier trains on prompts (the task inbox's `FreeProvider.trainsOnData`).
 *
 * @param connectionId - The connection id.
 */
export function freeTierTrains(connectionId) {
    return TRAINING_RULES.some((r) => r.connection === connectionId && r.freeTierTrains);
}
