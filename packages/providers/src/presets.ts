import { connectionTrainingRisk, type TrainingRisk } from "@kesher/shared";
import type { ProviderConfig } from "./provider.js";

/**
 * A ready-made provider config the UI offers in "Add connection", and that
 * the core server probes on start-up when `autodetect` is set.
 */
export interface ProviderPreset {
  /** Config to create; the user may still edit it. */
  config: ProviderConfig;
  /** Short description for the "Add connection" dialog. */
  description: string;
  /** Probe this preset on start-up and add it if it answers. */
  autodetect?: boolean;
  /** Whether the user must supply an API key. */
  needsApiKey?: boolean;
  /**
   * Whether the service may train on what it is sent (`some`: only some of its models). Filled from the shared
   * training table (training-risk.ts), the one source for the chat, the inbox and the interface.
   */
  trainsOnData?: TrainingRisk | "some";
}

/** Adds each preset's {@link ProviderPreset.trainsOnData} from the shared table. */
const withTrainingRisk = (list: readonly ProviderPreset[]): readonly ProviderPreset[] =>
  list.map((p) => {
    const risk = connectionTrainingRisk(p.config.id);
    return risk ? { ...p, trainsOnData: risk } : p;
  });

/**
 * Well-known servers and APIs. Ports are each project's defaults; the user
 * can change them after adding the connection.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = withTrainingRisk([
  {
    config: { id: "lmstudio", type: "openai-compatible", name: "LM Studio", baseUrl: "http://localhost:1234/v1", location: "server" },
    description: "Models already downloaded in LM Studio, through its local server.",
    autodetect: true,
  },
  {
    config: { id: "lmstudio-bionic", type: "openai-compatible", name: "LM Studio Bionic", baseUrl: "http://localhost:1235/v1", location: "server" },
    description: "Models loaded in LM Studio Bionic. It is a separate app from LM Studio and serves on port 1235 by default.",
    autodetect: true,
  },
  {
    config: { id: "ollama", type: "openai-compatible", name: "Ollama", baseUrl: "http://localhost:11434/v1", location: "server" },
    description: "Models pulled with Ollama.",
    autodetect: true,
  },
  {
    config: { id: "jan", type: "openai-compatible", name: "Jan", baseUrl: "http://localhost:1337/v1", location: "server" },
    description: "Models in Jan, through its local API server (Settings → Local API Server).",
    autodetect: true,
  },
  {
    config: { id: "koboldcpp", type: "openai-compatible", name: "KoboldCpp", baseUrl: "http://localhost:5001/v1", location: "server" },
    description: "The model loaded in KoboldCpp.",
    autodetect: true,
  },
  {
    config: { id: "vllm", type: "openai-compatible", name: "vLLM", baseUrl: "http://localhost:8000/v1", location: "server" },
    description: "Models served by vLLM (fast on NVIDIA cards).",
    autodetect: true,
  },
  {
    config: { id: "textgen", type: "openai-compatible", name: "Text Generation WebUI", baseUrl: "http://localhost:5000/v1", location: "server" },
    description: "The model loaded in oobabooga's text-generation-webui (start it with --api).",
    autodetect: true,
  },
  {
    config: { id: "gpt4all", type: "openai-compatible", name: "GPT4All", baseUrl: "http://localhost:4891/v1", location: "server" },
    description: "Models in GPT4All, through its local API server.",
    autodetect: true,
  },
  {
    config: { id: "localai", type: "openai-compatible", name: "LocalAI / llamafile", baseUrl: "http://localhost:8080/v1", location: "server" },
    description: "LocalAI or a llamafile, on their default port.",
    autodetect: true,
  },
  {
    config: { id: "comfyui", type: "comfyui", name: "ComfyUI", baseUrl: "http://127.0.0.1:8188", location: "local" },
    description: "Image, video and audio workflows in ComfyUI.",
    autodetect: true,
  },
  {
    config: { id: "llamacpp", type: "openai-compatible", name: "llama.cpp (managed)", baseUrl: "http://127.0.0.1:8081/v1", location: "local" },
    description: "The llama-server KesherAI starts for GGUF models you downloaded.",
  },
  {
    config: { id: "openai", type: "openai-compatible", name: "OpenAI", baseUrl: "https://api.openai.com/v1", location: "cloud" },
    description: "GPT models through the OpenAI API.",
    needsApiKey: true,
  },
  {
    config: { id: "anthropic", type: "anthropic", name: "Anthropic", location: "cloud" },
    description: "Claude models through the Anthropic API.",
    needsApiKey: true,
  },
  {
    // Gemini's OpenAI-compatible endpoint: chat, streaming, tools and model list.
    config: { id: "gemini", type: "openai-compatible", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", location: "cloud" },
    description: "Gemini models through Google AI Studio (free API keys at aistudio.google.com).",
    needsApiKey: true,
  },
  {
    // Its free "Experiment" plan (1 request/s) may use prompts for training: the task inbox uses it only with "Allow free
    // services that may train on my code" (task-inbox.ts FREE_PROVIDERS).
    config: { id: "mistral", type: "openai-compatible", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", location: "cloud" },
    description: "Mistral and Codestral models through the Mistral API.",
    needsApiKey: true,
  },
  {
    config: { id: "deepseek", type: "openai-compatible", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", location: "cloud" },
    description: "DeepSeek chat and reasoning models.",
    needsApiKey: true,
  },
  {
    config: { id: "xai", type: "openai-compatible", name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", location: "cloud" },
    description: "Grok models through the xAI API.",
    needsApiKey: true,
  },
  {
    config: { id: "openrouter", type: "openai-compatible", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", location: "cloud" },
    description: "Hundreds of models from many labs behind one key.",
    needsApiKey: true,
  },
  {
    // A flat monthly plan ($10; per-model 5-hour, weekly and monthly limits), not pay-per-token: the fallback coder when
    // Antigravity's weekly quota is out (docs/WORK_LIST.md, 2026-11-22). Keep "Use balance" off in its console so it
    // never bills past the plan.
    config: { id: "opencode-go", type: "openai-compatible", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", location: "cloud" },
    description: "Open coding models (Kimi, GLM, DeepSeek, Qwen, MiniMax, MiMo) on a flat $10/month plan with usage limits.",
    needsApiKey: true,
  },
  {
    // Free tier for coding agents: glm-4.7-flash and glm-4.5-flash, ONE request at a time (429 when more); API data is
    // not used for training unless the user agrees. Used by the task inbox as a free fallback (task-inbox.ts FREE_PROVIDERS).
    config: { id: "zai", type: "openai-compatible", name: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4", location: "cloud" },
    description: "GLM models (free glm-4.7-flash and glm-4.5-flash) from Z.ai.",
    needsApiKey: true,
  },
  {
    // A free trial key for testing and evaluation (~40 requests/min); may train on data, so the inbox needs the same setting.
    config: { id: "nvidia-nim", type: "openai-compatible", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", location: "cloud" },
    description: "NVIDIA's hosted model catalog on a free trial key (testing and evaluation).",
    needsApiKey: true,
  },
  {
    // Workers AI: 10,000 Neurons a day free on every account (resets 00:00 UTC). Replace ACCOUNT_ID in the address with your
    // Cloudflare account id when you add the key (an API token with Workers AI access). A free coder for the task inbox.
    config: { id: "cloudflare-ai", type: "openai-compatible", name: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1", location: "cloud" },
    description: "Open models on Cloudflare's network; a free daily allowance on every account (set your account id in the address).",
    needsApiKey: true,
  },
  {
    // Free, no card: 20 requests/min, 20/day, 200K tokens/day per model. Chat and research only: too small for agent loops,
    // so never in the task inbox's coder order (task-inbox.ts CHAT_ONLY_PROVIDERS).
    config: { id: "sambanova", type: "openai-compatible", name: "SambaNova", baseUrl: "https://api.sambanova.ai/v1", location: "cloud" },
    description: "Fast open models on a free tier with small daily limits (chat and research only).",
    needsApiKey: true,
  },
  {
    // Trial key: rate-limited and for non-commercial use. Chat and research only (CHAT_ONLY_PROVIDERS).
    config: { id: "cohere", type: "openai-compatible", name: "Cohere", baseUrl: "https://api.cohere.ai/compatibility/v1", location: "cloud" },
    description: "Command models on a free trial key with rate limits (chat and research only).",
    needsApiKey: true,
  },
  {
    // The free plan has a small monthly allowance on starter models. Chat only (CHAT_ONLY_PROVIDERS).
    config: { id: "ollama-cloud", type: "openai-compatible", name: "Ollama Cloud", baseUrl: "https://ollama.com/v1", location: "cloud" },
    description: "Models hosted by Ollama; the free plan has a small monthly allowance (chat only).",
    needsApiKey: true,
  },
  {
    config: { id: "groq", type: "openai-compatible", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", location: "cloud" },
    description: "Fast inference for open-weight models.",
    needsApiKey: true,
  },
]);
