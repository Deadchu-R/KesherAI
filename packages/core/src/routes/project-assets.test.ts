import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAssetRoutes, SAVE_TYPE } from "./project-assets.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

test("Open from project: only found projects, the file and a prefab read, and a phone's save waits for the computer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-pa-route-"));
  await mkdir(join(dir, "Assets", "T"), { recursive: true });
  await mkdir(join(dir, "ProjectSettings"));
  await writeFile(join(dir, "Assets", "T", "Rock.png"), PNG);
  await writeFile(join(dir, "Assets", "T", "Bark.tga"), Buffer.from([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0, 1, 2, 3]));
  await writeFile(join(dir, "Assets", "Crate.prefab"), "%YAML 1.1\n--- !u!1 &100\nGameObject:\n  m_Name: Crate\n--- !u!4 &101\nTransform:\n  m_GameObject: {fileID: 100}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalPosition: {x: 0, y: 1, z: 0}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_Father: {fileID: 0}\n");
  const data = await mkdtemp(join(tmpdir(), "kesher-pa-data-"));
  let phone = false;
  const app = Fastify();
  const notes: string[] = [];
  await projectAssetRoutes(app, { found: async () => [{ kind: "unity", name: "Game", path: dir }], dataDir: data, notify: (t) => notes.push(t), isLocal: () => !phone });
  const q = (o: Record<string, string>) => new URLSearchParams({ engine: "unity", project: dir, ...o }).toString();

  assert.equal((await app.inject({ url: "/api/project-assets/projects" })).json().projects[0].name, "Game");
  assert.deepEqual((await app.inject({ url: `/api/project-assets/list?${q({ kind: "image" })}` })).json().items.map((i: { path: string }) => i.path), ["Assets/T/Bark.tga", "Assets/T/Rock.png"]);
  // A folder that is a Unity project but not found on this computer, and paths outside, are refused.
  const other = await mkdtemp(join(tmpdir(), "kesher-pa-other-"));
  assert.equal((await app.inject({ url: `/api/project-assets/list?engine=unity&project=${encodeURIComponent(other)}&kind=image` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/project-assets/file?${q({ path: "Assets/../ProjectSettings/x.png" })}` })).statusCode, 400);
  const f = await app.inject({ url: `/api/project-assets/file?${q({ path: "Assets/T/Rock.png" })}` });
  assert.deepEqual(f.rawPayload, PNG);
  const tga = await app.inject({ url: `/api/project-assets/file?${q({ path: "Assets/T/Bark.tga" })}` });
  assert.equal(tga.headers["x-kesher-format"], "png");
  assert.equal((await app.inject({ url: `/api/project-assets/prefab?${q({ path: "Assets/Crate.prefab" })}` })).json().objects[0].name, "Crate");

  // From the phone: staged, the computer told, approving refused there; approved on the computer.
  phone = true;
  const edited = Buffer.concat([PNG, Buffer.from("x")]);
  const st = await app.inject({ method: "POST", url: `/api/project-assets/save?${q({ path: "Assets/T/Rock.png", mode: "replace" })}`, headers: { "content-type": SAVE_TYPE }, payload: edited });
  assert.equal(st.statusCode, 200, st.body);
  const { save, canApprove } = st.json();
  assert.equal(canApprove, false);
  assert.equal(save.fromPhone, true);
  assert.equal(notes.length, 1);
  assert.equal((await app.inject({ method: "POST", url: `/api/project-assets/saves/${save.id}/approve` })).statusCode, 403);
  assert.deepEqual(await readFile(join(dir, "Assets", "T", "Rock.png")), PNG);
  phone = false;
  const ok = await app.inject({ method: "POST", url: `/api/project-assets/saves/${save.id}/approve` });
  assert.equal(ok.json().save.state, "done");
  assert.deepEqual(await readFile(join(dir, "Assets", "T", "Rock.png")), edited);
  await app.close();
});
