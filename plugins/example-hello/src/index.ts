/**
 * Example plugin: the smallest useful KesherAI plugin.
 *
 * It shows the two extension points most plugins use:
 * 1. a new provider type ("echo"), which users add under Connections;
 * 2. a tool ("reverse_text"), which models and Pipelines can call.
 *
 * Only `import type` is used from the SDK, so the built file has no runtime
 * dependencies and works when copied straight into `~/.kesher/plugins/`.
 * If your plugin needs npm packages at runtime, bundle it (esbuild, tsup).
 *
 * @packageDocumentation
 */
import type { KesherPlugin, Provider, ProviderConfig } from "@kesher/plugin-sdk";

/**
 * A provider whose single chat model repeats the last user message. Useful
 * for testing the UI and the API without downloading a model.
 *
 * @param config - Provider config from the user.
 * @returns The provider.
 */
function createEchoProvider(config: ProviderConfig): Provider {
  return {
    id: config.id,
    name: config.name ?? "Echo",
    location: "local",
    capabilities: { chat: true },
    async checkHealth() {
      return true;
    },
    async listModels() {
      return [
        {
          id: `${config.id}/echo-1`,
          providerId: config.id,
          providerModelId: "echo-1",
          name: "Echo 1",
          category: "chat",
          location: "local",
        },
      ];
    },
    async *chat(request) {
      const last = [...request.messages].reverse().find((m) => m.role === "user");
      yield { type: "delta", text: `Echo: ${last?.content ?? ""}` };
      yield { type: "done" };
    },
  };
}

/** The plugin. The core server calls `activate` once when it loads. */
const plugin: KesherPlugin = {
  activate(ctx) {
    ctx.registerProviderFactory({
      type: "echo",
      displayName: "Echo (example plugin)",
      categories: ["chat"],
      create: createEchoProvider,
    });

    ctx.registerTool({
      name: "reverse_text",
      description: "Reverses a string. Use it when the user asks to reverse text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to reverse" } },
        required: ["text"],
      },
      async run(input) {
        return [...String(input.text ?? "")].reverse().join("");
      },
    });

    ctx.log.info("example-hello is active");
  },
};

export default plugin;
