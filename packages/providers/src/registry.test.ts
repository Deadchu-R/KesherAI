import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "./registry.js";
import type { Provider, ProviderFactory } from "./provider.js";

const echoFactory: ProviderFactory = {
  type: "echo",
  displayName: "Echo",
  categories: ["chat"],
  create: (config): Provider => ({
    id: config.id,
    name: "Echo",
    location: "local",
    capabilities: { chat: true },
    checkHealth: async () => true,
    listModels: async () => [
      { id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" },
    ],
  }),
};

const brokenFactory: ProviderFactory = {
  ...echoFactory,
  type: "broken",
  create: (config) => ({ ...echoFactory.create(config), listModels: async () => { throw new Error("offline"); } }),
};

test("registry routes model ids and isolates failing providers", async () => {
  const reg = new ProviderRegistry();
  reg.registerFactory(echoFactory);
  reg.registerFactory(brokenFactory);
  reg.add({ id: "a", type: "echo" });
  reg.add({ id: "b", type: "broken" });

  const listing = await reg.listAllModels();
  assert.deepEqual(listing.models.map((m) => m.id), ["a/m"]);
  assert.deepEqual(listing.errors, [{ providerId: "b", message: "offline" }]);

  const { provider, providerModelId } = reg.resolve("a/m");
  assert.equal(provider.id, "a");
  assert.equal(providerModelId, "m");
  assert.throws(() => reg.resolve("missing/m"));
});

test("registry rejects bad ids and unknown types", () => {
  const reg = new ProviderRegistry();
  reg.registerFactory(echoFactory);
  assert.throws(() => reg.add({ id: "has/slash", type: "echo" }));
  assert.throws(() => reg.add({ id: "ok", type: "nope" }));
  assert.throws(() => reg.registerFactory(echoFactory));
});
