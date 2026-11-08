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

test("another computer's models show at once from the last list; a computer that went to sleep is not waited on", async () => {
  let asked = 0;
  const reg = new ProviderRegistry();
  reg.registerFactory({
    ...echoFactory,
    type: "slow-server",
    create: (config) => ({
      ...echoFactory.create(config),
      location: "server",
      listModels: async () => {
        asked++;
        await new Promise((r) => setTimeout(r, 50));
        return [{ id: `${config.id}/big`, providerId: config.id, providerModelId: "big", name: "big", category: "chat", location: "server" }];
      },
    }),
  });
  reg.add({ id: "pc", type: "slow-server" });
  assert.deepEqual((await reg.listAllModels()).models.map((m) => m.id), ["pc/big"]);
  assert.equal(asked, 1);
  const t0 = Date.now();
  assert.deepEqual((await reg.listAllModels()).models.map((m) => m.id), ["pc/big"]);
  assert.ok(Date.now() - t0 < 40, "served from the last list without waiting");
  assert.equal(asked, 1);
  reg.setAway("pc", "PC went to sleep");
  const away = await reg.listAllModels();
  assert.deepEqual(away.models, []);
  assert.deepEqual(away.errors, [{ providerId: "pc", message: "PC went to sleep" }]);
  reg.setAway("pc", undefined);
  assert.equal((await reg.listAllModels()).models.length, 1);
});
