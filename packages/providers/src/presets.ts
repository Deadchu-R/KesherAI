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
}

/**
 * Well-known servers and APIs. Ports are each project's defaults; the user
 * can change them after adding the connection.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    config: { id: "lmstudio", type: "openai-compatible", name: "LM Studio", baseUrl: "http://localhost:1234/v1", location: "server" },
    description: "Models already downloaded in LM Studio, through its local server.",
    autodetect: true,
  },
  {
    config: { id: "ollama", type: "openai-compatible", name: "Ollama", baseUrl: "http://localhost:11434/v1", location: "server" },
    description: "Models pulled with Ollama.",
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
    config: { id: "openrouter", type: "openai-compatible", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", location: "cloud" },
    description: "Hundreds of models from many labs behind one key.",
    needsApiKey: true,
  },
  {
    config: { id: "groq", type: "openai-compatible", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", location: "cloud" },
    description: "Fast inference for open-weight models.",
    needsApiKey: true,
  },
];
