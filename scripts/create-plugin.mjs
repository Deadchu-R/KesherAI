#!/usr/bin/env node
// Creates a new plugin from plugins/example-hello.
// Usage: pnpm create-plugin <id> [--dir <target-folder>]
import { cp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const [id, flag, dirArg] = process.argv.slice(2);
if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error("Usage: pnpm create-plugin <id>   (lower-case letters, digits and '-')");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const target = flag === "--dir" && dirArg ? resolve(dirArg) : join(root, "plugins", id);
if (existsSync(target)) {
  console.error(`${target} already exists`);
  process.exit(1);
}

await cp(join(root, "plugins", "example-hello"), target, {
  recursive: true,
  filter: (src) => !/node_modules|dist|tsbuildinfo/.test(src),
});

const manifestPath = join(target, "kesher-plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
Object.assign(manifest, { id, name: id, version: "0.1.0", description: "Describe what your plugin does." });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const pkgPath = join(target, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
pkg.name = `kesher-plugin-${id}`;
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

await rm(join(target, "README.md"), { force: true });
await writeFile(join(target, "README.md"), `# ${id}\n\nA KesherAI plugin. See docs/PLUGINS.md.\n`);

console.log(`Created ${target}`);
console.log("Next: edit src/index.ts, then run `pnpm install && pnpm build:packages`.");
